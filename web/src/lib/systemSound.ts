// SPDX-License-Identifier: Apache-2.0
// One sound per prompt in the Mac app. The app posts a prompt's notification itself
// (apps/desktop macos/notify.rs), and macOS plays its sound for a permission request or a
// question whenever the window is not in front; the page's toast for the same prompt
// (components/Toasts.tsx) then plays none. The rule is native/logic.ts systemSounds; the
// app's switch and the system's permission are native/appState.ts's stores, fetched once
// and only inside the Mac app, so a browser and the phone never load them. Pause in the
// menu bar and the permission in System Settings change outside the page, so the stores
// are asked for again each time the window comes to the front.
import { systemSounds } from "../native/logic";
import { nativeNotify, shellPlatform } from "./device";

let sounds: ((kind: string) => boolean) | null = null;
let following = false;

/** Starts following the Mac app's notification settings (once; nothing anywhere else). */
export function followSystemSound(): void {
  if (following || shellPlatform() !== "macos" || !nativeNotify()) return;
  following = true;
  void import("../native/appState")
    .then((app) => {
      const ask = () => {
        void app.loadSettings();
        void app.loadNotify();
      };
      ask();
      window.addEventListener("focus", ask);
      sounds = (kind) => systemSounds(app.settings.get(), app.notify.get(), kind, document.hasFocus());
    })
    .catch(() => {
      following = false;
    });
}

/** Whether macOS plays the sound for a new prompt of this kind (an attention's `kind`)
 *  right now. False until the settings are in, and anywhere but the Mac app. */
export const systemSound = (kind: string): boolean => sounds?.(kind) ?? false;
