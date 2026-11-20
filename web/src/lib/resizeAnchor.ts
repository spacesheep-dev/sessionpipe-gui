// SPDX-License-Identifier: Apache-2.0
// The reading place through a change of the window's width: a phone unfolded, folded or
// turned, a window dragged narrower. A browser keeps the scroll offset in px while the
// page above it wraps anew, so the row being read ends up a screen away (and CSS scroll
// anchoring does not act on a resize, in Chromium or WebKit). Here the row being read is
// written down as the page is scrolled, and put back where it was once the width has
// changed: at the first sign of the new size, and again over the next frames, as the
// layout the width decides is rendered.
//
// The row being read is the one at a line a third of the way down the view, where the
// session page itself puts what is to be read next (its New line). Everything else on
// screen moves by what wraps between it and that row, so the row that is held is one in
// the middle of what is read, not the one at its edge under the bar.
//
// A scroll heard with another window size than the last one is never the person's: it is
// the browser fitting the page to its new window. WebKit sends it first, before the
// "resize" (which there can come after a frame's ResizeObservers), so the first sign is
// whichever comes first: that scroll, the "resize", or a ResizeObserver on the document.
import { useEffect, useRef } from "react";

/** Frames after a change of size in which the place is put back again and none is read:
 *  the other layout is rendered after the browser's "resize", and what measures itself in
 *  it (a long message folding to its eight lines) a frame later. */
const SETTLE_FRAMES = 3;
/** A reflow takes two rows at most this many times further apart, and this many px more
 *  (a wide grid's row becoming a phone's column). */
const REACH = 4;
const SLACK = 240;

/** Which of the rows written down to believe, by where each was (`was`, px under the bar)
 *  and where it is now (`now`, null: gone): the first that still stands with another as it
 *  stood, in the same order and within a reflow's reach of it. A card the list has moved
 *  elsewhere since stands with none, and the next row holds the place. One row alone is
 *  believed; -1 when none can be. */
export function believed(was: readonly number[], now: readonly (number | null)[]): number {
  const there = now.flatMap((top, i) => (top === null ? [] : [i]));
  if (there.length < 2) return there[0] ?? -1;
  const stand = (i: number, j: number): boolean => {
    const [a, b] = was[i]! <= was[j]! ? [i, j] : [j, i];
    const apart = now[b]! - now[a]!;
    return apart >= 0 && apart <= REACH * (was[b]! - was[a]!) + SLACK;
  };
  return there.find((i) => there.some((j) => j !== i && stand(i, j))) ?? -1;
}

/** The page as the keeper needs it: a few calls in front of the DOM, so its rules can be
 *  tried without one (resizeAnchor.test.ts). `Place` is whatever `read` writes down. */
export interface AnchorView<Place> {
  /** The window: innerWidth, innerHeight. */
  size(): readonly [number, number];
  scrollY(): number;
  /** What holds the place now. */
  read(): Place;
  /** How far to scroll to put it back, or null when nothing of it is left. */
  ask(place: Place): number | null;
  scrollBy(px: number): void;
  /** requestAnimationFrame. */
  frame(run: () => void): void;
  /** False while the page keeps a place of its own (a session followed at its end). */
  enabled(): boolean;
  /** After each time the place was put back, or would have been; `last`: the window has
   *  settled. For the page's own place. */
  settle?(last: boolean): void;
}

/** Keeps a page's place: `scrolled` on each scroll, `sized` at anything that may be the
 *  first sign of another window size (it is true while the page settles in it). */
