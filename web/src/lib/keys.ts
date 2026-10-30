// SPDX-License-Identifier: Apache-2.0
// The page-level keys, all through the one keymap (lib/shortcuts.ts): the global actions
// (go to a page, search, Esc, the appearance, the lens) get their handlers here, and
// `useListNav` gives a list a cursor the list actions move (j/k or the arrows), with one
// tab stop (roving tabindex over `[data-nav-item]`) so Tab enters the list once and the
// arrows walk it. The list's other keys live here too: `.` opens the row's menu at the
// row, Space peeks it beside the page, Esc clears the list's filter and then its cursor
// before it goes back, and in the installed app ⌘1–9 open the nth row (hold ⌘ to see the
// numbers). Coming back to a list (Back) puts the cursor where it was.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { prefetchSession } from "../data/prefetch";
import type { Store } from "../data/store";
import { applyRoving } from "./focus";
import { back, navigate, parseRoute, usePath } from "./router";
import { cycleLens } from "./settings";
import { installDispatcher, isTyping, registerHandler, useShortcut } from "./shortcuts";
import { isPlain, useSkins } from "./skins";
import { openSplit } from "./split";
import { setSkin, setTheme, useSettings } from "./theme";

export { isTyping };

export function focusSearch(): boolean {
  const el = document.querySelector<HTMLInputElement>("[data-search]");
  if (!el) return false;
  el.focus();
  el.select();
  return true;
}

/** The scheme the page shows right now. */
const resolved = (): "dark" | "light" => {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark" || t === "light") return t;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const NAV: Record<string, string> = {
  "nav.board": "/",
  "nav.inbox": "/inbox",
  "nav.search": "/search",
  "nav.feed": "/feed",
  "nav.review": "/review",
  "nav.machines": "/machines",
  "nav.usage": "/usage",
  "nav.workflows": "/workflows",
  "nav.connect": "/connect",
  "nav.setup": "/setup",
  "nav.views": "/themes",
  "nav.shortcuts": "/shortcuts",
};

/** The rail's pages: Esc never goes back from one of them. */
const TOP = new Set([
  "board",
  "inbox",
  "feed",
  "review",
  "search",
  "machines",
  "usage",
  "workflows",
  "connect",
  "setup",
  "themes",
  "shortcuts",
  "phone",
]);

/** The dispatcher and the global actions. Mounted once, in the shell. */
export function useGlobalKeys(onBack: () => void = () => back("/")) {
  const settings = useSettings();
  const { skins } = useSkins();
  const path = usePath();
  useEffect(() => installDispatcher(), []);
  useEffect(() => {
    const offs = Object.entries(NAV).map(([id, to]) => registerHandler(id, () => navigate(to)));
    return () => {
      for (const off of offs) off();
    };
  }, []);
  useShortcut("search.focus", () => (focusSearch() ? undefined : false));
  // ⌘⇧F from anywhere: the Search page, its field focused and its text selected.
  useShortcut("search.global", () => {
    if (parseRoute(path.split("?")[0] ?? "/").name !== "search") navigate("/search");
    requestAnimationFrame(() => focusSearch());
  });
  useShortcut("back", (e) => {
    if (isTyping(e.target)) {
      (e.target as HTMLElement).blur();
      return;
    }
    // Only one that is drawn: the panel keeps its Close in the DOM while it is shut.
    const open = [...document.querySelectorAll<HTMLElement>("[data-dismiss]")].find(drawn);
    if (open) {
      open.click();
      return;
    }
    // On a page with nowhere to go back to, Esc does nothing (no reload-looking jump); nor
    // on a page of the rail: it is a place, not a step, and Back there would leave the app.
    if (path === "/" && history.length <= 1) return false;
    if (TOP.has(parseRoute(path.split("?")[0] ?? "/").name)) return false;
    onBack();
  });
  useShortcut("appearance.toggle", () => {
    const next = resolved() === "dark" ? "light" : "dark";
    // A single-scheme skin pins the appearance: step to the first skin that lets go of it.
    if (settings.skin.scheme !== "both") {
      const free = skins.find((s) => s.scheme === "both" && !s.error);
      if (free) setSkin(free);
    }
    setTheme(next);
  });
  useShortcut("colorTheme.next", () => {
    // The skins the Display popover lists: Plain is the unlisted base, never a step.
    const all = skins.filter((s) => !s.error && !isPlain(s));
    const i = all.findIndex((s) => s.id === settings.skin.id);
    const next = all[(i + 1) % all.length];
    if (next) setSkin(next);
  });
  useShortcut("lens.cycle", () => {
    cycleLens();
  });
  useShortcut("toasts.focus", () => {
    const stack = document.querySelector<HTMLElement>('.toasts, [role="region"][aria-label="Notifications"]');
    if (!stack) return false;
    const target = stack.querySelector<HTMLElement>("button:not([disabled])") ?? stack;
    if (target === stack && !stack.hasAttribute("tabindex")) stack.tabIndex = -1;
    target.focus();
  });
}

