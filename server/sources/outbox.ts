// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Tails this machine's sessionpipe outbox the way
// `sessionpipe tail` does: every 500 ms, `Outbox.read` from the last offset of each
// session file. Zero config on the machine that runs the agents; the store's dedup
// resolves any overlap with a sink that also posts here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Outbox, stateDir as sessionpipeStateDir } from "sessionpipe-core";
import type { ProtocolEvent } from "../../shared/api.js";
import { eventProblem } from "../receiver/validate.js";
import type { Store } from "../store/store.js";

export interface OutboxSourceOptions {
  /** The sessionpipe state dir (`~/.local/state/sessionpipe`), or its `outbox` folder.
   *  Default: sessionpipe-core's own state dir. */
  path?: string;
  intervalMs?: number;
}

export interface OutboxStatus {
  /** The outbox folder being read. */
  path: string;
  sessions: number;
  enabled: true;
  /** Events handed to the store since start. */
  events: number;
  lastTickAt?: string;
}

export interface OutboxSource {
  stop(): void;
  status(): OutboxStatus;
  /** Read whatever is new right now (tests). */
  tick(): void;
}

/** `path` may name the state dir or the outbox folder itself; Outbox wants the state dir. */
export function resolveOutboxRoot(p?: string): string {
  if (!p) return sessionpipeStateDir();
  const abs = path.resolve(p);
  if (existsSync(path.join(abs, "outbox"))) return abs;
  if (path.basename(abs) === "outbox") return path.dirname(abs);
  return abs;
}

export function startOutboxSource(store: Store, opts: OutboxSourceOptions = {}): OutboxSource {
  const root = resolveOutboxRoot(opts.path);
  const outbox = new Outbox(root);
  const offsetsFile = path.join(store.dir, "outbox-offsets.json");
  const offsets = readOffsets(offsetsFile);
  let dirty = false;
  let events = 0;
  let sessions = 0;
  let lastTickAt: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  /** Session files that could not be read, and the error code each last failed with:
   *  logged once per file and code, not on every tick. */
  const unreadable = new Map<string, string>();

  const tick = (): void => {
    const refs = outbox.sessions();
    sessions = refs.length;
    const seen = new Set(refs.map((r) => `${r.harness}/${r.session}`));
    for (const k of unreadable.keys()) if (!seen.has(k)) unreadable.delete(k);
    for (const ref of refs) {
      const k = `${ref.harness}/${ref.session}`;
      let from = offsets[k] ?? 0;
      // Drain the file: on first run that is the whole history, instantly.
      for (;;) {
        let read: ReturnType<Outbox["read"]>;
        try {
          read = outbox.read(ref, from, 200);
        } catch (e) {
          // One file we can't open or read (permissions, a folder named *.jsonl) skips
          // that file for this tick, not the whole outbox; its offset stays. A throw
          // without an fs error code is a bug and still propagates.
          const code = (e as NodeJS.ErrnoException | undefined)?.code;
          if (typeof code !== "string") throw e;
          if (unreadable.get(k) !== code) {
            unreadable.set(k, code);
            process.stderr.write(`[outbox] can't read ${k}: ${(e as Error).message}; skipped, its offset stays\n`);
          }
          break;
        }
        unreadable.delete(k);
        const { events: batch, offset } = read;
        if (offset !== from) {
          offsets[k] = offset;
          dirty = true;
        }
        from = offset;
        if (!batch.length) break;
        const valid: ProtocolEvent[] = [];
        for (const e of batch) if (!eventProblem(e)) valid.push(e as unknown as ProtocolEvent);
        if (valid.length) {
          const r = store.ingest(valid, "outbox");
          events += r.accepted;
        }
        if (batch.length < 200) break;
      }
    }
    lastTickAt = new Date().toISOString();
    if (dirty) {
      dirty = false;
      writeOffsets(offsetsFile, offsets);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      try {
        tick();
      } catch (e) {
        process.stderr.write(`[outbox] ${(e as Error).message}\n`);
      }
      schedule();
    }, opts.intervalMs ?? 500);
    timer.unref();
  };

  // The first drain is history, not live traffic.
  store.setLoading(true);
  try {
    tick();
  } finally {
    store.setLoading(false);
  }
  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (dirty) writeOffsets(offsetsFile, offsets);
    },
    status: () => ({ path: path.join(root, "outbox"), sessions, enabled: true, events, lastTickAt }),
    tick,
  };
}

function readOffsets(file: string): Record<string, number> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v)) if (typeof n === "number" && n >= 0) out[k] = n;
    return out;
  } catch {
    return {};
  }
}

function writeOffsets(file: string, offsets: Record<string, number>): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(offsets)}\n`, { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[outbox] offsets: ${(e as Error).message}\n`);
  }
}