export function placeKeeper<Place>(view: AnchorView<Place>): { scrolled(): void; sized(): boolean } {
  let seen = view.size();
  let kept: Place | null = null;
  let reading = false;
  let settling = 0;
  /** The width is another one since the page last settled: only then do rows wrap anew.
   *  A height alone changes as a phone browser's toolbar slides away under a scroll. */
  let wrapped = false;
  /** Where the last step left the page: a scroll that ends there is its own echo. */
  let left: number | null = null;

  const step = (last: boolean) => {
    if (wrapped && kept !== null && view.enabled()) {
      const by = view.ask(kept);
      if (by !== null && Math.abs(by) >= 1) view.scrollBy(by);
    }
    view.settle?.(last);
    left = view.scrollY();
    if (last) wrapped = false;
  };
  const tick = () => {
    settling--;
    step(settling === 0);
    if (settling > 0) view.frame(tick);
  };
  const sized = (): boolean => {
    const [w, h] = view.size();
    if (w !== seen[0] || h !== seen[1]) {
      if (w !== seen[0]) wrapped = true;
      seen = [w, h];
      const began = settling > 0;
      settling = SETTLE_FRAMES;
      step(false);
      if (!began) view.frame(tick);
    }
    return settling > 0;
  };
  const read = () => {
    reading = false;
    if (!sized()) kept = view.read();
  };
  return {
    sized,
    scrolled() {
      if (sized() || reading) return;
      if (left !== null && Math.abs(view.scrollY() - left) < 1) return;
      left = null;
      reading = true;
      view.frame(read);
    },
  };
}

export interface ResizeAnchorOptions {
  /** The rows that can hold the place, in reading order: one compound selector. */
  rows: string;
  /** The attribute that names a row for as long as it is on the page. */
  key: string;
  /** Inside a row, the parts that hold the place for it (a reply's paragraphs: a reply can
   *  be longer than the screen). */
  blocks?: string;
  /** Where the rows are (default: the document). */
  root?: () => ParentNode | null;
  /** What the rows are of, where one page shows now one list and now another under the
   *  same names (a session's rows are numbered from 0): a place written down in one is
   *  never put back in another. */
  of?: string;
  /** The element that scrolls; the window without one. */
  scroller?: () => HTMLElement | null;
  /** The bottom edge of the bar over the top of the view, in the window's px. */
  barBottom: () => number;
  /** False while the page keeps a place of its own; rows are then not put back. */
  enabled?: () => boolean;
  /** `AnchorView.settle`. */
  settle?: (last: boolean) => void;
}

/** A row written down: the element (the attribute finds it again if the page drew it
 *  anew), the block of it that held the place if one did, and where its top was. */
interface Mark {
  el: HTMLElement;
  key: string;
  block?: number;
  offset: number;
}

/** The bottom of the bar stuck to the top of the page `inside` is in (components/PageBar.tsx). */
export const pageBarBottom = (inside: () => Element | null) => (): number =>
  inside()?.closest(".page")?.querySelector(":scope > .bar")?.getBoundingClientRect().bottom ?? 0;

/** An element's top in the window, or null when it has no box (a row in a folded group). */
function topOf(el: Element): number | null {
  const r = el.getBoundingClientRect();
  return r.width || r.height ? r.top : null;
}

/** The index of the first of `els` whose top is at or under `line`, or their count. They
 *  are in reading order, so tops never decrease, and a scroll moves the answer by a row
 *  or two: the walk starts `from` the last one, back while the row before is under the
 *  line too, then on while this one is above it. Rows with no box are passed over. */
function firstUnder(els: ArrayLike<Element>, line: number, from: number): number {
  let i = Math.max(0, Math.min(from, els.length - 1));
  for (let j = i - 1; j >= 0; j--) {
    const top = topOf(els[j]!);
    if (top === null) continue;
    if (top < line) break;
    i = j;
  }
  for (; i < els.length; i++) {
    const top = topOf(els[i]!);
    if (top !== null && top >= line) break;
  }
  return i;
}

/** How many rows with no box are passed over in looking for the one before. */
const LOOK = 32;

/** The last of `els` before index `end` that has a box, or -1. */
function lastBoxed(els: ArrayLike<Element>, end: number): number {
  for (let i = end - 1; i >= 0 && i >= end - LOOK; i--) if (topOf(els[i]!) !== null) return i;
  return -1;
}

