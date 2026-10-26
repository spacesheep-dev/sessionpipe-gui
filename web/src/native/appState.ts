// SPDX-License-Identifier: Apache-2.0
// What the page knows of the app around it (NATIVE-SPEC §11.1): its settings, the update,
// the receivers, the notification permission. Commands go to the shell; the shell's
// `update` and `receivers` events keep it current. Small stores for useSyncExternalStore.
import { useSyncExternalStore } from "react";
import { invoke } from "./bridge";

export interface AppSettings {
  launchAtLogin: boolean;
  menuBar: boolean;
  dockBadge: boolean;
  keepRunning: boolean;
  menuBarOnly: boolean;
  /** The New session shortcut, an accelerator ("Control+Alt+N"), or null (off). It
   *  changes through app_shortcut_set, which can fail (taken by another app). */
  hotkey: string | null;
  /** kinds: permission, question, error, idle; pausedUntil: an ISO time, or null. */
  notifications: { enabled: boolean; kinds: Record<string, boolean>; pausedUntil: string | null };
  /** Set once the first-run sheet has been seen (when the shell reports it). */
  firstRunDone?: boolean;
}
export interface Receiver {
  id: string;
  name: string;
  origin: string;
  local: boolean;
  connected?: boolean;
}
export type UpdateState = "idle" | "checking" | "downloading" | "ready" | "error";
export interface UpdateStatus {
  state: UpdateState;
  version?: string;
}
export type NotifyStatus = "granted" | "denied" | "undetermined";

/** A value with listeners. */
export function cell<T>(initial: T) {
  let value = initial;
  const ls = new Set<() => void>();
  return {
    get: () => value,
    set(v: T) {
      value = v;
      for (const l of ls) l();
    },
    subscribe(l: () => void) {
      ls.add(l);
      return () => void ls.delete(l);
    },
  };
}

export const settings = cell<AppSettings | null>(null);
export const update = cell<UpdateStatus>({ state: "idle" });
export const receivers = cell<Receiver[] | null>(null);
export const notify = cell<NotifyStatus | null>(null);

export const useCell = <T>(c: ReturnType<typeof cell<T>>): T => useSyncExternalStore(c.subscribe, c.get, c.get);

export async function loadSettings(): Promise<AppSettings | null> {
  try {
    const s = await invoke<AppSettings>("app_settings_get");
    settings.set(s);
    return s;
  } catch {
    return null;
  }
}

/** A change to the app's settings: shown at once, sent, and the shell's answer kept. */
export async function patchSettings(p: Partial<AppSettings>): Promise<void> {
  const before = settings.get();
  if (before) settings.set({ ...before, ...p });
  try {
    const s = await invoke<AppSettings | null>("app_settings_set", { settings: { ...before, ...p } });
    if (s) settings.set(s);
  } catch (err) {
    settings.set(before);
    throw err;
  }
}

/** Sets or clears the global New session shortcut; rejects with the system's reason. */
export async function setHotkey(hotkey: string | null): Promise<void> {
  settings.set(await invoke<AppSettings>("app_shortcut_set", { hotkey }));
}

export async function loadReceivers(): Promise<void> {
  try {
    receivers.set(await invoke<Receiver[]>("rx_list"));
  } catch {
    receivers.set([]);
  }
}
export async function loadUpdate(): Promise<void> {
  try {
    update.set(await invoke<UpdateStatus>("app_update_status"));
  } catch {}
}
export async function loadNotify(): Promise<NotifyStatus | null> {
  try {
    const s = await invoke<NotifyStatus>("app_notify_status");
    notify.set(s);
    return s;
  } catch {
    return null;
  }
}
export async function requestNotify(): Promise<NotifyStatus | null> {
  try {
    const s = await invoke<NotifyStatus>("app_notify_request");
    notify.set(s);
    return s;
  } catch {
    return null;
  }
}

type On = <T>(event: string, fn: (p: T) => void) => Promise<unknown>;
/** The shell's events for these stores (shell.ts calls it once). */
export function wire(on: On): void {
  void on<UpdateStatus>("update", (p) => p?.state && update.set(p));
  void on<{ list?: Receiver[] }>("receivers", (p) => Array.isArray(p?.list) && receivers.set(p.list));
}
