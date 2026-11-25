// SPDX-License-Identifier: Apache-2.0
// App settings, per device, in one localStorage key as JSON: the mode (Simple hides what
// most people never touch; Advanced is everything), the page the app opens on, whether
// Forget asks first, whether a session opens beside the page or as the page, the tier
// lens the whole app looks through (`null` = everything), and whether the sidebar shows
// what each account has left, and how wide the labelled sidebar is. The appearance, the color theme and the text size stay in
// lib/theme.ts (the appearance popover). Only what the person set is stored, so a default
// can change under a device that never chose (as NSUserDefaults registers defaults).
// Reading is tolerant: an unknown or malformed field falls back to its default, so a
// build may add fields, and a field a newer build wrote is kept.

import type { Tier } from "@shared/api";
import { useSyncExternalStore } from "react";
import { phoneLayout } from "./device";

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
  /** The labelled sidebar's width in px (SIDEBAR_MIN to SIDEBAR_MAX), dragged at its edge. */
  sidebarWidth: number;
}

/** The labelled sidebar's widths: from the narrowest its rows were drawn for to where the
 *  page would give up too much, and the width a device starts at. */
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_DEFAULT = 288;
/** A width as the sidebar takes it: whole pixels, inside its range. */
export const sidebarClamp = (px: number): number =>
  Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(Number.isFinite(px) ? px : SIDEBAR_DEFAULT)));

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
 *  only that explicit choice persists Advanced. A session opens beside the page on a
 *  computer and as its page on the phone, until the device chooses. */
const defaults = (phone: boolean): AppSettings => ({
  mode: "simple",
  defaultPage: "/",
  confirmForget: true,
  openSessions: phone ? "page" : "beside",
  tierLens: null,
  usageInSidebar: true,
  sidebarWidth: SIDEBAR_DEFAULT,
});

const isLens = (v: unknown): v is Lens => v === null || v === 0 || v === 1 || v === 2 || v === 3;

/** The stored form's version. Before 2 every save wrote every field. */
const VERSION = 2;
type Stored = Partial<Record<keyof AppSettings, unknown>> & { v?: unknown };

/** What the device has set, as stored. Once, on the way to version 2, a stored
 *  openSessions "page" goes: it was the default, which every save wrote, not a choice. */
function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    const stored = p as Stored;
    if (stored.v !== VERSION) {
      if (stored.openSessions === "page") delete stored.openSessions;
      stored.v = VERSION;
      try {
        localStorage.setItem(KEY, JSON.stringify(stored));
      } catch {
        // the next save writes it
      }
    }
    return stored;
  } catch {
    return {};
  }
}

function resolve(p: Stored, d: AppSettings): AppSettings {
  return {
    mode: p.mode === "simple" || p.mode === "advanced" ? p.mode : d.mode,
    defaultPage: DEFAULT_PAGES.some((o) => o.value === p.defaultPage) ? (p.defaultPage as DefaultPage) : d.defaultPage,
    confirmForget: typeof p.confirmForget === "boolean" ? p.confirmForget : d.confirmForget,
    openSessions: p.openSessions === "beside" || p.openSessions === "page" ? p.openSessions : d.openSessions,
    tierLens: isLens(p.tierLens) ? p.tierLens : d.tierLens,
    usageInSidebar: typeof p.usageInSidebar === "boolean" ? p.usageInSidebar : d.usageInSidebar,
    sidebarWidth: typeof p.sidebarWidth === "number" ? sidebarClamp(p.sidebarWidth) : d.sidebarWidth,
  };
}

let stored: Stored = load();
/** The settings as read, for the layout they were read in; `phone` is null once the device
 *  has chosen how sessions open, the one default the layout decides. */
let cache: { s: AppSettings; phone: boolean | null } | null = null;

export function getSettings(): AppSettings {
  if (cache && (cache.phone === null || cache.phone === phoneLayout())) return cache.s;
  const chosen = stored.openSessions === "beside" || stored.openSessions === "page";
  const phone = !chosen && phoneLayout();
  cache = { s: resolve(stored, defaults(phone)), phone: chosen ? null : phone };
  return cache.s;
}

/** Sets the fields in `patch` and stores what the device has set: never a default it did
 *  not choose. */
export function setSettings(patch: Partial<AppSettings>): void {
  stored = { ...stored, ...patch, v: VERSION };
  cache = null;
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // private mode or blocked storage: the choice lasts for this page only
  }
  for (const l of listeners) l();
}

export const setMode = (mode: Mode) => setSettings({ mode });
export const setTierLens = (tierLens: Lens) => setSettings({ tierLens });

/** The next lens along: all → 0 → 1 → 2 → 3 → all. Nothing in Simple mode (the lens is off there). */
export function cycleLens(): Lens {
  const settings = getSettings();
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
export const effectiveLens = (s: AppSettings = getSettings()): Lens => (s.mode === "simple" ? null : s.tierLens);
export const useLens = (): Lens => effectiveLens(useAppSettings());

/** "lens · all" / "lens · 2". */
export const lensLabel = (l: Lens): string => (l === null ? "all" : String(l));

/** Fires on every change; for code outside React (the theme host). */
export const subscribeSettings = subscribe;
