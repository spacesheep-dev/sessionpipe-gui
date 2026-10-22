// SPDX-License-Identifier: Apache-2.0
// The page-level keys, all through the one keymap (lib/shortcuts.ts): the global actions
// (go to a page, search, Esc, the appearance, the lens) get their handlers here, and
// `useListNav` gives a list a cursor the list actions move (j/k or the arrows), with one
// tab stop (roving tabindex over `[data-nav-item]`) so Tab enters the list once and the
// arrows walk it.
import { useCallback, useEffect, useRef, useState } from "react";
import { applyRoving } from "./focus";
import { back, navigate, usePath } from "./router";
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
  "nav.feed": "/feed",
  "nav.review": "/review",
  "nav.machines": "/machines",
  "nav.connect": "/connect",
  "nav.setup": "/setup",
  "nav.views": "/themes",
  "nav.shortcuts": "/shortcuts",
};

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
  useShortcut("back", (e) => {
    if (isTyping(e.target)) {
      (e.target as HTMLElement).blur();
      return;
    }
    const open = document.querySelector<HTMLElement>("[data-dismiss]");
    if (open) {
      open.click();
      return;
    }
    // On a page with nowhere to go back to, Esc does nothing (no reload-looking jump).
    if (path === "/" && history.length <= 1) return false;
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

/** A cursor over a list of hrefs, moved by the list actions; Enter opens the one under it,
 *  shift+Enter opens it beside the page when `keys` (session keys, same order) are given,
 *  mod+Enter beside as a background tab. The list's items carry `data-nav-item` (one tab
 *  stop; the arrows walk them) and the cursor item `data-cursor`. */
export function useListNav(hrefs: string[], enabled = true, keys?: string[]) {
  const [cursor, setCursor] = useState(-1);
  /** True when a key moved the cursor, so focus follows; a click or Tab sets it silently. */
  const byKey = useRef(false);
  useEffect(() => {
    if (cursor >= hrefs.length) setCursor(hrefs.length - 1);
  }, [hrefs.length, cursor]);

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
      if (i >= 0) setCursor(i);
    };
    r.addEventListener("focusin", onFocus);
    return () => r.removeEventListener("focusin", onFocus);
  }, [hrefs, cursor, enabled]);

  useEffect(() => {
    if (cursor < 0) return;
    const el = document.querySelector<HTMLElement>(`[data-cursor="${CSS.escape(String(cursor))}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const reset = useCallback(() => setCursor(-1), []);
  return { cursor, reset };
}
