// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Increase contrast (the system's setting; prefers-contrast: more): muted text, marks,
// dividers and control edges step up over the tokens a skin writes inline on <html>, in
// each built-in skin and scheme, and the skin's own values are back when the setting goes
// off, with no reload. Plain is the stock tokens with nothing inline, which is what the
// first frame shows before the app's script, so that frame is what is measured. A colour is
// read as it is painted: a probe's computed colour, drawn on a canvas and read back as sRGB.
import { expect, type Page, test } from "@playwright/test";
import { contrastRatio } from "../../shared/contrast.js";
import { BUILTIN_SKINS } from "../../shared/skins-builtin.js";
import { openBoard } from "./helpers.js";

const STEPPED = ["--fg-3", "--fg-4", "--line", "--line-2"] as const;
const READ = ["--bg-2", "--bg-4", "--fg-2", ...STEPPED] as const;
type Painted = Record<(typeof READ)[number] | "--focus-width", string>;

/** Each token as the page paints it (#rrggbb), and the ring's width. */
const painted = (page: Page): Promise<Painted> =>
  page.evaluate((names) => {
    const probe = document.body.appendChild(document.createElement("i"));
    const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const root = getComputedStyle(document.documentElement);
    const out: Record<string, string> = { "--focus-width": root.getPropertyValue("--focus-width").trim() };
    for (const name of names) {
      probe.style.color = `var(${name})`;
      // A colour the canvas cannot read leaves black, never the token before it.
      g.fillStyle = "#000";
      g.fillStyle = getComputedStyle(probe).color;
      g.fillRect(0, 0, 1, 1);
      const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
      out[name] = `#${[r, gr, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
    }
    probe.remove();
    return out;
  }, READ) as Promise<Painted>;

interface Case {
  name: string;
  /** The system's scheme. */
  os: "dark" | "light";
  /** The scheme on screen. */
  shows: "dark" | "light";
  /** The appearance chosen on the device; none is System. */
  theme?: "dark";
  /** The skin stored on the device; none is sessionpipe, the default. */
  skin?: "paper";
  /** Plain: the stock tokens, measured on the first frame. */
  stock?: true;
}

const CASES: Case[] = [
  { name: "sessionpipe, light", os: "light", shows: "light" },
  { name: "sessionpipe, dark", os: "dark", shows: "dark" },
  { name: "Paper, which is light on a dark system too", os: "dark", shows: "light", skin: "paper" },
  { name: "Plain, light", os: "light", shows: "light", stock: true },
  { name: "Plain, dark", os: "dark", shows: "dark", stock: true },
  { name: "Plain, Dark chosen on a light system", os: "light", shows: "dark", theme: "dark", stock: true },
];

test.describe("Increase contrast", () => {
  for (const c of CASES) {
    test(`${c.name}: muted text, marks, dividers and control edges step up, and step back`, async ({ page }) => {
      const skin = BUILTIN_SKINS.find((s) => s.id === (c.skin ?? "sessionpipe"))!;
      // Plain's values are sessionpipe's, word for word (shared/skins-builtin.test.ts).
      const own = skin.tokens[c.shows]!;
      await page.emulateMedia({ colorScheme: c.os, contrast: "more" });
      await page.addInitScript(
        ([theme, stored]) => {
          try {
            if (theme) localStorage.setItem("sessionpipe-gui.theme", theme);
            if (stored) localStorage.setItem("sessionpipe-gui.skin", stored);
          } catch {}
        },
        [c.theme ?? null, c.skin ? JSON.stringify(skin) : null] as const,
      );
      if (c.stock) {
        // The first frame and no more: with the app's script kept out, no skin is applied.
        await page.route("**/assets/*.js", (r) => r.abort());
        await page.goto("/");
      } else {
        await openBoard(page);
        await expect(page.locator("html")).toHaveAttribute("data-skin", skin.id);
      }
      // What the stylesheet has to hold over: the skin's own value, inline (none on Plain).
      expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--line"))).toBe(
        c.stock ? "" : own["--line"],
      );

      const more = await painted(page);
      const ratio = (fg: (typeof STEPPED)[number], bg: "--bg-2" | "--bg-4") => contrastRatio(more[fg], more[bg])!;
      expect(more["--fg-3"], "meta text is the tier above it").toBe(more["--fg-2"]);
      expect(more["--fg-2"], "which is still the skin's").toBe(own["--fg-2"]);
      expect(ratio("--fg-4", "--bg-4"), "marks, on --bg-4").toBeGreaterThanOrEqual(4.5);
      const edge = ratio("--line-2", "--bg-2");
      expect(edge, "control edges").toBeGreaterThanOrEqual(3);
      const divider = ratio("--line", "--bg-2");
      expect(divider, "dividers can be found").toBeGreaterThanOrEqual(2);
      expect(divider, "dividers do not make a grid of the rows").toBeLessThanOrEqual(2.6);
      expect(divider, "dividers stay quieter than control edges").toBeLessThan(edge);
      expect(more["--focus-width"]).toBe("3px");

      // The setting goes off while the page is open: the skin's own values, with no reload.
      await page.emulateMedia({ contrast: "no-preference" });
      const off = await painted(page);
      for (const name of STEPPED) expect(off[name], name).toBe(own[name]);
      expect(off["--focus-width"]).toBe("2px");
      // And on again.
      await page.emulateMedia({ contrast: "more" });
      expect(await painted(page)).toEqual(more);
    });
  }
});
