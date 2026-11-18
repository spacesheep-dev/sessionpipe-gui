// SPDX-License-Identifier: Apache-2.0
// What the page runs on, for page code that must not load the shell's module
// (native/shell.ts, which only main.tsx imports): the shell's platform, which shell.ts
// writes to `<html data-shell>` before the app renders (the flag it parsed stands in until
// then, and in a unit test), the phone layout (where tokens.css switches) and whether a
// finger is the main pointer, each as a yes or no, now or live. The layout's widths are
// written here and nowhere else in the page's code (breakpoints.test.ts).
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

/** The phone layout: a tab bar, sheets, large titles (tokens.css switches on the same
 *  query). A screen under 840 px whose main pointer is a finger, or that has none: a phone,
 *  a tablet held upright. A window with a mouse keeps the desktop's layout down to 720 px,
 *  the narrowest the desktop app's window goes (apps/desktop window.rs) and half the screen
 *  of a 13-inch laptop, so a window tiled to one side never turns into a phone. */
export const PHONE_QUERY =
  "(max-width: 719px), (max-width: 839px) and (pointer: coarse), (max-width: 839px) and (pointer: none)";

/** The other layout, the exact opposite: a sidebar, a panel beside the page, dialogs. A
 *  stylesheet writes one of the two whole, as its media query. */
export const DESKTOP_QUERY = "(min-width: 840px), (min-width: 720px) and (pointer: fine)";

/** The desktop layout with no room for a session beside its page: the panel's 420 px
 *  would leave a list about 260. There the panel covers the page (styles/split.css). */
export const PANEL_COVERS_QUERY = "(min-width: 720px) and (max-width: 839px) and (pointer: fine)";

/** Whether the page is laid out as a phone right now. */
export const phoneLayout = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;

/** The other layout: a sidebar, a panel beside the page, dialogs. */
export const wideLayout = (): boolean => !phoneLayout();

/** Whether an open panel covers the page right now, having no room beside it. */
export const panelCovers = (): boolean => typeof matchMedia === "function" && matchMedia(PANEL_COVERS_QUERY).matches;

/** A finger is the main pointer: a phone or a tablet, in the app or a browser, at any
 *  width; never a desktop window, however narrow. */
export const TOUCH_QUERY = "(pointer: coarse)";

/** Whether the keys are a touch screen's right now: its Return is a new line, as in
 *  Messages, and the send button sends (or ⌘/Ctrl+Return from a keyboard). */
export const touchKeys = (): boolean => typeof matchMedia === "function" && matchMedia(TOUCH_QUERY).matches;

const subscribeTo = (query: string) => (l: () => void) => {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia(query);
  mq.addEventListener("change", l);
  return () => mq.removeEventListener("change", l);
};
const onPhone = subscribeTo(PHONE_QUERY);
const onCovers = subscribeTo(PANEL_COVERS_QUERY);
const onTouch = subscribeTo(TOUCH_QUERY);

/** `phoneLayout`, live: re-renders when the window crosses the width. */
export const usePhoneLayout = (): boolean => useSyncExternalStore(onPhone, phoneLayout, () => false);

/** `panelCovers`, live: re-renders when the window crosses either end of that width. */
export const usePanelCovers = (): boolean => useSyncExternalStore(onCovers, panelCovers, () => false);

/** `touchKeys`, live: re-renders when the main pointer changes. */
export const useTouchKeys = (): boolean => useSyncExternalStore(onTouch, touchKeys, () => false);
