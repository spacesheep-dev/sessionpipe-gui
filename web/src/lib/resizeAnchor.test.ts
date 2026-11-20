// SPDX-License-Identifier: Apache-2.0
// The reading place through a change of the window's width, on a page made of numbers: rows
// 100 px tall in a window 400 wide and 60 px tall in one 800 wide, under `above` px of
// page, scrolled by `y` as far as `end`, with the frames run by hand. What is tried is
// when a place is written down, when it is put back, and which scrolls are taken for the
// person's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnchorView, believed, placeKeeper, topOf, windowSize } from "./resizeAnchor";

interface Place {
  row: number;
  offset: number;
}

function page(o: { enabled?: () => boolean } = {}) {
  const p = {
    size: [400, 700] as [number, number],
    y: 0,
    above: 0,
    end: Number.POSITIVE_INFINITY,
    reads: 0,
    settled: [] as boolean[],
    frames: [] as (() => void)[],
    /** Runs the frames asked for so far; those they ask for wait for the next call. */
    frame() {
      for (const run of p.frames.splice(0)) run();
    },
    rowHeight: () => (p.size[0] >= 800 ? 60 : 100),
    /** A row's top in the window. */
    top: (row: number) => p.above + row * p.rowHeight() - p.y,
  };
  const view: AnchorView<Place> = {
    size: () => p.size,
    scrollY: () => p.y,
    read() {
      p.reads++;
      const row = Math.ceil((p.y - p.above) / p.rowHeight());
      return { row, offset: p.top(row) };
    },
    ask: (place) => p.top(place.row) - place.offset,
    scrollBy(px) {
      p.y = Math.min(p.end, p.y + px);
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

  it("writes no place down while the page keeps one of its own, and puts none back", () => {
    let own = true;
    const t = page({ enabled: () => !own });
    scrollTo(t, 870);
    expect(t.p.reads).toBe(0);
    t.p.size = [800, 900];
    t.keeper.sized();
    for (let i = 0; i < 3; i++) t.p.frame();
    expect(t.p.y).toBe(870);
    expect(t.p.settled).toEqual([false, false, false, true]);
    // The page lets go with no scroll (a row opened in place): written down from there.
    own = false;
    t.keeper.changed();
    t.p.frame();
    expect(t.p.reads).toBe(1);
    expect(t.p.top(15)).toBe(30);
    t.p.size = [400, 700];
    t.keeper.sized();
    expect(t.p.top(15)).toBe(30);
    for (let i = 0; i < 3; i++) t.p.frame();
    // Its own place again (scrolled to the end, which it follows): the one written down
    // is no longer where the person is.
    own = true;
    scrollTo(t, 2400);
    t.p.size = [800, 900];
    t.keeper.sized();
    expect(t.p.y).toBe(2400);
  });

  it("has no place for a page that was never scrolled, whatever changes on it", () => {
    const t = page();
    t.p.above = 112;
    t.keeper.changed();
    t.p.frame();
    expect(t.p.reads).toBe(0);
    // So a scroll the page has not heard of yet as the window changes is not undone.
    t.p.y = 240;
    t.p.size = [800, 900];
    t.keeper.sized();
    for (let i = 0; i < 3; i++) t.p.frame();
    expect(t.p.y).toBe(240);
  });

  it("writes the place down again when the page changed under a view that was not scrolled", () => {
    const t = page();
    scrollTo(t, 870);
    // A card arrives above: every row is 112 px further down, and nothing scrolled.
    t.p.above = 112;
    t.keeper.changed();
    t.keeper.changed();
    expect(t.p.reads).toBe(1);
    t.p.frame();
    expect(t.p.reads).toBe(2);
    // Row 8 is the one under the bar now, 42 px under it. Unfolded, it still is.
    expect(t.p.top(8)).toBe(42);
    t.p.size = [800, 900];
    t.keeper.sized();
    expect(t.p.top(8)).toBe(42);
  });

  it("keeps the place it has when the page changed somewhere else", () => {
    const t = page();
    scrollTo(t, 870);
    // The rows are where they were: nothing is read anew.
    t.keeper.changed();
    t.p.frame();
    expect(t.p.reads).toBe(1);
    // Unfolded near the end of a page now shorter: row 9 can be put back to 40 px under
    // the bar and no further, and changes heard while the window settles are its own.
    t.p.size = [800, 900];
    t.p.end = 500;
    t.p.y = 500;
    t.keeper.sized();
    t.keeper.changed();
    for (let i = 0; i < 3; i++) {
      t.p.frame();
      t.keeper.changed();
    }
    t.p.frame();
    expect(t.p.top(9)).toBe(40);
    expect(t.p.reads).toBe(1);
    // So folded back, it is where it began.
    t.p.size = [400, 700];
    t.p.end = Number.POSITIVE_INFINITY;
    t.keeper.sized();
    expect(t.p.y).toBe(870);
  });

  it("reads once, and anew, for a change and a scroll in one frame", () => {
    const t = page();
    scrollTo(t, 870);
    t.keeper.changed();
    t.p.y = 900;
    t.keeper.scrolled();
    expect(t.p.frames).toHaveLength(1);
    t.p.frame();
    expect(t.p.reads).toBe(2);
    t.p.size = [800, 900];
    t.keeper.sized();
    expect(t.p.top(9)).toBe(0);
  });

  it("does nothing more once the page is left", () => {
    const t = page();
    scrollTo(t, 870);
    t.p.size = [800, 900];
    t.keeper.sized();
    expect(t.p.settled).toEqual([false]);
    // Another page is shown before the window has settled.
    t.keeper.stop();
    t.p.y = 0;
    for (let i = 0; i < 3; i++) t.p.frame();
    expect(t.p.y).toBe(0);
    expect(t.p.settled).toEqual([false]);
    t.p.y = 200;
    t.keeper.scrolled();
    t.keeper.changed();
    t.p.frame();
    expect(t.p.reads).toBe(1);
    t.p.size = [400, 700];
    expect(t.keeper.sized()).toBe(false);
    expect(t.p.y).toBe(200);
  });
});

describe("topOf", () => {
  interface Fake {
    move?: number;
    parentElement: Fake | null;
    getBoundingClientRect(): { top: number; width: number; height: number };
    closest(selector: string): Fake | null;
  }
  /** A box drawn `top` px down the window, in `parent`; `move`: a list is moving it, and
   *  it is drawn that many px from where it is laid out. */
  const box = (top: number, o: { move?: number; parent?: Fake; size?: number } = {}): Fake => {
    const me: Fake = {
      move: o.move,
      parentElement: o.parent ?? null,
      getBoundingClientRect: () => ({ top, width: o.size ?? 300, height: o.size ?? 40 }),
      closest: (selector) => (me.move !== undefined ? me : (me.parentElement?.closest(selector) ?? null)),
    };
    return me;
  };
  const top = (of: Fake) => topOf(of as unknown as Element, (moving) => (moving as unknown as Fake).move ?? Number.NaN);

  it("is where a row is laid out, not where a move draws it", () => {
    expect(top(box(232))).toBe(232);
    // A card on its way down to a place 112 px under where it is drawn.
    const card = box(120, { move: -112 });
    expect(top(card)).toBe(232);
    // What is in the card moves with it; a row in it with a move of its own has both.
    expect(top(box(150, { parent: card }))).toBe(262);
    expect(top(box(160, { parent: card, move: 10 }))).toBe(262);
  });

  it("is none for a row with no box", () => {
    expect(top(box(0, { size: 0 }))).toBeNull();
  });
});

describe("windowSize", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the window's, and through a pinch the one it had before it", () => {
    const w = { innerWidth: 393, innerHeight: 852, visualViewport: { scale: 1 } };
    vi.stubGlobal("window", w);
    expect(windowSize()).toEqual([393, 852]);
    // Pinched to twice the size in a phone's browser: half the page is in view.
    Object.assign(w, { innerWidth: 197, innerHeight: 426, visualViewport: { scale: 2 } });
    expect(windowSize()).toEqual([393, 852]);
    // Let go, and the phone turned.
    Object.assign(w, { innerWidth: 852, innerHeight: 393, visualViewport: { scale: 1 } });
    expect(windowSize()).toEqual([852, 393]);
    // A window with no visual viewport to ask is taken as it is.
    Object.assign(w, { innerWidth: 700, innerHeight: 500, visualViewport: undefined });
    expect(windowSize()).toEqual([700, 500]);
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
