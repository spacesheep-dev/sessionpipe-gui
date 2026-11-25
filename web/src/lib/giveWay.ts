// SPDX-License-Identifier: Apache-2.0
// Owned by: web. On a one-line row of facts, the part that gives way first (a repo) is cut
// at its end while its words keep a few characters' room; below that it leaves the line
// whole, so the line never ends in a dangling "· a…". Marked `data-give-way` in the line;
// `data-gone` takes it off the line but not from a screen reader (styles/shared.css).
// Checked after every render, again when the room the line is given changes, and once the
// fonts are in; the line's cut chips measure again at once when it flips (MEASURE_EVENT),
// so no frame shows a chip cut to the room it had before.
import { type RefObject, useLayoutEffect } from "react";

/** The event a line sends its cut chips (components/bits.tsx CutChip) when it changes their
 *  room itself: each measures again at once, before the line is drawn. */
export const MEASURE_EVENT = "midcut:measure";

/** The room, in ems, below which a cut part leaves whole: about four characters. */
export const GIVE_WAY_EM = 3;

/** Whether a part whose words are given `width` px, cut or not, leaves the line: only when
 *  it is cut and its words have less than GIVE_WAY_EM of its own font. */
export const leavesLine = (p: { cut: boolean; width: number; fontPx: number }): boolean =>
  p.cut && p.width < GIVE_WAY_EM * p.fontPx;

/** The part's own words: its last text node ("acme/infra", not the "· " before it, nor
 *  the dot a stylesheet draws). */
function words(part: HTMLElement): Text | null {
  for (let n = part.lastChild; n; n = n.previousSibling)
    if (n.nodeType === Node.TEXT_NODE && n.nodeValue?.trim()) return n as Text;
  return null;
}

/** Keep the `[data-give-way]` part of `line` whole or gone, never a stub; true when it
 *  flipped (and the line's chips were told to measure again). */
export function giveWay(line: HTMLElement): boolean {
  const part = line.querySelector<HTMLElement>("[data-give-way]");
  if (!part) return false;
  const was = part.hasAttribute("data-gone");
  // Back in first (only when it had gone), then measured as the line would draw it.
  if (was) part.removeAttribute("data-gone");
  const cut = part.scrollWidth > part.clientWidth + 0.5;
  let gone = false;
  if (cut) {
    const text = words(part);
    const range = document.createRange();
    if (text) range.selectNodeContents(text);
    // From where its words start to where the part is cut off.
    const width = part.getBoundingClientRect().right - (text ? range.getBoundingClientRect().left : 0);
    const fontPx = Number.parseFloat(getComputedStyle(part).fontSize) || 13;
    gone = leavesLine({ cut, width: text ? width : 0, fontPx });
  }
  if (gone) part.setAttribute("data-gone", "");
  if (gone === was) return false;
  for (const chip of line.querySelectorAll(".chip.midcut")) chip.dispatchEvent(new Event(MEASURE_EVENT));
  return true;
}

/** Keep the `[data-give-way]` part of `line` whole or gone (giveWay). `room` names the
 *  ancestor whose width is the room the line is given, not one as wide as what the line
 *  holds (which the part leaving would change): it is watched for that room changing. */
export function useGiveWay(line: RefObject<HTMLElement | null>, on: boolean, room: string): void {
  // After every render: what the line holds may have changed.
  useLayoutEffect(() => {
    if (on && line.current) giveWay(line.current);
  });
  // Once while on: the room changing, and the fonts coming in.
  useLayoutEffect(() => {
    const el = line.current;
    if (!on || !el || typeof ResizeObserver !== "function") return;
    const box = el.closest<HTMLElement>(room) ?? el.parentElement ?? el;
    let first = true;
    const ro = new ResizeObserver(() => {
      // Its first word is the size the check above has just seen.
      if (first) first = false;
      else giveWay(el);
    });
    ro.observe(box);
    let live = true;
    document.fonts?.ready.then(() => live && giveWay(el));
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [on, room, line]);
}
