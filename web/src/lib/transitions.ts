// SPDX-License-Identifier: Apache-2.0
// Which way a page change moves on the phone (lib/router.tsx plays it, styles/transitions.css
// draws it): a session opened from a list pushes in from the right as a UINavigationController
// push, and our own Back pops it the same way back. The decision is pure, so it is testable:
// the router hands it what it knows of the move and of the device.

/** The lists a session is opened from (a session page keeps its list lit, Shell.tsx). */
const LISTS: ReadonlySet<string> = new Set(["board", "inbox", "search", "feed", "review"]);
/** The detail pages that push over a list. */
const DETAILS: ReadonlySet<string> = new Set(["session"]);

/** How the move came about: `navigate` is a tap on a row or a link; `replace` a redirect;
 *  `back` our own Back button (whether it goes through history.back() or falls back to a
 *  navigate); `popstate` the browser's or the native gesture's own back, which the browser
 *  already animated, or a person who expects the instant jump. */
export type NavKind = "navigate" | "replace" | "back" | "popstate";

export type NavDirection = "push" | "pop";

export interface NavEnv {
  /** The phone layout (Shell.tsx PHONE_QUERY). */
  phone: boolean;
  /** The person asked for less motion. */
  reduced: boolean;
  /** document.startViewTransition exists. */
  supported: boolean;
}

/** The transition a move from route `from` to route `to` (their names) plays, or null for
 *  the plain swap: nothing on a desktop, under reduced motion, without view transitions,
 *  on a popstate, on a replace, or between pages that are not a list and a session. */
export function navDirection(from: string, to: string, kind: NavKind, env: NavEnv): NavDirection | null {
  if (!env.phone || env.reduced || !env.supported) return null;
  if (kind === "popstate" || kind === "replace") return null;
  if (kind === "navigate" && LISTS.has(from) && DETAILS.has(to)) return "push";
  if (kind === "back" && DETAILS.has(from) && LISTS.has(to)) return "pop";
  return null;
}
