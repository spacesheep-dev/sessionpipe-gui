// SPDX-License-Identifier: Apache-2.0
// The software keyboard's height as `--kb` on <html>, for what docks above it (the
// session's control strip, styles/session.css). WKWebView and a phone browser shrink only
// the visual viewport when the keyboard comes up, so the keyboard is what the layout
// viewport has below the visual one: innerHeight less the visual viewport's bottom edge.
// Android's shell resizes the view itself (MainActivity.kt) and the desktop apps have no
// software keyboard, so only iOS's shell and a plain browser follow it.
import { useEffect } from "react";

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

/** Keeps `--kb` on <html> at the keyboard's height while mounted (and `on`), following the
 *  visual viewport's resize and scroll, and removes it on the way out so nothing docked
 *  keeps a stale inset. With no keyboard the property is absent, so `var(--kb, 0px)`
 *  reads 0 and nothing moves. */
export function useKeyboardInset(on = true): void {
  useEffect(() => {
    if (!on || typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv || !keyboardInsetWanted(document.documentElement.dataset.shell, true)) return;
    const root = document.documentElement;
    const apply = () => {
      const kb = keyboardHeight(vv, window.innerHeight);
      if (kb > 0) root.style.setProperty("--kb", `${kb}px`);
      else root.style.removeProperty("--kb");
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--kb");
    };
  }, [on]);
}
