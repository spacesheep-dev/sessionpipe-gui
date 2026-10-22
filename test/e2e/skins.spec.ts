// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Skins: a fixture package is installed by test/e2e/serve.mjs with the real CLI before the
// server starts. The list names it beside the built-ins (the two shipped, Spacesheep and
// Paper, and Plain, the internal base the UI never lists), picking it in Display sets its
// tokens, fonts, shape and density on <html>, a view inherits the tokens by name, the
// choice survives a reload, and a device's old color-theme choice is migrated once.
import { expect, type Page, test } from "@playwright/test";
import { openBoard, openPage } from "./helpers.js";

interface Listed {
  id: string;
  name: string;
  source: string;
  scheme: string;
  url?: string;
  dir?: string;
  error?: string;
  tokens: { dark?: Record<string, string>; light?: Record<string, string> };
}

/** A style variable set on <html> by applySkin (a function, not an expression string:
 *  Playwright no longer calls a function an expression string evaluates to). */
const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => document.documentElement.style.getPropertyValue(n), name);

test.describe("skins", () => {
  test("the server lists built-ins, the fixture package and a broken one; files have the right caching", async ({
    request,
  }) => {
    const { skins } = (await (await request.get("/api/ui/skins")).json()) as { skins: Listed[] };
    expect(skins.slice(0, 2).map((s) => [s.id, s.source])).toEqual([
      ["spacesheep", "builtin"],
      ["plain", "builtin"],
    ]);
    expect(skins.filter((s) => s.source === "builtin").map((s) => s.name)).toEqual(["Spacesheep", "Plain", "Paper"]);
    const fx = skins.find((s) => s.id === "e2e-skin")!;
    expect(fx).toMatchObject({ source: "skin", scheme: "both", url: "/skins/e2e-skin/" });
    expect(fx.error).toBeUndefined();
    expect(fx.dir).toMatch(/skins[\\/]e2e-skin$/);
    const broken = skins.find((s) => s.id === "e2e-skin-broken")!;
    expect(broken.error).toMatch(/unknown token --nope/);
    const font = await request.get("/skins/e2e-skin/fonts/e2e.woff2");
    expect(font.status()).toBe(200);
    expect(font.headers()["content-type"]).toBe("font/woff2");
    expect(font.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await request.get("/skins/e2e-skin/skin.css")).headers()["cache-control"]).toBe("no-cache");
    expect((await request.get("/skins/e2e-skin-broken/skin.json")).status()).toBe(404);
  });

  test("picking the fixture skin applies tokens, fonts, shape and density; a view inherits; it persists", async ({
    page,
  }) => {
    await openBoard(page);
    const root = page.locator("html");
    // A fresh device is on Spacesheep, which follows the appearance (System → light here).
    await expect(root).toHaveAttribute("data-skin", "spacesheep");
    await expect(root).not.toHaveAttribute("data-theme", /./);
    expect(await rootVar(page, "--bg")).toBe("oklch(0.993 0.002 285)");

    const trigger = page.locator("nav.rail button[aria-label='Quick settings']");
    await trigger.click();
    const pop = page.getByRole("dialog", { name: "Quick settings" });
    await expect(pop.locator(".qs-divider")).toHaveText(["Installed"]);
    await expect(pop.locator("[data-skin='plain']")).toHaveCount(0);
    const broken = pop.locator("[data-skin='e2e-skin-broken']");
    await expect(broken).toBeDisabled();
    await expect(broken.locator(".qs-theme-hint")).toHaveText("broken");
    const row = pop.locator("[data-skin='e2e-skin']");
    await expect(row).toHaveAttribute("data-skin-source", "skin");
    await expect(row.locator(".qs-swatch")).toHaveCount(1);
    await row.click();
    await expect(row).toHaveAttribute("aria-pressed", "true");

    await expect(root).toHaveAttribute("data-skin", "e2e-skin");
    await expect(root).toHaveAttribute("data-density", "comfortable");
    // Light tokens under the System appearance (the test browser is light).
    expect(await rootVar(page, "--bg")).toBe("rgb(250, 240, 230)");
    expect(await rootVar(page, "--font-ui")).toBe('"E2E Sans", serif');
    expect(await rootVar(page, "--font-mono")).toBe('"E2E Mono", monospace');
    expect(await rootVar(page, "--radius")).toBe("2px");
    expect(await rootVar(page, "--hairline")).toBe("1.5px");
    // The page really uses them: the body's font and a settings row's height.
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toBe('"E2E Sans", serif');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--row-lg"))).toBe(
      "44px",
    );
    // The @font-face from the manifest and the stylesheet, loaded last.
    const faces = await page.locator("style#skin-fonts").textContent();
    expect(faces).toContain('font-family: "E2E Sans";');
    expect(faces).toContain('url("/skins/e2e-skin/fonts/e2e.woff2") format("woff2")');
    expect(faces).toContain("font-weight: 200 900;");
    const link = page.locator("link#skin-css");
    await expect(link).toHaveAttribute("href", "/skins/e2e-skin/skin.css");
    expect(await page.evaluate(() => document.head.lastElementChild?.id)).toBe("skin-css");
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--e2e-skin-css").trim()))
      .toBe("on");
    // Appearance is still free (a "both" skin); Dark switches to the dark tokens.
    await expect(pop.locator("fieldset.seg").first()).not.toHaveAttribute("disabled", /.*/);
    await pop.locator("label.seg-opt", { hasText: /^Dark$/ }).click();
    await expect(root).toHaveAttribute("data-theme", "dark");
    expect(await rootVar(page, "--bg")).toBe("rgb(10, 20, 30)");
    await page.keyboard.press("Escape");

    // A view inherits by name: the token on the theme host is the skin's.
    await openPage(page, "/t/e2e-counter");
    const host = page.locator("[data-theme-id='e2e-counter']");
    await expect(host.locator("[data-scheme]")).toHaveText("dark");
    expect(await host.evaluate((el) => getComputedStyle(el).getPropertyValue("--bg").trim())).toBe("rgb(10, 20, 30)");
    expect(await host.evaluate((el) => getComputedStyle(el).fontFamily)).toBe('"E2E Sans", serif');

    // Survives a reload, before any fetch (the skin is stored whole).
    await page.reload();
    await expect(root).toHaveAttribute("data-skin", "e2e-skin");
    await expect(root).toHaveAttribute("data-density", "comfortable");
    expect(await rootVar(page, "--bg")).toBe("rgb(10, 20, 30)");
    expect(await page.evaluate(() => localStorage.getItem("sessionpipe-gui.skin"))).toContain('"id":"e2e-skin"');

    // Back to Spacesheep: its tokens, no fonts, shape or density of the fixture's; the extras are gone.
    await openBoard(page);
    await trigger.click();
    await pop.locator("[data-skin='spacesheep']").click();
    await expect(root).toHaveAttribute("data-skin", "spacesheep");
    await expect(root).not.toHaveAttribute("data-density", /./);
    expect(await rootVar(page, "--bg")).toBe("oklch(0.185 0.01 285)");
    expect(await rootVar(page, "--font-ui")).toBe("");
    await expect(page.locator("style#skin-fonts")).toHaveCount(0);
    await expect(page.locator("link#skin-css")).toHaveCount(0);
    await pop.locator("label.seg-opt", { hasText: /^System$/ }).click();
  });

  test("a device's old color-theme choice is migrated to the skin key once", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        if (!localStorage.getItem("sessionpipe-gui.skin")) {
          localStorage.setItem(
            "sessionpipe-gui.colorTheme",
            JSON.stringify({
              id: "paper",
              name: "Paper",
              scheme: "light",
              tokens: { "--bg": "oklch(0.968 0.012 80)" },
            }),
          );
        }
      } catch {}
    });
    await openBoard(page);
    const root = page.locator("html");
    await expect(root).toHaveAttribute("data-skin", "paper");
    await expect(root).toHaveAttribute("data-theme", "light");
    // The built-in of that id, whole, not the stored fragment.
    expect(await rootVar(page, "--fg")).toBe("oklch(0.24 0.02 60)");
    expect(await page.evaluate(() => localStorage.getItem("sessionpipe-gui.colorTheme"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("sessionpipe-gui.skin"))).toContain('"id":"paper"');
  });
});
