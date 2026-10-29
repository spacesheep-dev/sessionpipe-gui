// SPDX-License-Identifier: Apache-2.0
// App settings, per device, in one localStorage key as JSON: the mode (Simple hides what
// most people never touch; Advanced is everything), the page the app opens on, whether
// Forget asks first, whether a session opens beside the page or as the page, the tier
// lens the whole app looks through (`null` = everything), and whether the sidebar shows
// what each account has left. The appearance, the color theme and the text size stay in
// lib/theme.ts (the appearance popover). Reading is tolerant: an unknown or malformed
// field falls back to its default, so a build may add fields.

import type { Tier } from "@shared/api";
import { useSyncExternalStore } from "react";

export type Mode = "simple" | "advanced";
export type DefaultPage = "/" | "/inbox" | "/feed" | "/review" | "/machines";
export type OpenSessions = "page" | "beside";
export type Lens = Tier | null;

export interface AppSettings {
  mode: Mode;
  defaultPage: DefaultPage;
  confirmForget: boolean;
  openSessions: OpenSessions;
  /** The app-wide tier lens; null = everything. Simple mode reads it as null. */
  tierLens: Lens;
  /** The sidebar's Usage lines (Shell.tsx UsageGlance), on this device. */
  usageInSidebar: boolean;
}

export const KEY = "sessionpipe-gui.settings";
export const DEFAULT_PAGES: { value: DefaultPage; label: string }[] = [
  { value: "/", label: "Board" },
  { value: "/inbox", label: "Inbox" },
  { value: "/feed", label: "Feed" },
  { value: "/review", label: "Review" },
  { value: "/machines", label: "Machines" },
];
export const LENSES: readonly Lens[] = [null, 0, 1, 2, 3];

const listeners = new Set<() => void>();

/** Simple is the default for every device until it chooses otherwise in Settings › General;
 *  only that explicit choice persists Advanced. */
const defaults = (): AppSettings => ({
  mode: "simple",
  defaultPage: "/",
  confirmForget: true,
  openSessions: "page",
  tierLens: null,
  usageInSidebar: true,
});

const isLens = (v: unknown): v is Lens => v === null || v === 0 || v === 1 || v === 2 || v === 3;

function read(): AppSettings {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) as Partial<Record<keyof AppSettings, unknown>>;
    return {
      mode: p.mode === "simple" || p.mode === "advanced" ? p.mode : d.mode,
      defaultPage: DEFAULT_PAGES.some((o) => o.value === p.defaultPage)
        ? (p.defaultPage as DefaultPage)
        : d.defaultPage,
      confirmForget: typeof p.confirmForget === "boolean" ? p.confirmForget : d.confirmForget,
      openSessions: p.openSessions === "beside" || p.openSessions === "page" ? p.openSessions : d.openSessions,
      tierLens: isLens(p.tierLens) ? p.tierLens : d.tierLens,
      usageInSidebar: typeof p.usageInSidebar === "boolean" ? p.usageInSidebar : d.usageInSidebar,
    };
  } catch {
    return d;
  }
}

let settings: AppSettings = read();

export function getSettings(): AppSettings {
  return settings;
}

export function setSettings(patch: Partial<AppSettings>): void {
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // private mode or blocked storage: the choice lasts for this page only
  }
  for (const l of listeners) l();
}

export const setMode = (mode: Mode) => setSettings({ mode });
export const setTierLens = (tierLens: Lens) => setSettings({ tierLens });

/** The next lens along: all → 0 → 1 → 2 → 3 → all. Nothing in Simple mode (the lens is off there). */
export function cycleLens(): Lens {
  if (settings.mode === "simple") return null;
  const i = LENSES.indexOf(settings.tierLens);
  const next = LENSES[(i + 1) % LENSES.length] ?? null;
  setTierLens(next);
  return next;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useAppSettings(): AppSettings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}

/** Simple or Advanced, live. */
export const useMode = (): Mode => useAppSettings().mode;
export const useSimple = (): boolean => useAppSettings().mode === "simple";

/** The lens the pages apply: the setting, except in Simple mode, where everything shows. */
export const effectiveLens = (s: AppSettings = settings): Lens => (s.mode === "simple" ? null : s.tierLens);
export const useLens = (): Lens => effectiveLens(useAppSettings());

/** "lens · all" / "lens · 2". */
export const lensLabel = (l: Lens): string => (l === null ? "all" : String(l));

/** Fires on every change; for code outside React (the theme host). */
export const subscribeSettings = subscribe;
