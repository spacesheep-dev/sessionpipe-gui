// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Bundled views: test/e2e/serve.mjs points --bundled-dir at a fixture that stands in for
// dist/bundled/views. It is listed as bundled, on the rail and mountable; disabling it
// (the Views page button, loopback) hides it from the rail and /t/<id> says so; enabling
// brings it back. The real Canvas and Office are never touched.
import { expect, test } from "@playwright/test";
import { openPage } from "./helpers.js";

interface Listed {
  id: string;
  source?: string;
  bundled?: boolean;
  disabled?: boolean;
}

test.describe("bundled views", () => {
  test("listed as bundled, served and mountable; disable hides it, enable brings it back", async ({
    page,
    request,
  }) => {
    const { themes } = (await (await request.get("/api/ui/themes")).json()) as { themes: Listed[] };
    expect(themes.find((t) => t.id === "e2e-bundled")).toMatchObject({ source: "bundled", bundled: true });
    expect((await request.get("/themes/e2e-bundled/index.js")).status()).toBe(200);

    await openPage(page, "/t/e2e-bundled");
    await expect(page.locator(".e2e-bundled-title")).toHaveText("E2E Bundled");
    await expect(page.locator("nav.rail a[data-nav='t:e2e-bundled']")).toBeVisible();

    await openPage(page, "/themes");
    const row = page.locator("[data-theme-row='e2e-bundled']");
    await expect(row.locator(".themes-flag")).toHaveText(["bundled"]);
    await row.locator("[data-toggle='e2e-bundled']").click();
    await expect(row.locator(".themes-flag")).toHaveText(["bundled", "disabled"]);
    await expect(row.getByRole("link", { name: "Open" })).toHaveCount(0);
    await expect(page.locator("nav.rail a[data-nav='t:e2e-bundled']")).toHaveCount(0);
    await expect(page.locator(".themes-tools .sect-note")).toHaveText("e2e-bundled is off: hidden from the rail.");

    await openPage(page, "/t/e2e-bundled");
    await expect(page.locator(".theme-error h2")).toHaveText("E2E Bundled is disabled");
    await expect(page.locator(".theme-error-msg")).toContainText("ships with the GUI");
    await expect(page.locator("[data-theme-id='e2e-bundled']")).toBeHidden();
    expect((await request.get("/themes/e2e-bundled/index.js")).status()).toBe(404);

    await openPage(page, "/themes");
    await row.locator("[data-toggle='e2e-bundled']").click();
    await expect(row.locator(".themes-flag")).toHaveText(["bundled"]);
    await expect(page.locator("nav.rail a[data-nav='t:e2e-bundled']")).toBeVisible();
    await expect(row.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/t/e2e-bundled");
  });
});
