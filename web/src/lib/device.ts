// SPDX-License-Identifier: Apache-2.0
// What the page runs on, for page code that must not load the shell's module
// (native/shell.ts, which only main.tsx imports): the shell's platform, which shell.ts
// writes to `<html data-shell>` before the app renders (the flag it parsed stands in until
// then, and in a unit test), the phone layout (where tokens.css switches) and whether a
// finger is the main pointer, each as a yes or no, now or live; inside the touch app its
// size class (a sidebar, or the tab bar), from the window; and the place the page's
// sessions come from, by the name the page says it with. The layout is decided
// here and nowhere else (breakpoints.test.ts holds its widths to this file): every part
// of the page asks this file, and all of them hear of a change in the same turn, so no
// render has a phone's bar over a desktop's page.
import { useSyncExternalStore } from "react";

export type ShellPlatform = "macos" | "windows" | "linux" | "ios" | "android";
const PLATFORMS: readonly string[] = ["macos", "windows", "linux", "ios", "android"];

/** The shell around the page, or null in a browser. */
export function shellPlatform(): ShellPlatform | null {
  const marked = typeof document === "undefined" ? undefined : document.documentElement?.dataset?.shell;
  const flagged = (globalThis as { sessionpipeShell?: { platform?: unknown } }).sessionpipeShell?.platform;
  const p = marked ?? flagged;
  return typeof p === "string" && PLATFORMS.includes(p) ? (p as ShellPlatform) : null;
}

/** The app posts notifications itself (the shell lists "notifications": the Mac app and
 *  the phone app, not Windows or Linux), so the page's own are not the ones to offer. */
export const nativeNotify = (): boolean => {
  const f = (globalThis as { sessionpipeShell?: { features?: unknown } }).sessionpipeShell?.features;
  return shellPlatform() !== null && Array.isArray(f) && f.includes("notifications");
};

/** The phone app (iOS or Android), where the page is the whole screen and the person
 *  holds it in one hand; false on a desktop shell and in any browser, a phone's included. */
export const phoneShell = (): boolean => {
  const p = shellPlatform();
  return p === "ios" || p === "android";
};

/** The receiver the shell says this window shows, as page code may read it. */
type FlagReceiver = { name?: unknown; local?: unknown; kind?: unknown };
const flagReceiver = (): FlagReceiver | null => {
  const r = (globalThis as { sessionpipeShell?: { receiver?: unknown } }).sessionpipeShell?.receiver;
  return r && typeof r === "object" ? (r as FlagReceiver) : null;
};
const DESKTOPS: readonly (ShellPlatform | null)[] = ["macos", "windows", "linux"];

/** This window's receiver is the one on this computer, in the desktop app: the one the
 *  app can start ("Start sessionpipe"). False on a phone, in a browser, for another
 *  computer's and for a spacesheep account. */
export const localReceiver = (): boolean => {
  const r = flagReceiver();
  return !!r && r.local === true && r.kind !== "spacesheep" && DESKTOPS.includes(shellPlatform());
};

/** Where the page's sessions come from, as the words that say it can't be reached name it
 *  ("Can't reach …", "Connecting to …"): "spacesheep" for an account, "sessionpipe on this
 *  Mac" (or "this computer" off a Mac) for the app's own receiver, another computer by its
 *  name, and "sessionpipe" in a browser, where the page's own server is the receiver. The
 *  menu bar's item says the same place ("Can't reach this Mac", tray.rs THIS_MACHINE). */
export function reachName(): string {
  const r = flagReceiver();
  if (!r) return "sessionpipe";
  if (r.kind === "spacesheep") return "spacesheep";
  if (localReceiver()) return shellPlatform() === "macos" ? "sessionpipe on this Mac" : "sessionpipe on this computer";
  return typeof r.name === "string" && r.name ? r.name : "sessionpipe";
}

