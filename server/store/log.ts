// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Where the store keeps full events and reads them back from. The
// index (store/core.ts) remembers each event's place as `{ offset, bytes }` and asks for
// it again by that; what `offset` means is the log's own business. The server's log is
// the JSONL files (store/files.ts EventFiles: a byte offset in the session's file);
// MemoryLog keeps the events themselves (an index in the session's list), for a store
// with no disk under it. `bytes` is the event's line as UTF-8, newline excluded, in both:
// the store adds them up as its storage figure.
import type { StoredEvent } from "../../shared/api.js";

export interface LogLine {
  event: StoredEvent;
  offset: number;
  bytes: number;
}

export interface LogFileInfo {
  harness: string;
  id: string;
  /** Everything kept for the session: its lines and a newline after each. */
  size: number;
  /** Valid lines. */
  lines: number;
  /** `arrivedAt` of the first valid line. */
  firstArrivedAt?: string;
}

export interface EventLog {
  /** Every kept event, one line at a time, at boot; then what each session holds. */
  scanEach(visit: (file: LogFileInfo, line: LogLine) => void): LogFileInfo[];
  /** Append to a session; `size` is the session's size before, and the answer its size after. */
  append(harness: string, id: string, events: StoredEvent[], size: number): { lines: LogLine[]; size: number };
  /** Full events back by the places `append` and `scanEach` gave; undefined where one cannot be read. */
  readAt(harness: string, id: string, at: { offset: number; bytes: number }[]): (StoredEvent | undefined)[];
  /** Forget a session's events. */
  remove(harness: string, id: string): void;
}

/** UTF-8 length of a string: what Buffer.byteLength gives, without Buffer. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** Full events in memory, per session, in the order they came: a session's `offset` is
 *  the event's place in its list. */
export class MemoryLog implements EventLog {
  private readonly sessions = new Map<string, StoredEvent[]>();

  private list(harness: string, id: string): StoredEvent[] {
    const key = `${harness}\u0000${id}`;
    let list = this.sessions.get(key);
    if (!list) {
      list = [];
      this.sessions.set(key, list);
    }
    return list;
  }

  /** Events kept from an earlier run, in the order they were appended, before the store boots. */
  seed(events: Iterable<StoredEvent>): void {
    for (const e of events) this.list(e.harness.name, e.session.id).push(e);
  }

  scanEach(visit: (file: LogFileInfo, line: LogLine) => void): LogFileInfo[] {
    const out: LogFileInfo[] = [];
    for (const list of this.sessions.values()) {
      const first = list[0];
      if (!first) continue;
      const info: LogFileInfo = {
        harness: first.harness.name,
        id: first.session.id,
        size: 0,
        lines: 0,
        firstArrivedAt: first.arrivedAt,
      };
      list.forEach((event, offset) => {
        const bytes = utf8Bytes(JSON.stringify(event));
        info.size += bytes + 1;
        info.lines++;
        visit(info, { event, offset, bytes });
      });
      out.push(info);
    }
    return out;
  }

  append(harness: string, id: string, events: StoredEvent[], size: number): { lines: LogLine[]; size: number } {
    const list = this.list(harness, id);
    const lines: LogLine[] = [];
    let total = size;
    for (const event of events) {
      const bytes = utf8Bytes(JSON.stringify(event));
      lines.push({ event, offset: list.length, bytes });
      list.push(event);
      total += bytes + 1;
    }
    return { lines, size: total };
  }

  readAt(harness: string, id: string, at: { offset: number; bytes: number }[]): (StoredEvent | undefined)[] {
    const list = this.sessions.get(`${harness}\u0000${id}`);
    return at.map(({ offset }) => list?.[offset]);
  }

  remove(harness: string, id: string): void {
    this.sessions.delete(`${harness}\u0000${id}`);
  }
}
