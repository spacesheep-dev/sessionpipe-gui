// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The reader of a spacesheep account's relay (docs/rfcs/08): the
// relay at `/api/sessionpipe/v1/relay` hands over the account's accepted wire events after
// a cursor, long-polling when there are none, and this feeds them to a store's ingest. The
// store's dedup resolves any overlap with a machine that also posts to the same store.
//
// One loop, never two: a poll that waits up to 25 s on the server, then the next at
// once; on an error, a pause that grows to a minute. A 401 means the key was revoked on
// spacesheep (Settings → API keys there): the loop stops and the status says so.
//
// One definition, two openers. The receiver (sources/spacesheep.ts) holds the account's
// key and keeps the cursor in files beside the outbox offsets; a page that carries its own
// board (the phone on an account) asks through the native hub, which holds the key, and
// keeps the cursor in its own storage. What differs is handed in: the doors (`fetch` with
// whatever reaches spacesheep), where the cursor and the read times are kept, the clock and
// its timers, and the sink the events go to. Nothing here is Node's (store/browser.test.ts
// holds it to what a page has).
import type { ProtocolEvent, SpacesheepSourceStatus } from "../../shared/api.js";
import { eventProblem } from "../receiver/validate.js";

export const RELAY_PATH = "/api/sessionpipe/v1/relay";
export const RELAY_WAIT_S = 25;
export const RELAY_PAGE = 500;

/** A request to one of the account's doors, by path and query: the opener adds the origin
 *  and the key (the receiver), or hands it to the hub that does (a page never has the key). */
