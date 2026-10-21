// SPDX-License-Identifier: Apache-2.0
// The phone's keyboard, as far as CSS can know it. While the composer's text area has focus
// on a phone, <html> carries `data-composing` (app.css hides the tab bar and the context
// line's explanation) and `--keyboard`, how much of the layout viewport the keyboard covers
// per `visualViewport`, for the sticky composer where Safari leaves it under the keyboard.
import { useEffect } from "react";

const ATTR = "data-composing";
const VAR = "--keyboard";
const PHONE = "(max-width: 839px)";
const COMPOSER = ".sess-ctl";
/** The layout goes back this long after the field blurs: a tap on one of the composer's own
 *  buttons blurs it first, and the tab bar must not come back under the finger before the tap lands. */
const SETTLE_MS = 250;

const inComposer = (t: EventTarget | null): t is HTMLTextAreaElement =>
  t instanceof HTMLTextAreaElement && t.closest(COMPOSER) !== null;

/** The layout viewport's bottom the visual viewport does not reach; nothing while pinch-zoomed. */
const covered = (): number => {
  const vv = window.visualViewport;
  if (!vv || vv.scale > 1) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
};

export function useComposing(): void {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    const phone = window.matchMedia?.(PHONE);
    let on = false;
    let off: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      root.style.setProperty(VAR, `${on ? covered() : 0}px`);
    };
    const set = (next: boolean) => {
      clearTimeout(off);
      if (next === on) return;
      on = next;
      root.toggleAttribute(ATTR, on);
      if (on) {
        vv?.addEventListener("resize", measure);
        vv?.addEventListener("scroll", measure);
      } else {
        vv?.removeEventListener("resize", measure);
        vv?.removeEventListener("scroll", measure);
      }
      measure();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (phone?.matches && inComposer(e.target)) set(true);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!inComposer(e.target) || inComposer(e.relatedTarget)) return;
      clearTimeout(off);
      off = setTimeout(() => set(false), SETTLE_MS);
    };
    const onMedia = () => {
      if (!phone?.matches) set(false);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    phone?.addEventListener("change", onMedia);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      phone?.removeEventListener("change", onMedia);
      clearTimeout(off);
      root.removeAttribute(ATTR);
      root.style.removeProperty(VAR);
    };
  }, []);
}
