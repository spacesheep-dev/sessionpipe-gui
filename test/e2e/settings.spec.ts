// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Settings: the Display popover in the sidebar (appearance, the two shipped skins, text
// size) and the settings window at /settings (the mode, the app-wide tier lens), each
// remembered per device.
import { expect, type Page, test } from "@playwright/test";
import { openBoard, openPage } from "./helpers.js";

test.describe("quick settings", () => {
  test("skin and text size apply, and persist across a reload", async ({ page }) => {
    await openBoard(page);
    const trigger = page.locator("nav.rail button[aria-label='Quick settings']");
    await trigger.click();
    const pop = page.getByRole("dialog", { name: "Quick settings" });
    await expect(pop).toBeVisible();
    // The two shipped skins first, in order, Spacesheep on; Plain (the internal base) is never listed.
    await expect(pop.locator(".qs-theme[data-skin-source='builtin']")).toHaveText([/Spacesheep/, /Paper/]);
    await expect(pop.locator("[data-skin='plain']")).toHaveCount(0);
    await expect(pop.locator("[data-skin='spacesheep']")).toHaveAttribute("aria-pressed", "true");

    await pop.locator("[data-skin='paper']").click();
    const root = page.locator("html");
    await expect(root).toHaveAttribute("data-theme", "light");
    await expect(root).toHaveAttribute("data-skin", "paper");
    const bg = await page.evaluate(() => document.documentElement.style.getPropertyValue("--bg"));
    expect(bg).toBe("oklch(0.972 0.01 80)");
    // The body really paints with it (the token is used, not just set).
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bodyBg).toMatch(/^(oklch|color|rgb)/);
    // Appearance is the skin's while a single-scheme one is on.
    const appearance = pop.locator("fieldset.seg", { has: page.locator("legend", { hasText: "Appearance" }) });
    await expect(appearance).toHaveJSProperty("disabled", true);

    const before = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    // Four stops on one slider, small A to large A: the third is 110 %.
    const size = pop.getByRole("slider", { name: "Text size" });
    await size.fill("2");
    await expect(size).toHaveAttribute("aria-valuetext", "Large, 110 %");
    const after = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(after / before).toBeCloseTo(1.1, 2);

    await page.reload();
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await expect(root).toHaveAttribute("data-theme", "light");
    await expect(root).toHaveAttribute("data-skin", "paper");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--bg"))).toBe(
      "oklch(0.972 0.01 80)",
    );
    expect(
      (await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))) / before,
    ).toBeCloseTo(1.1, 2);

    // Back to Spacesheep: its own tokens, the appearance free again; Esc closes the popover.
    await trigger.click();
    await pop.locator("[data-skin='spacesheep']").click();
    await expect(root).toHaveAttribute("data-skin", "spacesheep");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--bg"))).toBe(
      "oklch(0.993 0.002 285)",
    );
    await expect(appearance).toHaveJSProperty("disabled", false);
    await pop.getByRole("slider", { name: "Text size" }).fill("1");
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
  });

  test("every skin the server lists is a row but Plain: built-ins, then the installed ones", async ({
    page,
    request,
  }) => {
    const listed = (await (await request.get("/api/ui/skins")).json()) as { skins: { id: string }[] };
    const skins = listed.skins.filter((s) => s.id !== "plain");
    await openBoard(page);
    await page.locator("nav.rail button[aria-label='Quick settings']").click();
    const pop = page.getByRole("dialog", { name: "Quick settings" });
    const rows = pop.locator(".qs-theme");
    await expect(rows).toHaveCount(skins.length);
    for (const s of skins) await expect(pop.locator(`[data-skin='${s.id}']`)).toBeVisible();
  });

  test("the popover ends in a row to the Settings window", async ({ page }) => {
    await openBoard(page);
    await page.locator("nav.rail button[aria-label='Quick settings']").click();
    await page.getByRole("dialog", { name: "Quick settings" }).locator("[data-nav='all-settings']").click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Quick settings" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings$/);
  });
});

const dialog = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true });
const mode = (page: Page, which: "Simple" | "Advanced") =>
  dialog(page)
    .locator("fieldset.seg", { has: page.locator("legend", { hasText: "Mode" }) })
    .locator("label.seg-opt", {
      hasText: which,
    });

