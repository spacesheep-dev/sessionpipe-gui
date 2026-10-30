// SPDX-License-Identifier: Apache-2.0
// Focus management shared by the dialogs and the lists: what is focusable, a focus trap
// that gives focus back on close, roving tabindex over a list (one tab stop, the arrows
// move inside), and the WAI-ARIA tabs keys for a tab strip.
import { type RefObject, useEffect, useRef } from "react";

export const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Every element inside `root` a Tab press could land on, in DOM order. */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("inert") && !el.closest("[inert]") && el.getClientRects().length > 0,
  );
}

export interface TrapOptions {
  /** Esc, or a click outside: the caller closes. */
  onClose?: () => void;
  /** Selector of the element to focus first; else the first focusable, else the root. */
  initial?: string;
  /** Give focus back to where it was when the trap closes (default true). */
  restore?: boolean;
}

/** While `active`, Tab cycles inside `ref`, Esc calls `onClose`, and focus goes back to
 *  the element that had it when the trap opened. The root gets `tabindex=-1` so it can
 *  hold focus when it has nothing focusable yet. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, opts: TrapOptions = {}): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
    const first = () => {
      // The first match that is drawn: a layout's other form of the same control (a
      // phone bar's button beside a desktop footer's) may be in the tree, display none.
      const want = optsRef.current.initial
        ? ([...root.querySelectorAll<HTMLElement>(optsRef.current.initial)].find(
            (el) => el.getClientRects().length > 0,
          ) ?? null)
        : null;
      (want ?? root.querySelector<HTMLElement>("[autofocus]") ?? focusables(root)[0] ?? root).focus({
        preventScroll: true,
      });
    };
    // After the open render, so autofocus and layout are in place.
    const raf = requestAnimationFrame(() => {
      if (!root.contains(document.activeElement)) first();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!optsRef.current.onClose) return;
        // An open pop-up inside the dialog (a Select) takes its own Esc first.
        const t = e.target as HTMLElement | null;
        if (t?.getAttribute?.("role") === "combobox" && t.getAttribute("aria-expanded") === "true") return;
        e.preventDefault();
        e.stopPropagation();
        optsRef.current.onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables(root);
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const i = list.indexOf(document.activeElement as HTMLElement);
      let next: HTMLElement | undefined;
      if (e.shiftKey) next = i <= 0 ? list[list.length - 1] : list[i - 1];
      else next = i < 0 || i === list.length - 1 ? list[0] : list[i + 1];
      e.preventDefault();
      next?.focus();
    };
    // Focus that escapes (a click on the scrim, a programmatic move) comes back in.
    const onFocusIn = (e: FocusEvent) => {
      if (root.contains(e.target as Node)) return;
      if ((e.target as HTMLElement | null)?.closest?.("[data-dismiss]")) return;
      first();
    };
    root.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      // Give focus back only while it is still ours (or nobody's): an overlay this one
      // handed over to (More → Display) has already taken it, and keeps it.
      const now = document.activeElement;
      const ours = !now || now === document.body || root.contains(now);
      if (optsRef.current.restore !== false && ours && before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [active, ref]);
}

/** Roving tabindex over the `[data-nav-item]` elements under `root`: the one at `cursor`
 *  (the first when there is none) is the list's single tab stop. Call after each render
 *  that may change the items. */
export function applyRoving(root: ParentNode, cursor: number): HTMLElement[] {
  const items = [...root.querySelectorAll<HTMLElement>("[data-nav-item]")];
  const stop = cursor >= 0 && cursor < items.length ? cursor : 0;
  items.forEach((el, i) => {
    el.tabIndex = i === stop ? 0 : -1;
  });
  return items;
}

/** The WAI-ARIA tabs keys on a tab strip with automatic activation: arrows move and
 *  activate, Home/End jump, Delete closes (when `close` is given). Returns true when the
 *  key was taken. */
export function tablistKey(
  e: { key: string; preventDefault(): void },
  count: number,
  index: number,
  o: { activate(i: number): void; close?(i: number): void; vertical?: boolean },
): boolean {
  if (count === 0) return false;
  const prev = o.vertical ? "ArrowUp" : "ArrowLeft";
  const next = o.vertical ? "ArrowDown" : "ArrowRight";
  let to = -1;
  if (e.key === prev) to = (index - 1 + count) % count;
  else if (e.key === next) to = (index + 1) % count;
  else if (e.key === "Home") to = 0;
  else if (e.key === "End") to = count - 1;
  else if ((e.key === "Delete" || e.key === "Backspace") && o.close) {
    e.preventDefault();
    o.close(index);
    return true;
  } else return false;
  e.preventDefault();
  o.activate(to);
  return true;
}

/** Focuses the tab at `index` inside a tablist, once it is rendered. */
export function focusTab(strip: HTMLElement | null, index: number): void {
  if (!strip) return;
  requestAnimationFrame(() => {
    strip.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
  });
}