/** A query the page watches. One MediaQueryList for each, made when it is first asked,
 *  with one "change" listener that tells every subscriber before it returns, so React
 *  renders them all in one pass. (With a listener each, the browser let React render
 *  between two of them: for that render the bar was a phone's and the page a desktop's.)
 *  `on` is what the browser last told, not what the list says this instant: Chromium has
 *  a kept list say the new width already in a resize handler, WebKit not before the
 *  "change", and a render between the two must read the layout every other part has.
 *  So inside a "resize" handler the answer is still the layout the window is leaving
 *  (the "change" comes later in that frame): code that measures on a resize must also
 *  follow `usePhoneLayout` or `onPhoneLayout`, and measure again when the layout turns. */
interface Watch {
  list: MediaQueryList;
  on: boolean;
  subs: Set<() => void>;
  /** The one listener, on the list that is kept. */
  heard: () => void;
}
const watches = new Map<string, Watch>();

function watch(query: string): Watch {
  let w = watches.get(query);
  if (!w) {
    const list = matchMedia(query);
    const made: Watch = {
      list,
      on: list.matches,
      subs: new Set(),
      heard: () => {
        made.on = made.list.matches;
        for (const tell of [...made.subs]) tell();
      },
    };
    list.addEventListener("change", made.heard);
    watches.set(query, made);
    w = made;
  }
  return w;
}

/** What a query says. While no part listens (the first render, and anything that asks
 *  before it) the browser is asked afresh each time, as every part asked it before this
 *  file kept a list: a window can still be taking its size as the app starts (a phone's
 *  document begins 980 px wide, and a shell may size its window after the page has begun),
 *  and a width kept from then would draw the first render in the other layout. A fresh
 *  list that says otherwise than the kept one is kept in its place: the browser tells of
 *  a change from what a list itself last said, so the old list would have nothing to tell
 *  if the width went back before it had heard, and the answer would stay wrong. Once a
 *  part listens, the answer is the one all of them were last told. (The phone layout has
 *  a listener from the Shell's first render, and in a window that stays wide from the
 *  first idle moment at the latest: the More sheet's warm-up, components/Shell.tsx.) */
const stateOf = (query: string) => (): boolean => {
  if (typeof matchMedia !== "function") return false;
  const kept = watches.get(query);
  if (!kept) return watch(query).on;
  if (kept.subs.size === 0) {
    const fresh = matchMedia(query);
    if (fresh.matches !== kept.on) {
      kept.list.removeEventListener("change", kept.heard);
      fresh.addEventListener("change", kept.heard);
      kept.list = fresh;
      kept.on = fresh.matches;
    }
  }
  return kept.on;
};
const subscribeTo = (query: string) => (l: () => void) => {
  if (typeof matchMedia !== "function") return () => {};
  const w = watch(query);
  w.subs.add(l);
  return () => void w.subs.delete(l);
};

/** A finger is the main pointer: a phone or a tablet, in the app or a browser, at any
 *  width; never a desktop window, however narrow. */
export const TOUCH_QUERY = "(pointer: coarse)";

/** The phone layout, the touch app: a tab bar, sheets, large titles (tokens.css switches
 *  on the same query). A touch-first screen at any width, so a tablet on its side or a
 *  phone opened flat keeps the app it had; a screen with no pointer under 840 px. A
 *  window with a mouse keeps the desktop's layout down to 720 px, the narrowest the
 *  desktop app's window goes (apps/desktop window.rs) and half the screen of a 13-inch
 *  laptop, so a window tiled to one side never turns into a phone. */
export const PHONE_QUERY = "(max-width: 719px), (pointer: coarse), (max-width: 839px) and (pointer: none)";

/** The other layout, the exact opposite: a sidebar, a panel beside the page, dialogs. A
 *  window with a mouse from 720 px, and one with no pointer from 840. A stylesheet writes
 *  one of the two whole, as its media query. */
export const DESKTOP_QUERY = "(min-width: 720px) and (pointer: fine), (min-width: 840px) and (pointer: none)";

