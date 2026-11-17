// SPDX-License-Identifier: Apache-2.0
// The words of the phone's spacesheep-account screens: the first run's way in, the wait,
// Settings, "Approve this iPhone". Two kinds, kept apart so the owner can see which is
// which: what is reused as it stands (below, each with where it was approved), and what is
// new or changed (accountWords.new.ts, one line a sentence). No screen holds a sentence of
// its own. The hub's own words (its note about a key that is not kept, its alerts) are the
// hub's and are shown as they come.
import { shellPlatform } from "../lib/device";
import { NEW_WORDS, SEND } from "./accountWords.new";
import { WORDS } from "./onboarding";

export { NEW_WORDS, SEND };

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
  /** What the app's own doors say (the hub's words for it, account/doors.ts); also said
   *  for an error that came with no words of its own. */
  unreachableNow: "spacesheep could not be reached.",
  /** A button while its ask is out (Add this device, a handoff's Ask). */
  asking: "Asking…",
  /** Where a session can be answered when this phone cannot ("Open on spacesheep.dev"). */
  openOn: (host: string) => `Open on ${host}`,
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
/** The sentences are English, so a time or a day inside one is written in English digits
 *  and names whatever the phone's own language is; only the phone's choice of a 12- or a
 *  24-hour clock is taken from it. */
const twelve = (): boolean => {
  try {
    const cycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
    return cycle === "h12" || cycle === "h11";
  } catch {
    return true;
  }
};
/** A time of day as the sentences write one: "5:30 PM", or "17:30" on a 24-hour phone. */
export const clock = (ms: number): string =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: twelve(),
    numberingSystem: "latn",
    calendar: "gregory",
  }).format(new Date(ms));

/** A day as the sentences write one: "Nov 3, 2026". */
export const day = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Intl.DateTimeFormat("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
        numberingSystem: "latn",
        calendar: "gregory",
      }).format(new Date(t))
    : "";
};
