// SPDX-License-Identifier: Apache-2.0
// What the page runs on, for page code that must not load the shell's module
// (native/shell.ts, which only main.tsx imports): the shell's platform, which shell.ts
// writes to `<html data-shell>` before the app renders (the flag it parsed stands in until
// then, and in a unit test), and the phone layout (Shell.tsx PHONE_QUERY, the width
// tokens.css switches at) as a yes or no, now or live.
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

/** The phone app (iOS or Android), where the page is the whole screen and the person
 *  holds it in one hand; false on a desktop shell and in any browser, a phone's included. */
export const phoneShell = (): boolean => {
  const p = shellPlatform();
  return p === "ios" || p === "android";
};

/** The phone layout's width (the same string as Shell.tsx PHONE_QUERY). */
export const PHONE_QUERY = "(max-width: 839px)";

/** Whether the page is laid out as a phone right now. */
export const phoneLayout = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;

const subscribe = (l: () => void) => {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia(PHONE_QUERY);
  mq.addEventListener("change", l);
  return () => mq.removeEventListener("change", l);
};

/** `phoneLayout`, live: re-renders when the window crosses the width. */
export const usePhoneLayout = (): boolean => useSyncExternalStore(subscribe, phoneLayout, () => false);
