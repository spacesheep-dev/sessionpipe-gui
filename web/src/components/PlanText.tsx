// SPDX-License-Identifier: Apache-2.0
// A plan review's plan under its question on the permission strip (ControlStrip.tsx).
// Its own chunk: the strip is in the first paint, and the Markdown it reads with is not.
import { useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";

/** The bottom of the last line that fits whole in the first `cap` pixels of `el`, so a
 *  clamp ends on a line and never halves one (a list item or a code span is taller). A
 *  heading whose next line falls under the fold would read as an empty section, so the
 *  clamp ends above it instead, unless that keeps less than half. */
function wholeLines(el: HTMLElement, cap: number): number {
  const top = el.getBoundingClientRect().top;
  const r = document.createRange();
  r.selectNodeContents(el);
  const rects = [...r.getClientRects()];
  const upTo = (y0: number) => {
    let fit = 0;
    for (const b of rects) {
      const y = b.bottom - top;
      if (y <= y0 && y > fit) fit = y;
    }
    return fit;
  };
  let fit = upTo(cap);
  for (const h of el.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const b = h.getBoundingClientRect();
    if (b.top - top >= fit || b.bottom - top < fit - 1) continue;
    const above = upTo(b.top - top);
    if (above >= cap / 2) fit = above;
    break;
  }
  return Math.ceil(fit) || cap;
}

/** Folds the plan to its clamp, from its top: a plan scrolled while it was whole would
 *  otherwise fold on its middle, with no way back up. True when it was cut. */
export function foldPlan(el: HTMLElement): boolean {
  el.style.maxHeight = "";
  el.scrollTop = 0;
  const cap = el.clientHeight;
  const over = el.scrollHeight > cap + 1;
  if (over) el.style.maxHeight = `${wholeLines(el, cap)}px`;
  return over;
}

/** Opens the plan to its cap (CSS's), ending halfway down a line, so a line cut in half
 *  always says there is more, as a long command does. A margin under a paragraph or a
 *  heading would otherwise end it on a clean edge. */
export function peekPlan(el: HTMLElement): void {
  el.style.maxHeight = "";
  const cap = el.clientHeight;
  if (el.scrollHeight <= cap + 1) return;
  const top = el.getBoundingClientRect().top - el.scrollTop;
  const lh = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
  const r = document.createRange();
  r.selectNodeContents(el);
  let mid = 0;
  for (const b of r.getClientRects()) {
    // A line's box, not a block's (a paragraph or a list is one box of several lines).
    const y = b.top - top + b.height / 2;
    if (b.height < 2 * lh && y <= cap && y > mid) mid = y;
  }
  if (mid) el.style.maxHeight = `${Math.floor(mid)}px`;
}

/** The plan a plan review asks to start on (its call's `input.plan`, tier 3), as the
 *  timeline reads Markdown, in the question's column: eight lines (six on a phone) until
 *  "Show the whole plan", then up to half the view, scrolling inside, a line cut in half
 *  at its foot. */
export function PlanText({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [whole, setWhole] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(".ctl-plan-text");
    if (!el) return;
    const measure = whole ? () => peekPlan(el) : () => setCut(foldPlan(el));
    measure();
    // The opened cap follows the view's height, which leaves the clamped box as it was.
    addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [text, whole]);
  return (
    <div className={whole ? "ctl-plan is-whole" : "ctl-plan"} ref={box}>
      <Markdown text={text} className="ctl-plan-text" />
      {(cut || whole) && (
        <button type="button" className="ctl-more" aria-expanded={whole} onClick={() => setWhole((w) => !w)}>
          {whole ? "Show less" : "Show the whole plan"}
        </button>
      )}
    </div>
  );
}
