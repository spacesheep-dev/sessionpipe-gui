// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// On a phone (the `phone` project, 390×844): the bottom tab bar is on every page with at
// most five tabs (the rest behind More), nothing scrolls sideways, the session page's
// control strip sits above the tabs, and New session is a full-height sheet.
import { expect, type Page, test } from "@playwright/test";
import { CONTROL_BASE, fakeDaemon, passkeyPage, seenSetupHere, sinkToken } from "./control-helpers.js";
import { openBoard } from "./helpers.js";

const noSidewaysScroll = async (page: Page) => {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `scrollWidth ${scrollWidth} must not exceed innerWidth ${innerWidth}`).toBeLessThanOrEqual(
    innerWidth,
  );
};

const tabBarIsOn = async (page: Page) => {
  const bar = page.locator("nav.tabbar");
  await expect(bar).toBeVisible();
  // Never more than five tabs: the first four pages, then More for everything else.
  const tabs = bar.locator(":scope > a.nav-link, :scope > .more > .more-tab");
  expect(await tabs.count()).toBeLessThanOrEqual(5);
  // The first pages of the shell's list are the tabs; Board leads and the inbox (with its
  // badge) is beside it, whatever else the list carries.
  for (const label of ["Board", "Inbox"]) await expect(bar.getByRole("link", { name: label })).toBeVisible();
  // No tab's label is cut short.
  const clipped = await bar
    .locator(".nav-label")
    .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent));
  expect(clipped).toEqual([]);
  const box = (await bar.boundingBox())!;
  const vh = await page.evaluate(() => window.innerHeight);
  expect(box.y + box.height, "the tab bar is pinned to the bottom edge").toBeGreaterThanOrEqual(vh - 1);
  await expect(page.locator("nav.rail")).toBeHidden();
};

test.describe("phone", () => {
  test.skip(({ isMobile }) => !isMobile, "phone project only");

  test("tab bar on every page, no horizontal scroll", async ({ page }) => {
    await openBoard(page);
    await tabBarIsOn(page);
    await noSidewaysScroll(page);
    await expect(page.locator("nav.tabbar a[aria-current='page']")).toHaveText(/Board/);
    // What each page shows once open; a page without an entry is checked by its URL alone.
    const MARKER: Record<string, string> = {
      inbox: ".inbox",
      feed: "ol.rows",
      machines: "section.machine",
      connect: ".sect--phone",
    };
    const bar = page.locator("nav.tabbar");
    const onBar = (
      await bar.locator(":scope > a.nav-link").evaluateAll((els) => els.map((el) => el.getAttribute("data-nav")))
    ).filter((k): k is string => !!k && k !== "board");
    for (const key of onBar) {
      await bar.locator(`a[data-nav='${key}']`).click();
      await expect(page).toHaveURL(new RegExp(`/${key}$`));
      if (MARKER[key]) await expect(page.locator(MARKER[key]).first()).toBeVisible();
      await tabBarIsOn(page);
      await noSidewaysScroll(page);
      await expect(bar.locator("a[aria-current='page']")).toHaveAttribute("data-nav", key);
    }
    // The pages past the fourth sit behind More, which then carries the current mark.
    const behindMore = ["inbox", "feed", "review", "machines", "connect"].filter((k) => !onBar.includes(k));
    for (const key of behindMore) {
      await bar.getByRole("button", { name: "More" }).click();
      await page.getByRole("dialog", { name: "More" }).locator(`a[data-nav='${key}']`).click();
      await expect(page).toHaveURL(new RegExp(`/${key}$`));
      if (MARKER[key]) await expect(page.locator(MARKER[key]).first()).toBeVisible();
      await tabBarIsOn(page);
      await noSidewaysScroll(page);
      await expect(bar.locator("[aria-current='page']")).toHaveText(/More/);
    }
  });

  test("every installed view and the quick settings are reachable through More", async ({ page }) => {
    await openBoard(page);
    const bar = page.locator("nav.tabbar");
    const more = bar.getByRole("button", { name: "More" });
    await expect(more).toBeVisible();
    const { themes } = (await (await page.request.get("/api/ui/themes")).json()) as {
      themes: { id: string; name: string; error?: string }[];
    };
    for (const t of themes.filter((x) => !x.error)) {
      await more.click();
      const sheet = page.getByRole("dialog", { name: "More" });
      await expect(sheet).toBeVisible();
      await sheet.locator(`a[data-nav='t:${t.id}']`).click();
      await expect(page).toHaveURL(new RegExp(`/t/${t.id}$`));
      await expect(sheet).toHaveCount(0);
      // The active page lives inside More, so More carries the current mark.
      await expect(bar.locator("[aria-current='page']")).toHaveText(/More/);
      await tabBarIsOn(page);
      await noSidewaysScroll(page);
    }
    // Display opens the quick settings from the sheet; Esc closes the popover.
    await more.click();
    await page
      .getByRole("dialog", { name: "More" })
      .getByRole("button", { name: /Display/ })
      .click();
    const pop = page.getByRole("dialog", { name: "Quick settings" });
    await expect(pop).toBeVisible();
    await expect(page.getByRole("dialog", { name: "More" })).toHaveCount(0);
    await expect(pop.locator(".qs-theme").first()).toHaveText(/sessionpipe/);
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    // Esc closes the sheet too.
    await more.click();
    await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "More" })).toHaveCount(0);
  });

  test("the session page keeps its control strip above the tab bar", async ({ page }) => {
    await openBoard(page);
    const link = page.locator("article.card a.card-link").first();
    await link.click();
    await expect(page).toHaveURL(/\/s\//);
    await expect(page.locator("h1.sess-title")).toBeVisible();
    await expect(page.locator("ol.timeline li.turn").first()).toBeVisible();
    await tabBarIsOn(page);
    await noSidewaysScroll(page);
    const ctl = page.locator(".sess-ctl");
    await expect(ctl).toBeVisible();
    await expect(ctl.getByRole("form", { name: "Control" })).toBeVisible();
    const check = async () => {
      const c = (await ctl.boundingBox())!;
      const t = (await page.locator("nav.tabbar").boundingBox())!;
      expect(c.y + c.height, `control strip bottom ${c.y + c.height} vs tab bar top ${t.y}`).toBeLessThanOrEqual(
        t.y + 1,
      );
      expect(c.y + c.height, "the strip is on screen, not pushed under the fold").toBeLessThanOrEqual(t.y + 1);
      expect(c.y).toBeGreaterThanOrEqual(0);
    };
    await check();
    // After scrolling to the end of the timeline the sticky strip still sits above the tabs.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await check();
    // The input is reachable and not hidden behind the tab bar.
    const input = ctl.getByRole("textbox", { name: "Message for the next turn" });
    await expect(input).toBeVisible();
    const ib = (await input.boundingBox())!;
    const tb = (await page.locator("nav.tabbar").boundingBox())!;
    expect(ib.y + ib.height).toBeLessThanOrEqual(tb.y);
  });
});