export type Doors = (path: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** The two small values the reader keeps between runs, each whole JSON: `cursor`
 *  (`{ origin, email, cursor }`) and `reads` (`{ origin, email, reads }`). Read once at the
 *  start; `read` answers undefined for one that is not there or cannot be read. */
export type RelayKept = "cursor" | "reads";
export interface RelayKeep {
  read(name: RelayKept): unknown;
  write(name: RelayKept, value: unknown): void;
}

/** The clock and its timers. A handle is whatever `setTimeout` gave: Node's Timeout (the
 *  reader unrefs the ones that must not keep a process alive) or a page's number. */
export interface RelayClock {
  now(): number;
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

/** Where the events go. */
export interface RelaySink {
  /** Valid events, in the relay's order: how many were new. */
  ingest(events: ProtocolEvent[]): number;
  /** True around the first read: it is history, not live traffic. */
  setLoading(on: boolean): void;
}

/** The header the native hub puts on an answer of its own (docs/rfcs/08, "The doors"):
 *  with it the answer is the hub's, without it spacesheep's. */
export const HUB_HEADER = "x-sessionpipe-hub";

export interface RelayReaderOptions {
  /** The account read: its cursor and its read times are kept under these two. */
  origin: string;
  email: string;
  doors: Doors;
  keep: RelayKeep;
  sink: RelaySink;
  /** Absent: the real clock. */
  clock?: RelayClock;
  /** The pause after an error, before it grows (tests). */
  retryMs?: number;
  /** The relay's machine list, each time it is read (every minute): the control state
   *  keeps them as rows paired there (state.upsertRemoteMachines). */
  onMachines?: (machines: unknown[], origin: string, rpId: string) => void;
  /** The spacesheep job ids still unsettled here, lowest first: while there is one, the
   *  jobs door is read every few seconds and its word handed to `onJobs`, with the highest
   *  job id the read covered (Infinity when it reached the end of the list) and
   *  spacesheep's own time from the answer's Date (undefined without one). */
  pendingJobs?: () => number[];
  onJobs?: (jobs: RelayJob[], through: number, serverNow?: number) => void;
  /** How soon the jobs door is worth reading again: `fast` every JOBS_FAST_MS, `slow`
   *  every JOBS_SLOW_MS (every send waits for a computer shown offline), `none` (nothing to
   *  read). Absent: fast. kickJobs reads at once whatever it says. */
  jobsCadence?: () => "fast" | "slow" | "none";
  /** spacesheep refused the key (its own poll's 401, or unauthorized() for a send's). */
  onUnauthorized?: () => void;
  /** The sessions (`harness:id`) a relay page brought events for. */
  onEvents?: (keys: string[]) => void;

  // What follows is for an opener behind the native hub with no board of its own until
  // the relay is read (a page). The receiver sets none of it.

  /** The doors go through the native hub: an answer with HUB_HEADER is the hub's own, read
   *  by its code and never as spacesheep's (a `busy` 429 is not spacesheep's limit and is
   *  asked again, HUB_BUSY_RUN times in a row at most before it is an error like any other
   *  of the hub's; `answer_too_large` asks again for fewer events, and one event the hub
   *  cannot pass even alone is an error of the hub's, asked for again every
   *  HUB_UNPASSABLE_MS with the cursor where it is; a hub 401 is not a revoked key). The
   *  first read asked again is still the first: `setLoading(false)` waits for a page or a
   *  failure. Off, the header is never looked at. */
  hub?: boolean;
  /** History is read first: while a page comes back full (more is waiting) the next is
   *  read at once and with no wait, as long as BACKLOG_RESERVE reads of the budget stay
   *  unspent (backlogPaceMs). Off, every read is paced alike (relayPaceMs) and waits. */
  backlog?: boolean;
  /** The key was made just now, so no reader before this one spent any of its budget:
   *  with no read times kept, none are taken as spent (readsFrom's seed). */
  fresh?: boolean;
  /** Each relay page as it was taken: how many events it held, how many were new, the
   *  cursor after it, and whether it came back full (more is waiting). */
  onPage?: (page: { events: number; taken: number; cursor: number; more: boolean }) => void;
  /** The state, each time it changes. */
  onState?: (state: RelayStatus["state"]) => void;
}

/** The jobs door's pace: while a send was just made, is taken, or its computer is online. */
export const JOBS_FAST_MS = 3000;
/** ...and while every send waits for a computer the machine list shows offline. */
export const JOBS_SLOW_MS = 45_000;

/** What the reader says of itself; the receiver's source adds the account to it. */
export type RelayStatus = Omit<SpacesheepSourceStatus, "origin" | "email" | "connectedAt">;

export interface RelayReader {
  stop(): void;
  status(): RelayStatus;
  /** One poll now, with no wait (tests): how many events were taken. */
  tick(): Promise<number>;
  /** One read of the jobs door now (tests). */
  pollJobs(): Promise<void>;
  /** One read of the machines door now (tests). */
  pollMachines(): Promise<void>;
  /** spacesheep refused the key elsewhere (a send's 401): the reader stops as its own poll
   *  would on one, so the status says so at the same moment. */
  unauthorized(): void;
  /** Read the jobs door now (a send just made, its computer back, events for its session). */
  kickJobs(): void;
}

/** One job as the relay's jobs door lists it (spacesheep's `relay/jobs`). */
export interface RelayJob {
  id: number;
  status: string;
  note: string | null;
  /** Why it ended as it did, when spacesheep says (a computer's refusal code, `cancelled`,
   *  `expired`); absent on a spacesheep from before the field. */
  code?: string | null;
  done_at: number | null;
  created_at: number;
}

/** The jobs door answers at most this many jobs after `since`, oldest first. */
export const JOBS_PAGE = 100;
/** Pages read in one look at the jobs door, at most. */
export const JOBS_PAGES_MAX = 10;

/** One look at the jobs door: a page from below the lowest pending id, then, while a
 *  pending id lies past the page's last job, a page from just below that one, so a job
 *  that waits (a computer off for days) never keeps a newer send's word out of reach.
 *  `through` is the highest id the pages covered; Infinity once a page came back short. */
export async function readJobs(
  pending: number[],
  page: (since: number) => Promise<RelayJob[]>,
): Promise<{ jobs: RelayJob[]; through: number }> {
  const jobs: RelayJob[] = [];
  let since = Math.max(0, (pending[0] ?? 1) - 1);
  for (let i = 0; i < JOBS_PAGES_MAX; i++) {
    const got = await page(since);
    jobs.push(...got);
    const last = got.length ? got[got.length - 1]!.id : since;
    if (got.length < JOBS_PAGE) return { jobs, through: Number.POSITIVE_INFINITY };
    const next = pending.find((id) => id > last);
    if (next === undefined) return { jobs, through: last };
    since = next - 1;
  }
  return { jobs, through: jobs.length ? jobs[jobs.length - 1]!.id : since };
}

/** The relay's page, as the server sends it; `events` are wire events, checked here. */
export interface RelayPage {
  events: unknown[];
  next: number;
  oldest: number | null;
  protocol?: number;
}

export function parseRelayPage(body: unknown): RelayPage | null {
  const b = body as Partial<RelayPage> | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.events) || typeof b.next !== "number") return null;
  return {
    events: b.events,
    next: b.next,
    oldest: typeof b.oldest === "number" ? b.oldest : null,
    protocol: b.protocol,
  };
}

