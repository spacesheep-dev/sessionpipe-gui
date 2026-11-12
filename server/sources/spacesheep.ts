// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. A spacesheep account as a source (docs/rfcs/08): the relay at
// `${origin}/api/sessionpipe/v1/relay` hands this GUI the account's accepted wire events
// after a cursor, long-polling when there are none, and this feeds them through the same
// store ingest the receiver route uses. The cursor lives beside the outbox offsets; the
// store's dedup resolves any overlap with a machine that also posts here directly.
//
// One loop, never two: a poll that waits up to 25 s on the server, then the next at
// once; on an error, a pause that grows to a minute. A 401 means the key was revoked on
// spacesheep (Settings → API keys there): the loop stops and the status says so.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProtocolEvent, SpacesheepSourceStatus } from "../../shared/api.js";
import { eventProblem } from "../receiver/validate.js";
import type { Store } from "../store/store.js";

export const RELAY_PATH = "/api/sessionpipe/v1/relay";
export const RELAY_WAIT_S = 25;
export const RELAY_PAGE = 500;

export interface SpacesheepSourceOptions {
  origin: string;
  key: string;
  email: string;
  connectedAt: string;
  fetch?: typeof fetch;
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
}

/** The jobs door's pace: while a send was just made, is taken, or its computer is online. */
export const JOBS_FAST_MS = 3000;
/** ...and while every send waits for a computer the machine list shows offline. */
export const JOBS_SLOW_MS = 45_000;

export interface SpacesheepSource {
  stop(): void;
  status(): SpacesheepSourceStatus;
  /** One poll now, with no wait (tests): how many events were taken. */
  tick(): Promise<number>;
  /** One read of the jobs door now (tests). */
  pollJobs(): Promise<void>;
  /** One read of the machines door now (tests). */
  pollMachines(): Promise<void>;
  /** spacesheep refused the key elsewhere (a send's 401): the source stops as its own poll
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

export function startSpacesheepSource(store: Store, opts: SpacesheepSourceOptions): SpacesheepSource {
  const f = opts.fetch ?? fetch;
  const cursorFile = path.join(store.dir, "spacesheep-cursor.json");
  let cursor = readCursor(cursorFile, opts.origin, opts.email);
  let events = 0;
  let machines: string[] = [];
  let state: SpacesheepSourceStatus["state"] = "starting";
  /** The first event the relay still held when a gap was found: the state says "gap" from
   *  then on, while this source runs, not only for the one poll that saw it. */
  let gapBefore: number | null = null;
  let lastAt: string | undefined;
  let lastError: string | undefined;
  let stopped = false;
  let pause = opts.retryMs ?? 2000;
  let inFlight: Promise<number> | null = null;
  let abort: AbortController | null = null;
  /** When each relay read in the last window was made (relayPaceMs). */
  let reads: number[] = [];
  /** A pause the loop is in (the pace, an error's, a 429's), cut short by stop(). */
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  const revoked = (): void => {
    state = "unauthorized";
    lastError = "the key no longer opens the relay (revoked on spacesheep?)";
    stopped = true;
    if (jobsTimer) clearTimeout(jobsTimer);
    if (machinesTimer) clearTimeout(machinesTimer);
    wake?.();
    abort?.abort();
    opts.onUnauthorized?.();
  };

