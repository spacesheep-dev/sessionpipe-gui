// SPDX-License-Identifier: Apache-2.0
// Owned by: web. On a one-line row of facts, the part that gives way first (a repo) is cut
// at its end while it keeps a few characters' room; below that it leaves whole, so the line
// never ends in a dangling "· a…". Marked `data-give-way` in the line; `data-gone` hides it
// (styles/shared.css). Measured after every render and again when the line changes width.
import { type RefObject, useLayoutEffect } from "react";

/** The room, in ems, below which a cut part leaves whole: about four characters. */
export const GIVE_WAY_EM = 3;

/** Whether a part drawn `width` px wide, cut or not, leaves the line: only when it is cut
 *  and narrower than GIVE_WAY_EM of its own font. */
export const leavesLine = (p: { cut: boolean; width: number; fontPx: number }): boolean =>
  p.cut && p.width < GIVE_WAY_EM * p.fontPx;

/** Keep the `[data-give-way]` part of `line` whole or gone, never a stub. */
export function useGiveWay(line: RefObject<HTMLElement | null>, on: boolean): void {
  useLayoutEffect(() => {
    const el = line.current;
    if (!on || !el) return;
    const check = () => {
      const part = el.querySelector<HTMLElement>("[data-give-way]");
      if (!part) return;
      // Back in first, then measured as the line would draw it.
      part.removeAttribute("data-gone");
      const width = part.getBoundingClientRect().width;
      const cut = part.scrollWidth > part.clientWidth + 0.5;
      const fontPx = Number.parseFloat(getComputedStyle(part).fontSize) || 13;
      if (leavesLine({ cut, width, fontPx })) part.setAttribute("data-gone", "");
    };
    check();
    if (typeof ResizeObserver !== "function") return;
    // The line's own box: a part that leaves narrows what the line holds, not its room, so
    // the check settles on the same answer.
    const ro = new ResizeObserver(check);
    ro.observe(el.parentElement ?? el);
    let live = true;
    document.fonts?.ready.then(() => live && check());
    return () => {
      live = false;
      ro.disconnect();
    };
  });
}
