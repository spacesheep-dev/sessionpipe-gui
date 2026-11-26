// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Dragging a row of the sidebar's session tree, its pure parts: when a
// press becomes a drag (4 px with a pointer; a finger held 350 ms, before it scrolls), the
// place under the pointer and what a drop there would be (on a row: under it; on a folder
// header: into that folder; on the line between top-level rows: to the top level, into
// that folder, or a place among the pinned; on the Pinned heading: pinned), and how fast
// the list scrolls near its edges. The component (components/SessionTree.tsx) measures
// the rows and draws; lib/arrange.ts says what a move means and does it.
import type { SessionKey } from "@shared/api";
import type { Move } from "./arrange";

/** A pointer that moves this far while pressed has started a drag; less is a click. */
export const DRAG_SLOP_PX = 4;
/** A finger held this long presses the row and opens its menu (the system's 500 ms). */
export const LONG_PRESS_MS = 500;
/** Kept under the old name for callers: a finger's long-press matches the system's. */
export const LIFT_MS = LONG_PRESS_MS;
/** A finger that moves this far before the hold is scrolling, not long-pressing. */
export const TOUCH_SLOP_PX = 8;
/** A finger that moves this far after the long-press closes the menu and lifts the row. */
export const TOUCH_MOVE_PX = 10;
/** A folded parent or folder held under the pointer this long opens. */
export const OPEN_AFTER_MS = 600;
/** How near the list's top or bottom edge the pointer scrolls it. */
export const EDGE_PX = 32;
/** The fastest the list scrolls, in px a frame, at its very edge. */
export const EDGE_SPEED = 14;
/** The share of a row at its top and its bottom that is the line between rows. */
const LINE_SHARE = 0.25;

export type Group = "pinned" | "sessions" | "folder";

/** One drawn row, as measured: its box on screen (px from the viewport's top). */
export interface RowBox {
  key: SessionKey;
  top: number;
  bottom: number;
  level: number;
  group: Group;
  /** The custom folder this row sits inside, when `group === "folder"`. */
  folderId?: string;
}

export interface FolderZone {
  folderId: string;
  top: number;
  bottom: number;
}

export interface RectY {
  top: number;
  bottom: number;
}

export interface DropZones {
  pinned?: RectY | readonly RectY[];
  sessions?: RectY;
  folders?: readonly FolderZone[];
  projects?: readonly RectY[];
  bottom?: number;
}

/** A place to drop. */
export type Target =
  /** On a row: under it. */
  | { kind: "on"; key: SessionKey }
  /** The line between top-level rows in Pinned: before the pin at `at`. `y` is where it draws. */
  | { kind: "line"; group: "pinned"; at: number; y: number }
  /** To the top level of Sessions (no line: Sessions sorts itself). */
  | { kind: "top" }
  /** The Pinned heading or pin zone: pinned first. */
  | { kind: "pinned" }
  /** A custom folder header (or edge between root rows inside that folder). */
  | { kind: "folder"; folderId: string };

/** The place under `y`, or null (outside the rows: a drop there cancels). `zones` are the
 *  group headings, folder rows, project headers and the scroll list's bottom edge, when
 *  drawn. A row the dragged one may not go on (itself, the sessions under it) is no place;
 *  nor is the line inside its own gap. */
export function targetAt(
  rows: readonly RowBox[],
  y: number,
  dragged: SessionKey,
  refused: ReadonlySet<SessionKey>,
  zones: DropZones = {},
): Target | null {
  if (zones.pinned) {
    const pinnedZones = Array.isArray(zones.pinned) ? zones.pinned : [zones.pinned];
    for (const p of pinnedZones) {
      if (y >= p.top && y < p.bottom) return { kind: "pinned" };
    }
  }
  if (zones.folders) {
    for (const f of zones.folders) {
      if (y >= f.top && y < f.bottom) return { kind: "folder", folderId: f.folderId };
    }
  }
  if (zones.sessions && y >= zones.sessions.top && y < zones.sessions.bottom) return { kind: "top" };
  if (zones.projects) {
    for (const p of zones.projects) {
      if (y >= p.top && y < p.bottom) return { kind: "top" };
    }
  }
  const i = rows.findIndex((r) => y >= r.top && y < r.bottom);
  if (i < 0) {
    const lastSession = [...rows].reverse().find((r) => r.group === "sessions");
    const after = lastSession?.bottom ?? zones.sessions?.bottom;
    if (after !== undefined && y >= after && (zones.bottom === undefined || y < zones.bottom)) {
      return { kind: "top" };
    }
    return null;
  }
  const r = rows[i]!;
  const same = rows.filter((x) => x.group === r.group && x.folderId === r.folderId);
  const next = same[same.indexOf(r) + 1];
  /** The pin's place among the pinned: the top-level rows of Pinned before this one. */
  const pinAt = (upTo: number) => same.slice(0, upTo).filter((x) => x.level === 0).length;
  const edgeTarget = (pinIndex: number, lineY: number): Target =>
    r.group === "pinned"
      ? { kind: "line", group: "pinned", at: pinIndex, y: lineY }
      : r.group === "folder" && r.folderId
        ? { kind: "folder", folderId: r.folderId }
        : { kind: "top" };
  const f = (y - r.top) / Math.max(1, r.bottom - r.top);
  if (f < LINE_SHARE && r.level === 0) {
    if (r.key === dragged) return null;
    return edgeTarget(pinAt(same.indexOf(r)), r.top);
  }
  if (f > 1 - LINE_SHARE && (!next || next.level === 0)) {
    if (r.key === dragged || (r.level > 0 && refused.has(r.key))) return null;
    return edgeTarget(pinAt(same.indexOf(r) + 1), r.bottom);
  }
  if (r.key === dragged || refused.has(r.key)) return null;
  return { kind: "on", key: r.key };
}

/** What a drop on `t` asks for. */
export function moveFor(t: Target): Move {
  if (t.kind === "on") return { kind: "under", parent: t.key };
  if (t.kind === "pinned") return { kind: "pin", at: 0 };
  if (t.kind === "folder") return { kind: "folder", folderId: t.folderId };
  if (t.kind === "top") return { kind: "top" };
  return { kind: "pin", at: t.at };
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
