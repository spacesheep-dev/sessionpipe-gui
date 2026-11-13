// SPDX-License-Identifier: Apache-2.0
// The words of the phone's spacesheep-account screens: the first run's way in, the wait,
// Settings, "Approve this iPhone". Two kinds, kept apart so the owner can see which is
// which: what is reused as it stands (below, each with where it was approved), and what is
// new or changed (accountWords.new.ts, one line a sentence). No screen holds a sentence of
// its own. The hub's own words (its note about a key that is not kept, its alerts) are the
// hub's and are shown as they come.
import { shellPlatform } from "../lib/device";
import { NEW_WORDS } from "./accountWords.new";
import { WORDS } from "./onboarding";

export { NEW_WORDS };

/** Reused as they stand. */
export const REUSED = {
  /** Settings → Data on the desktop: the row's label. */
  use: "Use a spacesheep account",
  /** Settings → Data on the desktop: the group's label. */
  group: "A spacesheep account",
  /** The first run: "Connecting to studio-mac…". */
  connecting: WORDS.connecting,
  /** The first run's trust page: "Open in Safari", "Open the page again". */
  open: WORDS.trust.open,
  again: WORDS.trust.again,
  cancel: WORDS.scanning.cancel,
  back: WORDS.back,
  /** The first run: "Couldn't reach studio-mac", "Try again". */
  unreachable: WORDS.failed.title,
  retry: WORDS.failed.retry,
  /** The hub's alerts say "Continue"; the first run's sheet "You're in.", "Later", "Done". */
  go: "Continue",
  in: WORDS.connected.title,
  later: WORDS.connected.later,
  done: WORDS.connected.done,
  disconnect: "Disconnect",
  /** What the app's own doors say (the hub's words for it, account/doors.ts). */
  unreachableNow: "spacesheep could not be reached.",
} as const;

/** "this iPhone" / "this phone" (as control/signer.ts deviceWords says it; not imported
 *  here, so the first run stays as light as it was), and the same with a capital. */
export const thisPhone = (): string => {
  const p = shellPlatform();
  return p === "ios" ? "this iPhone" : p === "android" ? "this phone" : "this Mac";
};
export const ThisPhone = (): string => {
  const p = thisPhone();
  return p.charAt(0).toUpperCase() + p.slice(1);
};

/** A clock time as the phone writes one: "14:05". */
export const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** A day as the phone writes one: "12 Nov 2026". */
export const day = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
    : "";
};
