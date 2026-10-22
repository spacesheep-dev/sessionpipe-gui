// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Theme plugins: two fixture themes are installed by test/e2e/serve.mjs with the real CLI
// before the server starts. The nav lists them, /t/<id> mounts one with the ThemeApi,
// counts update live, the viewers list names this browser, storage round-trips through
// the server, the theme unmounts on navigation, a syntax error shows the error panel, and /themes manages the lot.
import { expect, test } from "@playwright/test";
import { openPage } from "./helpers.js";

interface Listed {
  id: string;
  name: string;
  source?: string;
  dir?: string;
  error?: string;
  linked?: boolean;
  experimental?: boolean;
}

test.describe("themes", () => {
  test("the server lists both fixture themes with their source", async ({ request }) => {
    const { themes } = (await (await request.get("/api/ui/themes")).json()) as { themes: Listed[] };
    const counter = themes.find((t) => t.id === "e2e-counter");
    const broken = themes.find((t) => t.id === "e2e-broken");
    expect(counter).toMatchObject({ name: "E2E Counter" });
    expect(counter!.error).toBeUndefined();
    expect(counter!.source).toMatch(/fixtures[\\/]e2e-counter$/);
    expect(counter!.dir).toMatch(/themes[\\/]e2e-counter$/);
    expect(broken).toMatchObject({ name: "E2E Broken", experimental: true });
    const js = await request.get("/themes/e2e-counter/index.js");
    expect(js.status()).toBe(200);
    expect(js.headers()["content-type"]).toMatch(/^text\/javascript/);
    expect(js.headers()["cache-control"]).toBe("no-cache");
  });

  test("the rail shows an entry per theme, experimental ones after the divider", async ({ page }) => {
    await openPage(page, "/");
    const rail = page.locator("nav.rail");
    const counter = rail.locator("a[data-nav='t:e2e-counter']");
    await expect(counter).toBeVisible();
    await expect(counter).toHaveText("E2E Counter");
    await expect(counter.locator(".nav-glyph--svg svg")).toBeVisible();
    const broken = rail.locator("a[data-nav='t:e2e-broken']");
    await expect(broken).toBeVisible();
    // Order on the rail: builtins, the counter, the divider, then the experimental ones.
    const keys = await rail
      .locator(".rail-nav > a, .rail-nav > .rail-group")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-nav") ?? el.textContent));
    expect(keys.indexOf("t:e2e-counter")).toBeLessThan(keys.indexOf("experimental"));
    expect(keys.indexOf("t:e2e-broken")).toBeGreaterThan(keys.indexOf("experimental"));
    await counter.click();
    await expect(page).toHaveURL(/\/t\/e2e-counter$/);
    await expect(counter).toHaveAttribute("aria-current", "page");
  });

  test("/t/<id> mounts the theme full-bleed with the ThemeApi, and counts update live", async ({ page }) => {
    await openPage(page, "/t/e2e-counter");
    const host = page.locator("[data-theme-id='e2e-counter']");
    await expect(host.locator(".e2e-title")).toHaveText("E2E Counter");
    // The stylesheet from the manifest is linked.
    await expect(host.locator(".e2e-title")).toHaveCSS("color", "rgb(1, 2, 3)");
    await expect(page).toHaveTitle("E2E Counter · sessionpipe gui");
    // The snapshot: demo sessions are there, the host is named, tokens and React handed over.
    await expect(host.locator("[data-sessions]")).toHaveText(/^[1-9]\d*$/);
    await expect(host.locator("[data-host]")).toHaveText(/^sessionpipe-gui \d+\.\d+\.\d+/);
    await expect(host.locator("[data-scheme]")).toHaveText(/^(dark|light)$/);
    await expect(host.locator("[data-react]")).toHaveText("function");
    expect(Number(await host.locator("[data-tokens]").innerText())).toBeGreaterThan(20);
    // Live: the demo keeps sending events, so the count climbs without a reload.
    const before = Number(await host.locator("[data-events]").innerText());
    await expect
      .poll(async () => Number(await host.locator("[data-events]").innerText()), { timeout: 20_000 })
      .toBeGreaterThan(before);
    // Full-bleed: the container fills the main column with no padding.
    const main = (await page.locator("main.main").boundingBox())!;
    const box = (await host.boundingBox())!;
    expect(box.x).toBe(main.x);
    expect(box.width).toBe(main.width);
    expect(box.y).toBe(0);
    await expect(host).toHaveCSS("overflow", "hidden");
    await expect(host).toHaveCSS("position", "relative");
  });

  test("the snapshot lists the browsers on the stream, this one marked current", async ({ page, context, request }) => {
    await openPage(page, "/t/e2e-counter");
    const host = page.locator("[data-theme-id='e2e-counter']");
    await expect(host.locator("[data-viewers]")).toHaveText(/^[1-9]\d*$/);
    const me = await host.locator("[data-me]").innerText();
    expect(me).toMatch(/^[0-9a-f]{16}$/);
    // Chromium on this machine, over loopback: a desktop, with the OS and the browser named.
    await expect(host.locator("[data-current]")).toHaveText(/^desktop · (Mac|Linux|Windows|ChromeOS) · Chrome$/);
    const listed = (await (await request.get("/api/ui/viewers")).json()) as { viewers: { id: string }[] };
    expect(listed.viewers.map((v) => v.id)).toContain(me);
    // A second tab joins: the first one sees it arrive, and go.
    const other = await context.newPage();
    await openPage(other, "/t/e2e-counter");
    const otherId = await other.locator("[data-theme-id='e2e-counter'] [data-me]").innerText();
    expect(otherId).not.toBe(me);
    await expect(host.locator("[data-ids]")).toContainText(otherId);
    await other.close();
    await expect(host.locator("[data-ids]")).not.toContainText(otherId);
    await expect(host.locator("[data-ids]")).toContainText(me);
  });

  test("storage round-trips through the server and the theme unmounts on navigation", async ({ page, request }) => {
    await openPage(page, "/t/e2e-counter");
    const host = page.locator("[data-theme-id='e2e-counter']");
    const note = `note-${Date.now()}`;
    await host.locator("[data-note]").fill(note);
    await host.locator("[data-save]").click();
    await expect(host.locator("[data-stored]")).toHaveText(JSON.stringify({ note }));
    expect(await (await request.get("/api/ui/themes/e2e-counter/state")).json()).toEqual({ note });
    await page.reload();
    await expect(host.locator("[data-stored]")).toHaveText(JSON.stringify({ note }));

    const counts = () =>
      page.evaluate(() => {
        const w = window as unknown as { __e2eThemeMounted?: number; __e2eThemeUnmounted?: number };
        return { mounted: w.__e2eThemeMounted ?? 0, unmounted: w.__e2eThemeUnmounted ?? 0 };
      });
    expect(await counts()).toEqual({ mounted: 1, unmounted: 0 });
    await page.locator("nav.rail a[data-nav='feed']").click();
    await expect(page).toHaveURL(/\/feed$/);
    expect(await counts()).toEqual({ mounted: 1, unmounted: 1 });
    await expect(page.locator("[data-theme-id]")).toHaveCount(0);
    await expect(page.locator("link[data-theme='e2e-counter']")).toHaveCount(0);
  });

  test("a theme with a syntax error shows the error panel, not a blank page", async ({ page }) => {
    await openPage(page, "/t/e2e-broken");
    const panel = page.locator(".theme-error");
    await expect(panel).toBeVisible();
    await expect(panel.locator("h2")).toHaveText("E2E Broken failed to load");
    await expect(panel.locator(".theme-error-msg")).toHaveText(/SyntaxError|error/i);
    await expect(panel.locator(".theme-error-file code")).toHaveText(/\/themes\/e2e-broken\/index\.js$/);
    await expect(page.locator(".theme-page")).toHaveAttribute("data-status", "error");
    await expect(page.locator("[data-theme-id='e2e-broken']")).toBeHidden();
  });

  test("an unknown id says so", async ({ page }) => {
    await openPage(page, "/t/no-such-theme");
    await expect(page.locator(".theme-error h2")).toHaveText('No theme "no-such-theme" is installed');
  });

  test("/themes lists what is installed, reloads, and shows the add line and the warning", async ({ page }) => {
    await openPage(page, "/themes");
    const counter = page.locator("[data-theme-row='e2e-counter']");
    await expect(counter.locator(".themes-row-name")).toHaveText("E2E Counter");
    await expect(counter.locator(".themes-row-ver")).toHaveText("0.1.0");
    await expect(counter.locator(".themes-row-meta")).toContainText("Counts sessions and events");
    // The path is one right-click away, with the row's other real actions.
    await counter.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Disable" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(counter.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/t/e2e-counter");
    await expect(page.locator("[data-theme-row='e2e-broken'] .themes-flag")).toHaveText("experimental");
    await expect(page.locator(".cmd-text").first()).toContainText("sessionpipe-gui view add");
    await expect(page.locator(".themes-trust")).toContainText("Only install themes you trust");
    // The Plugins section: nothing installed in the e2e state dir, the add line, the warning.
    const plugins = page.locator("[data-plugins]");
    await expect(plugins.locator("h2")).toHaveText("Plugins");
    await expect(plugins.locator(".themes-empty")).toHaveText(/No plugins installed/);
    await expect(plugins.locator(".cmd-text")).toContainText("sessionpipe-gui plugin add");
    await expect(plugins).toContainText("runs inside the receiver process");
    await expect(plugins.getByRole("button", { name: "Reload plugins" })).toBeEnabled();
    const reload = page.getByRole("button", { name: "Reload", exact: true });
    await expect(reload).toBeEnabled();
    await reload.click();
    await expect(page.locator(".themes-tools .sect-note")).toHaveText("Re-read the themes folder.");
    // The rail footer links here.
    await expect(page.locator("nav.rail .rail-foot a[aria-label='Views']")).toHaveAttribute("aria-current", "page");
  });
});
