// SPDX-License-Identifier: Apache-2.0
// Pull to refresh, the part with no DOM in it: how far the page follows a finger, when
// the pull arms, what a release does, and how long a refresh is shown.
// components/PullRefresh.tsx feeds it touch positions and draws what it says; this file
// is what pull.test.ts covers.

/** Finger travel before the page follows at all: a tap, or the wobble at the start of a
 *  row's sideways swipe, never moves the page. */
export const SLACK_PX = 6;
/** The page's travel that arms a refresh; the content rests here while one runs. */
export const ARM_PX = 56;
/** Up to here the page gives half the finger's travel; past it the band tightens. */
export const SOFT_PX = 64;
/** The band's reach: the page never goes further, however far the finger does. */
export const MAX_PX = 96;
/** A refresh is shown at least this long, so a receiver that answers at once never
 *  flickers the ring. */
export const MIN_SPIN_MS = 600;
/** And at most this long: past it the refresh ends with what the stream says then. */
export const TIMEOUT_MS = 8000;

/** Nothing; a finger down that may become a pull (`y0` set, still idle); the page
 *  following the finger; the ring spinning while the stream reopens; everything easing
 *  back. */
export type Phase = "idle" | "pulling" | "refreshing" | "settling";

export interface Pull {
  phase: Phase;
  /** Where the finger landed, while it is watched (null: nobody's finger is ours). */
  x0: number;
  y0: number | null;
  /** How far the page is drawn down. */
  y: number;
  /** Past ARM_PX: letting go refreshes. */
  armed: boolean;
  /** When the refresh began (ms), while refreshing. */
  since: number;
}

export const IDLE: Pull = { phase: "idle", x0: 0, y0: null, y: 0, armed: false, since: 0 };

/** The page's travel for the finger's: nothing inside the slack, half of it up to
 *  SOFT_PX, then an ease into MAX_PX that is never felt as a wall (the slope is 1 at the
 *  join and fades from there). */
export function travel(raw: number): number {
  const half = Math.max(0, raw - SLACK_PX) / 2;
  if (half <= SOFT_PX) return half;
  const room = MAX_PX - SOFT_PX;
  return SOFT_PX + room * (1 - Math.exp(-(half - SOFT_PX) / room));
}

/** The ring's arc: nothing at rest, the full circle at the arm distance. */
export const arc = (y: number): number => Math.min(1, Math.max(0, y / ARM_PX));

/** A finger lands. It is watched only when nothing else owns it (`ok`: the page at its
 *  top, one finger, no sheet open, not on a field or a row that scrolls sideways). */
export function begin(s: Pull, x: number, y: number, ok: boolean): Pull {
  if (s.phase !== "idle" || !ok) return s;
  return { ...IDLE, x0: x, y0: y };
}

/** The finger moves. `atTop` is whether the page is still at its top: once it has
 *  scrolled, the touch is the page's and the pull lets go. `arm` says when the pull just
 *  crossed the arm distance either way (the haptic plays on "arm", once). */
export function move(s: Pull, x: number, y: number, atTop: boolean): { state: Pull; arm: "arm" | "disarm" | null } {
  if (s.y0 === null || (s.phase !== "idle" && s.phase !== "pulling")) return { state: s, arm: null };
  const dx = x - s.x0;
  const dy = y - s.y0;
  if (s.phase === "idle") {
    // Not a pull yet. A scroll up, a sideways swipe (a row's own) or a page that has
    // scrolled let the touch go; inside the slack it is still a tap.
    if (!atTop || dy < -SLACK_PX || Math.abs(dx) > Math.max(SLACK_PX, dy)) return { state: IDLE, arm: null };
    if (dy <= SLACK_PX) return { state: s, arm: null };
  } else if (!atTop) {
    return { state: IDLE, arm: null };
  }
  const t = travel(dy);
  const armed = t >= ARM_PX;
  return {
    state: { ...s, phase: "pulling", y: t, armed },
    arm: armed === s.armed ? null : armed ? "arm" : "disarm",
  };
}

/** The finger lifts: past the arm distance the refresh begins, short of it the page
 *  eases back and nothing happens. A touch that never became a pull is forgotten. */
export function release(s: Pull, now: number): Pull {
  if (s.phase === "pulling") return s.armed ? { ...IDLE, phase: "refreshing", y: ARM_PX, since: now } : settle(s);
  return s.y0 !== null ? IDLE : s;
}

/** Whether the refresh has what it waited for: the stream live again with a snapshot
 *  newer than the one it had (`before`, as the refresh began). */
export const landed = (before: string | null, snapshotAt: string | null, connection: string): boolean =>
  connection === "live" && snapshotAt !== null && snapshotAt !== before;

/** How much longer a refresh whose snapshot has landed must still be shown. */
export const holdFor = (s: Pull, now: number): number =>
  s.phase === "refreshing" ? Math.max(0, s.since + MIN_SPIN_MS - now) : 0;

/** Whether a refresh has run past its hard stop. */
export const overdue = (s: Pull, now: number): boolean => s.phase === "refreshing" && now - s.since >= TIMEOUT_MS;

/** The words the live region says as a refresh ends. */
export const outcome = (live: boolean): string => (live ? "Up to date" : "Couldn't refresh");

/** The refresh (or an unarmed pull) is over: everything eases back. */
export function settle(s: Pull): Pull {
  return s.phase === "refreshing" || s.phase === "pulling" ? { ...IDLE, phase: "settling" } : s;
}

/** The ease back has played out. */
export const settled = (s: Pull): Pull => (s.phase === "settling" ? IDLE : s);