test.describe("a device that has not chosen", () => {
  // No stored settings at all: Simple is the default; the dialog's General row says so.
  test.use({ storageState: { cookies: [], origins: [] } });
  test("starts in Simple mode, with the switch to Advanced one line away", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.setup.seen", "1"));
    await openBoard(page);
    await expect(page.locator("nav.rail a[data-nav='feed']")).toHaveCount(0);
    await expect(page.locator("article.card .card-foot:not(.card-foot--mark)")).toHaveCount(0);
    await openPage(page, "/settings");
    await expect(dialog(page).locator(".settings-row").first()).toContainText("Simple mode");
    await expect(dialog(page).locator(".settings-row").first()).toContainText("Switch to Advanced");
    await mode(page, "Advanced").click();
    await expect(page.locator("nav.rail a[data-nav='feed']")).toBeVisible();
    await page.reload();
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await expect(page.locator("nav.rail a[data-nav='feed']")).toBeVisible();
  });
});

test.describe("settings dialog", () => {
  test("opens from the gear and at /settings, with its sections", async ({ page }) => {
    await openBoard(page);
    await page.locator("nav.rail a[aria-label='Settings']").click();
    await expect(dialog(page)).toBeVisible();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(dialog(page).getByRole("tab", { selected: true })).toHaveText("General");
    for (const s of ["Tier lens", "Notifications", "Keyboard", "Views & skins", "Data", "About"]) {
      await dialog(page).getByRole("tab", { name: s }).click();
      await expect(dialog(page).getByRole("tabpanel")).toBeVisible();
    }
    // Data knows the receiver's storage; About its version.
    await dialog(page).getByRole("tab", { name: "Data" }).click();
    await expect(dialog(page).locator("[data-storage]")).toHaveText(/\d/);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    // Straight to a section by URL.
    await openPage(page, "/settings?section=data");
    await expect(dialog(page).getByRole("tab", { selected: true })).toHaveText("Data");
  });

  test("Simple mode hides Feed and Review from the rail and the card footers, and persists", async ({ page }) => {
    // The counts are Advanced's "Show counts" (off by default): on, so Simple has some to hide.
    await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.board.counts", "1"));
    await openBoard(page);
    await expect(page.locator("nav.rail a[data-nav='feed']")).toBeVisible();
    await expect(page.locator("article.card .card-foot:not(.card-foot--mark)").first()).toBeVisible();
    await openPage(page, "/settings");
    await mode(page, "Simple").click();
    await expect(page.locator("nav.rail a[data-nav='feed']")).toHaveCount(0);
    await expect(page.locator("nav.rail a[data-nav='review']")).toHaveCount(0);
    await expect(page.locator("nav.rail a[data-nav='inbox']")).toBeVisible();
    await expect(page.locator("article.card .card-foot:not(.card-foot--mark)")).toHaveCount(0);
    // The lens chip is gone with it.
    await expect(page.locator(".lens-chip")).toHaveCount(0);

    await page.reload();
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await expect(page.locator("nav.rail a[data-nav='feed']")).toHaveCount(0);
    await expect(page.locator("article.card .card-foot:not(.card-foot--mark)")).toHaveCount(0);
    // Feed is still a page (⌘K and the URL reach it).
    await openPage(page, "/feed");
    await expect(page.locator(".page.feed")).toBeVisible();

    await openPage(page, "/settings");
    await mode(page, "Advanced").click();
    await expect(page.locator("nav.rail a[data-nav='feed']")).toBeVisible();
  });

  test("the lens chip picks from a menu; at lens 1 the board hides snippets and says so", async ({ page }) => {
    await openBoard(page);
    const chip = page.locator(".lens-chip-btn");
    const pick = async (name: RegExp) => {
      await chip.click();
      await page.getByRole("menuitemradio", { name }).click();
    };
    await expect(chip).toHaveAttribute("aria-label", "Tier lens: All tiers");
    await expect(page.locator("article.card .card-text").first()).toBeVisible();
    await pick(/^Tier 0/);
    await expect(chip).toHaveAttribute("aria-label", "Tier lens: Tier 0");
    await pick(/^Tier 1/);
    await expect(chip).toHaveAttribute("aria-label", "Tier lens: Tier 1");
    await expect(page.locator("article.card .card-text")).toHaveCount(0);
    const note = page.locator("[data-lens-note]");
    await expect(note).toHaveText(/^Showing presence and actions · \d+ hidden/);
    // `l` steps through the tiers too.
    await page.keyboard.press("l");
    await expect(chip).toHaveAttribute("aria-label", "Tier lens: Tier 2");
    await expect(page.locator("article.card .card-text").first()).toBeVisible();
    await pick(/^All tiers/);
    await expect(chip).toHaveAttribute("aria-label", "Tier lens: All tiers");
  });

  test("the session page's lens and the board's chip stay in sync", async ({ page }) => {
    await openBoard(page);
    const chip = page.locator(".lens-chip-btn");
    await chip.click();
    await page.getByRole("menuitemradio", { name: /^Tier 1/ }).click();
    await expect(chip).toHaveAttribute("aria-label", "Tier lens: Tier 1");
    await page.locator("article.card a.card-link").first().click();
    await expect(page.locator(".page.session")).toBeVisible();
    // A session page has its own lens line instead of the chip.
    await expect(chip).toHaveCount(0);
    const seg = page.locator(".lens fieldset.seg");
    await expect(seg.locator(".seg-on")).toHaveText("1");
    await expect(page.locator(".lens-hint")).toContainText("Actions");
    await seg.locator("label.seg-opt", { hasText: /^2$/ }).click();
    await page.goBack();
    await expect(chip).toHaveAttribute("aria-label", "Tier lens: Tier 2");
    // Picked from the settings section as well.
    await openPage(page, "/settings?section=lens");
    await dialog(page).locator("label.seg-opt", { hasText: /^All$/ }).click();
    await page.keyboard.press("Escape");
    await expect(chip).toHaveAttribute("aria-label", "Tier lens: All tiers");
  });

  test("a view route has no lens chip and nothing covers the view's own controls", async ({ page }) => {
    await openPage(page, "/t/e2e-counter");
    await expect(page.locator(".lens-chip")).toHaveCount(0);
    const button = page.locator("[data-theme-id='e2e-counter'] button").first();
    await expect(button).toBeVisible();
    expect(
      await button.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === el;
      }),
    ).toBe(true);
  });

  test("an unknown path says so, with a way to the board; /settings opens over the split panel", async ({ page }) => {
    await openPage(page, "/nothing-here");
    await expect(page.locator("[data-missing]")).toContainText("No page at /nothing-here");
    await expect(page.getByRole("link", { name: "Go to Board" })).toBeVisible();
    await openPage(page, "/");
    await expect(page.locator("section.group").first()).toBeVisible();
    const href = (await page.locator("article.card a.card-link").first().getAttribute("href"))!;
    const key = href.replace(/^\/s\//, "").replace("/", ":");
    await openPage(page, `/settings?section=notifications&s=${encodeURIComponent(key)}`);
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("tab", { selected: true })).toHaveText("Notifications");
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/^[^?]*\/\?s=/);
  });

  test("Simple mode shows a session as a chat", async ({ page }) => {
    await openPage(page, "/settings");
    await mode(page, "Simple").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("section.group").first()).toBeVisible();
    await page.locator("article.card a.card-link").first().click();
    const view = page.locator(".page.session");
    await expect(view).toHaveAttribute("data-ui", "simple");
    await expect(view.locator(".sess-counts")).toHaveCount(0);
    await expect(view.locator(".lens")).toHaveCount(0);
    await expect(view.locator("ol.timeline--chat")).toBeVisible();
    // A turn as a chat, or (a session that has only just started) the chat's empty state.
    await expect(view.locator(".turn--chat, ol.timeline--chat > li.state").first()).toBeVisible();
    await expect(view.locator(".ctl--chat textarea")).toHaveAttribute("placeholder", "Message this session…");
    // The suite runs on 127.0.0.1, never the rp id's origin: the one reason under the field
    // is where sending works (it comes before pairing, which needs that address too), and
    // never "Add it" (phone.spec.ts covers the guard itself).
    await expect(view.locator(".ctl-context")).toContainText("Sending works from");
    await expect(view.getByRole("link", { name: /Add this device|Add it/ })).toHaveCount(0);
    await openPage(page, "/settings");
    await mode(page, "Advanced").click();
  });
});