  const poll = async (waitS: number): Promise<number> => {
    abort = new AbortController();
    const at = Date.now();
    reads = reads.filter((t) => at - t < RELAY_WINDOW_MS);
    reads.push(at);
    const url = `${opts.origin}${RELAY_PATH}?since=${cursor}&limit=${RELAY_PAGE}&wait=${waitS}`;
    const res = await f(url, {
      headers: { authorization: `Bearer ${opts.key}`, accept: "application/json" },
      signal: abort.signal,
    });
    // Stopped while this poll was out (a send found the key revoked, a disconnect): its
    // answer changes nothing.
    if (stopped) return 0;
    if (res.status === 401 || res.status === 403) {
      revoked();
      return 0;
    }
    if (res.status === 429) {
      // Not unreachable: spacesheep's limit for this key. Its Retry-After, within bounds.
      const asked = retryAfterMs(res.headers.get("retry-after")) ?? 60_000;
      throw new Limited(Math.min(RETRY_AFTER_MAX_MS, Math.max(opts.retryMs ?? 2000, asked)));
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = parseRelayPage(await res.json());
    if (!page) throw new Error("not a relay page");
    const valid: ProtocolEvent[] = [];
    for (const e of page.events) if (!eventProblem(e)) valid.push(e as ProtocolEvent);
    let taken = 0;
    if (valid.length) taken = store.ingest(valid, "spacesheep").accepted;
    if (valid.length && opts.onEvents)
      opts.onEvents([...new Set(valid.map((e) => `${e.harness.name}:${e.session.id}`))]);
    events += taken;
    const c = cursorAfter(cursor, page);
    if (c.gap) gapBefore = page.oldest;
    if (gapBefore !== null) {
      state = "gap";
      lastError = `the relay no longer holds events before ${gapBefore}; the board shows what it still has`;
    } else state = "ok";
    if (c.cursor !== cursor) {
      cursor = c.cursor;
      writeCursor(cursorFile, { origin: opts.origin, email: opts.email, cursor });
    }
    lastAt = new Date().toISOString();
    if (state === "ok") lastError = undefined;
    pause = opts.retryMs ?? 2000;
    return taken;
  };

  const machinesPoll = async (): Promise<void> => {
    try {
      const res = await f(`${opts.origin}${RELAY_PATH}/machines`, {
        headers: { authorization: `Bearer ${opts.key}`, accept: "application/json" },
      });
      if (!res.ok) return;
      const j = (await res.json()) as { machines?: Array<{ name?: unknown }>; rp_id?: unknown };
      machines = (j.machines ?? []).map((m) => String(m.name ?? "")).filter(Boolean);
      if (opts.onMachines && typeof j.rp_id === "string") opts.onMachines(j.machines ?? [], opts.origin, j.rp_id);
    } catch {
      /* the names are a nicety */
    }
  };

  // How the sends spacesheep carried are going: read while any is unsettled here.
  let jobsTimer: NodeJS.Timeout | undefined;
  const jobsPoll = async (): Promise<void> => {
    const pending = opts.pendingJobs?.() ?? [];
    if (!pending.length) return;
    try {
      let serverNow: number | undefined;
      const r = await readJobs(pending, async (since) => {
        const res = await f(`${opts.origin}${RELAY_PATH}/jobs?since=${since}`, {
          headers: { authorization: `Bearer ${opts.key}`, accept: "application/json" },
        });
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
    if (jobsTimer) clearTimeout(jobsTimer);
    const pace = opts.jobsCadence?.() ?? "fast";
    jobsTimer = setTimeout(() => void runJobs(), pace === "slow" ? JOBS_SLOW_MS : JOBS_FAST_MS);
    jobsTimer.unref();
  };
  const kickJobs = (): void => {
    if (stopped) return;
    if (jobsTimer) clearTimeout(jobsTimer);
    void runJobs();
  };
  scheduleJobs();

  // The machine list, once a minute on its own clock: not metered, so it stays fresh while
  // the relay waits out a pace or a 429.
  let machinesTimer: NodeJS.Timeout | undefined;
  const scheduleMachines = (): void => {
    if (stopped) return;
    machinesTimer = setTimeout(async () => {
      await machinesPoll();
      scheduleMachines();
    }, 60_000);
    machinesTimer.unref();
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const pace = relayPaceMs(reads, Date.now());
        if (pace > 0) await sleep(pace);
        if (stopped) break;
        inFlight = poll(RELAY_WAIT_S);
        await inFlight;
        inFlight = null;
      } catch (e) {
        inFlight = null;
        if (stopped) break;
        lastError = (e as Error).message;
        if (e instanceof Limited) {
          state = "limited";
          await sleep(e.pauseMs);
          continue;
        }
        state = "offline";
        await sleep(pause);
        pause = Math.min(pause * 2, 60_000);
      }
    }
  };

  void machinesPoll();
  scheduleMachines();
  // The first page is history: the board shouldn't ring for it.
  store.setLoading(true);
  let firstPause = 0;
  const first = poll(0)
    .catch((e) => {
      state = e instanceof Limited ? "limited" : "offline";
      if (e instanceof Limited) firstPause = e.pauseMs;
      lastError = (e as Error).message;
      return 0;
    })
    .finally(() => store.setLoading(false));
  void first.then(async () => {
    if (firstPause) await sleep(firstPause);
    if (!stopped) void loop();
  });

  return {
    stop() {
      stopped = true;
      if (jobsTimer) clearTimeout(jobsTimer);
      if (machinesTimer) clearTimeout(machinesTimer);
      wake?.();
      abort?.abort();
    },
    status: () => ({
      origin: opts.origin,
      email: opts.email,
      connectedAt: opts.connectedAt,
      events,
      cursor,
      state,
      lastAt,
      lastError,
      machines,
    }),
    tick: () => inFlight ?? poll(0),
    pollJobs: jobsPoll,
    pollMachines: machinesPoll,
    unauthorized: revoked,
    kickJobs,
  };
}

function readCursor(file: string, origin: string, email: string): number {
  if (!existsSync(file)) return 0;
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { origin?: unknown; email?: unknown; cursor?: unknown };
    // Another account or origin: its cursor means nothing here.
    if (v.origin !== origin || v.email !== email) return 0;
    return typeof v.cursor === "number" && v.cursor >= 0 ? v.cursor : 0;
  } catch {
    return 0;
  }
}

function writeCursor(file: string, v: { origin: string; email: string; cursor: number }): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(v)}\n`, { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[spacesheep] cursor: ${(e as Error).message}\n`);
  }
}
