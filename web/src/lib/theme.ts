// SPDX-License-Identifier: Apache-2.0
// Per-device display settings, persisted in localStorage: the appearance (follow the OS,
// dark, light), the skin (a token / font / shape package; a single-scheme skin forces its
// scheme while applied, a "both" skin follows the appearance) and the text size (a scale
// on the root font-size, so every rem-based size follows). The skin itself is stored,
// not only its id, so it applies at boot before any fetch. A device with no stored skin
// gets Spacesheep; a device that chose a color theme before skins existed keeps it (the
// old key is read once and rewritten under the new one).
import type { ColorTheme } from "@shared/color-theme";
import { skinSchemeFor } from "@shared/skin-api";
import { useSyncExternalStore } from "react";
import {
  applySkin,
  BUILTIN_SKINS,
  DEFAULT_SKIN,
  DEFAULT_SKIN_ID,
  findSkin,
  getSkins,
  type InstalledSkin,
  PLAIN_SKIN_ID,
  subscribeSkins,
} from "./skins";

export type Theme = "auto" | "light" | "dark";
export type TextSize = 0.9 | 1 | 1.1 | 1.25;
export const TEXT_SIZES: readonly TextSize[] = [0.9, 1, 1.1, 1.25];

export interface Settings {
  appearance: Theme;
  /** The applied skin itself (not just its id), so it applies at boot before any fetch. */
  skin: InstalledSkin;
  textSize: TextSize;
}

const KEY = "sessionpipe-gui.theme";
const KEY_SKIN = "sessionpipe-gui.skin";
/** Before skins: the color theme, stored whole. Read once, then moved to KEY_SKIN. */
const KEY_COLOR_OLD = "sessionpipe-gui.colorTheme";
const KEY_TEXT = "sessionpipe-gui.textSize";
const listeners = new Set<() => void>();

const isSkin = (v: unknown): v is InstalledSkin =>
  !!v &&
  typeof v === "object" &&
  typeof (v as InstalledSkin).id === "string" &&
  typeof (v as InstalledSkin).scheme === "string" &&
  !!(v as InstalledSkin).tokens &&
  typeof (v as InstalledSkin).tokens === "object";

/** A stored color theme as a skin: the built-in of that id, else a token-only skin. */
export function skinFromColorTheme(ct: ColorTheme): InstalledSkin {
  const builtin = BUILTIN_SKINS.find((s) => s.id === ct.id);
  if (builtin) return builtin;
  return {
    id: ct.id,
    name: ct.name,
    version: "",
    scheme: ct.scheme,
    source: "color-theme",
    tokens: { [ct.scheme]: ct.tokens },
    origin: `${ct.id}.json`,
  };
}

/** A stored skin as it applies today: a built-in from this build's own list (so an update
 *  shows at once), and Spacesheep for Plain or for a built-in this build no longer ships. */
const current = (skin: InstalledSkin): InstalledSkin => {
  if (skin.source !== "builtin") return skin;
  if (skin.id === PLAIN_SKIN_ID) return DEFAULT_SKIN;
  return BUILTIN_SKINS.find((b) => b.id === skin.id) ?? DEFAULT_SKIN;
};

const read = (): Settings => {
  let appearance: Theme = "auto";
  let skin: InstalledSkin = DEFAULT_SKIN;
  let textSize: TextSize = 1;
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") appearance = v;
    const s = localStorage.getItem(KEY_SKIN);
    if (s) {
      const parsed: unknown = JSON.parse(s);
      if (isSkin(parsed)) skin = current(parsed);
    } else {
      const old = localStorage.getItem(KEY_COLOR_OLD);
      if (old) {
        const parsed = JSON.parse(old) as ColorTheme;
        if (parsed && typeof parsed.id === "string" && parsed.tokens) skin = skinFromColorTheme(parsed);
        localStorage.setItem(KEY_SKIN, JSON.stringify(skin));
        localStorage.removeItem(KEY_COLOR_OLD);
      }
    }
    const t = Number(localStorage.getItem(KEY_TEXT));
    if ((TEXT_SIZES as readonly number[]).includes(t)) textSize = t as TextSize;
  } catch {
    // private mode or blocked storage: defaults
  }
  return { appearance, skin, textSize };
};
let settings: Settings = read();

const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // the choice lasts for this page only
  }
};

/** The scheme the OS asks for right now. */
const osScheme = (): "dark" | "light" =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

/** The scheme the page renders in for these settings: the skin's own, else the appearance. */
export function resolvedScheme(s: Settings = settings): "dark" | "light" {
  return skinSchemeFor(s.skin, s.appearance === "auto" ? osScheme() : s.appearance);
}

/** Puts every setting on the document. Called at boot and after each change. */
export function applySettings(s: Settings = settings): void {
  const root = document.documentElement;
  const forced = s.skin.scheme === "both" ? s.appearance : s.skin.scheme;
  if (forced === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", forced);
  applySkin(s.skin, resolvedScheme(s));
  const scale = s.textSize * (s.skin.typography?.scale ?? 1);
  root.style.fontSize = scale === 1 ? "" : `${Math.round(scale * 1000) / 10}%`;
}

/** Kept for callers of the first version; applies everything. */
export const applyTheme = (t?: Theme): void => applySettings(t ? { ...settings, appearance: t } : settings);

/** Holds every transition off while a change lands (base.css `[data-switching]`), so a
 *  scheme or skin switch is one frame, as the OS's is, not a colour tween of the window.
 *  Two frames: the first paints the new colours, the second lets transitions back in. */
function switching(): void {
  const root = document.documentElement;
  root.setAttribute("data-switching", "");
  requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute("data-switching")));
}

function commit(next: Settings) {
  settings = next;
  switching();
  applySettings(next);
  for (const l of listeners) l();
}

export function setTheme(t: Theme): void {
  write(KEY, t === "auto" ? null : t);
  commit({ ...settings, appearance: t });
}

export function setSkin(skin: InstalledSkin): void {
  write(KEY_SKIN, JSON.stringify(skin));
  commit({ ...settings, skin });
}

export function setTextSize(size: TextSize): void {
  write(KEY_TEXT, size === 1 ? null : String(size));
  commit({ ...settings, textSize: size });
}

// A "both" skin under the "System" appearance follows the OS as it changes.
if (typeof matchMedia === "function") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (settings.appearance !== "auto") return;
    switching();
    applySettings();
  });
}

// When the list arrives with a newer copy of the applied skin (a linked skin edited, a
// built-in changed by an update), apply that copy and store it.
// A skin the list no longer has (a bundled one this version dropped, one uninstalled
// elsewhere) falls back to the default, quietly.
subscribeSkins(() => {
  const fresh = findSkin(settings.skin.id);
  if (fresh && !fresh.error && JSON.stringify(fresh) !== JSON.stringify(settings.skin)) setSkin(fresh);
  else if (!fresh && getSkins().loaded && !getSkins().error && settings.skin.id !== DEFAULT_SKIN_ID)
    setSkin(DEFAULT_SKIN);
});

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The display settings now (for code outside render: a menu builder). */
export const getDisplaySettings = (): Settings => settings;

export function useSettings(): Settings {
  return useSyncExternalStore(
    subscribe,
    () => settings,
    () => settings,
  );
}

export function useTheme(): Theme {
  return useSettings().appearance;
}
