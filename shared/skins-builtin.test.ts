// SPDX-License-Identifier: Apache-2.0
// The default skin is tokens.css word for word (so the first frame, before any script, is
// already on brand), and both shipped skins keep the brand's colour rules (docs/brand.md):
// the orange reads as a dot or glyph (3:1) and as text in its text cut (4.5:1), ink on an
// orange fill reads, the ring reads, and the error crimson never comes near the orange.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseCssColor, STOCK_TEXT_TOKENS } from "./contrast.js";
import type { SkinTokens } from "./skin-api.js";
import { BUILTIN_SKINS, DEFAULT_SKIN_ID } from "./skins-builtin.js";

const css = readFileSync(new URL("../web/src/styles/tokens.css", import.meta.url), "utf8");
/** The custom properties of the first block that starts with `head`, by name. */
function block(head: string): Record<string, string> {
  const at = css.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  const body = css.slice(at + head.length, css.indexOf("\n}", at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) out[m[1]!] = m[2]!.trim();
  return out;
}
const light = block(":root {");
const forced = block(':root[data-theme="dark"] {');
const media = block(':root:not([data-theme="light"]) {');
// A dark block sets what differs; the rest comes from :root.
const stock = { light, dark: { ...light, ...forced } };
const def = BUILTIN_SKINS.find((s) => s.id === DEFAULT_SKIN_ID)!;

/** sRGB → OKLab, for the distance between two hues. */
function oklab(c: string): [number, number, number] {
  const lin = parseCssColor(c)!.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as number[];
  const [r, g, b] = lin as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const dist = (a: string, b: string) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]!));

describe("the sessionpipe skin", () => {
  it("is the default", () => {
    expect(DEFAULT_SKIN_ID).toBe("sessionpipe");
    expect(BUILTIN_SKINS.map((s) => s.id)).toEqual(["sessionpipe", "plain", "paper"]);
  });

  it("is tokens.css word for word, in both schemes and both dark blocks", () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const [k, v] of Object.entries(def.tokens[scheme]!)) expect(stock[scheme][k], `${scheme} ${k}`).toBe(v);
      for (const [k, v] of Object.entries(STOCK_TEXT_TOKENS[scheme])) expect(stock[scheme][k], `stock ${k}`).toBe(v);
    }
    expect(media).toEqual(forced);
  });
});

describe("the brand's colour rules, in every shipped skin and scheme", () => {
  const cases: [string, SkinTokens][] = [
    ["sessionpipe light", def.tokens.light!],
    ["sessionpipe dark", def.tokens.dark!],
    ["paper", BUILTIN_SKINS.find((s) => s.id === "paper")!.tokens.light!],
  ];
  for (const [name, t] of cases) {
    it(name, () => {
      const ratio = (a: keyof SkinTokens, b: keyof SkinTokens) => contrastRatio(t[a]!, t[b]!)!;
      for (const ground of ["--bg", "--bg-2"] as const) {
        expect(ratio("--needs", ground), `needs dot on ${ground}`).toBeGreaterThanOrEqual(3);
        expect(ratio("--needs-fg", ground), `needs text on ${ground}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio("--err", ground), `error text on ${ground}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio("--focus", ground), `ring on ${ground}`).toBeGreaterThanOrEqual(3);
      }
      expect(ratio("--needs-ink", "--needs"), "text on the orange").toBeGreaterThanOrEqual(4.5);
      expect(ratio("--mark-fg", "--mark"), "a search hit").toBeGreaterThanOrEqual(7);
      expect(dist(t["--err"]!, t["--needs"]!), "error vs accent, OKLab").toBeGreaterThanOrEqual(0.1);
    });
  }
});
