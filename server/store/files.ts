// SPDX-License-Identifier: Apache-2.0
// Append-only JSONL per session under <stateDir>/events/<harness>/<session>.jsonl, one
// StoredEvent per line (`sessionFileName` for an id a file name cannot spell as it is). The index (store.ts) remembers each line's byte offset and
// length so the full event can be read back from disk on demand.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { StoredEvent } from "../../shared/api.js";

/** A file-name-safe id (the same rule as sessionpipe-core's safeId). */
export const safeName = (s: string): string =>
  String(s)
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 160);

/** The name (without `.jsonl`) a session's events are kept under: the id itself when a
 *  file name can spell it, which is every id a harness makes today. An id `safeName`
 *  changes (a `:`, which the protocol allows in a session id, or past 160 characters) would
 *  share its name with another id's (`run:1` and `run_1`), and then its file: each would
 *  read the other's lines at its own offsets, and forgetting one would delete both. Such
 *  an id gets its safe spelling and a hash of the id after a `~`, a character no plain
 *  name holds. */
export function sessionFileName(id: string): string {
  const plain = safeName(id);
  if (plain === id) return plain;
  return `${plain}~${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

export interface Line {
  event: StoredEvent;
  /** Byte offset of the line in its file. */
  offset: number;
  /** Byte length of the line, newline excluded. */
  bytes: number;
}

export interface ScannedFileInfo {
  harness: string;
  id: string;
  file: string;
  size: number;
  /** Valid lines seen so far. */
  lines: number;
  /** `arrivedAt` of the first valid line. */
  firstArrivedAt?: string;
}

export interface ScannedFile extends Omit<ScannedFileInfo, "lines" | "firstArrivedAt"> {
  lines: Line[];
}

/** Bytes read at a time while scanning; a line longer than this is joined from pieces. */
const CHUNK = 256 * 1024;

/** Calls `onLine(text, offset, bytes)` for every newline-terminated line of a file (and
 *  a last line without one), reading CHUNK bytes at a time into one reused buffer.
 *  Returns the file size. Empty lines are skipped but still take their byte. */
export function readLines(file: string, onLine: (text: string, offset: number, bytes: number) => void): number {
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    let pending: Buffer[] = [];
    let pos = 0;
    let lineStart = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK, pos);
      if (n <= 0) break;
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(10, from);
        if (nl < 0 || nl >= n) break;
        let text: string;
        if (pending.length) {
          pending.push(chunk.subarray(from, nl));
          text = Buffer.concat(pending).toString("utf8");
          pending = [];
        } else text = chunk.toString("utf8", from, nl);
        const bytes = pos + nl - lineStart;
        if (bytes > 0) onLine(text, lineStart, bytes);
        lineStart = pos + nl + 1;
        from = nl + 1;
      }
      // The tail of this chunk belongs to a line that continues; the buffer is reused, so copy.
      if (from < n) pending.push(Buffer.from(chunk.subarray(from, n)));
      pos += n;
    }
    if (pending.length) onLine(Buffer.concat(pending).toString("utf8"), lineStart, pos - lineStart);
    return pos;
  } finally {
    closeSync(fd);
  }
}

export class EventFiles {
  readonly root: string;
  constructor(stateDir: string) {
    this.root = path.join(stateDir, "events");
  }

  file(harness: string, id: string): string {
    return path.join(this.root, safeName(harness), `${sessionFileName(id)}.jsonl`);
  }

  /** Every session file (directory order) with what its lines hold, handed over one
   *  line at a time as the file is read in CHUNK-sized pieces, so no file is ever whole
   *  in memory: the store keeps the slim copy and lets the full line go. A line that is
   *  not JSON is skipped; its bytes still count toward the offsets after it. The
   *  file's harness and id come from its first valid line (the name on disk otherwise).
   *  A file an older version kept under another name for its id (`run_1.jsonl` for
   *  `run:1`, before `sessionFileName`) is moved to its own name once read, so the id
   *  whose plain name that was gets a file of its own. */
  scanEach(visit: (file: ScannedFileInfo, line: Line) => void): ScannedFileInfo[] {
    const out: ScannedFileInfo[] = [];
    if (!existsSync(this.root)) return out;
    for (const h of readdirSync(this.root)) {
      const dir = path.join(this.root, h);
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const n of names) {
        const file = path.join(dir, n);
        const info: ScannedFileInfo = { harness: h, id: n.slice(0, -6), file, size: 0, lines: 0 };
        try {
          info.size = readLines(file, (text, offset, bytes) => {
            let event: StoredEvent;
            try {
              event = JSON.parse(text) as StoredEvent;
            } catch {
              return;
            }
            if (!event || typeof event !== "object" || !event.session || typeof event.session.id !== "string") return;
            if (info.lines === 0) {
              info.harness = event.harness.name;
              info.id = event.session.id;
              info.firstArrivedAt = event.arrivedAt;
            }
            info.lines++;
            visit(info, { event, offset, bytes });
          });
        } catch {
          continue;
        }
        if (info.lines > 0) {
          const own = this.file(info.harness, info.id);
          if (own !== file && path.dirname(own) === dir && !existsSync(own)) {
            try {
              renameSync(file, own);
              info.file = own;
            } catch {
              // Left where it is: read as before, and moved on a later start.
            }
          }
        }
        out.push(info);
      }
    }
    return out;
  }

  /** Every session file with all its lines in memory (tests and small stores); the
   *  store boots with `scanEach` instead. */
  scan(): ScannedFile[] {
    // By the file's own info, which keeps its path current when an old name is moved.
    const files = new Map<ScannedFileInfo, ScannedFile>();
    const infos = this.scanEach((f, line) => {
      let sf = files.get(f);
      if (!sf) {
        sf = { harness: f.harness, id: f.id, file: f.file, size: 0, lines: [] };
        files.set(f, sf);
      }
      sf.lines.push(line);
    });
    return infos.map((f) => {
      const sf = files.get(f) ?? { harness: f.harness, id: f.id, file: f.file, size: 0, lines: [] };
      sf.file = f.file;
      sf.harness = f.harness;
      sf.id = f.id;
      sf.size = f.size;
      return sf;
    });
  }

  /** Append events to a session's file; returns each line's offset and length. */
  append(harness: string, id: string, events: StoredEvent[], size: number): { lines: Line[]; size: number } {
    const file = this.file(harness, id);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lines: Line[] = [];
    const parts: Buffer[] = [];
    let pos = size;
    for (const event of events) {
      const b = Buffer.from(`${JSON.stringify(event)}\n`);
      lines.push({ event, offset: pos, bytes: b.length - 1 });
      parts.push(b);
      pos += b.length;
    }
    appendFileSync(file, Buffer.concat(parts), { mode: 0o600 });
    return { lines, size: pos };
  }

  /** Read full events back by offset. A line that cannot be read yields undefined. */
  readAt(harness: string, id: string, at: { offset: number; bytes: number }[]): (StoredEvent | undefined)[] {
    const file = this.file(harness, id);
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch {
      return at.map(() => undefined);
    }
    try {
      return at.map(({ offset, bytes }) => {
        const buf = Buffer.alloc(bytes);
        const n = readSync(fd, buf, 0, bytes, offset);
        try {
          return JSON.parse(buf.toString("utf8", 0, n)) as StoredEvent;
        } catch {
          return undefined;
        }
      });
    } finally {
      closeSync(fd);
    }
  }

  remove(harness: string, id: string): void {
    rmSync(this.file(harness, id), { force: true });
  }

  sizeOf(harness: string, id: string): number {
    try {
      return statSync(this.file(harness, id)).size;
    } catch {
      return 0;
    }
  }
}