/** The desktop layout with no room for a session beside its page: the panel's 420 px
 *  would leave a list about 260. There the panel covers the page (styles/split.css). */
export const PANEL_COVERS_QUERY = "(min-width: 720px) and (max-width: 839px) and (pointer: fine)";

/** Whether the page is laid out as a phone right now. */
export const phoneLayout = stateOf(PHONE_QUERY);

/** The other layout: a sidebar, a panel beside the page, dialogs. */
export const wideLayout = (): boolean => !phoneLayout();

/** Calls the listener each time the page changes between the two layouts, for code
 *  outside React; returns the way to stop. */
export const onPhoneLayout = subscribeTo(PHONE_QUERY);

/** `phoneLayout`, live: re-renders when a mouse window crosses the width, or the main
 *  pointer changes (a laptop folded into a tablet). */
export const usePhoneLayout = (): boolean => useSyncExternalStore(onPhoneLayout, phoneLayout, () => false);

/** Whether an open panel covers the page right now, having no room beside it. */
export const panelCovers = stateOf(PANEL_COVERS_QUERY);
const onCovers = subscribeTo(PANEL_COVERS_QUERY);

/** `panelCovers`, live: re-renders when the window crosses either end of that width. */
export const usePanelCovers = (): boolean => useSyncExternalStore(onCovers, panelCovers, () => false);

/** Whether the keys are a touch screen's right now: its Return is a new line, as in
 *  Messages, and the send button sends (or ⌘/Ctrl+Return from a keyboard). */
export const touchKeys = stateOf(TOUCH_QUERY);
const onTouch = subscribeTo(TOUCH_QUERY);

/** `touchKeys`, live: re-renders when the main pointer changes. */
export const useTouchKeys = (): boolean => useSyncExternalStore(onTouch, touchKeys, () => false);

/** Inside the touch app, how much room the window gives: "regular" (a tablet, a phone
 *  opened flat, either way up) has a labelled sidebar in the tab bar's place; "compact"
 *  (every phone held upright, a folded phone, a Split View half) is the phone app as it
 *  is. Worked out from the window, never from the device: no device's size is written
 *  here. A window with a mouse has none. */
export type SizeClass = "regular" | "compact";
export const REGULAR = { minWidth: 600, minHeight: 560 } as const;

/** The window as the size class reads it: its width, and its height as it stands with no
 *  keyboard. Android's shell makes the view shorter for the keyboard (iOS makes only the
 *  visual viewport shorter), and a tablet on its side would lose its sidebar while a field
 *  is typed in. So a resize that keeps the width and lowers the height while a text field
 *  has the focus keeps the height it had. Null until followSizeClass has settled once. */
let steady: { width: number; height: number } | null = null;
/** The inputs that raise no keyboard. */
const NO_KEYS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);
const typing = (): boolean => {
  const el = (typeof document === "undefined" ? null : document.activeElement) as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !NO_KEYS.has((el as HTMLInputElement).type);
};
/** A page pinched larger in a phone's or a tablet's browser keeps the size it had:
 *  innerWidth and innerHeight are then only the part of it in view (as windowSize() in
 *  lib/resizeAnchor.ts has it). */
const pinched = (): boolean => Math.abs((globalThis.visualViewport?.scale ?? 1) - 1) >= 0.01;
const measured = (): { width: number; height: number } => {
  if (steady && pinched()) return steady;
  const now = { width: innerWidth, height: innerHeight };
  if (steady && now.width === steady.width && now.height < steady.height && typing()) return steady;
  return now;
};

/** The touch app's size class now, or null where the main pointer is not a finger. Once
 *  followSizeClass runs, the size it last settled, which is what <html> says. */
export function sizeClass(): SizeClass | null {
  if (typeof innerWidth !== "number" || !touchKeys()) return null;
  const { width, height } = steady ?? measured();
  return width >= REGULAR.minWidth && height >= REGULAR.minHeight ? "regular" : "compact";
}

