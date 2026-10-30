// SPDX-License-Identifier: Apache-2.0
// The system bars follow the page's scheme (NATIVE-SPEC §11.4). lib/theme.ts puts a forced
// scheme on `<html data-theme="light|dark">` (the appearance setting, or a one-scheme
// skin) and takes it off when the page follows the OS; this tells the shell, at start and
// at each change, so the status bar's text is readable over a dark page on a light phone
// and the other way round. Loaded only inside the phone shells (native/shell.ts).
//
// iOS: the `app_appearance` command overrides the window's interface style (uikit.rs).
// Android: `spAppearance.set(scheme)`, a JavascriptInterface MainActivity.kt adds, over
// WindowInsetsControllerCompat's light bars.
import { invoke } from "./bridge";
import { platform } from "./shell";

export type Scheme = "light" | "dark" | "auto";

/** The shell's word for what `data-theme` holds: a forced scheme as it is, anything else
 *  (absent, or a value the page doesn't apply) is auto, the OS's. */
export const schemeOf = (theme: unknown): Scheme => (theme === "light" || theme === "dark" ? theme : "auto");

/** Tells the shell. Fire and forget. */
export function sendAppearance(scheme: Scheme): void {
  if (platform() === "android") {
    try {
      (globalThis as { spAppearance?: { set(scheme: string): void } }).spAppearance?.set(scheme);
    } catch {
      // an older shell without it
    }
    return;
  }
  void invoke("app_appearance", { scheme }).catch(() => {});
}

/** Sends the scheme now and again whenever `<html data-theme>` changes (a setting, a skin,
 *  a one-scheme skin applied); the same scheme twice is sent once. */
export function followAppearance(): void {
  const root = document.documentElement;
  let last: Scheme | null = null;
  const send = () => {
    const scheme = schemeOf(root.dataset.theme);
    if (scheme === last) return;
    last = scheme;
    sendAppearance(scheme);
  };
  send();
  if (typeof MutationObserver === "function")
    new MutationObserver(send).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
}