/** The cursor to ask from next, and whether events were lost: the relay answers every
 *  event after the cursor it still holds, so when the oldest it holds (`oldest`, the first
 *  of the page) is not the one after the cursor, the ones between are gone (past its 7 days
 *  or 50 000 events). A full page then still comes back, and is a gap all the same. From 0
 *  there is no gap: everything held is everything there is to read. */
export function cursorAfter(kept: number, page: RelayPage): { cursor: number; gap: boolean } {
  const gap = kept > 0 && page.oldest != null && page.oldest > kept + 1;
  if (gap && !page.events.length) return { cursor: page.oldest! - 1, gap };
  return { cursor: page.next, gap };
}

/** spacesheep's limit on relay reads per key (its gui_relay rule: 240 in each 600 s
 *  window). The reader keeps under RELAY_BUDGET in any 600 s, so never near the 240th. */
export const RELAY_LIMIT = 240;
export const RELAY_WINDOW_MS = 600_000;
export const RELAY_BUDGET = 230;

/** How long to wait before the next relay read, given when the reads in the last window
 *  were made. Under a third of the budget spent (a quiet board's long polls are some 24 a
 *  window), none. Past that, the longer of two waits: one that grows with what is spent,
 *  from 0 to 1.6 steady intervals (1.6 × 600 s / RELAY_BUDGET, about 4.2 s) at the budget,
 *  and the reads left spread over the time until the oldest leaves the window. A steady
 *  stream then settles near 186 reads a window, one every ~3.2 s, each reading the batch
 *  that arrived meanwhile. At the budget, none until the oldest leaves. */
export function relayPaceMs(reads: readonly number[], now: number): number {
  let n = 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const t of reads)
    if (now - t < RELAY_WINDOW_MS) {
      n++;
      if (t < oldest) oldest = t;
    }
  const end = oldest + RELAY_WINDOW_MS;
  if (n >= RELAY_BUDGET) return Math.max(0, end - now);
  const free = RELAY_BUDGET / 3;
  if (n < free) return 0;
  const ramp = ((n - free) / (RELAY_BUDGET - free)) * 1.6 * (RELAY_WINDOW_MS / RELAY_BUDGET);
  const spread = (end - now) / (RELAY_BUDGET - n);
  return Math.max(0, Math.ceil(Math.max(ramp, spread)));
}

/** The reads of the budget history leaves alone: while a full page says more is waiting
 *  and fewer than RELAY_BUDGET less this are spent, the next page is read at once
 *  (RelayReaderOptions.backlog). The relay holds 50 000 events at most, 100 full pages, so a
 *  reader that starts with nothing spent reads all of it at once and has more than half the
 *  budget left for what comes after; one that starts from a third spent (readsFrom's seed)
 *  reads all of it too and is then paced by what is left. */
export const BACKLOG_RESERVE = 50;

/** relayPaceMs for a reader that is still reading history: no wait while the reserve holds. */
export function backlogPaceMs(reads: readonly number[], now: number): number {
  let n = 0;
  for (const t of reads) if (now - t < RELAY_WINDOW_MS) n++;
  return n < RELAY_BUDGET - BACKLOG_RESERVE ? 0 : relayPaceMs(reads, now);
}

/** The longest pause a Retry-After is followed for. */
export const RETRY_AFTER_MAX_MS = 15 * 60_000;

