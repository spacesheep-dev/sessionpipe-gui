// SPDX-License-Identifier: Apache-2.0
// Haptics, the shell's side (NATIVE-SPEC §11.3): plays lib/haptics.ts's kinds on the
// phone's engine. Loaded only inside the shell (native/shell.ts wires it at start when
// the contract lists "haptics"); a browser never loads it.
//
// iOS: the `app_haptic` command (apps/mobile/src-tauri/src/lib.rs) drives uikit.rs's
// UISelectionFeedbackGenerator / UIImpactFeedbackGenerator / UINotificationFeedbackGenerator,
// kept prepared between calls.
// Android: `spHaptic.perform(kind)`, a JavascriptInterface MainActivity.kt adds, over
// View.performHapticFeedback.
import { type Haptic, shellHaptics } from "../lib/haptics";
import { invoke } from "./bridge";
import { platform } from "./shell";

/** The engine for this platform. */
export function play(kind: Haptic): void {
  if (platform() === "android") {
    (globalThis as { spHaptic?: { perform(kind: string): void } }).spHaptic?.perform(kind);
    return;
  }
  void invoke("app_haptic", { kind }).catch(() => {});
}

/** Hands the page its engine. */
export function wireHaptics(): void {
  shellHaptics.play = play;
}
