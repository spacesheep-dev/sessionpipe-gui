// SPDX-License-Identifier: Apache-2.0
// WCAG contrast for the token values a skin sets, so the server can say when a skin's
// text tiers fall under the floors tokens.css promises (fg ≥ 7:1, fg-2 ≥ 5:1, fg-3 ≥ 4.5:1
// for 12–13 px meta text, fg-4 ≥ 3:1 for marks only) on the page and the card. Parses the
// colour forms a skin is likely to use: oklch(), #hex, rgb(). Anything else is left
// unmeasured rather than guessed. No dependencies.
import type { SkinTokens } from "./skin-api.js";

export type Rgb = [number, number, number];

const gam = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp01 = (c: number): number => Math.min(1, Math.max(0, c));

/** `oklch(L C H)` (L as 0–1 or a percentage), `#rgb`/`#rrggbb`, `rgb(r, g, b)` / `rgb(r g b)`
 *  → sRGB 0–1, gamut-clipped; null for anything else (var(), color-mix(), keywords). */
export function parseCssColor(value: string): Rgb | null {
  const s = value.trim();
  let m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/.*)?\)$/i.exec(s);
  if (m) {
    const L = m[2] ? Number(m[1]) / 100 : Number(m[1]);
    const C = Number(m[3]);
    const h = (Number(m[4]) * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const ss = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      gam(clamp01(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss)),
      gam(clamp01(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss)),
      gam(clamp01(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss)),
    ];
  }
  m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) {
    const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
    return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
  }
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/].*)?\)$/i.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255].map(clamp01) as Rgb;
  return null;
}

export const luminance = ([r, g, b]: Rgb): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** WCAG 2 contrast ratio of two CSS colours, or null when one cannot be parsed. */
export function contrastRatio(a: string, b: string): number | null {
  const x = parseCssColor(a);
  const y = parseCssColor(b);
  if (!x || !y) return null;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The text tiers and the floor each must clear on `--bg` and `--bg-2`. */
export const TEXT_TIERS: readonly [token: "--fg" | "--fg-2" | "--fg-3" | "--fg-4", floor: number][] = [
  ["--fg", 7],
  ["--fg-2", 5],
  ["--fg-3", 4.5],
  ["--fg-4", 3],
];
const GROUNDS = ["--bg", "--bg-2"] as const;

/** The stock values of the six tokens the check reads (tokens.css), so a skin that sets
 *  only some of them is measured against what the page fills in for the rest. Kept by
 *  hand beside tokens.css; shared/skins-builtin.test.ts holds them equal. */
export const STOCK_TEXT_TOKENS: Record<
  "dark" | "light",
  Record<(typeof GROUNDS)[number] | "--fg" | "--fg-2" | "--fg-3" | "--fg-4", string>
> = {
  light: {
    "--bg": "#ffffff",
    "--bg-2": "#ffffff",
    "--fg": "#141414",
    "--fg-2": "#454545",
    "--fg-3": "#5c5c5a",
    "--fg-4": "#858581",
  },
  dark: {
    "--bg": "#141414",
    "--bg-2": "#1c1c1b",
    "--fg": "#f5f5f3",
    "--fg-2": "#c4c4c0",
    "--fg-3": "#9a9a96",
    "--fg-4": "#6e6e6a",
  },
};

/** Every text tier under its floor on the page or the card, as one short line each
 *  ("--fg-3 on --bg 3.9:1, needs 4.5"); empty when all clear or nothing is measurable. */
export function textTierWarnings(tokens: SkinTokens, scheme: "dark" | "light"): string[] {
  const stock = STOCK_TEXT_TOKENS[scheme];
  const value = (k: keyof typeof stock): string => tokens[k] ?? stock[k];
  const out: string[] = [];
  for (const [fg, floor] of TEXT_TIERS) {
    for (const bg of GROUNDS) {
      // Only pairs the skin has a hand in: a skin that sets no text tier and no ground is
      // the stock scheme, which clears its own floors.
      if (tokens[fg] === undefined && tokens[bg] === undefined) continue;
      const r = contrastRatio(value(fg), value(bg));
      if (r !== null && r < floor) out.push(`${fg} on ${bg} ${r.toFixed(1)}:1, needs ${floor}`);
    }
  }
  return out;
}
