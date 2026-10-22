// SPDX-License-Identifier: Apache-2.0
// A color theme is a set of the design tokens in web/src/styles/tokens.css, like a VS
// Code color theme: a name, the scheme it is for, and the custom properties it sets.
// Custom ones are JSON files the server reads from <stateDir>/color-themes/*.json and
// serves at /api/ui/color-themes; since skins (shared/skin-api.ts) they are also listed
// by GET /api/ui/skins as token-only skins, and the built-ins live in shared/skins-builtin.ts.

/** Every colour custom property of tokens.css. A theme may set any subset; the scheme's
 *  defaults fill the rest. */
export const COLOR_TOKEN_NAMES = [
  "--bg",
  "--bg-2",
  "--bg-3",
  "--bg-4",
  "--line",
  "--line-2",
  "--fg",
  "--fg-2",
  "--fg-3",
  "--fg-4",
  "--needs",
  "--needs-fg",
  "--needs-bg",
  "--needs-line",
  "--needs-ink",
  "--state-working",
  "--state-working-bg",
  "--state-stale",
  "--state-stale-bg",
  "--work",
  "--work-fg",
  "--work-bg",
  "--work-line",
  "--stale",
  "--stale-fg",
  "--stale-bg",
  "--idle",
  "--idle-fg",
  "--done",
  "--done-fg",
  "--ok",
  "--err",
  "--err-soft",
  "--err-bg",
  "--focus",
  "--mark",
  "--mark-fg",
  "--shadow",
  "--qr-bg",
  "--qr-fg",
  "--label-red",
  "--label-orange",
  "--label-yellow",
  "--label-green",
  "--label-blue",
  "--label-purple",
  "--label-grey",
] as const;

export type ColorTokenName = (typeof COLOR_TOKEN_NAMES)[number];

export interface ColorTheme {
  /** `[a-z][a-z0-9-]{1,40}`; "default" is reserved for the built-in scheme. */
  id: string;
  name: string;
  /** The scheme the page is forced to while the theme is applied. */
  scheme: "dark" | "light";
  tokens: Partial<Record<ColorTokenName, string>>;
}

export interface ColorThemesResponse {
  themes: ColorTheme[];
  /** Files that did not parse or validate, with why. */
  errors: { file: string; error: string }[];
}

export const COLOR_THEME_ID = /^[a-z][a-z0-9-]{1,40}$/;

/** A CSS colour value we accept: a keyword or function, no braces, semicolons or url(). */
export const COLOR_TOKEN_VALUE = /^[A-Za-z0-9#%.,\s()/+-]{1,120}$/;
const TOKEN_VALUE = COLOR_TOKEN_VALUE;

/** The theme a JSON document describes, or the reason it is refused. At least `--bg`
 *  and `--fg` must be set, and every key must be a token name from tokens.css. */
export function parseColorTheme(doc: unknown): { theme: ColorTheme } | { error: string } {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { error: "not an object" };
  const d = doc as Record<string, unknown>;
  if (typeof d.id !== "string" || !COLOR_THEME_ID.test(d.id)) return { error: "id must match [a-z][a-z0-9-]{1,40}" };
  if (d.id === "default") return { error: '"default" is the built-in scheme' };
  if (typeof d.name !== "string" || !d.name.trim() || d.name.length > 60) return { error: "name must be 1–60 chars" };
  if (d.scheme !== "dark" && d.scheme !== "light") return { error: 'scheme must be "dark" or "light"' };
  if (!d.tokens || typeof d.tokens !== "object" || Array.isArray(d.tokens))
    return { error: "tokens must be an object" };
  const tokens: Partial<Record<ColorTokenName, string>> = {};
  for (const [k, v] of Object.entries(d.tokens as Record<string, unknown>)) {
    if (!(COLOR_TOKEN_NAMES as readonly string[]).includes(k)) return { error: `unknown token ${k}` };
    if (typeof v !== "string" || !TOKEN_VALUE.test(v)) return { error: `${k} must be a CSS colour value` };
    tokens[k as ColorTokenName] = v.trim();
  }
  if (!tokens["--bg"] || !tokens["--fg"]) return { error: "tokens must set at least --bg and --fg" };
  return { theme: { id: d.id, name: d.name.trim(), scheme: d.scheme, tokens } };
}
