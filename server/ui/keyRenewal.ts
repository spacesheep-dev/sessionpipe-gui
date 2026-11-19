// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. When the text this receiver keeps or takes in holds the board's
// current key (the UI key, config.ts), the receiver makes a new key (app.ts renewKey).
//
// Where it looks, and when:
//  - every batch as it arrives, from any source, before any of it is kept
//    (Store.onArrival), and every send it carries as it is queued (control's `control`
//    frames): a look through the strings of what is already in memory;
//  - once after each start, what it kept before: the session files
//    (`<stateDir>/events/<harness>/<id>.jsonl`) and the queues of sends
//    (`<stateDir>/control/queue/<machine>.json`), read as the search index reads them
//    (search/sources/prefilter.ts: reused 1 MB chunks, a byte search, nothing decoded),
//    a few MB at a time with a turn of the event loop between, so a large state folder
//    holds no request up.
//
// It looks for the key as it is now. Once a new key is made the text holds the old one,
// which matches nothing: a start after that finds nothing, so this runs on every start
// and never goes round. It logs nothing; a page whose key is refused asks for the board's
// link again (static.ts, components/KeyRefused.tsx).
import { closeSync, type Dirent, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { SECRET_MIN } from "../config.js";
import { Finder, readAppend } from "../search/sources/prefilter.js";

/** Bytes the start-up look reads before it gives the event loop a turn. */
export const SLICE_BYTES = 1 << 20;

/** Does any string in `v` (an event or a frame as it is: its text, its data, its field
 *  names) hold `needle`? Parsed JSON has no cycles; the walk keeps its own stack. */
export function holdsText(v: unknown, needle: string): boolean {
  if (!needle) return false;
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === "string") {
      if (x.includes(needle)) return true;
    } else if (Array.isArray(x)) {
      for (const y of x) stack.push(y);
    } else if (x && typeof x === "object") {
      for (const [k, y] of Object.entries(x)) {
        if (k.includes(needle)) return true;
        stack.push(y);
      }
    }
  }
  return false;
}

/** The files whose text the start-up look reads: every session file and every queue of
 *  sends. Not config.json (the key's own place), the pictures, the certificates, the
 *  search index (made from the same session files) nor the plugins' own storage. */
export function keptTextFiles(stateDir: string): string[] {
  const out: string[] = [];
  const list = (dir: string, ext: string, deep: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && deep) list(p, ext, false);
      else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
    }
  };
  list(path.join(stateDir, "events"), ".jsonl", true);
  list(path.join(stateDir, "control", "queue"), ".json", false);
  return out;
}

export interface LookOptions {
  signal?: AbortSignal;
  /** Bytes read between two turns of the event loop (SLICE_BYTES). */
  sliceBytes?: number;
}

/** Whether a kept file holds `needle` in one of its lines. Stops at the first one, or
 *  with false once `signal` aborts. A file that goes away while it is read is passed. */
export async function keptTextHolds(stateDir: string, needle: string, o: LookOptions = {}): Promise<boolean> {
  if (!needle || !existsSync(stateDir)) return false;
  const slice = o.sliceBytes ?? SLICE_BYTES;
  for (const file of keptTextFiles(stateDir)) {
    let from = 0;
    for (;;) {
      if (o.signal?.aborted) return false;
      // A Finder remembers its place by the reader's chunk count, which starts again with
      // each read: one per read.
      const finder = new Finder(needle);
      let hit = false;
      let next: number;
      try {
        next = readAppend(
          file,
          from,
          (buf, s, e, _at, gen) => {
            if (!hit && finder.has(buf, gen, s, e)) hit = true;
          },
          { maxBytes: slice },
        ).offset;
      } catch {
        break;
      }
      if (hit) return true;
      if (next <= from) {
        if (tailHolds(file, from, needle)) return true;
        break;
      }
      from = next;
      await turn();
    }
  }
  return false;
}

/** A last line with no newline after it (a write cut short) is not handed out as a line;
 *  it is read here, up to the size a line may be (LINE_MAX's 64 MB). */
