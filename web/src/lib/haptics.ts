// SPDX-License-Identifier: Apache-2.0
// Haptics, the page's side: the one call every surface makes when a gesture lands (a
// pull that arms a refresh, a switch that flips, a sheet that snaps, a tab tapped). In a
// browser and on a desktop it plays nothing. Inside a phone shell with the feature,
// native/shell.ts fills `shellHaptics.play` at start (the same shape as net.ts's
// `shellStreams`), so page code never imports a byte of the native layer. Fire and
// forget: a tap never waits on it.

/** The kinds, named as Apple's generators name them: a selection ticking over
 *  (`selection`), a touch landing on something (`light`, `medium`), and an outcome
 *  (`success`, `warning`, `error`). */
export type Haptic = "selection" | "light" | "medium" | "success" | "warning" | "error";

export const HAPTICS: readonly Haptic[] = ["selection", "light", "medium", "success", "warning", "error"];

/** The shell's engine, when there is one (native/haptics.ts sets it). */
export const shellHaptics: { play: ((kind: Haptic) => void) | null } = { play: null };

/** Whether this shell can play one. */
export const hasHaptics = (): boolean => shellHaptics.play !== null;

/** Plays `kind` on the phone, or nothing. Never throws, never awaited. */
export function haptic(kind: Haptic): void {
  try {
    shellHaptics.play?.(kind);
  } catch {
    // no engine here
  }
}
