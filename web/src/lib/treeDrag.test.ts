// SPDX-License-Identifier: Apache-2.0
// The sidebar drag's pure parts: when a press becomes a drag, the place under the pointer
// (on a row, the line between top-level rows, the Pinned heading; never the row itself
// or one of its own sessions), what a drop there asks for, and the scroll at the edges.
import { describe, expect, it } from "vitest";
import {
  DRAG_SLOP_PX,
  dragStarts,
  EDGE_PX,
  EDGE_SPEED,
  edgeScroll,
  moveFor,
  type RowBox,
  targetAt,
  touchScrolls,
} from "./treeDrag";

/** Rows 28 px tall from y 100: pinned p1, p2; then sessions a, its kid a1, b. */
const rows: RowBox[] = [
  { key: "c:p1", top: 100, bottom: 128, level: 0, group: "pinned" },
  { key: "c:p2", top: 128, bottom: 156, level: 0, group: "pinned" },
  { key: "c:a", top: 200, bottom: 228, level: 0, group: "sessions" },
  { key: "c:a1", top: 228, bottom: 256, level: 1, group: "sessions" },
  { key: "c:b", top: 256, bottom: 284, level: 0, group: "sessions" },
];
const zones = { pinned: { top: 76, bottom: 100 }, sessions: { top: 176, bottom: 200 } };
const none = new Set<string>();

describe("targetAt", () => {
  it("is the row under the pointer in its middle half", () => {
    expect(targetAt(rows, 214, "c:b", none, zones)).toEqual({ kind: "on", key: "c:a" });
    expect(targetAt(rows, 242, "c:b", none, zones)).toEqual({ kind: "on", key: "c:a1" });
  });

  it("is the line between top-level rows at a row's edges, and only between top-level rows", () => {
    // Just inside b's top: the line above b.
    expect(targetAt(rows, 258, "c:p1", none, zones)).toEqual({ kind: "line", group: "sessions", at: 1, y: 256 });
    // Just inside a's bottom: a's next row is its kid, so there is no line: it is a.
    expect(targetAt(rows, 226, "c:p1", none, zones)).toEqual({ kind: "on", key: "c:a" });
    // Just inside a1's bottom: the next row is top-level, so the line under it.
    expect(targetAt(rows, 254, "c:p1", none, zones)).toMatchObject({ kind: "line", group: "sessions", y: 256 });
    // Among the pinned the line says where: before p2 is place 1, after it place 2.
    expect(targetAt(rows, 130, "c:b", none, zones)).toEqual({ kind: "line", group: "pinned", at: 1, y: 128 });
    expect(targetAt(rows, 154, "c:b", none, zones)).toEqual({ kind: "line", group: "pinned", at: 2, y: 156 });
  });

  it("is the Pinned heading, or the line atop Sessions on its heading", () => {
    expect(targetAt(rows, 80, "c:b", none, zones)).toEqual({ kind: "pinned" });
    expect(targetAt(rows, 180, "c:p1", none, zones)).toEqual({ kind: "line", group: "sessions", at: 0, y: 200 });
  });

  it("is no place on the row itself, on its own sessions, or outside the rows", () => {
    expect(targetAt(rows, 214, "c:a", none, zones)).toBeNull();
    expect(targetAt(rows, 202, "c:a", none, zones)).toBeNull();
    expect(targetAt(rows, 242, "c:a", new Set(["c:a1"]), zones)).toBeNull();
    expect(targetAt(rows, 500, "c:a", none, zones)).toBeNull();
    expect(targetAt(rows, 170, "c:a", none, zones)).toBeNull();
  });
});

describe("moveFor", () => {
  it("says what a drop asks for", () => {
    expect(moveFor({ kind: "on", key: "c:a" })).toEqual({ kind: "under", parent: "c:a" });
    expect(moveFor({ kind: "pinned" })).toEqual({ kind: "pin", at: 0 });
    expect(moveFor({ kind: "line", group: "pinned", at: 2, y: 0 })).toEqual({ kind: "pin", at: 2 });
    expect(moveFor({ kind: "line", group: "sessions", at: 2, y: 0 })).toEqual({ kind: "top" });
  });
});

describe("a press, a drag, a scroll", () => {
  it("a pointer drags past 4 px; a finger only once held, and a finger that moves first scrolls", () => {
    expect(dragStarts({ touch: false, dx: 2, dy: 2, held: false })).toBe(false);
    expect(dragStarts({ touch: false, dx: DRAG_SLOP_PX, dy: 0, held: false })).toBe(true);
    expect(dragStarts({ touch: true, dx: 30, dy: 0, held: false })).toBe(false);
    expect(dragStarts({ touch: true, dx: 0, dy: 0, held: true })).toBe(true);
    expect(touchScrolls(0, 6)).toBe(false);
    expect(touchScrolls(0, 12)).toBe(true);
  });

  it("the list scrolls near its edges, faster nearer them, and not in between", () => {
    expect(edgeScroll(300, 100, 600)).toBe(0);
    expect(edgeScroll(100, 100, 600)).toBe(-EDGE_SPEED);
    expect(edgeScroll(600, 100, 600)).toBe(EDGE_SPEED);
    const near = edgeScroll(100 + EDGE_PX - 4, 100, 600);
    expect(near).toBeLessThan(0);
    expect(Math.abs(near)).toBeLessThan(EDGE_SPEED);
  });
});
