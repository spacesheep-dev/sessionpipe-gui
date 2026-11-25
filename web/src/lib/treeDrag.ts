// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Dragging a row of the sidebar's session tree, its pure parts: when a
// press becomes a drag (4 px with a pointer; a finger held 350 ms, before it scrolls), the
// place under the pointer and what a drop there would be (on a row: under it; on the line
// between top-level rows: to the top level, or a place among the pinned; on the Pinned
// heading: pinned), and how fast the list scrolls near its edges. The component
// (components/SessionTree.tsx) measures the rows and draws; lib/arrange.ts says what a
// move means and does it.
import type { SessionKey } from "@shared/api";
import type { Move } from "./arrange";

/** A pointer that moves this far while pressed has started a drag; less is a click. */
export const DRAG_SLOP_PX = 4;
/** A finger held this long lifts the row (before it, a move is a scroll). */
export const LIFT_MS = 350;
/** A finger that moves this far before the lift is scrolling, not lifting. */
export const TOUCH_SLOP_PX = 8;
/** A folded parent held under the pointer this long opens. */
export const OPEN_AFTER_MS = 600;
/** How near the list's top or bottom edge the pointer scrolls it. */
export const EDGE_PX = 32;
/** The fastest the list scrolls, in px a frame, at its very edge. */
export const EDGE_SPEED = 14;
/** The share of a row at its top and its bottom that is the line between rows. */
const LINE_SHARE = 0.25;

export type Group = "pinned" | "sessions";

/** One drawn row, as measured: its box on screen (px from the viewport's top). */
export interface RowBox {
  key: SessionKey;
  top: number;
  bottom: number;
  level: number;
  group: Group;
}

/** A place to drop. */
export type Target =
  /** On a row: under it. */
  | { kind: "on"; key: SessionKey }
  /** The line between top-level rows: in Pinned, before the pin at `at`; in Sessions, the
   *  top level (Sessions keeps the Board's order, so where the line is says nothing more).
   *  `y` is where the line is drawn. */
  | { kind: "line"; group: Group; at: number; y: number }
  /** The Pinned heading: pinned first. */
  | { kind: "pinned" };

/** The place under `y`, or null (outside the rows: a drop there cancels). `zones` are the
 *  two group headings, when drawn. A row the dragged one may not go on (itself, the
 *  sessions under it) is no place; nor is the line inside its own gap. */
export function targetAt(
  rows: readonly RowBox[],
  y: number,
  dragged: SessionKey,
  refused: ReadonlySet<SessionKey>,
  zones: { pinned?: { top: number; bottom: number }; sessions?: { top: number; bottom: number } } = {},
): Target | null {
  if (zones.pinned && y >= zones.pinned.top && y < zones.pinned.bottom) return { kind: "pinned" };
  if (zones.sessions && y >= zones.sessions.top && y < zones.sessions.bottom) {
    const first = rows.find((r) => r.group === "sessions");
    return { kind: "line", group: "sessions", at: 0, y: first?.top ?? zones.sessions.bottom };
  }
  const i = rows.findIndex((r) => y >= r.top && y < r.bottom);
  if (i < 0) return null;
  const r = rows[i]!;
  const same = rows.filter((x) => x.group === r.group);
  const next = same[same.indexOf(r) + 1];
  /** The pin's place among the pinned: the top-level rows of Pinned before this one. */
  const pinAt = (upTo: number) => same.slice(0, upTo).filter((x) => x.level === 0).length;
  const f = (y - r.top) / Math.max(1, r.bottom - r.top);
  if (f < LINE_SHARE && r.level === 0) {
    if (r.key === dragged) return null;
    return { kind: "line", group: r.group, at: pinAt(same.indexOf(r)), y: r.top };
  }
  if (f > 1 - LINE_SHARE && (!next || next.level === 0)) {
    if (r.key === dragged || (r.level > 0 && refused.has(r.key))) return null;
    return { kind: "line", group: r.group, at: pinAt(same.indexOf(r) + 1), y: r.bottom };
  }
  if (r.key === dragged || refused.has(r.key)) return null;
  return { kind: "on", key: r.key };
}

/** What a drop on `t` asks for. */
export function moveFor(t: Target): Move {
  if (t.kind === "on") return { kind: "under", parent: t.key };
  if (t.kind === "pinned") return { kind: "pin", at: 0 };
  return t.group === "pinned" ? { kind: "pin", at: t.at } : { kind: "top" };
}

/** How far the list scrolls this frame with the pointer at `y` in a list from `top` to
 *  `bottom`: up (negative) near the top, down near the bottom, faster nearer the edge. */
export function edgeScroll(y: number, top: number, bottom: number): number {
  if (y < top + EDGE_PX) return -Math.ceil(EDGE_SPEED * Math.min(1, (top + EDGE_PX - y) / EDGE_PX));
  if (y > bottom - EDGE_PX) return Math.ceil(EDGE_SPEED * Math.min(1, (y - (bottom - EDGE_PX)) / EDGE_PX));
  return 0;
}

/** Whether a press has become a drag: a pointer past DRAG_SLOP_PX; a finger only once it
 *  has been held LIFT_MS (`held`) without scrolling first. */
export function dragStarts(o: { touch: boolean; dx: number; dy: number; held: boolean }): boolean {
  if (o.touch) return o.held;
  return Math.hypot(o.dx, o.dy) >= DRAG_SLOP_PX;
}

/** Whether a finger that moved `dx, dy` before its lift was scrolling. */
export const touchScrolls = (dx: number, dy: number): boolean => Math.hypot(dx, dy) > TOUCH_SLOP_PX;