/** A Retry-After header (seconds, or an HTTP date) in milliseconds from `now`, or null. */
export function retryAfterMs(v: string | null, now = Date.now()): number | null {
  if (!v) return null;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** spacesheep asked to wait (429): the loop pauses as long as it said. */
class Limited extends Error {
  constructor(readonly pauseMs: number) {
    super("HTTP 429");
  }
}

/** The hub's room for this account was full (its own 429 `busy`): the read never reached
 *  spacesheep, so it is not counted, the state stays, and it is asked again after `pauseMs`. */
class HubBusy extends Error {
  constructor(readonly pauseMs: number) {
    super("hub: busy");
  }
}

/** The hub would not pass a relay page that large (`answer_too_large`): the next read asks
 *  for fewer events. */
class TooLarge extends Error {
  constructor() {
    super("hub: answer_too_large");
  }
}

/** The hub would not pass even one event alone: no smaller read can bring it. The reader
 *  never steps over it (the events after it are not its to judge, and one it stepped over
 *  would be lost for good): it is the hub failing, said as any failure of the hub's. */
class Unpassable extends Error {
  constructor() {
    super("hub: answer_too_large");
  }
}

/** How long a hub `busy` is waited out, whatever its Retry-After says. */
export const HUB_BUSY_MIN_MS = 250;
export const HUB_BUSY_MAX_MS = 5000;
/** How many reads in a row the hub may answer `busy` and be asked again at its own pace.
 *  One more is the hub failing like any other way: said (`offline`, "hub: busy") and waited
 *  out with a pause that grows, so a hub that is always busy is not asked every second. */
export const HUB_BUSY_RUN = 5;
/** How long the reader waits before it asks again for an event the hub would not pass even
 *  alone. Asking sooner brings nothing: the hub's cap is above any event the relay takes
 *  (docs/rfcs/08), so this is a hub or a relay at fault, and every ask is a read spacesheep
 *  counts. Three or four in ten minutes. */
export const HUB_UNPASSABLE_MS = 3 * 60_000;

/** A timer that does not keep a Node process alive; a page's timer is a number, with no unref. */
const unref = <T>(timer: T): T => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};

