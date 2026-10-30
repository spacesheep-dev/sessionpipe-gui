// SPDX-License-Identifier: Apache-2.0
// The page inside the native app. The shell's initialization script sets
// `window.sessionpipeShell` (NATIVE-SPEC §2.5) before any page script runs; main.tsx
// imports this module only when it is there, so a browser never loads a byte of it.
// It reads the flag, puts the chrome's stylesheet on, and wires the shell's events to
// what the page already does: the app menu, deep links and the menu bar (`navigate`),
// sleep and wake, updates, and the receiver list.
import "./chrome.css";
import type { Store } from "../data/store";
import { shellStreams } from "../lib/net";
import { navigate } from "../lib/router";
import { invoke, listen } from "./bridge";
import { installKeyFilter, type MenuPayload, restoreSidebar, runMenu } from "./menu";
import { openStream, resyncAll } from "./stream";

export type Platform = "macos" | "windows" | "linux" | "ios" | "android";
export type Feature =
  | "tray"
  | "notifications"
  | "hotkey"
  | "autostart"
  | "deeplink"
  | "updater"
  | "signer"
  | "vibrancy"
  | "haptics"
  | "scanner";
export interface ShellReceiver {
  id: string;
  name: string;
  origin: string;
  local: boolean;
}
export interface ShellInfo {
  v: 1;
  platform: Platform;
  appVersion: string;
  features: Feature[];
  /** The receiver this window shows; null: none yet (the welcome). */
  receiver: ShellReceiver | null;
  rxBase: string | null;
}

const PLATFORMS: readonly string[] = ["macos", "windows", "linux", "ios", "android"];
const FEATURES: readonly string[] = [
  "tray",
  "notifications",
  "hotkey",
  "autostart",
  "deeplink",
  "updater",
  "signer",
  "vibrancy",
  "haptics",
  "scanner",
];
const str = (v: unknown): v is string => typeof v === "string";

/** The flag, checked: null when absent, malformed or of another version (the page then
 *  behaves as in a browser, apart from net.ts's base). Unknown features are dropped. */
export function parseShell(raw: unknown): ShellInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !str(r.platform) || !PLATFORMS.includes(r.platform)) return null;
  const x = r.receiver as Record<string, unknown> | null | undefined;
  const receiver =
    x && typeof x === "object" && str(x.id) && x.id && str(x.origin)
      ? { id: x.id, name: str(x.name) && x.name ? x.name : x.id, origin: x.origin, local: x.local === true }
      : null;
  return {
    v: 1,
    platform: r.platform as Platform,
    appVersion: str(r.appVersion) ? r.appVersion : "",
    features: (Array.isArray(r.features) ? r.features : []).filter((f): f is Feature => str(f) && FEATURES.includes(f)),
    receiver,
    rxBase: receiver && str(r.rxBase) ? r.rxBase : null,
  };
}

const info = parseShell((globalThis as { sessionpipeShell?: unknown }).sessionpipeShell);
export const shellInfo = (): ShellInfo | null => info;
export const isShell = (): boolean => info !== null;
export const platform = (): Platform | null => info?.platform ?? null;
export const features = (): ReadonlySet<Feature> => new Set(info?.features ?? []);

/** An in-app path from a `navigate` event ("/inbox", "/s/claude/abc?x=1"); anything else
 *  (another origin, "//host", a scheme) is refused. */
export const safePath = (to: unknown): string | null =>
  str(to) && /^\/(?!\/)/.test(to) && ![...to].some((c) => c < " " || c === "\\") ? to : null;

const SETUP_SEEN = "sessionpipe-gui.setup.seen";

/** Whether the page shows the demo (?mock=1): the welcome's "Try the demo". */
export const isDemo = (): boolean => new URLSearchParams(location.search).get("mock") === "1";

/** Finds a receiver already running on this machine and selects it. False when there is
 *  none, or the shell can't say (the welcome then offers to start one). */
export async function useLocalReceiver(): Promise<boolean> {
  try {
    const found = await invoke<{ local: { id: string } | null }>("rx_discover");
    if (!found?.local?.id) return false;
    await invoke("rx_select", { id: found.local.id });
    return true;
  } catch {
    return false;
  }
}

/** Android's WebView has no env(safe-area-inset-*) for the system bars, so the shell's
 *  `spInsets` (MainActivity.kt) says them, "top right bottom left" in CSS px, and fires
 *  `sp-insets` when they change. The stylesheets read them as --safe-*. */
