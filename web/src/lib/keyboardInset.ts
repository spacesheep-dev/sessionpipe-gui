// SPDX-License-Identifier: Apache-2.0
// The software keyboard's height as `--kb` on <html>, for what docks above it (the
// session's control strip, styles/session.css) and what makes room for it (a sheet's
// foot, a form sheet's height), and <html data-kb> while it is up, for what folds away on
// a short screen while typing (session.css, search.css). Shell.tsx keeps it for the app's
// whole life. WKWebView and a phone browser shrink only the visual viewport when the
// keyboard comes up, so the keyboard is what the layout viewport has below the visual one:
// innerHeight less the visual viewport's bottom edge.
// Android's shell resizes the view itself (MainActivity.kt) and the desktop apps have no
// software keyboard, so only iOS's shell and a plain browser follow it.
import { type RefObject, useEffect } from "react";

/** Below this the shortfall is a toolbar settling or rounding, not a keyboard (even a
 *  hardware keyboard's shortcut bar is taller). */
const KEYBOARD_MIN_PX = 30;

/** Whether this page should follow the keyboard at all: iOS's shell or a plain browser
 *  with a visual viewport; never Android's shell or a desktop app's. */
export function keyboardInsetWanted(shell: string | undefined, hasVisualViewport: boolean): boolean {
  return hasVisualViewport && (shell === undefined || shell === "ios");
}

/** The keyboard's height from the visual viewport: what the layout viewport has below the
 *  visual one, clamped at 0, and 0 while pinch-zoomed (the viewport is then smaller for
 *  another reason). */
export function keyboardHeight(vv: { height: number; offsetTop: number; scale: number }, innerHeight: number): number {
  if (vv.scale > 1.01) return 0;
  const kb = Math.round(innerHeight - vv.height - vv.offsetTop);
  return kb >= KEYBOARD_MIN_PX ? kb : 0;
}

/** What <html> is told of a keyboard `kb` px tall: `--kb` and `data-kb` together, both
 *  there while it is up and both gone with it. */
export function showKeyboard(
  root: Pick<HTMLElement, "setAttribute" | "removeAttribute"> & {
    style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
  },
  kb: number,
): void {
  if (kb > 0) {
    root.style.setProperty("--kb", `${kb}px`);
    root.setAttribute("data-kb", "");
  } else {
    root.style.removeProperty("--kb");
    root.removeAttribute("data-kb");
  }
}

/** Keeps `--kb` and `data-kb` on <html> while mounted, following the visual viewport's
 *  resize and scroll, and removes them on the way out so nothing docked keeps a stale
 *  inset. With no keyboard both are absent, so `var(--kb, 0px)` reads 0 and nothing moves. */
export function useKeyboardInset(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv || !keyboardInsetWanted(document.documentElement.dataset.shell, true)) return;
    const root = document.documentElement;
    const apply = () => showKeyboard(root, keyboardHeight(vv, window.innerHeight));
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      showKeyboard(root, 0);
    };
  }, []);
}

/** What the keyboard comes up for. */
const TYPED =
  "textarea, input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=file]), [contenteditable]";

/** While the keyboard is up, the field being typed in inside a sheet that scrolls (`ref`)
 *  is kept above it: as the field takes the focus, and again whenever the keyboard changes
 *  height. The sheet's status line comes into view with it when there is room for both,
 *  so what is said about the field is not under the keys either. The sheet's scroll-padding
 *  says where its bar and the keys are (control/newSessionSheet.css). */
export function useFieldAboveKeys(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let frame = 0;
    const keep = () => {
      const sheet = ref.current;
      const field = document.activeElement;
      if (!sheet || !document.documentElement.hasAttribute("data-kb")) return;
      if (!(field instanceof HTMLElement) || !sheet.contains(field) || !field.matches(TYPED)) return;
      const status = sheet.querySelector<HTMLElement>(".ns-status");
      if (status?.textContent?.trim()) {
        const style = getComputedStyle(sheet);
        const room =
          sheet.clientHeight -
          (Number.parseFloat(style.scrollPaddingTop) || 0) -
          (Number.parseFloat(style.scrollPaddingBottom) || 0);
        const f = field.getBoundingClientRect();
        const s = status.getBoundingClientRect();
        if (s.top >= f.top && s.bottom - f.top <= room) status.scrollIntoView({ block: "nearest" });
      }
      field.scrollIntoView({ block: "nearest" });
    };
    // A frame later: the keyboard's new height is on <html> (Shell's listener may come after
    // this one) and laid out.
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(keep);
    };
    const vv = window.visualViewport;
    document.addEventListener("focusin", soon);
    vv?.addEventListener("resize", soon);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", soon);
      vv?.removeEventListener("resize", soon);
    };
  }, [ref]);
}
