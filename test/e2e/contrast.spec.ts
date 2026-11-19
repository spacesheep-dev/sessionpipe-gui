// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Increase contrast (the system's setting; prefers-contrast: more): muted text, marks,
// dividers and control edges step up over the tokens a skin writes inline on <html>, in
// each built-in skin and scheme, and the skin's own values are back when the setting goes
// off, with no reload. Plain is the stock tokens with nothing inline, which is what the
// first frame shows before the app's script, so that frame is what is measured. A colour is
// read as it is painted: a probe's computed colour, drawn on a canvas and read back as sRGB.
// And a switch on a computer reads on or off at a glance (WCAG 1.4.11): its track on, the
// edge of one off and its knob on the track at 3:1 or better, with the setting on or off.
import { expect, type Page, test } from "@playwright/test";
import { contrastRatio } from "../../shared/contrast.js";
import { BUILTIN_SKINS } from "../../shared/skins-builtin.js";
import { openBoard, openPage } from "./helpers.js";

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

/** Every switch on screen as painted (#rrggbb): its track, its knob, the edge an off one
 *  draws (null if none) and the card under it (the first ground that is not see-through). */
const switches = (page: Page) =>
  page.locator(".toggle").evaluateAll(async (els) => {
    // A switch just flipped is read once its colours have eased to the new state.
    await Promise.all(els.flatMap((el) => el.getAnimations({ subtree: true }).map((a) => a.finished)));
    const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const paint = (css: string) => {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = "#000";
      g.fillStyle = css;
      g.fillRect(0, 0, 1, 1);
      const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data;
      return a === 0 ? null : `#${[r, gr, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
    };
    return els.map((el) => {
      let card: string | null = null;
      for (let up = el.parentElement; up && !card; up = up.parentElement)
        card = paint(getComputedStyle(up).backgroundColor);
      const shadow = getComputedStyle(el).boxShadow;
      const edge = shadow === "none" ? null : /^(?:#\w+|[a-z-]+\([^)]*\))/.exec(shadow)?.[0];
      return {
        on: el.getAttribute("aria-checked") === "true",
        track: paint(getComputedStyle(el).backgroundColor)!,
        knob: paint(getComputedStyle(el.querySelector(".toggle-knob")!).backgroundColor)!,
        edge: edge ? paint(edge) : null,
        card: card ?? "#ffffff",
      };
    });
  });

interface SwitchCase {
  name: string;
  os: "dark" | "light";
  theme?: "dark";
  skin?: "paper";
  contrast?: "more";
}

const SWITCH_CASES: SwitchCase[] = [
  { name: "sessionpipe, light", os: "light" },
  { name: "sessionpipe, Dark chosen", os: "light", theme: "dark" },
  { name: "sessionpipe, dark", os: "dark" },
  { name: "Paper", os: "light", skin: "paper" },
  { name: "sessionpipe, dark, with Increase contrast", os: "dark", contrast: "more" },
  { name: "sessionpipe, light, with Increase contrast", os: "light", contrast: "more" },
];

// A switch on is a filled pill, one off an outlined one, and the knob stands out on the
// fill: each at 3:1 or better (WCAG 1.4.11), in either scheme, in each skin.
test.describe("switches", () => {
  for (const c of SWITCH_CASES) {
    test(`${c.name}: on and off read at a glance in Settings and Shortcuts`, async ({ page }) => {
      const skin = BUILTIN_SKINS.find((s) => s.id === (c.skin ?? "sessionpipe"))!;
      await page.emulateMedia({ colorScheme: c.os, contrast: c.contrast ?? "no-preference", reducedMotion: "reduce" });
      await page.addInitScript(
        ([theme, stored]) => {
          try {
            if (theme) localStorage.setItem("sessionpipe-gui.theme", theme);
            if (stored) localStorage.setItem("sessionpipe-gui.skin", stored);
          } catch {}
        },
        [c.theme ?? null, c.skin ? JSON.stringify(skin) : null] as const,
      );
      const pages = [
        // General: both switches are on; one goes off.
        { path: "/settings", flip: "Usage in the sidebar" },
        // The presets are all off; one goes on.
        { path: "/shortcuts", flip: "Vim-style preset" },
      ];
      for (const p of pages) {
        await openPage(page, p.path);
        await expect(page.locator("html")).toHaveAttribute("data-skin", skin.id);
        await page.getByRole("switch", { name: p.flip }).click();
        const all = await switches(page);
        expect(all.some((s) => s.on) && all.some((s) => !s.on), `${p.path}: a switch on and one off`).toBe(true);
        for (const s of all) {
          const at = `${p.path}, ${s.on ? "on" : "off"}`;
          if (s.on) {
            expect(contrastRatio(s.track, s.card)!, `${at}: the track on the card`).toBeGreaterThanOrEqual(3);
            expect(contrastRatio(s.knob, s.track)!, `${at}: the knob on the track`).toBeGreaterThanOrEqual(3);
            expect(s.edge, `${at}: no edge`).toBeNull();
          } else {
            expect(s.edge, `${at}: an edge`).not.toBeNull();
            expect(contrastRatio(s.edge!, s.card)!, `${at}: the edge on the card`).toBeGreaterThanOrEqual(3);
          }
        }
      }
    });
  }
});