export function followInsets(): void {
  const bridge = (globalThis as { spInsets?: { get(): string } }).spInsets;
  if (!bridge) return;
  const apply = () => {
    const sides = bridge.get().split(" ").map(Number);
    if (sides.length !== 4 || sides.some((n) => !Number.isFinite(n) || n < 0)) return;
    const style = document.documentElement.style;
    for (const [i, side] of ["top", "right", "bottom", "left"].entries())
      style.setProperty(`--safe-${side}`, `${sides[i]}px`);
  };
  apply();
  addEventListener("sp-insets", apply);
}

/** How long the page waits for the shell to replace its window after selecting the
 *  receiver it found (a new window is up in well under a second). */
export const HANDOFF_MS = 8000;

/** Runs before the app renders. True when it put up the welcome instead (no receiver), or
 *  handed the window to a receiver found running on this machine. */
export async function start(): Promise<boolean> {
  if (!info) return false;
  const d = document.documentElement;
  d.dataset.shell = info.platform;
  d.toggleAttribute("data-vibrancy", info.features.includes("vibrancy"));
  if (info.platform === "ios" || info.platform === "android")
    for (const load of Object.values(import.meta.glob("./mobile.css"))) await load();
  if (info.platform === "android") followInsets();
  // The phone's engine behind lib/haptics.ts, when the shell has one.
  if (info.features.includes("haptics")) (await import("./haptics")).wireHaptics();
  // The phone's system bars follow the page's scheme (a forced Light or Dark, a one-scheme
  // skin), so the status bar's text stays readable over it.
  if (info.platform === "ios" || info.platform === "android") (await import("./appearance")).followAppearance();
  if (!info.receiver && !isDemo()) {
    // A receiver already running on this machine (the default port, or the one its run.json
    // names) is the one to use; the welcome is for when there is none. Selecting it opens
    // a fresh window on it.
    if (await useLocalReceiver()) {
      // The shell builds a new window on it and this one goes. Should it stay (the hand-over
      // failed), the welcome takes over rather than the first frame staying up for good.
      const shown = info;
      setTimeout(() => void import("./Welcome").then((m) => m.showWelcome(shown)), HANDOFF_MS);
      return true;
    }
    (await import("./Welcome")).showWelcome(info);
    return true;
  }
  // The app has its own first run (the sheet below); the browser's Setup redirect, which
  // is about https and passkeys, is not it. Setup stays one click away in the rail.
  try {
    localStorage.setItem(SETUP_SEEN, "1");
  } catch {}
  shellStreams.open = openStream;
  restoreSidebar();
  installKeyFilter();
  installDrag();
  const on = <T>(event: string, fn: (p: T) => void) => listen<T>(event, fn).catch(() => {});
  void on<MenuPayload>("menu", (p) => p?.action && runMenu(p.action, p));
  void on<{ to?: string }>("navigate", (p) => {
    const to = safePath(p?.to);
    if (to) navigate(to);
  });
  void on("wake", () => resyncAll());
  void import("./appState").then((m) => m.wire(on));
  if (info.receiver) void import("./FirstRun").then((m) => m.maybeShowFirstRun());
  return false;
}

/** The launch's last mark, after fcp: the first snapshot is on the page (the board has its
 *  rows). The shell prints it with the others; packaging's scripts read it. */
export function markFirstSnapshot(store: Store): void {
  const off = store.subscribe(() => {
    if (!store.get().snapshotAt) return;
    off();
    invoke("app_mark", { name: "snapshot", at: Date.now(), ms: performance.now() }).catch(() => {});
  });
}

/** The window's drag regions: the page bar's ground, the top band of the rail and the
 *  welcome's bar. Tauri drags from an element marked `data-tauri-drag-region`;
 *  "deep" lets a title or an empty stretch inside it drag too, while its own check keeps
 *  every control a control. The mark goes on just before its listener reads it, so the
 *  page's markup stays the browser's. */
export const DRAG_REGIONS = ".bar, .rail-head, .welcome-bar";
export function dragRegion(t: EventTarget | null): HTMLElement | null {
  const el = t as HTMLElement | null;
  return el?.closest ? el.closest<HTMLElement>(DRAG_REGIONS) : null;
}
function installDrag(): void {
  window.addEventListener(
    "mousedown",
    (e) => {
      const region = e.button === 0 ? dragRegion(e.target) : null;
      if (region && !region.hasAttribute("data-tauri-drag-region"))
        region.setAttribute("data-tauri-drag-region", "deep");
    },
    true,
  );
}