/** The installed app (a standalone window, or one with its controls overlaid): the one
 *  place ⌘1–9 are ours; in a browser tab they switch tabs. */
export const installedApp = (): boolean =>
  typeof matchMedia === "function" &&
  (matchMedia("(display-mode: standalone)").matches ||
    matchMedia("(display-mode: window-controls-overlay)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

/** The row a list's cursor was on when the page was left, by path (the row's href): Back
 *  puts it there again (app.tsx restores the scroll). */
const lastCursor = new Map<string, string>();
/** Set by app.tsx for the render after a Back (popstate); read once by the list. */
let restoring = false;
export function markRestoring(on: boolean): void {
  restoring = on;
}

export interface ListNavOptions {
  /** Space peeks the row beside the page: the keymap action that does it on this page. */
  peek?: "board.peek" | "inbox.peek";
  /** Esc first clears this (true when it did; a list with no filter returns false). */
  clear?: () => boolean;
  /** Warm the session under a resting cursor (data/prefetch.ts). */
  store?: Store;
  /** What Enter does with the item at this index, in place of going to its href (Usage
   *  opens New session there); false when it does nothing. */
  open?: (index: number) => boolean;
}

/** A cursor over a list of hrefs, moved by the list actions; Enter opens the one under it,
 *  shift+Enter opens it beside the page when `keys` (session keys, same order) are given,
 *  mod+Enter beside as a background tab. The list's items carry `data-nav-item` (one tab
 *  stop; the arrows walk them) and the cursor item `data-cursor`. */
export function useListNav(hrefs: string[], enabled = true, keys?: string[], opts: ListNavOptions = {}) {
  const path = usePath().split("?")[0] ?? "/";
  const [cursor, setCursor] = useState(() => {
    if (!restoring) return -1;
    const href = lastCursor.get(path);
    return href ? hrefs.indexOf(href) : -1;
  });
  // Coming back, focus follows the restored cursor once (the scroll is app.tsx's).
  const restored = useRef(cursor >= 0);
  /** Back's row, while the list has not drawn it yet (a live list fills in after paint). */
  const pending = useRef<string | null>(restoring && cursor < 0 ? (lastCursor.get(path) ?? null) : null);
  /** The row the cursor is on: it follows the row, not the index, when a live list
   *  reorders or a row above it comes or goes. */
  const onRow = useRef<string | null>(cursor >= 0 ? (hrefs[cursor] ?? null) : null);
  /** True when a key moved the cursor, so focus follows; a click or Tab sets it silently. */
  const byKey = useRef(false);
  /** The cursor last moved by following focus (a click, Tab), not a key. */
  const followed = useRef(false);
  const lastHrefs = useRef(hrefs);
  // After every commit: a list that changed under the cursor moves the cursor with its
  // row; otherwise the cursor's index names its row (a key or a click moved it).
  useLayoutEffect(() => {
    const was = lastHrefs.current;
    lastHrefs.current = hrefs;
    if (pending.current) {
      const i = hrefs.indexOf(pending.current);
      if (i < 0) return;
      pending.current = null;
      restored.current = true;
      setCursor(i);
      return;
    }
    const changed = was !== hrefs && (was.length !== hrefs.length || was.some((h, i) => h !== hrefs[i]));
    if (changed && onRow.current) {
      const i = hrefs.indexOf(onRow.current);
      if (i >= 0 && i !== cursor) {
        setCursor(i);
        return;
      }
    }
    if (cursor >= hrefs.length) {
      setCursor(hrefs.length - 1);
      return;
    }
    onRow.current = cursor >= 0 ? (hrefs[cursor] ?? null) : null;
  });

  const root = () => document.getElementById("main") ?? document.body;
  const move = (d: 1 | -1) => {
    byKey.current = true;
    setCursor((c) => {
      const n = c < 0 && d === 1 ? 0 : Math.max(0, Math.min(hrefs.length - 1, c + d));
      return n;
    });
  };
  useShortcut("list.down", () => (hrefs.length ? move(1) : false), { enabled });
  useShortcut("list.up", () => (hrefs.length ? move(-1) : false), { enabled });
  const open = (mode: "page" | "beside" | "background") => {
    const href = hrefs[cursor];
    if (!href) return false;
    if (opts.open) return opts.open(cursor);
    const key = keys?.[cursor];
    if (mode !== "page" && key) {
      openSplit(key, {
        from: document.querySelector(`[data-cursor="${cursor}"]`)?.getBoundingClientRect(),
        background: mode === "background",
      });
    } else navigate(href);
    return true;
  };
  useShortcut("list.open", () => open("page"), { enabled });
  useShortcut("list.beside", () => open("beside"), { enabled });
  useShortcut("list.background", () => open("background"), { enabled });
  // Space: the row beside the page, the focus staying on the list (Quick Look).
  useShortcut(opts.peek ?? "board.peek", () => (opts.peek && keys?.[cursor] ? open("beside") : false), {
    enabled: enabled && !!opts.peek,
  });
  // `.`: the row's own right-click menu, under the row, the keyboard's way in.
  useShortcut(
    "list.menu",
    () => {
      const el =
        document.querySelector<HTMLElement>(`[data-cursor="${cursor}"] [data-nav-item]`) ??
        document.querySelector<HTMLElement>(`[data-cursor="${cursor}"]`);
      if (cursor < 0 || !el || inPanel()) return false;
      el.focus({ preventScroll: true });
      const r = el.getBoundingClientRect();
      const ce = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 24,
        clientY: r.bottom,
      }) as MouseEvent & { __kbd?: boolean };
      ce.__kbd = true;
      el.dispatchEvent(ce);
    },
    { enabled },
  );
  // Esc, in two steps before it goes back: the filter, then the cursor.
  useShortcut(
    "back",
    (e) => {
      if (isTyping(e.target) || openDismiss() || inPanel()) return false;
      if (opts.clear?.()) return;
      if (cursor < 0) return false;
      setCursor(-1);
      (document.activeElement as HTMLElement | null)?.blur();
    },
    { enabled, priority: 1 },
  );
  // ⌘1–9, the installed app only: the nth row of the list as it stands.
  const jump = (i: number) => () => {
    if (!installedApp() || inPanel() || !hrefs[i]) return false;
    if (opts.open) return opts.open(i);
    navigate(hrefs[i]!);
  };
  useShortcut("list.jump1", jump(0), { enabled });
  useShortcut("list.jump2", jump(1), { enabled });
  useShortcut("list.jump3", jump(2), { enabled });
  useShortcut("list.jump4", jump(3), { enabled });
  useShortcut("list.jump5", jump(4), { enabled });
  useShortcut("list.jump6", jump(5), { enabled });
  useShortcut("list.jump7", jump(6), { enabled });
  useShortcut("list.jump8", jump(7), { enabled });
  useShortcut("list.jump9", jump(8), { enabled });
  useJumpHints(enabled && hrefs.length > 0);

  // One tab stop per list, and the cursor follows focus (Tab, a click) into an item.
  useEffect(() => {
    if (!enabled) return;
    const r = root();
    const items = applyRoving(r, cursor);
    if (byKey.current && cursor >= 0) {
      byKey.current = false;
      items[cursor]?.focus({ preventScroll: true });
    }
    const onFocus = (e: FocusEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.("[data-nav-item]");
      if (!el) return;
      const i = applyRoving(r, -1).indexOf(el as HTMLElement);
      if (i < 0 || i === cursor) return;
      followed.current = true;
      setCursor(i);
    };
    r.addEventListener("focusin", onFocus);
    return () => r.removeEventListener("focusin", onFocus);
  }, [hrefs, cursor, enabled]);

  useEffect(() => {
    if (cursor < 0) return;
    // A restored cursor sits where the page put it back; the scroll is already right.
    if (restored.current) return;
    // A cursor that followed focus (a click, Tab) is already on screen; scrolling the whole
    // item "nearest" would move one taller than the window out from under the pointer.
    if (followed.current) {
      followed.current = false;
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-cursor="${CSS.escape(String(cursor))}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Remember the row for Back, and focus it once when Back brought us here.
  const href = cursor >= 0 ? hrefs[cursor] : undefined;
  useEffect(() => {
    if (href) lastCursor.set(path, href);
    else lastCursor.delete(path);
  }, [href, path]);
  useEffect(() => {
    if (!restored.current) return;
    restored.current = false;
    document
      .querySelector<HTMLElement>(`[data-cursor="${cursor}"] [data-nav-item], [data-cursor="${cursor}"][data-nav-item]`)
      ?.focus({ preventScroll: true });
  }, [cursor]);

  // A keyboard cursor resting on a session warms its transcript.
  const key = cursor >= 0 ? keys?.[cursor] : undefined;
  const store = opts.store;
  useEffect(() => {
    if (!key || !store) return;
    const [harness, ...rest] = key.split(":");
    const t = window.setTimeout(() => prefetchSession(store, { harness: harness!, id: rest.join(":"), key }), 150);
    return () => window.clearTimeout(t);
  }, [key, store]);

  const reset = useCallback(() => setCursor(-1), []);
  /** The person is about to take the cursor's row out of its place (e on the board): the
   *  cursor goes with `href`, the row that takes that place, not with the row that left. */
  const follow = useCallback((href: string | undefined) => {
    onRow.current = href ?? null;
    byKey.current = true;
  }, []);
  return { cursor, reset, follow };
}

/** Something open that Esc closes first (a popover, a confirm, the panel): a
 *  `[data-dismiss]` that is drawn, not one kept in the DOM while closed. */
/** Drawn and not on its way out: an overlay fading through its exit is already closed. */
const drawn = (el: HTMLElement): boolean =>
  !el.closest("[data-closing]") &&
  (typeof el.checkVisibility === "function" ? el.checkVisibility({ visibilityProperty: true }) : !!el.offsetParent);
const openDismiss = (): boolean => [...document.querySelectorAll<HTMLElement>("[data-dismiss]")].some(drawn);

/** Focus is in the side panel: its own keys win there. */
/** Focus is inside the panel beside the page: a list's bare keys (its menu, the jumps,
 *  e and ⇧E) leave the row under the cursor alone, since the person is working there. */
export const inPanel = (): boolean => !!document.activeElement?.closest?.("aside.panel");

/** Holding ⌘ (ctrl elsewhere) for 600 ms in the installed app marks the document
 *  `data-jump-hints`, so the first nine rows show their number (board.css); letting go
 *  takes them away. */
function useJumpHints(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let t: number | undefined;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform ?? "");
    const off = () => {
      window.clearTimeout(t);
      t = undefined;
      document.documentElement.removeAttribute("data-jump-hints");
    };
    const down = (e: KeyboardEvent) => {
      const mod = mac ? e.key === "Meta" : e.key === "Control";
      if (!mod) {
        off();
        return;
      }
      if (t !== undefined || !installedApp()) return;
      t = window.setTimeout(() => document.documentElement.setAttribute("data-jump-hints", ""), 600);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", off);
    window.addEventListener("blur", off);
    return () => {
      off();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", off);
      window.removeEventListener("blur", off);
    };
  }, [enabled]);
}