/** Keeps the reading place of a list or a timeline through a change of the window's
 *  width: the row at the reading line, a third of the way down the view under the bar
 *  (the last row that starts at or above it; near the page's top, the first under it), or
 *  the one of its `blocks` at that line. The rows next to it are written down with it and
 *  vouch for it (`believed`). Nothing is put back while `enabled()` is false. */
export function useResizeAnchor(o: ResizeAnchorOptions): void {
  const opts = useRef(o);
  opts.current = o;
  const { scroller } = o;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const box = scroller?.() ?? null;
    const root = (): ParentNode | null => (opts.current.root ? opts.current.root() : document);
    const blocksOf = (row: Element) => row.querySelectorAll<HTMLElement>(opts.current.blocks ?? ":not(*)");
    let rowHint = 0;
    let blockHint = 0;
    let readOf: string | undefined;
    const keeper = placeKeeper<Mark[]>({
      size: () => [window.innerWidth, window.innerHeight],
      scrollY: () => box?.scrollTop ?? window.scrollY,
      scrollBy: (px) => {
        if (box) box.scrollTop += px;
        else window.scrollBy(0, px);
      },
      frame: (run) => void requestAnimationFrame(run),
      enabled: () => opts.current.enabled?.() ?? true,
      settle: (last) => opts.current.settle?.(last),
      read() {
        const { key, blocks } = opts.current;
        const bar = opts.current.barBottom();
        const bottom = box?.getBoundingClientRect().bottom ?? window.innerHeight;
        const line = bar + (bottom - bar) / 3;
        const rows = root()?.querySelectorAll<HTMLElement>(opts.current.rows) ?? [];
        const marks: Mark[] = [];
        readOf = opts.current.of;
        const mark = (row: HTMLElement | undefined, part?: HTMLElement, block?: number) => {
          const top = row && topOf(part ?? row);
          const k = row?.getAttribute(key);
          if (row && k && top !== null && top !== undefined) marks.push({ el: row, key: k, block, offset: top - bar });
        };
        // A row that starts on the line is the row at it.
        const under = firstUnder(rows, line + 0.5, rowHint);
        rowHint = under;
        const at = lastBoxed(rows, under);
        if (blocks && at >= 0) {
          const parts = blocksOf(rows[at]!);
          const part = lastBoxed(parts, firstUnder(parts, line + 0.5, blockHint));
          blockHint = Math.max(part, 0);
          if (part >= 0) mark(rows[at], parts[part], part);
          if (marks.length) return marks;
        }
        mark(rows[at]);
        mark(rows[under]);
        mark(rows[at >= 0 ? lastBoxed(rows, at) : under + 1]);
        return marks;
      },
      ask(marks) {
        const { rows, key } = opts.current;
        if (opts.current.of !== readOf) return null;
        const bar = opts.current.barBottom();
        const tops = marks.map((m) => {
          const row = m.el.isConnected
            ? m.el
            : root()?.querySelector<HTMLElement>(`${rows}[${key}="${CSS.escape(m.key)}"]`);
          const el = m.block === undefined ? row : row && blocksOf(row)[m.block];
          return el ? topOf(el) : null;
        });
        const i = believed(
          marks.map((m) => m.offset),
          tops,
        );
        return i < 0 ? null : tops[i]! - bar - marks[i]!.offset;
      },
    });
    const target: EventTarget = box ?? window;
    const onSized = () => void keeper.sized();
    target.addEventListener("scroll", keeper.scrolled, { passive: true });
    window.addEventListener("resize", onSized);
    // Before the frame is painted, where the "resize" itself comes late (WebKit).
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(onSized) : null;
    ro?.observe(document.documentElement);
    return () => {
      target.removeEventListener("scroll", keeper.scrolled);
      window.removeEventListener("resize", onSized);
      ro?.disconnect();
    };
  }, [scroller]);
}
