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
  LIFT_MS,
  LONG_PRESS_MS,
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
const zones = { pinned: { top: 76, bottom: 100 }, sessions: { top: 176, bottom: 200 }, bottom: 400 };
const none = new Set<string>();

describe("targetAt", () => {
  it("is the row under the pointer in its middle half", () => {
    expect(targetAt(rows, 214, "c:b", none, zones)).toEqual({ kind: "on", key: "c:a" });
    expect(targetAt(rows, 242, "c:b", none, zones)).toEqual({ kind: "on", key: "c:a1" });
  });

  it("uses insertion lines only in Pinned; Sessions edges and gap return top", () => {
    // Just inside b's top: top level in Sessions, never a line.
    expect(targetAt(rows, 258, "c:p1", none, zones)).toEqual({ kind: "top" });
    // Just inside a's bottom: a's next row is its kid, so it stays on a.
    expect(targetAt(rows, 226, "c:p1", none, zones)).toEqual({ kind: "on", key: "c:a" });
    // Just inside a1's bottom: the next row is top-level, so top level in Sessions.
    expect(targetAt(rows, 254, "c:p1", none, zones)).toEqual({ kind: "top" });
    // Gap below the last row of Sessions (inside the scroller): top level.
    expect(targetAt(rows, 310, "c:a1", none, zones)).toEqual({ kind: "top" });
    // Among the pinned the line says where: before p2 is place 1, after it place 2.
    expect(targetAt(rows, 130, "c:b", none, zones)).toEqual({ kind: "line", group: "pinned", at: 1, y: 128 });
    expect(targetAt(rows, 154, "c:b", none, zones)).toEqual({ kind: "line", group: "pinned", at: 2, y: 156 });
  });

  it("is the Pinned heading, or top level on the Sessions heading", () => {
    expect(targetAt(rows, 80, "c:b", none, zones)).toEqual({ kind: "pinned" });
    expect(targetAt(rows, 180, "c:p1", none, zones)).toEqual({ kind: "top" });
  });

  it("is no place on the row itself, on its own sessions, or outside the scroller", () => {
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
    expect(moveFor({ kind: "top" })).toEqual({ kind: "top" });
  });
});

describe("a press, a drag, a scroll", () => {
  it("long-press matches the system 500 ms; pointer drags past 4 px", () => {
    expect(LONG_PRESS_MS).toBe(500);
    expect(LIFT_MS).toBe(500);
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
