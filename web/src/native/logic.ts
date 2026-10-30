// SPDX-License-Identifier: Apache-2.0
// The decisions behind the welcome, the first-run sheet and Settings › App, apart from
// their React so they are tested on their own (logic.test.ts).
import type { AppSettings, NotifyStatus } from "./appState";

// ----- the welcome: Start sessionpipe on this Mac -----

export type StartState =
  | { kind: "idle" }
  | { kind: "starting"; message: string }
  | { kind: "needsNode" }
  | { kind: "failed"; message: string };

export type StartEvent =
  | { type: "begin" }
  | { type: "progress"; step?: string; message?: string }
  | { type: "error"; error: unknown };

const text = (e: unknown): string =>
  e instanceof Error
    ? e.message
    : typeof e === "string"
      ? e
      : e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : "It did not start.";

/** The start's failure for want of Node (no `node` or `npx` on this Mac). */
export const isNoNode = (e: unknown): boolean => {
  if (e && typeof e === "object" && (e as { code?: unknown }).code === "no-node") return true;
  const m = text(e);
  return /\bno-node\b/.test(m) || /\bnode\b.*\b(not found|missing|required|needed)\b/i.test(m);
};

export function startStep(prev: StartState, ev: StartEvent): StartState {
  switch (ev.type) {
    case "begin":
      return { kind: "starting", message: "Starting sessionpipe…" };
    case "progress":
      if (prev.kind !== "starting") return prev;
      if (ev.step === "no-node") return { kind: "needsNode" };
      return { kind: "starting", message: ev.message?.trim() || prev.message };
    case "error":
      return isNoNode(ev.error) ? { kind: "needsNode" } : { kind: "failed", message: text(ev.error) };
  }
}

/** What to run once Node is there; shown with Copy. */
export const INSTALL_COMMAND = "npx -y sessionpipe-gui service install";

/** A pasted address or phone link, as `rx_add` takes it; null when it is not one. The
 *  link's `?k=` stays (it is the UI key the shell keeps in the Keychain). */
export function parseAddress(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

// ----- the first-run sheet -----

export const FIRST_RUN_KEY = "sessionpipe-gui.native.firstRun";

/** Once: when the shell says it was seen (firstRunDone), or this device remembers it. */
export function firstRunDue(settings: AppSettings | null, seenHere: boolean): boolean {
  if (settings?.firstRunDone !== undefined) return !settings.firstRunDone;
  return !seenHere;
}

/** Turning notifications on asks for permission then, never before; a refusal leaves the
 *  switch off and says where to change it. */
export async function notifyToggle(
  on: boolean,
  ask: () => Promise<NotifyStatus | null>,
): Promise<{ enabled: boolean; note: string | null }> {
  if (!on) return { enabled: false, note: null };
  const status = await ask();
  if (status === "granted") return { enabled: true, note: null };
  if (status === "denied") return { enabled: false, note: "Notifications are off for sessionpipe in System Settings." };
  return { enabled: false, note: null };
}

/** The suggested New session shortcut (NATIVE-SPEC §3.5). */
export const DEFAULT_HOTKEY = "Control+Alt+N";

// ----- Settings › App: the shortcut recorder -----

/** A global shortcut from a key press: at least one of ⌃ ⌥ ⌘ and a letter, digit or F-key
 *  (a bare key or ⇧ alone would take the key from every other app). */
export function hotkeyFrom(e: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const key = /^Key[A-Z]$/.test(e.code)
    ? e.code.slice(3).toLowerCase()
    : /^Digit[0-9]$/.test(e.code)
      ? e.code.slice(5)
      : /^F([1-9]|1[0-9])$/.test(e.key)
        ? e.key.toLowerCase()
        : e.code === "Space"
          ? "space"
          : null;
  if (!key) return null;
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Command"].filter(
    Boolean,
  );
  return [...mods, key.length === 1 ? key.toUpperCase() : key === "space" ? "Space" : key.toUpperCase()].join("+");
}

/** An accelerator ("Control+Alt+N", "CmdOrCtrl+Shift+K") as the Mac writes it: ⌃⌥N. */
export function hotkeyLabel(h: string | null): string {
  if (!h) return "";
  const parts = h.split("+");
  const key = (parts.pop() ?? "").replace(/^Key(?=[A-Z]$)|^Digit(?=[0-9]$)/, "");
  const sym: Record<string, string> = {
    control: "⌃",
    ctrl: "⌃",
    alt: "⌥",
    option: "⌥",
    shift: "⇧",
    command: "⌘",
    cmd: "⌘",
    super: "⌘",
    cmdorctrl: "⌘",
    commandorcontrol: "⌘",
  };
  const order = "⌃⌥⇧⌘";
  const mods = parts
    .map((p) => sym[p.toLowerCase()] ?? "")
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .join("");
  return mods + (key.toLowerCase() === "space" ? "Space" : key.toUpperCase());
}

/** A rejection the person caused (Cancel in the shell's own sheet): not an error to show. */
export const isCancel = (e: unknown): boolean => (e instanceof Error ? e.message : String(e)) === "cancelled";

// ----- Settings › App: updates -----

export interface UpdateWords {
  state: string;
  version?: string;
  lastChecked?: string;
  error?: string;
  progress?: number;
}

export function updateLine(appVersion: string, u: UpdateWords): string {
  switch (u.state) {
    case "checking":
      return "Checking for updates…";
    case "downloading": {
      const pct = typeof u.progress === "number" ? ` ${Math.round(u.progress)}%` : "";
      return u.version ? `Downloading ${u.version}…${pct}` : `Downloading the update…${pct}`;
    }
    case "ready":
      return u.version ? `${u.version} is ready` : "An update is ready";
    case "error":
      return "Couldn't check for updates";
    default:
      return appVersion ? `sessionpipe ${appVersion} is up to date` : "sessionpipe is up to date";
  }
}

/** "Last checked just now" … "Last checked 3 days ago", or "" before the first check. */
export function lastCheckedLine(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return "Last checked just now";
  if (m < 60) return `Last checked ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Last checked ${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  return `Last checked ${d === 1 ? "yesterday" : `${d} days ago`}`;
}

/** The caption under the update row: the reason it failed, the version you have while
 *  another is on its way, and when it last looked. */
export function updateHint(appVersion: string, u: UpdateWords, now = Date.now()): string {
  const parts: string[] = [];
  if (u.state === "error" && u.error) parts.push(u.error);
  if (appVersion && (u.state === "ready" || u.state === "downloading")) parts.push(`You have ${appVersion}.`);
  const last = lastCheckedLine(u.lastChecked, now);
  if (last) parts.push(`${last}.`);
  return parts.join(" ");
}
