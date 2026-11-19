// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. A spacesheep account as a source (docs/rfcs/08): the relay's
// reader (sources/relay.ts) as this receiver runs it. It asks spacesheep itself with the
// account's key, feeds the events through the same store ingest the receiver route uses,
// and keeps the cursor and the read times in two files beside the outbox offsets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SpacesheepSourceStatus } from "../../shared/api.js";
import type { Store } from "../store/store.js";
import { type RelayJob, type RelayKept, type RelayReader, readsFrom, startRelayReader } from "./relay.js";

export * from "./relay.js";

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

export interface SpacesheepSource extends Omit<RelayReader, "status"> {
  status(): SpacesheepSourceStatus;
}

export function startSpacesheepSource(store: Store, opts: SpacesheepSourceOptions): SpacesheepSource {
  const f = opts.fetch ?? fetch;
  const files: Record<RelayKept, string> = {
    cursor: path.join(store.dir, "spacesheep-cursor.json"),
    reads: path.join(store.dir, "spacesheep-reads.json"),
  };
  const reader = startRelayReader({
    origin: opts.origin,
    email: opts.email,
    doors: (door, init) =>
      f(`${opts.origin}${door}`, {
        headers: { authorization: `Bearer ${opts.key}`, accept: "application/json" },
        ...(init?.signal ? { signal: init.signal } : {}),
      }),
    keep: { read: (name) => readKept(files[name]), write: (name, value) => writeKept(name, files[name], value) },
    sink: {
      ingest: (events) => store.ingest(events, "spacesheep").accepted,
      setLoading: (on) => store.setLoading(on),
    },
    retryMs: opts.retryMs,
    onMachines: opts.onMachines,
    pendingJobs: opts.pendingJobs,
    onJobs: opts.onJobs,
    jobsCadence: opts.jobsCadence,
    onUnauthorized: opts.onUnauthorized,
    onEvents: opts.onEvents,
  });
  return {
    ...reader,
    status: () => ({
      origin: opts.origin,
      email: opts.email,
      connectedAt: opts.connectedAt,
      ...reader.status(),
    }),
  };
}

/** The reads of the last window as a stopped source wrote them down, for this account;
 *  with nothing usable on file (none, another account, unreadable), a third of the budget
 *  taken as spent just now (relay.ts readsFrom). */
export function loadReads(file: string, origin: string, email: string, now: number): number[] {
  return readsFrom(readKept(file), origin, email, now);
}

/** A kept value as its file holds it; undefined with no file, or one that is not JSON. */
function readKept(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function writeKept(name: RelayKept, file: string, v: unknown): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(v)}\n`, { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[spacesheep] ${name}: ${(e as Error).message}\n`);
  }
}
