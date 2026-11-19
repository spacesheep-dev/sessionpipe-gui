// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The event log of a page that carries its own board (server/store/log.ts
// EventLog). The store's index keeps a copy of every event with its big strings cut to a
// preview (store/slim.ts), and asks the log for the whole event when a session's page is
// read. On a spacesheep account an event is a kilobyte or so and few are ever cut, so
// keeping every event a second time (as MemoryLog does, for a store with a disk's worth
// of tier 3 behind it) would double what the page holds for nothing. This log keeps the
// full line only of an event the index did cut; for every other one it answers nothing,
// and the store hands out its own copy, which is the whole event. The store must keep its
// previews whole for that (`keepDays: 0`): the backend opens it so.
import type { StoredEvent } from "@shared/api";
import type { EventLog, LogFileInfo, LogLine } from "../../../server/store/log";
import { utf8Bytes } from "../../../server/store/log";
import { PREVIEW_CHARS, slimEvent } from "../../../server/store/slim";

const keyOf = (harness: string, id: string): string => `${harness}\u0000${id}`;

export class PageLog implements EventLog {
  /** The events kept from an earlier launch: handed to the store's boot once, then let go. */
  private seeded: StoredEvent[] | null;
  /** Per session: how many lines it has, and the lines kept whole by their place. */
  private readonly sessions = new Map<string, { n: number; long: Map<number, string> }>();

  constructor(seed: StoredEvent[] = []) {
    this.seeded = seed;
  }

  private of(harness: string, id: string) {
    const key = keyOf(harness, id);
    let s = this.sessions.get(key);
    if (!s) {
      s = { n: 0, long: new Map() };
      this.sessions.set(key, s);
    }
    return s;
  }

  /** One event's line: its place and size, and the line itself kept when the index cuts it. */
  private line(event: StoredEvent): LogLine {
    const s = this.of(event.harness.name, event.session.id);
    const text = JSON.stringify(event);
    const offset = s.n++;
    // Only a line longer than a preview can hold a string the index cuts.
    if (text.length > PREVIEW_CHARS && slimEvent(event).preview) s.long.set(offset, text);
    return { event, offset, bytes: utf8Bytes(text) };
  }

  scanEach(visit: (file: LogFileInfo, line: LogLine) => void): LogFileInfo[] {
    const infos = new Map<string, LogFileInfo>();
    for (const event of this.seeded ?? []) {
      const key = keyOf(event.harness.name, event.session.id);
      let info = infos.get(key);
      if (!info) {
        info = {
          harness: event.harness.name,
          id: event.session.id,
          size: 0,
          lines: 0,
          firstArrivedAt: event.arrivedAt,
        };
        infos.set(key, info);
      }
      const line = this.line(event);
      info.size += line.bytes + 1;
      info.lines++;
      visit(info, line);
    }
    this.seeded = null;
    return [...infos.values()];
  }

  append(harness: string, id: string, events: StoredEvent[], size: number): { lines: LogLine[]; size: number } {
    void harness;
    void id;
    const lines: LogLine[] = [];
    let total = size;
    for (const event of events) {
      const line = this.line(event);
      lines.push(line);
      total += line.bytes + 1;
    }
    return { lines, size: total };
  }

  readAt(harness: string, id: string, at: { offset: number; bytes: number }[]): (StoredEvent | undefined)[] {
    const long = this.sessions.get(keyOf(harness, id))?.long;
    return at.map(({ offset }) => {
      const text = long?.get(offset);
      return text === undefined ? undefined : (JSON.parse(text) as StoredEvent);
    });
  }

  remove(harness: string, id: string): void {
    this.sessions.delete(keyOf(harness, id));
  }
}