function tailHolds(file: string, from: number, needle: string): boolean {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const n = size - from;
    if (n < needle.length || n > 64 << 20) return false;
    fd = openSync(file, "r");
    const buf = Buffer.allocUnsafe(n);
    const got = readSync(fd, buf, 0, n, from);
    return buf.subarray(0, got).indexOf(needle, 0, "latin1") >= 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface KeyRenewalDeps {
  stateDir: string;
  store: { onArrival(read: (events: readonly unknown[]) => void): () => void };
  /** Control's frames: a send's text rides on its `control` frame as it is queued. */
  control?: { subscribe(l: (m: { kind: string }) => void): () => void };
  /** The key as it is now. */
  key: () => string;
  /** Make a new key and apply it (app.ts). */
  renew: () => void;
  sliceBytes?: number;
  /** The first wait of a streak (FIRST_WAIT_MS); tests shorten it. */
  firstWaitMs?: number;
  /** The clock: a monotonic one (performance.now), so a wall clock set back changes nothing. */
  now?: () => number;
}

/** New keys the receiver makes itself back off. The first is made at once. A find within
 *  FIRST_WAIT_MS of the last one waits until that much has passed; each further one in the
 *  same streak waits twice as long as the one before, up to WINDOW_MS; WINDOW_MS with no
 *  new key ends the streak. A find that waits is kept: the new key is made when the wait
 *  ends, if the key found is still the key then. A new key made by hand (Connect, `key
 *  renew`) is never held back; it only drops the find that waits. Only a key of at least
 *  SECRET_MIN characters is looked for: a shorter one (the owner's choice in config.json)
 *  would be found in ordinary text. */
export const FIRST_WAIT_MS = 30_000;
export const WINDOW_MS = 10 * 60_000;

export interface KeyRenewal {
  /** The start-up look: true when it found the key (and a new one was made). */
  readonly looked: Promise<boolean>;
  close(): void;
}

/** Look for the key in what arrives from now on, and once in what was kept before. */
export function watchUiKey(d: KeyRenewalDeps): KeyRenewal {
  const stop = new AbortController();
  const firstWait = d.firstWaitMs ?? FIRST_WAIT_MS;
  const now = d.now ?? (() => performance.now());
  let last = Number.NEGATIVE_INFINITY;
  let wait = firstWait;
  let held: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;
  // Only the key that was looked for is replaced: one made meanwhile is not the one found.
  // `fresh`: the first of a streak (nothing for WINDOW_MS before the find); else the wait
  // for the next one doubles.
  const renew = (key: string, fresh: boolean): void => {
    if (stop.signal.aborted || d.key() !== key) return;
    wait = fresh ? firstWait : Math.min(wait * 2, WINDOW_MS);
    last = now();
    d.renew();
  };
  const found = (key: string): void => {
    if (stop.signal.aborted || d.key() !== key || key.length < SECRET_MIN) return;
    const t = now();
    // A quiet WINDOW_MS ends the streak: the first of the next is made at once.
    const fresh = t - last >= WINDOW_MS;
    const due = fresh ? t : last + wait;
    if (due <= t) {
      renew(key, fresh);
      return;
    }
    if (held) {
      held.key = key;
      return;
    }
    const timer = setTimeout(() => {
      const k = held?.key;
      held = null;
      if (k !== undefined) renew(k, false);
    }, due - t);
    timer.unref?.();
    held = { key, timer };
  };
  const offStore = d.store.onArrival((events) => {
    const key = d.key();
    if (holdsText(events, key)) found(key);
  });
  const offControl =
    d.control?.subscribe((m) => {
      if (m.kind !== "control") return;
      const key = d.key();
      if (holdsText(m, key)) found(key);
    }) ?? (() => {});
  const looked = (async () => {
    // After the start has finished what it does at once.
    await turn();
    const key = d.key();
    if (key.length < SECRET_MIN || stop.signal.aborted) return false;
    if (!(await keptTextHolds(d.stateDir, key, { signal: stop.signal, sliceBytes: d.sliceBytes }))) return false;
    found(key);
    return true;
  })().catch(() => false);
  return {
    looked,
    close() {
      stop.abort();
      if (held) clearTimeout(held.timer);
      held = null;
      offStore();
      offControl();
    },
  };
}
