// SPDX-License-Identifier: Apache-2.0
// The QR scanner on the phone (NATIVE-SPEC §11.5): the page's one way to read the code
// the Connect page shows on a computer. Loaded only inside the phone shells, and only when
// the contract lists "scanner". The shell scans natively (tauri-plugin-barcode-scanner
// 2.5: the camera behind the webview, which the page keeps transparent while a scan runs,
// and draws its own viewfinder over). The page never sees camera frames, only the text.
//
// The order of a scan: `cameraPermission()`, `requestCamera()` when it says "prompt"
// (the plugin's `scan` never asks on its own: it rejects when the camera isn't granted),
// `scanQr()`, then `haptic("success")` and `invoke("rx_add", { url: text })`. While it
// runs the plugin makes the webview itself transparent (Android drops its background, iOS
// its opacity), so the page must paint nothing behind the viewfinder: `html[data-scanning]`
// is on for the scan's length, and native/mobile.css clears the page's grounds under it.
//
// What the code says, and what `rx_add` (apps/mobile/src-tauri/src/net.rs `ConnectLink`)
// does with the text, handed over as it is:
// - `http://10.0.0.128:7397/?k=<key>`: the Connect page's code. The receiver is the
//   origin; `?k=` is the UI key, kept by the shell and never shown to the page.
// - `https://studio.local:7373/trust?k=<key>`: the same code when the receiver runs TLS.
//   It points at the trust page (shared/api.ts ROUTES.trust), where a phone installs the
//   CA; the receiver and the key are read out of it the same way, but it can't be reached
//   until that certificate is trusted on this phone, so offer the link (opened outside the
//   app, `app_open_external`) before connecting. `new URL(text).pathname === "/trust"`.
// - Anything that isn't an http(s) address is refused: "That isn't an http or https address."
//
// The plugin's own words: `plugin:barcode-scanner|check_permissions` and
// `|request_permissions` answer `{ camera: "granted" | "denied" | "prompt" |
// "prompt-with-rationale" }`; `|scan` takes `{ windowed, formats, cameraDirection }` and
// answers `{ content, format, bounds? }` (no bounds on iOS); `|cancel` makes a pending scan
// reject with "cancelled"; `|open_app_settings` opens the app's page in Settings.
import { invoke } from "./bridge";
import { features } from "./shell";

/** Whether this shell can scan. */
export const hasScanner = (): boolean => features().has("scanner");

export type CameraPermission = "granted" | "denied" | "prompt";

const permission = (r: { camera?: string }): CameraPermission =>
  r.camera === "granted" ? "granted" : r.camera === "denied" ? "denied" : "prompt";

/** The camera's standing, without asking. */
export async function cameraPermission(): Promise<CameraPermission> {
  return permission(await invoke<{ camera?: string }>("plugin:barcode-scanner|check_permissions").catch(() => ({})));
}

/** Asks for the camera (the system alert, once); later calls answer with the setting. */
export async function requestCamera(): Promise<CameraPermission> {
  return permission(await invoke<{ camera?: string }>("plugin:barcode-scanner|request_permissions").catch(() => ({})));
}

/** The plugin's reason for a failed scan: it rejects with a string, or an object with the
 *  string as its message. */
const reason = (e: unknown): string =>
  typeof e === "string" ? e : String((e as { message?: unknown } | null)?.message ?? e);

/** Scans one QR code: resolves with its text, or null when cancelled (`cancelScan`, or
 *  the system). Anything else that stops it is thrown with the plugin's words: no camera
 *  (the simulator), the camera not granted yet, a second scan started over this one.
 *  While it runs the camera is behind the page: `html[data-scanning]` is set, and the
 *  caller draws the viewfinder over a transparent ground (styles in native/mobile.css). */
export async function scanQr(): Promise<string | null> {
  document.documentElement.dataset.scanning = "";
  try {
    const r = await invoke<{ content?: string }>("plugin:barcode-scanner|scan", {
      windowed: true,
      formats: ["QR_CODE"],
      cameraDirection: "back",
    });
    return r?.content ?? null;
  } catch (e) {
    if (reason(e) === "cancelled") return null;
    throw new Error(reason(e));
  } finally {
    delete document.documentElement.dataset.scanning;
  }
}

/** Stops a scan in progress; `scanQr` then resolves null. */
export function cancelScan(): void {
  void invoke("plugin:barcode-scanner|cancel").catch(() => {});
}

/** Opens the app's page in Settings, where a refused camera is turned back on. */
export function openCameraSettings(): void {
  void invoke("plugin:barcode-scanner|open_app_settings").catch(() => {});
}
