// SPDX-License-Identifier: Apache-2.0
// Skins on the page: `applySkin` puts one on the document (its tokens for the scheme in
// force, the font stacks, radius, hairline width, density, its @font-face rules and its
// stylesheet), and a small external store holds the list GET /api/ui/skins returns: the
// built-ins (shared/skins-builtin.ts, which the page has without a server), the
// color-theme files and the installed packages. The choice itself lives in lib/theme.ts.
import { COLOR_TOKEN_NAMES } from "@shared/color-theme";
import {
  type InstalledSkin,
  SKIN_ROUTES,
  SKIN_STYLE_TOKEN_NAMES,
  type SkinScheme,
  skinSchemeFor,
  skinTokensFor,
} from "@shared/skin-api";
import { BUILTIN_SKINS, DEFAULT_SKIN_ID, PLAIN_SKIN_ID } from "@shared/skins-builtin";
import { useSyncExternalStore } from "react";
import { apiUrl } from "./net";

export type { InstalledSkin, SkinScheme } from "@shared/skin-api";
export { BUILTIN_SKINS, DEFAULT_SKIN_ID, PLAIN_SKIN_ID } from "@shared/skins-builtin";

export const DEFAULT_SKIN: InstalledSkin = BUILTIN_SKINS.find((s) => s.id === DEFAULT_SKIN_ID)!;

const FONTS_ID = "skin-fonts";
const CSS_ID = "skin-css";

const cssString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The @font-face rules a skin's manifest describes, against its files' URL. */
export function fontFaceCss(skin: InstalledSkin): string {
  if (!skin.fonts?.length || !skin.url) return "";
  return skin.fonts
    .map((f) => {
      const src = apiUrl(`${skin.url}${f.src.split("/").map(encodeURIComponent).join("/")}`);
      const ext = f.src.toLowerCase().split(".").pop();
      const format = ext === "ttf" ? "truetype" : ext === "otf" ? "opentype" : ext;
      return [
        "@font-face {",
        `  font-family: ${cssString(f.family)};`,
        `  src: url(${cssString(src)}) format(${cssString(format ?? "woff2")});`,
        `  font-weight: ${f.weight ?? "400"};`,
        `  font-style: ${f.style ?? "normal"};`,
        "  font-display: swap;",
        "}",
      ].join("\n");
    })
    .join("\n");
}

/** Puts the skin on <html>: tokens for `appearance` (a "both" skin follows it), the
 *  style variables, the density attribute, the font faces and the stylesheet. Everything a
 *  previous skin set is cleared first, so the scheme's own tokens show through where the
 *  skin says nothing. */
export function applySkin(skin: InstalledSkin, appearance: "dark" | "light"): void {
  const root = document.documentElement;
  const style = root.style;
  for (const name of [...COLOR_TOKEN_NAMES, ...SKIN_STYLE_TOKEN_NAMES]) style.removeProperty(name);

  const tokens = skinTokensFor(skin, appearance);
  for (const [k, v] of Object.entries(tokens)) if (v) style.setProperty(k, v);
  if (skin.typography?.ui) style.setProperty("--font-ui", skin.typography.ui);
  if (skin.typography?.mono) style.setProperty("--font-mono", skin.typography.mono);
  if (skin.shape?.radius !== undefined) {
    style.setProperty("--radius", `${skin.shape.radius}px`);
    style.setProperty("--radius-sm", `${skin.shape.radius}px`);
  }
  if (skin.shape?.hairline !== undefined) style.setProperty("--hairline", `${skin.shape.hairline}px`);
  if (skin.shape?.density && skin.shape.density !== "default") root.setAttribute("data-density", skin.shape.density);
  else root.removeAttribute("data-density");
  root.setAttribute("data-skin", skin.id);
  root.setAttribute("data-skin-scheme", skinSchemeFor(skin, appearance));

  const faces = fontFaceCss(skin);
  let fontsEl = document.getElementById(FONTS_ID);
  if (faces) {
    if (!fontsEl) {
      fontsEl = document.createElement("style");
      fontsEl.id = FONTS_ID;
      document.head.append(fontsEl);
    }
    if (fontsEl.textContent !== faces) fontsEl.textContent = faces;
  } else fontsEl?.remove();

  const cssEl = document.getElementById(CSS_ID) as HTMLLinkElement | null;
  const href = skin.css && skin.url ? apiUrl(`${skin.url}${skin.css}${skin.linked ? `?t=${Date.now()}` : ""}`) : null;
  if (href) {
    const link = cssEl ?? document.createElement("link");
    link.id = CSS_ID;
    link.rel = "stylesheet";
    // A new href only when the skin or its file changed, so a re-apply does not reload it.
    if (link.getAttribute("href")?.split("?")[0] !== href.split("?")[0] || link.dataset.skin !== skin.id) {
      link.href = href;
    }
    link.dataset.skin = skin.id;
    // Last in <head>: after the app's own stylesheets, so the skin's rules win on a tie.
    if (link.parentNode !== document.head || link.nextSibling) document.head.append(link);
  } else cssEl?.remove();
}

/** The scheme word(s) for a row's hint. */
export function schemeLabel(scheme: SkinScheme): string {
  return scheme === "both" ? "dark · light" : scheme;
}

// ----- the list the server serves -----

export interface SkinsState {
  skins: readonly InstalledSkin[];
  /** The first fetch finished (with a list, or with the built-ins when there is no server). */
  loaded: boolean;
  error: string | null;
}

let state: SkinsState = { skins: BUILTIN_SKINS, loaded: false, error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function set(next: SkinsState) {
  state = next;
  for (const l of listeners) l();
}

async function request(method: "GET" | "POST", url: string): Promise<InstalledSkin[]> {
  const res = await fetch(apiUrl(url), { method, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { skins?: InstalledSkin[] };
  return body.skins ?? [];
}

/** Fetch the list once; concurrent callers share the request. */
export function fetchSkins(): Promise<void> {
  if (inflight) return inflight;
  inflight = request("GET", SKIN_ROUTES.list)
    .then((skins) => set({ skins: skins.length ? skins : BUILTIN_SKINS, loaded: true, error: null }))
    .catch((e: unknown) => {
      // No server (mock mode) or an old one: the built-ins only.
      set({ ...state, loaded: true, error: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Re-read the folders on the receiver machine, then the fresh list. */
export async function reloadSkins(): Promise<void> {
  const skins = await request("POST", SKIN_ROUTES.reload);
  set({ skins: skins.length ? skins : BUILTIN_SKINS, loaded: true, error: null });
}

export const getSkins = (): SkinsState => state;

export function subscribeSkins(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSkins(): SkinsState {
  return useSyncExternalStore(subscribeSkins, getSkins, getSkins);
}

/** The skin with that id as the list knows it, else undefined. */
export function findSkin(id: string): InstalledSkin | undefined {
  return state.skins.find((s) => s.id === id);
}

export const isPlain = (skin: InstalledSkin): boolean => skin.id === PLAIN_SKIN_ID;