// New session on a phone (STEER-SPEC B.6): the compose glyph in the Board's bar opens a
// full-height sheet, Start sits in its top bar, and Start pushes the session's page in its
// starting state. Signed for real, against the test-door instance (control-helpers.ts).
test.describe("phone: new session", () => {
  test.skip(({ isMobile }) => !isMobile, "phone project only");

  test("compose glyph → full-height sheet → Start in the top bar → the session page", async ({ context, page }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const d = await fakeDaemon(
      key,
      {
        name: `ns-phone-${Math.random().toString(36).slice(2, 8)}`,
        harnesses: ["claude-code"],
        folders: ["/Users/e2e/code"],
        mode: "auto",
        start: { "claude-code": { permissions: ["read", "safe", "auto"], permission: "auto", any_model: true } },
      },
      { sinkToken: await sinkToken() },
    );
    try {
      await page.goto(`${CONTROL_BASE}/?new=1&machine=${d.name}`);
      const sheet = page.locator("[data-new-session]");
      await expect(sheet).toHaveClass(/ns-sheet--phone/);
      await page.locator("[data-ns-cancel]").click();
      await page.locator(".page.board .compose-btn--phone").click();
      await expect(sheet).toBeVisible();
      const box = (await sheet.boundingBox())!;
      const vh = await page.evaluate(() => window.innerHeight);
      expect(box.height, "full height").toBeGreaterThanOrEqual(vh - 1);
      await expect(sheet.locator(".ns-bar [data-ns-start]")).toBeDisabled();
      await sheet.locator("[data-ns-row=machine] button.sel").click();
      await page.locator(".sel-sheet .sel-opt", { hasText: d.name }).click();
      await sheet.locator("[data-ns-text]").fill("Run the e2e suite and tell me what fails.");
      await expect(sheet.locator("[data-ns-row=permission]")).toBeVisible();
      await sheet.locator(".ns-bar [data-ns-start]").click();
      await expect(page).toHaveURL(/\/s\/claude-code\//);
      await expect(page.locator(".starting .chat-bubble")).toHaveText("Run the e2e suite and tell me what fails.");
      await noSidewaysScroll(page);
    } finally {
      await d.stop();
    }
  });
});
