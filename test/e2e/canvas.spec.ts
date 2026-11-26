// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The bundled Canvas view draws its preset bar with the host's .seg / .seg-opt (shared.css)
// on markup of its own: a div of buttons, each as wide as its own label, in a bar sized
// for that width. The grid of equal segments is the app's own control's (fieldset.seg); a
// view's bar stays the flex row it was written against. The suite's server ships a fixture
// in place of the real bundled views (serve.mjs), so the page is handed the repo's Canvas
// here: its listing, its files and no stored layout.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openPage } from "./helpers.js";

const CANVAS = path.resolve(import.meta.dirname, "../../bundled/views/canvas");

async function shipCanvas(page: Page) {
  const manifest = JSON.parse(readFileSync(path.join(CANVAS, "theme.json"), "utf8")) as Record<string, unknown>;
  await page.route("**/api/ui/themes", async (r) => {
    const real = (await (await r.fetch()).json()) as { themes: unknown[] };
    await r.fulfill({
      json: { themes: [...real.themes, { ...manifest, url: "/themes/canvas/", source: "bundled", bundled: true }] },
    });
  });
  await page.route("**/themes/canvas/**", (r) =>
    r.fulfill({ path: path.join(CANVAS, new URL(r.request().url()).pathname.replace("/themes/canvas/", "")) }),
  );
  await page.route("**/api/ui/themes/canvas/state", (r) => r.fulfill({ status: 204, headers: { etag: '"e2e"' } }));
}

/** The presets in the bar, by name, with the width each one takes. */
const presets = (page: Page) =>
  page
    .locator(".cv-views .cv-view")
    .evaluateAll((els) =>
      Object.fromEntries(els.map((el) => [(el.textContent ?? "").trim(), el.getBoundingClientRect().width])),
    );

test.describe("the Canvas view's preset bar", () => {
  test.beforeEach(({ page }) => shipCanvas(page));
  test.afterEach(({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

  test("each preset is as wide as its own name", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await openPage(page, "/t/canvas");
    await expect(page.locator(".cv-views .cv-view").first()).toBeVisible();
    const w = await presets(page);
    expect(Object.keys(w)).toEqual(["State", "Machine", "Harness", "Repo", "Label", "My layout", "Map"]);
    expect(w.State!, "State is narrower than My layout").toBeLessThan(w["My layout"]! - 10);
    expect(w.Map!, "Map is narrower than Machine").toBeLessThan(w.Machine! - 10);
  });

  test("at the largest text size, in the narrowest window that shows the bar whole, the layout tools end clear of the search field", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.textSize", "1.25"));
    await openPage(page, "/t/canvas");
    const root = page.locator(".spcv");
    await expect(page.locator(".cv-views .cv-view").first()).toBeVisible();
    await expect(page.locator("html")).toHaveCSS("font-size", "20px");
    // Canvas folds its presets into a chip under 1100 px of its own width: the window that
    // leaves it exactly that, whatever the sidebar takes.
    const beside = 1500 - (await root.boundingBox())!.width;
    await page.setViewportSize({ width: Math.ceil(1100 + beside), height: 860 });
    await page.locator(".cv-views .cv-view", { hasText: "My layout" }).click();
    const tools = page.locator(".cv-layout-tools > *");
    await expect(tools.last()).toBeVisible();
    await expect(page.locator(".cv-views")).toBeVisible();
    const [last, search] = await Promise.all([tools.last().boundingBox(), page.locator(".cv-search").boundingBox()]);
    expect(last!.x + last!.width, "the last layout tool ends left of the search field").toBeLessThanOrEqual(search!.x);
  });
});