const sizeSubs = new Set<() => void>();
let shown: SizeClass | null | undefined;
/** Writes the size class to <html data-size-class> and, when it changed, tells every
 *  subscriber, all in the one call. */
function settleSize(): void {
  steady = measured();
  const now = sizeClass();
  if (now === shown) return;
  shown = now;
  const marks = document.documentElement.dataset;
  if (now) marks.sizeClass = now;
  else delete marks.sizeClass;
  for (const tell of [...sizeSubs]) tell();
}
let following = false;
/** From main.tsx, before the first render: the size class follows the window. Its
 *  "resize" listener and its pointer one are made before any part's, so the stylesheet
 *  (styles/regular.css) and every part that asks have the new class before any part
 *  measures. index.html wrote the first one before the first paint. Returns the way to
 *  stop (for a test). */
export function followSizeClass(): () => void {
  if (following || typeof matchMedia !== "function") return () => {};
  following = true;
  const offTouch = onTouch(settleSize);
  addEventListener("resize", settleSize);
  // A phone folded or opened while the app was away may send no resize on the way back.
  addEventListener("pageshow", settleSize);
  document.addEventListener("visibilitychange", settleSize);
  settleSize();
  return () => {
    following = false;
    steady = null;
    shown = undefined;
    offTouch();
    removeEventListener("resize", settleSize);
    removeEventListener("pageshow", settleSize);
    document.removeEventListener("visibilitychange", settleSize);
  };
}

/** Calls the listener each time the size class changes; returns the way to stop. */
export const onSizeClass = (l: () => void): (() => void) => {
  sizeSubs.add(l);
  return () => void sizeSubs.delete(l);
};

/** `sizeClass`, live. */
export const useSizeClass = (): SizeClass | null => useSyncExternalStore(onSizeClass, sizeClass, () => null);

const regularNow = (): boolean => sizeClass() === "regular";
/** Whether the touch app has room for its sidebar (the regular size class), live. */
export const useRegular = (): boolean => useSyncExternalStore(onSizeClass, regularNow, () => false);

/** Where a window with a mouse has a Select's list as a bottom sheet (components/Select.tsx),
 *  not a pop-up under its button. */
export const SELECT_SHEET_QUERY = "(max-width: 599px)";
const narrowSelect = stateOf(SELECT_SHEET_QUERY);
const onNarrowSelect = subscribeTo(SELECT_SHEET_QUERY);

/** Whether a Select's list is a bottom sheet: on a touch screen when the window is compact
 *  (with room it is a pop-up under its button, as an iPad's is, in the sheet it is in too);
 *  in a window with a mouse under 600 px. */
export const selectSheet = (): boolean => {
  const size = sizeClass();
  return size ? size === "compact" : narrowSelect();
};
const onSelectSheet = (l: () => void): (() => void) => {
  const offSize = onSizeClass(l);
  const offWidth = onNarrowSelect(l);
  return () => {
    offSize();
    offWidth();
  };
};

/** `selectSheet`, live. */
export const useSelectSheet = (): boolean => useSyncExternalStore(onSelectSheet, selectSheet, () => false);

/** What the system keeps at the window's two sides, in px: a notch, the rounded corners,
 *  the band its own bars stand in beside a folding phone's page. As the stylesheets have
 *  it: --safe-* where a shell sets them (native/shell.ts), else the engine's env(). For
 *  code that places a box itself (a Select's list); a stylesheet reads them directly. */
export function safeSides(): { left: number; right: number } {
  if (typeof document === "undefined" || !document.body) return { left: 0, right: 0 };
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;padding:0 var(--safe-right, env(safe-area-inset-right)) 0 var(--safe-left, env(safe-area-inset-left))";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const sides = { left: Number.parseFloat(style.paddingLeft) || 0, right: Number.parseFloat(style.paddingRight) || 0 };
  probe.remove();
  return sides;
}
