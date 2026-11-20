// SPDX-License-Identifier: Apache-2.0
// The reading place through a change of the window's width, on a page made of numbers: rows
// 100 px tall in a window 400 wide and 60 px tall in one 800 wide, scrolled by `y`, with
// the frames run by hand. What is tried is when a place is written down, when it is put
// back, and which scrolls are taken for the person's.
import { describe, expect, it } from "vitest";
import { type AnchorView, believed, placeKeeper } from "./resizeAnchor";

interface Place {
  row: number;
  offset: number;
}

function page(o: { enabled?: () => boolean } = {}) {
  const p = {
    size: [400, 700] as [number, number],
    y: 0,
    reads: 0,
    settled: [] as boolean[],
    frames: [] as (() => void)[],
    /** Runs the frames asked for so far; those they ask for wait for the next call. */
    frame() {
      for (const run of p.frames.splice(0)) run();
    },
    rowHeight: () => (p.size[0] >= 800 ? 60 : 100),
    /** A row's top in the window. */
    top: (row: number) => row * p.rowHeight() - p.y,
  };
  const view: AnchorView<Place> = {
    size: () => p.size,
    scrollY: () => p.y,
    read() {
      p.reads++;
      const row = Math.ceil(p.y / p.rowHeight());
      return { row, offset: p.top(row) };
    },
    ask: (place) => p.top(place.row) - place.offset,
    scrollBy(px) {
      p.y += px;
    },
    frame: (run) => void p.frames.push(run),
    enabled: o.enabled ?? (() => true),
    settle: (last) => void p.settled.push(last),
  };
  return { p, keeper: placeKeeper(view) };
}

/** The person scrolls to `y`, and the frame after it runs. */
function scrollTo(t: ReturnType<typeof page>, y: number) {
  t.p.y = y;
  t.keeper.scrolled();
  t.p.frame();
}

describe("placeKeeper", () => {
  it("writes the place down once a frame, however many scrolls the frame had", () => {
    const t = page();
    t.p.y = 10;
    t.keeper.scrolled();
    t.p.y = 30;
    t.keeper.scrolled();
    expect(t.p.reads).toBe(0);
    t.p.frame();
    expect(t.p.reads).toBe(1);
  });

  it("ignores scrolls that come with a size change", () => {
    const t = page();
    // Row 9 is 30 px under the bar.
    scrollTo(t, 870);
    expect(t.p.top(9)).toBe(30);
    // The window is unfolded, and the browser's own scroll comes first, as in WebKit: with
    // the new size, and the page clamped to somewhere else.
    t.p.size = [800, 900];
    t.p.y = 420;
    t.keeper.scrolled();
    // It was not read as where the person is: row 9 is back 30 px under the bar at once,
    expect(t.p.reads).toBe(1);
    expect(t.p.top(9)).toBe(30);
    // and no scroll is read until the page has settled, the keeper's own least of all.
    t.keeper.scrolled();
    t.p.frame();
    t.keeper.scrolled();
    t.p.frame();
    t.p.frame();
    t.keeper.scrolled();
    t.p.frame();
    expect(t.p.reads).toBe(1);
    // Folded again without a scroll of the person's in between, it is where it began.
    t.p.size = [400, 700];
    expect(t.keeper.sized()).toBe(true);
    expect(t.p.y).toBe(870);
  });

  it("puts the row back at the first sign of another width, and again on the frames after it", () => {
    const t = page();
    scrollTo(t, 870);
    t.p.size = [800, 900];
    expect(t.keeper.sized()).toBe(true);
    expect(t.p.top(9)).toBe(30);
    // The layout the width decides comes a frame late and moves the row: back again.
    t.p.y += 200;
    t.p.frame();
    expect(t.p.top(9)).toBe(30);
    t.p.y -= 45;
    t.p.frame();
    expect(t.p.top(9)).toBe(30);
    expect(t.keeper.sized()).toBe(true);
    t.p.frame();
    // Settled: told so once, at the last step.
    expect(t.keeper.sized()).toBe(false);
    expect(t.p.settled).toEqual([false, false, false, true]);
    // From here a scroll is the person's again.
    scrollTo(t, t.p.y + 300);
    expect(t.p.reads).toBe(2);
  });

  it("keeps the first place through folds that come faster than the page settles", () => {
    const t = page();
    scrollTo(t, 870);
    for (const size of [
      [800, 900],
      [400, 700],
      [800, 900],
      [401, 700],
      [800, 600],
    ] as [number, number][]) {
      t.p.size = size;
      t.keeper.sized();
      t.keeper.scrolled();
      t.p.frame();
    }
    expect(t.p.reads).toBe(1);
    expect(t.p.top(9)).toBe(30);
  });

  it("leaves the page alone when only the height changed, as under a phone browser's toolbar", () => {
    const t = page();
    scrollTo(t, 870);
    t.p.size = [400, 760];
    t.p.y = 900;
    expect(t.keeper.sized()).toBe(true);
    for (let i = 0; i < 3; i++) t.p.frame();
    expect(t.p.y).toBe(900);
    // The page's own place is still told of it.
    expect(t.p.settled).toEqual([false, false, false, true]);
  });

  it("puts nothing back while the page keeps a place of its own", () => {
    let own = true;
    const t = page({ enabled: () => !own });
    scrollTo(t, 870);
    t.p.size = [800, 900];
    t.keeper.sized();
    for (let i = 0; i < 3; i++) t.p.frame();
    expect(t.p.y).toBe(870);
    expect(t.p.settled).toEqual([false, false, false, true]);
    // The place it wrote down is still good once the page lets go.
    own = false;
    t.p.size = [400, 700];
    t.p.y = 400;
    t.keeper.sized();
    expect(t.p.y).toBe(870);
  });
});

describe("believed", () => {
  it("is the first row while its neighbours stand as they stood", () => {
    // A phone's rows become a wide window's: closer together, in the same order.
    expect(believed([40, 136, -56], [300, 364, 236])).toBe(0);
    // A reply reflowed between two rows far apart.
    expect(believed([100, 2600], [100, 1500])).toBe(0);
    // A wide grid's one row becomes a phone's column.
    expect(believed([40, 40, 40], [10, 106, 202])).toBe(0);
  });

  it("is the next row when the first went elsewhere in the list", () => {
    // The card at the line was re-sorted to the top of the board: far above the others.
    expect(believed([40, 136, -56], [-2000, 300, 204])).toBe(1);
    // Or far below them.
    expect(believed([40, 136, -56], [5000, 300, 204])).toBe(1);
    // Or it is gone.
    expect(believed([40, 136, -56], [null, 300, 204])).toBe(1);
  });

  it("is a row alone, and none when every row went its own way or is gone", () => {
    expect(believed([40], [300])).toBe(0);
    expect(believed([40, 136], [null, 300])).toBe(1);
    expect(believed([40, 136, -56], [-2000, 300, 5000])).toBe(-1);
    expect(believed([40, 136], [null, null])).toBe(-1);
    expect(believed([], [])).toBe(-1);
  });
});
