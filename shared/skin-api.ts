// SPDX-License-Identifier: Apache-2.0
// A skin is the third kind of extension: a package that restyles the GUI without code.
// Its skin.json names the design tokens it sets (the colour tokens of tokens.css, per
// scheme), the fonts it bundles, the typography and shape it wants (radius, hairline,
// density) and an optional stylesheet loaded last. Installed under <stateDir>/skins/<id>/,
// served at /skins/<id>/, picked in the appearance popover. The old color-theme JSON files
// (shared/color-theme.ts) are listed beside them as token-only skins, and the built-ins
// (shared/skins-builtin.ts) complete the one list GET /api/ui/skins returns.
import { COLOR_TOKEN_NAMES, type ColorTokenName } from "./color-theme.js";

export const SKIN_API_VERSION = 1;
export const SKIN_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;

export type SkinScheme = "dark" | "light" | "both";
export type SkinDensity = "compact" | "default" | "comfortable";
export type SkinHairline = 1 | 1.5 | 2;
export const SKIN_DENSITIES: readonly SkinDensity[] = ["compact", "default", "comfortable"];
export const SKIN_HAIRLINES: readonly SkinHairline[] = [1, 1.5, 2];
/** `typography.scale` multiplies the root font size; the text-size setting stacks on it. */
export const SKIN_SCALE_MIN = 0.9;
export const SKIN_SCALE_MAX = 1.15;
/** `shape.radius`, in px. */
export const SKIN_RADIUS_MAX = 24;

/** Beyond the colour tokens, the style variables a skin's `tokens` may set directly
 *  (the structured `typography` and `shape` fields are the usual way). */
export const SKIN_STYLE_TOKEN_NAMES = ["--font-ui", "--font-mono", "--radius", "--radius-sm", "--hairline"] as const;
export type SkinStyleTokenName = (typeof SKIN_STYLE_TOKEN_NAMES)[number];
export type SkinTokenName = ColorTokenName | SkinStyleTokenName;
export const SKIN_TOKEN_NAMES: readonly string[] = [...COLOR_TOKEN_NAMES, ...SKIN_STYLE_TOKEN_NAMES];

export type SkinTokens = Partial<Record<SkinTokenName, string>>;
/** One token set per scheme; a single-scheme skin fills one, a "both" skin fills both. */
export interface SkinTokenSets {
  dark?: SkinTokens;
  light?: SkinTokens;
}

export interface SkinFont {
  /** The `font-family` name the `typography` stacks refer to. */
  family: string;
  /** A font file inside the package (`fonts/Literata.woff2`); woff2, woff, ttf or otf. */
  src: string;
  /** `font-weight`: "400", "600", or a range for a variable font, "200 900". Default "400". */
  weight?: string;
  /** `font-style`: "normal" (default) or "italic". */
  style?: string;
}

export interface SkinTypography {
  /** The `--font-ui` stack. */
  ui?: string;
  /** The `--font-mono` stack. */
  mono?: string;
  /** Root font-size multiplier, 0.9–1.15. */
  scale?: number;
}

export interface SkinShape {
  /** `--radius` and `--radius-sm`, in px (0–24). */
  radius?: number;
  /** `--hairline`: the width of every rule and border that is a hairline today. */
  hairline?: SkinHairline;
  /** Row heights and paddings: `data-density` on <html>, mapped in density.css. */
  density?: SkinDensity;
}

/** skin.json. */
export interface SkinManifest {
  id: string;
  name: string;
  version: string;
  kind: "skin";
  /** The skin contract version this was written against (SKIN_API_VERSION). */
  api: number;
  description?: string;
  scheme: SkinScheme;
  /** A flat token map for "dark" or "light"; `{ dark, light }` for "both". */
  tokens: SkinTokens | { dark: SkinTokens; light: SkinTokens };
  fonts?: SkinFont[];
  typography?: SkinTypography;
  shape?: SkinShape;
  /** A stylesheet inside the package, linked after the app's own. Scope its selectors. */
  css?: string;
  /** An image inside the package, for listings. */
  preview?: string;
  /** Written by the installer. */
  source?: string;
}

export type SkinSource = "builtin" | "color-theme" | "skin";

/** One entry of GET /api/ui/skins: a built-in, a color-theme file or an installed package,
 *  in the one shape the page applies (tokens normalised per scheme). */
export interface InstalledSkin {
  id: string;
  name: string;
  version: string;
  description?: string;
  scheme: SkinScheme;
  source: SkinSource;
  tokens: SkinTokenSets;
  fonts?: SkinFont[];
  typography?: SkinTypography;
  shape?: SkinShape;
  css?: string;
  preview?: string;
  /** `/skins/<id>/` for a package: `fonts[].src`, `css` and `preview` resolve against it. */
  url?: string;
  /** Where it came from: the installer's source, the color-theme file's name, or
   *  "bundled" for a package that ships with the GUI. */
  origin?: string;
  linked?: boolean;
  /** Shipped with the GUI (dist/bundled/skins/<id>), not installed by the person: listed
   *  after their own installs (an install of the same id overrides it), cannot be removed,
   *  only disabled (`sessionpipe-gui skin disable <id>`). */
  bundled?: boolean;
  /** Turned off (config.json `disabled`, as `skin:<id>`): kept in the list so a terminal
   *  can show it, left out of the appearance popover, its files not served. */
  disabled?: boolean;
  /** On disk; loopback only. */
  dir?: string;
  /** Why it cannot be applied; listed so the problem shows. */
  error?: string;
  /** Applied all the same, but its text tiers fall under the floors (shared/contrast.ts):
   *  "--fg-3 on --bg 3.9:1, needs 4.5 · …", per scheme for a "both" skin. */
  warning?: string;
}

export const SKIN_ROUTES = {
  /** GET → { skins: InstalledSkin[] }: built-ins, then color-theme files and packages. */
  list: "/api/ui/skins",
  /** POST (loopback): re-read the skins and color-themes folders → { skins } */
  reload: "/api/ui/skins/reload",
  /** Static: /skins/:id/<file> */
  files: "/skins",
} as const;

/** The scheme a skin renders in: its own, or the appearance for a "both" skin. */
export function skinSchemeFor(skin: Pick<InstalledSkin, "scheme">, appearance: "dark" | "light"): "dark" | "light" {
  return skin.scheme === "both" ? appearance : skin.scheme;
}

/** The tokens to set for that scheme (empty when the skin has none for it). */
export function skinTokensFor(
  skin: Pick<InstalledSkin, "scheme" | "tokens">,
  appearance: "dark" | "light",
): SkinTokens {
  return skin.tokens[skinSchemeFor(skin, appearance)] ?? {};
}
