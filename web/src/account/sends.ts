// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The `sends` document of an account (docs/rfcs/08, "The documents"): the
// rows of what this page sent through spacesheep, so a send still on its way is followed
// again after the app was closed. MemoryControl (server/control/remote.ts) hands over every
// queue as the receiver would keep it; a document is at most 1 MiB at the hub, so this
// holds it well under: what is unsettled is kept whole, and of what settled the long texts
// are cut first and the oldest rows go next.
import type { KeptQueues } from "../../../server/control/remote";
import { isFinal, type MessageRow } from "../../../server/control/rows";
import { utf8Bytes } from "../../../server/store/log";

/** The document's ceiling here: half of what the hub takes. */
export const SENDS_MAX_BYTES = 512 * 1024;
/** Characters of a settled row's text kept once the document is over its ceiling. */
export const SETTLED_TEXT_CHARS = 400;

export interface SendsDoc {
  v: 1;
  queues: KeptQueues;
}

const size = (queues: KeptQueues): number => utf8Bytes(JSON.stringify({ v: 1, queues }));
const cut = (s: string | undefined, n: number): string | undefined =>
  s !== undefined && s.length > n ? `${s.slice(0, n)}…` : s;

/** The queues as the document keeps them, within `max` bytes. */
export function fitSends(queues: KeptQueues, max = SENDS_MAX_BYTES): SendsDoc {
  if (size(queues) <= max) return { v: 1, queues };
  // Settled rows are history: their long texts go first.
  let next: KeptQueues = {};
  for (const [id, rows] of Object.entries(queues))
    next[id] = rows.map((r) =>
      isFinal(r.outcome)
        ? {
            ...r,
            ...(r.text !== undefined ? { text: cut(r.text, SETTLED_TEXT_CHARS) } : {}),
            ...(r.reply !== undefined ? { reply: cut(r.reply, SETTLED_TEXT_CHARS) } : {}),
          }
        : r,
    );
  // Then the oldest settled rows, a tenth at a time, until it fits or none is left.
  for (;;) {
    if (size(next) <= max) return { v: 1, queues: next };
    const settled: MessageRow[] = [];
    for (const rows of Object.values(next)) for (const r of rows) if (isFinal(r.outcome)) settled.push(r);
    if (!settled.length) break;
    settled.sort((a, b) => (a.id < b.id ? -1 : 1));
    const gone = new Set(settled.slice(0, Math.max(1, Math.ceil(settled.length / 10))).map((r) => r.id));
    const kept: KeptQueues = {};
    for (const [id, rows] of Object.entries(next)) kept[id] = rows.filter((r) => !gone.has(r.id));
    next = kept;
  }
  // Only what is unsettled is left and it is still too much: its texts are cut too. The row
  // still says what was sent where, and spacesheep's word still settles it.
  const last: KeptQueues = {};
  for (const [id, rows] of Object.entries(next))
    last[id] = rows.map((r) => ({ ...r, ...(r.text !== undefined ? { text: cut(r.text, SETTLED_TEXT_CHARS) } : {}) }));
  return { v: 1, queues: last };
}

/** The queues a kept document holds, or null when it is not one. */
export function readSends(raw: unknown): KeptQueues | null {
  if (!raw || typeof raw !== "object") return null;
  const q = (raw as { queues?: unknown }).queues;
  if (!q || typeof q !== "object" || Array.isArray(q)) return null;
  const out: KeptQueues = {};
  for (const [id, rows] of Object.entries(q)) if (Array.isArray(rows)) out[id] = rows as MessageRow[];
  return out;
}