const realClock: RelayClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function startRelayReader(opts: RelayReaderOptions): RelayReader {
  const f = opts.doors;
  const clock = opts.clock ?? realClock;
  const { sink, keep } = opts;
  let cursor = cursorFrom(keep.read("cursor"), opts.origin, opts.email);
  let events = 0;
  let machines: string[] = [];
  let state: RelayStatus["state"] = "starting";
  const say = (next: RelayStatus["state"]): void => {
    if (state === next) return;
    state = next;
    opts.onState?.(next);
  };
  /** The first event the relay still held when a gap was found: the state says "gap" from
   *  then on, while this source runs, not only for the one poll that saw it. */
  let gapBefore: number | null = null;
  let lastAt: string | undefined;
  let lastError: string | undefined;
  let stopped = false;
  let pause = opts.retryMs ?? 2000;
  let inFlight: Promise<number> | null = null;
  let abort: AbortController | null = null;
  /** How many events a read asks for: RELAY_PAGE, fewer after the hub found a page too
   *  large, and no more again until the cursor is past the events that page would have held. */
  let limit = RELAY_PAGE;
  let smallUntil = 0;
  /** How many reads in a row the hub answered `busy` (HUB_BUSY_RUN). */
  let busyRun = 0;
  /** The hub had the first read asked again (its room was full, the page too large): it is
   *  still the first, and what it brings is still history. */
  let firstAgain = false;
  /** The first read is not over: the sink was told `setLoading(true)` and not yet false. */
  let loading = false;
  const loaded = (): void => {
    if (!loading) return;
    loading = false;
    sink.setLoading(false);
  };
  /** The last page came back full: more is waiting (RelayReaderOptions.backlog). */
  let more = false;
  /** When each relay read in the last window was made (relayPaceMs). */
  // Kept beside the cursor (READS_SAVE_MS and at stop), so a restart mid-stream goes on
  // from the same budget rather than an empty one. One reader per key: each Connect mints
  // its own key, so two apps never share this count (two readers on one key are not paced).
  let reads: number[] = readsFrom(keep.read("reads"), opts.origin, opts.email, clock.now(), !opts.fresh);
  let readsDirty = false;
  /** A keep that throws (a page's storage refusing a write) stops nothing: what was read is
   *  read, the timer that writes the read times goes on, and the write is tried again at
   *  the next change. False when it was not kept. */
  const write = (name: RelayKept, value: unknown): boolean => {
    try {
      keep.write(name, value);
      return true;
    } catch (e) {
      console.error("[relay] %s was not kept: %s", name, (e as Error)?.message ?? e);
      return false;
    }
  };
  const saveReads = (): void => {
    if (!readsDirty) return;
    const now = clock.now();
    reads = reads.filter((t) => now - t < RELAY_WINDOW_MS);
    if (write("reads", { origin: opts.origin, email: opts.email, reads })) readsDirty = false;
  };
  let readsTimer: unknown;
  const scheduleReads = (): void => {
    readsTimer = unref(
      clock.setTimeout(() => {
        saveReads();
        scheduleReads();
      }, READS_SAVE_MS),
    );
  };
  scheduleReads();
  /** A pause the loop is in (the pace, an error's, a 429's), cut short by stop(). */
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = clock.setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clock.clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  const revoked = (): void => {
    say("unauthorized");
    lastError = "the key no longer opens the relay (revoked on spacesheep?)";
    stopped = true;
    if (firstAgain) loaded();
    if (jobsTimer) clock.clearTimeout(jobsTimer);
    if (machinesTimer) clock.clearTimeout(machinesTimer);
    wake?.();
    abort?.abort();
    clock.clearTimeout(readsTimer);
    saveReads();
    opts.onUnauthorized?.();
  };

  const poll = async (waitS: number): Promise<number> => {
    abort = new AbortController();
    const at = clock.now();
    reads = reads.filter((t) => at - t < RELAY_WINDOW_MS);
    reads.push(at);
    readsDirty = true;
    const size = limit;
    const res = await f(`${RELAY_PATH}?since=${cursor}&limit=${size}&wait=${waitS}`, { signal: abort.signal });
    // Stopped while this poll was out (a send found the key revoked, a disconnect): its
    // answer changes nothing.
    if (stopped) return 0;
    const hub = opts.hub ? res.headers.get(HUB_HEADER) : null;
    if (hub === "busy") {
      // It never left the hub: not a read spacesheep counted.
      const i = reads.lastIndexOf(at);
      if (i >= 0) reads.splice(i, 1);
      // Busy time after time is the hub failing, said and waited out as any other failure.
      if (++busyRun > HUB_BUSY_RUN) throw new Error("hub: busy");
      const asked = retryAfterMs(res.headers.get("retry-after"), clock.now()) ?? 1000;
      throw new HubBusy(Math.min(HUB_BUSY_MAX_MS, Math.max(HUB_BUSY_MIN_MS, asked)));
    }
    busyRun = 0;
    if (hub === "answer_too_large") {
      if (size > 1) {
        limit = Math.max(1, Math.floor(size / 2));
        smallUntil = cursor + size;
        throw new TooLarge();
      }
      // One event alone is more than the hub passes: no smaller read can bring it, and the
      // cursor stays where it is. Offline, in the hub's own words, and asked for again
      // slowly. Should the relay let the event go meanwhile, the read that then comes
      // through finds the cursor behind what the relay holds and says the gap.
      throw new Unpassable();
    }
    // Any other answer of the hub's own (its 401 `not_connected` among them) is the hub
    // speaking, not spacesheep: an error to wait out, never a revoked key.
    if (hub) throw new Error(`hub: ${hub}`);
    if (res.status === 401 || res.status === 403) {
      revoked();
      return 0;
    }
    if (res.status === 429) {
      // Not unreachable: spacesheep's limit for this key. Its Retry-After, within bounds.
      const asked = retryAfterMs(res.headers.get("retry-after"), clock.now()) ?? 60_000;
      throw new Limited(Math.min(RETRY_AFTER_MAX_MS, Math.max(opts.retryMs ?? 2000, asked)));
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    // Stopped while the answer was read (doors that do not take the signal let it finish):
    // nothing of it is taken, and the cursor stays.
    if (stopped) return 0;
    const page = parseRelayPage(body);
    if (!page) throw new Error("not a relay page");
    const valid: ProtocolEvent[] = [];
    for (const e of page.events) if (!eventProblem(e)) valid.push(e as ProtocolEvent);
    let taken = 0;
    if (valid.length) taken = sink.ingest(valid);
    if (valid.length && opts.onEvents)
      opts.onEvents([...new Set(valid.map((e) => `${e.harness.name}:${e.session.id}`))]);
    events += taken;
    const c = cursorAfter(cursor, page);
    if (c.gap) gapBefore = page.oldest;
    if (gapBefore !== null) {
      say("gap");
      lastError = `the relay no longer holds events before ${gapBefore}; the board shows what it still has`;
    } else say("ok");
    if (c.cursor !== cursor) {
      cursor = c.cursor;
      write("cursor", { origin: opts.origin, email: opts.email, cursor });
    }
    loaded();
    lastAt = new Date(clock.now()).toISOString();
    if (state === "ok") lastError = undefined;
    pause = opts.retryMs ?? 2000;
    more = page.events.length >= size;
    // Past what was too large: the next may ask for more again.
    if (limit < RELAY_PAGE && cursor >= smallUntil) limit = Math.min(RELAY_PAGE, limit * 2);
    opts.onPage?.({ events: page.events.length, taken, cursor, more });
    return taken;
  };

  const machinesPoll = async (): Promise<void> => {
    try {
      const res = await f(`${RELAY_PATH}/machines`);
      if (!res.ok) return;
      const j = (await res.json()) as { machines?: Array<{ name?: unknown }>; rp_id?: unknown };
      machines = (j.machines ?? []).map((m) => String(m.name ?? "")).filter(Boolean);
      if (opts.onMachines && typeof j.rp_id === "string") opts.onMachines(j.machines ?? [], opts.origin, j.rp_id);
    } catch {
      /* the names are a nicety */
    }
  };

  // How the sends spacesheep carried are going: read while any is unsettled here.
  let jobsTimer: unknown;
  const jobsPoll = async (): Promise<void> => {
    const pending = opts.pendingJobs?.() ?? [];
    if (!pending.length) return;
    try {
      let serverNow: number | undefined;
      const r = await readJobs(pending, async (since) => {
        const res = await f(`${RELAY_PATH}/jobs?since=${since}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // spacesheep's clock, for how old its jobs are (state.applyRemoteJobs), not ours: the
        // answer's `now` (spacesheep ≥ the field), else its Date header.
        const date = Date.parse(res.headers.get("date") ?? "");
        if (Number.isFinite(date)) serverNow = date;
        const j = (await res.json()) as { jobs?: unknown; now?: unknown };
        if (typeof j.now === "number" && Number.isFinite(j.now) && j.now > 0) serverNow = j.now;
        if (!Array.isArray(j.jobs)) throw new Error("not a jobs page");
        return j.jobs as RelayJob[];
      });
      opts.onJobs?.(r.jobs, r.through, serverNow);
    } catch {
      /* next tick */
    }
  };
  // One read at a time; a kick while one is out reads again right after it.
  let jobsBusy = false;
  let jobsAgain = false;
  const runJobs = async (): Promise<void> => {
    if (jobsBusy) {
      jobsAgain = true;
      return;
    }
    jobsBusy = true;
    try {
      do {
        jobsAgain = false;
        await jobsPoll();
      } while (jobsAgain && !stopped);
    } finally {
      jobsBusy = false;
    }
    scheduleJobs();
  };
  const scheduleJobs = (): void => {
    if (stopped) return;
    if (jobsTimer) clock.clearTimeout(jobsTimer);
    const pace = opts.jobsCadence?.() ?? "fast";
    jobsTimer = unref(clock.setTimeout(() => void runJobs(), pace === "slow" ? JOBS_SLOW_MS : JOBS_FAST_MS));
  };
  const kickJobs = (): void => {
    if (stopped) return;
    if (jobsTimer) clock.clearTimeout(jobsTimer);
    void runJobs();
  };
  scheduleJobs();

  // The machine list, once a minute on its own clock: not metered, so it stays fresh while
  // the relay waits out a pace or a 429.
  let machinesTimer: unknown;
  const scheduleMachines = (): void => {
    if (stopped) return;
    machinesTimer = unref(
      clock.setTimeout(async () => {
        await machinesPoll();
        scheduleMachines();
      }, 60_000),
    );
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const pace = opts.backlog && more ? backlogPaceMs(reads, clock.now()) : relayPaceMs(reads, clock.now());
        if (pace > 0) await sleep(pace);
        if (stopped) break;
        // History is not waited for: after a full page the next is asked for with no wait, so
        // the page that ends it comes back at once.
        inFlight = poll(opts.backlog && more ? 0 : RELAY_WAIT_S);
        await inFlight;
        inFlight = null;
      } catch (e) {
        inFlight = null;
        if (stopped) break;
        if (e instanceof TooLarge) continue;
        if (e instanceof HubBusy) {
          await sleep(e.pauseMs);
          continue;
        }
        lastError = (e as Error).message;
        // A first read that was asked again and then failed is over, as one that failed at once.
        loaded();
        if (e instanceof Limited) {
          say("limited");
          await sleep(e.pauseMs);
          continue;
        }
        say("offline");
        if (e instanceof Unpassable) {
          await sleep(HUB_UNPASSABLE_MS);
          continue;
        }
        await sleep(pause);
        pause = Math.min(pause * 2, 60_000);
      }
    }
  };

  void machinesPoll();
  scheduleMachines();
  // The first page is history: the board shouldn't ring for it.
  loading = true;
  sink.setLoading(true);
  let firstPause = 0;
  const first = poll(0)
    .catch((e) => {
      if (e instanceof TooLarge) {
        firstAgain = true;
        return 0;
      }
      if (e instanceof HubBusy) {
        firstAgain = true;
        firstPause = e.pauseMs;
        return 0;
      }
      say(e instanceof Limited ? "limited" : "offline");
      if (e instanceof Limited) firstPause = e.pauseMs;
      lastError = (e as Error).message;
      return 0;
    })
    .finally(() => {
      if (!firstAgain) loaded();
    });
  void first.then(async () => {
    if (firstPause) await sleep(firstPause);
    if (!stopped) void loop();
  });

  return {
    stop() {
      clock.clearTimeout(readsTimer);
      saveReads();
      stopped = true;
      // A first read the hub had asked again never ended by itself.
      if (firstAgain) loaded();
      if (jobsTimer) clock.clearTimeout(jobsTimer);
      if (machinesTimer) clock.clearTimeout(machinesTimer);
      wake?.();
      abort?.abort();
    },
    status: () => ({ events, cursor, state, lastAt, lastError, machines }),
    tick: () => inFlight ?? poll(0),
    pollJobs: jobsPoll,
    pollMachines: machinesPoll,
    unauthorized: revoked,
    kickJobs,
  };
}

/** How often the reads of the last window are written down (and at stop). A process that
 *  dies between two writes loses at most this many seconds of reads: a few, under the 10
 *  between RELAY_BUDGET and RELAY_LIMIT. */
export const READS_SAVE_MS = 15_000;

/** The reads of the last window as a stopped reader wrote them down (`kept`: the value of
 *  `reads`), for this account; with nothing usable kept (none, another account, not that
 *  shape), a third of the budget taken as spent just now, since a reader before this one
 *  may have been busy. `seed` false: none taken as spent (a key made just now). */
export function readsFrom(kept: unknown, origin: string, email: string, now: number, seed = true): number[] {
  const none = () => (seed ? Array.from({ length: Math.floor(RELAY_BUDGET / 3) }, () => now) : []);
  if (!kept || typeof kept !== "object") return none();
  const v = kept as { origin?: unknown; email?: unknown; reads?: unknown };
  if (v.origin !== origin || v.email !== email || !Array.isArray(v.reads)) return none();
  return v.reads.filter((t): t is number => typeof t === "number" && t <= now && now - t < RELAY_WINDOW_MS);
}

/** The cursor as it was kept (the value of `cursor`), for this account; 0 with none. */
export function cursorFrom(kept: unknown, origin: string, email: string): number {
  if (!kept || typeof kept !== "object") return 0;
  const v = kept as { origin?: unknown; email?: unknown; cursor?: unknown };
  // Another account or origin: its cursor means nothing here.
  if (v.origin !== origin || v.email !== email) return 0;
  return typeof v.cursor === "number" && v.cursor >= 0 ? v.cursor : 0;
}
