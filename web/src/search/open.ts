// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. Opening a result (SEARCH-SPEC.md D17). A session the receiver knows
// opens in the live view, at the hit's turn (`#seq-N`; a hit from the history log has none
// and opens at the latest). A history-only session opens
// its transcript from the index at the exact hit (`?q=…#h-<ref>`), with the find bar on.
// As a page (pushState, so Back returns to the results), beside (the side panel), or
// beside in the background (focus stays on the results).
import type { SessionMatch, SessionSearchHit } from "@shared/api";
import { noteHistoryTitle } from "../lib/historyTitle";
import { hrefFor, navigate, sessionPath } from "../lib/router";
import { openSplit } from "../lib/split";

export type OpenMode = "page" | "beside" | "background";

/** The hash a session view reads once to land on a hit. */
export function hitHash(m: SessionMatch, hit: SessionSearchHit | undefined): string {
  if (!hit) return "";
  if (m.summary) {
    // A hit from the history log has no seq: the live view opens at its latest (the
    // bridge into the history's earlier turns is P1).
    return hit.seq !== undefined ? `#seq-${hit.seq}` : "";
  }
  return `#h-${hit.ref}`;
}

/** The address a result's link carries (the router's kept parameters before the hash). */
export function resultLink(m: SessionMatch, hit: SessionSearchHit | undefined, q: string): string {
  const href = resultHref(m, hit, q);
  const at = href.indexOf("#");
  return at < 0 ? hrefFor(href) : `${hrefFor(href.slice(0, at))}${href.slice(at)}`;
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
  if (!m.summary) noteHistoryTitle(m.key, m.title);
  if (mode === "page") {
    // The hash goes on after the router has kept its own parameters (the mock flag, the
    // panel), which it would otherwise append after it.
    const href = resultHref(m, hit, q);
    const at = href.indexOf("#");
    navigate(at < 0 ? href : href.slice(0, at));
    if (at >= 0) history.replaceState(history.state, "", `${location.pathname}${location.search}${href.slice(at)}`);
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
