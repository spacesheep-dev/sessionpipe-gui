// SPDX-License-Identifier: Apache-2.0
// What an open session view holds of its session's events, kept whole: one listener from
// the open to the close (so no event falls between the first page and the live ones), and
// the read that follows the stream coming back (Store.resyncs), which adds what the drop
// kept from the page without touching what it already shows. Pure but for the listener;
// components/SessionBody.tsx draws from it.
import type { DetailQuery, SessionKey, SessionSummary, StoredEvent } from "@shared/api";

/** The most a re-read asks for (the detail route's own cap). */
export const REREAD_MAX = 1000;
/** How far back from its newest event a re-read starts: an event recorded late lands
 *  among the last ones, not after them. */
export const REREAD_BACK = 100;

interface Events {
  onEvent(l: (e: StoredEvent, session: SessionSummary) => void): () => void;
}

/** One listener on a session's live events. Until `release` it holds what arrives (the
 *  first page is being read: `held` starts with what a prefetch already collected); from
 *  `release` on, which hands the held ones over, each event goes straight to `sink`. The
 *  hand-over is one call, so there is no moment with nobody listening. */
export function tapSession(
  store: Events,
  key: SessionKey,
  sink: (e: StoredEvent) => void,
  held: StoredEvent[] = [],
): { release(): StoredEvent[]; stop(): void } {
  let open = false;
  const stop = store.onEvent((e, s) => {
    if (s.key !== key) return;
    if (open) sink(e);
    else held.push(e);
  });
  return {
    release() {
      open = true;
      return held;
    },
    stop,
  };
}

/** `prev` and `more` as one list in seq order, each seq once, the copy already held kept
 *  (it may be the full event a row was opened on; a page's copy is slim). The same array
 *  when `more` brings nothing new, so nothing redraws. Whatever order the two were read
 *  in, nothing held is lost: an answer that lands after newer live events only adds. */
export function mergeBySeq(prev: StoredEvent[], more: readonly StoredEvent[]): StoredEvent[] {
  const have = new Set(prev.map((e) => e.session.seq));
  const add = more.filter((e) => !have.has(e.session.seq) && have.add(e.session.seq));
  if (!add.length) return prev;
  return [...prev, ...add].sort((a, b) => a.session.seq - b.session.seq);
}

/** The page a view asks for once the stream is back: forwards from REREAD_BACK events
 *  before its newest, so what was recorded late among them comes too, up to REREAD_MAX.
 *  A view with nothing reads its newest page as it does on open. */
export function rereadQuery(events: readonly StoredEvent[], tail: number): DetailQuery {
  if (!events.length) return { tail: true, limit: tail };
  const from = events[Math.max(0, events.length - REREAD_BACK)]!;
  return { after: from.session.seq - 1, limit: REREAD_MAX };
}

/** Whether a re-read's answer may have left events out: it came back full, so the drop
 *  outlasted one page. The view then opens afresh on the newest page. */
export const rereadShort = (answer: readonly StoredEvent[]): boolean => answer.length >= REREAD_MAX;
