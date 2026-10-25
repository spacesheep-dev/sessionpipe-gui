// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. Opening a result (SEARCH-SPEC.md D17). A session the receiver knows
// opens in the live view, at the hit's turn (`#seq-N`) or, for a hit from the history log
// with no seq, at the turn nearest its time (`#at-<ms>`). A history-only session opens
// its transcript from the index at the exact hit (`?q=…#h-<ref>`), with the find bar on.
// As a page (pushState, so Back returns to the results), beside (the side panel), or
// beside in the background (focus stays on the results).
import type { SessionMatch, SessionSearchHit } from "@shared/api";
import { navigate, sessionPath } from "../lib/router";
import { openSplit } from "../lib/split";

export type OpenMode = "page" | "beside" | "background";

/** The hash a session view reads once to land on a hit. */
export function hitHash(m: SessionMatch, hit: SessionSearchHit | undefined): string {
  if (!hit) return "";
  if (m.summary) {
    if (hit.seq !== undefined) return `#seq-${hit.seq}`;
    const t = Date.parse(hit.at);
    return Number.isNaN(t) ? "" : `#at-${t}`;
  }
  return `#h-${hit.ref}`;
}

/** The page a result opens: the live view or the history transcript, at `hit`. */
export function resultHref(m: SessionMatch, hit: SessionSearchHit | undefined, q: string): string {
  const path = sessionPath(m.harness, m.id);
  const query = !m.summary && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return `${path}${query}${hitHash(m, hit)}`;
}

/** The best hit: the first of the shown ones the engine ranked highest is not known
 *  here, so the first in transcript order stands in, as the row's first snippet. */
export const bestHit = (m: SessionMatch): SessionSearchHit | undefined => m.hits[0];

export function openResult(
  m: SessionMatch,
  hit: SessionSearchHit | undefined,
  q: string,
  mode: OpenMode,
  from?: DOMRect,
): void {
  if (mode === "page") {
    navigate(resultHref(m, hit, q));
    return;
  }
  openSplit(m.key, { from, background: mode === "background" });
  // The panel reads the hash once (components/SessionBody.tsx, search/History.tsx), the
  // search page's own `?q=` is the history view's query.
  const hash = hitHash(m, hit);
  if (!hash) return;
  history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
