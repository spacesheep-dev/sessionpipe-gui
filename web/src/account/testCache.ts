// SPDX-License-Identifier: Apache-2.0
// Test helper (no page imports it): what the page's IndexedDB cache keeps (cache.ts), without
// IndexedDB: the relay's pages under their cursors, the reader's small values, a forget and
// a destroy, all in one object a test holds on to across "launches" of a backend. It keeps
// what it is handed as JSON text, as a database would: nothing is shared with the page.
// The trims (count, age) are the real cache's own, tested where IndexedDB is (the browser).
import type { SessionKey, StoredEvent } from "@shared/api";
import { type EventCache, withoutSessions } from "./cache";

export interface KeptCache extends EventCache {
  /** The pages as kept, oldest first: the cursor each is under and its events. */
  pages(): { key: number; events: StoredEvent[] }[];
  /** Every kept event, in order. */
  events(): StoredEvent[];
  meta: Map<string, string>;
  destroyed: boolean;
  /** Every forget it was asked for. */
  forgotten: SessionKey[][];
}

export function keptCache(): KeptCache {
  const pages = new Map<number, string>();
  const meta = new Map<string, string>();
  const read = () =>
    [...pages.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([key, text]) => ({ key, events: JSON.parse(text) as StoredEvent[] }));
  const cache: KeptCache = {
    kind: "indexeddb",
    meta,
    destroyed: false,
    forgotten: [],
    pages: read,
    events: () => read().flatMap((p) => p.events),
    async load() {
      const kept: Record<string, unknown> = {};
      for (const [name, text] of meta) kept[name] = JSON.parse(text);
      return { events: cache.events(), kept, pages: pages.size, ms: 0 };
    },
    page(cursor, events, cursorDoc) {
      if (events.length) pages.set(cursor, JSON.stringify(events));
      meta.set("cursor", JSON.stringify(cursorDoc));
    },
    put: (name, value) => void meta.set(name, JSON.stringify(value)),
    forget(sessions) {
      cache.forgotten.push([...sessions]);
      const gone = new Set(sessions);
      for (const p of read()) {
        const kept = withoutSessions(p.events, gone);
        if (kept === p.events) continue;
        if (kept.length) pages.set(p.key, JSON.stringify(kept));
        else pages.delete(p.key);
      }
    },
    async destroy() {
      cache.destroyed = true;
      pages.clear();
      meta.clear();
    },
    flushed: async () => {},
    bytes: async () => null,
  };
  return cache;
}
