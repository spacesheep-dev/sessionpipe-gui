// SPDX-License-Identifier: Apache-2.0
// The page's active scroller: while the desktop split panel is open (.shell.shell--split),
// the document is locked to the viewport and <main id="main"> owns page scrolling so the
// window never grows an outer scrollbar beside the panel's own scroller.
import { createContext, type RefObject, useContext } from "react";

export const PageScrollerCtx = createContext<RefObject<HTMLElement | null> | null>(null);

export const usePageScrollerRef = (): RefObject<HTMLElement | null> | null => useContext(PageScrollerCtx);

export const pageScroller = (): HTMLElement | null =>
  typeof document === "undefined" ? null : document.querySelector<HTMLElement>(".shell.shell--split > main#main");

export const pageScrollY = (): number => pageScroller()?.scrollTop ?? window.scrollY;

export const scrollPageTo = (top: number, behavior?: ScrollBehavior): void => {
  const el = pageScroller();
  if (el) el.scrollTo({ top, ...(behavior ? { behavior } : {}) });
  else window.scrollTo({ top, ...(behavior ? { behavior } : {}) });
};
