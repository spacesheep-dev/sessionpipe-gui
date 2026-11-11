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
  /** The lowest spacesheep job id still unsettled here, or null: while there is one, the
   *  jobs door is read every few seconds and its word handed to `onJobs`. */
  pendingJobsFrom?: () => number | null;
  onJobs?: (
    jobs: Array<{ id: number; status: string; note: string | null; done_at: number | null; created_at: number }>,
  ) => void;
}

export interface SpacesheepSource {
  stop(): void;
  status(): SpacesheepSourceStatus;
  /** One poll now, with no wait (tests): how many events were taken. */
  tick(): Promise<number>;
  /** One read of the jobs door now (tests). */
  pollJobs(): Promise<void>;
  /** One read of the machines door now (tests). */
  pollMachines(): Promise<void>;
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

/** The cursor to ask from: the one kept, unless the relay no longer holds its past
 *  (`oldest` is above it), in which case the gap is noted and the oldest kept is next. */
export function cursorAfter(kept: number, page: RelayPage): { cursor: number; gap: boolean } {
  if (page.oldest != null && page.oldest > kept + 1 && kept > 0 && !page.events.length)
    return { cursor: page.oldest - 1, gap: true };
  return { cursor: page.next, gap: false };
}

export function startSpacesheepSource(store: Store, opts: SpacesheepSourceOptions): SpacesheepSource {
  const f = opts.fetch ?? fetch;
  const cursorFile = path.join(store.dir, "spacesheep-cursor.json");
  let cursor = readCursor(cursorFile, opts.origin, opts.email);
  let events = 0;
  let machines: string[] = [];
  let state: SpacesheepSourceStatus["state"] = "starting";
  let lastAt: string | undefined;
  let lastError: string | undefined;
  let stopped = false;
  let pause = opts.retryMs ?? 2000;
  let inFlight: Promise<number> | null = null;
  let abort: AbortController | null = null;

  const poll = async (waitS: number): Promise<number> => {
    abort = new AbortController();
    const url = `${opts.origin}${RELAY_PATH}?since=${cursor}&limit=${RELAY_PAGE}&wait=${waitS}`;
    const res = await f(url, {
      headers: { authorization: `Bearer ${opts.key}`, accept: "application/json" },
      signal: abort.signal,
    });
    if (res.status === 401 || res.status === 403) {
      state = "unauthorized";
      lastError = "the key no longer opens the relay (revoked on spacesheep?)";
      stopped = true;
      return 0;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = parseRelayPage(await res.json());
    if (!page) throw new Error("not a relay page");
    const valid: ProtocolEvent[] = [];
    for (const e of page.events) if (!eventProblem(e)) valid.push(e as ProtocolEvent);
    let taken = 0;
    if (valid.length) taken = store.ingest(valid, "spacesheep").accepted;
    events += taken;
    const c = cursorAfter(cursor, page);
    if (c.gap) {
      state = "gap";
      lastError = `the relay no longer holds events before ${page.oldest}; the board shows what it still has`;
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
    const from = opts.pendingJobsFrom?.();
    if (from === null || from === undefined) return;
    try {
      const res = await f(`${opts.origin}${RELAY_PATH}/jobs?since=${Math.max(0, from - 1)}`, {
        headers: { authorization: `Bearer ${opts.key}`, accept: "application/json" },
      });
      if (!res.ok) return;
      const j = (await res.json()) as {
        jobs?: Array<{ id: number; status: string; note: string | null; done_at: number | null; created_at: number }>;
      };
      if (j.jobs?.length) opts.onJobs?.(j.jobs);
    } catch {
      /* next tick */
    }
  };
  const scheduleJobs = (): void => {
    if (stopped) return;
    jobsTimer = setTimeout(async () => {
      await jobsPoll();
      scheduleJobs();
    }, 3000);
    jobsTimer.unref();
  };
  scheduleJobs();

  const loop = async (): Promise<void> => {
    let sinceMachines = 0;
    while (!stopped) {
      try {
        if (Date.now() - sinceMachines > 60_000) {
          sinceMachines = Date.now();
          await machinesPoll();
        }
        inFlight = poll(RELAY_WAIT_S);
        await inFlight;
        inFlight = null;
      } catch (e) {
        inFlight = null;
        if (stopped) break;
        state = "offline";
        lastError = (e as Error).message;
        await new Promise((r) => setTimeout(r, pause));
        pause = Math.min(pause * 2, 60_000);
      }
    }
  };

  // The first page is history: the board shouldn't ring for it.
  store.setLoading(true);
  const first = poll(0)
    .catch((e) => {
      state = "offline";
      lastError = (e as Error).message;
      return 0;
    })
    .finally(() => store.setLoading(false));
  void first.then(() => {
    if (!stopped) void loop();
  });

  return {
    stop() {
      stopped = true;
      if (jobsTimer) clearTimeout(jobsTimer);
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
