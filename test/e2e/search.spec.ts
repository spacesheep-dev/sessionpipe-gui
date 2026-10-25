// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Owned by: search-ui. Session search end to end (SEARCH-SPEC.md §8.7): typing shows one
// row per session with the engine's marks, instant and still; ⏎ / ⇧⏎ / ⌘⏎ and Space open
// it as a page, beside, beside in the background and as a peek; ⌘K's In transcripts
// section and its Search-all row; the history transcript's find bar stepping "2 of N";
// the row menu; the phone. The demo's own sessions answer the live parts; the history
// transcript runs on the mock (`?mock=1`), which ships in every build, so it needs no
// history home on the server.
import { expect, type Page, test } from "@playwright/test";
import { openPage } from "./helpers.js";

const rows = (page: Page) => page.locator("ol.sx-list a.sx-row");
const field = (page: Page) => page.getByRole("combobox", { name: /Search prompts, replies and tool calls/ });

/** Types into the field the way a person does, one key at a time. */
async function typeQuery(page: Page, q: string): Promise<void> {
  await field(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(q, { delay: 25 });
}

test.describe("search", () => {
  test("typing shows one row per session with the engine's marks, the result line and the URL", async ({ page }) => {
    await openPage(page, "/search");
    await expect(page.getByRole("heading", { name: "Search every session" })).toBeVisible();
    await expect(field(page)).toBeFocused();
    await typeQuery(page, "webhook");
    await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
    // One row per session: no key twice.
    const keys = await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-key")));
    expect(new Set(keys).size).toBe(keys.length);
    // The marks are the text's own ink at 600, never a fill.
    const mark = rows(page).first().locator("mark.sx-mark").first();
    await expect(mark).toHaveText(/webhook/i);
    expect(await mark.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(await mark.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("600");
    await expect(page.locator(".sx-resline")).toHaveText(/^[\d,]+\+? sessions? · [\d.]+ ms$/);
    // The URL is the search (replaced, not pushed, per keystroke).
    await expect.poll(() => page.evaluate(() => location.search)).toBe("?q=webhook");
    // A filter chip edits the same text.
    await page.getByRole("combobox", { name: "Date" }).click();
    await page.getByRole("option", { name: "Past 7 days" }).click();
    await expect(field(page)).toHaveValue("webhook since:7d");
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(field(page)).toHaveValue("webhook");
  });

  test("a word nothing has gives the no-result state, and Clear search goes back to idle", async ({ page }) => {
    await openPage(page, "/search?q=zzqqxxnothing");
    await expect(page.getByRole("heading", { name: "No sessions match “zzqqxxnothing”" })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(field(page)).toHaveValue("");
    await expect(page.getByRole("heading", { name: "Search every session" })).toBeVisible();
    // An unknown key is searched as text, and the page says so.
    await typeQuery(page, "foo:bar");
    await expect(page.locator(".sx-note")).toContainText("“foo:” isn't a filter");
  });

  test("⏎ opens as a page and Back returns to the results; ⇧⏎ beside; ⌘⏎ beside keeping focus", async ({ page }) => {
    await openPage(page, "/search?q=webhook");
    await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
    await field(page).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/s\/[^/]+\/[^?#]+/);
    await page.goBack();
    await expect(page).toHaveURL(/\/search\?q=webhook/);
    await expect(rows(page).first()).toBeVisible();

    await field(page).focus();
    await page.keyboard.press("Shift+Enter");
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    await page.keyboard.press("Escape");

    await openPage(page, "/search?q=webhook");
    await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
    await field(page).focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    // Focus stayed on the results' field: the next key still types.
    await expect(field(page)).toBeFocused();
  });

  test("j/k walk the rows, Space peeks beside with focus kept, `.` opens the row menu", async ({ page }) => {
    await openPage(page, "/search?q=webhook");
    await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
    // ↓ in the field walks the rows (the field keeps focus); in the list, j/k do.
    await field(page).focus();
    await page.keyboard.press("ArrowDown");
    await rows(page).first().focus();
    await expect(rows(page).first()).toBeFocused();
    if ((await rows(page).count()) > 1) {
      await page.keyboard.press("j");
      await expect(rows(page).nth(1)).toHaveAttribute("aria-current", "true");
      await page.keyboard.press("k");
    }
    await expect(rows(page).first()).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Space");
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    await expect(rows(page).first()).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.locator("aside.panel")).not.toHaveClass(/panel--open/);
    await page.keyboard.press(".");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Open/ }).first()).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /Copy (resume command|session ID|conversation ID)/ }).first(),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Find in this session…" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("the row's right-click menu offers open, copy and narrow", async ({ page }) => {
    await openPage(page, "/search?q=webhook");
    await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
    await rows(page).first().click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Open beside" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^More from / }).first()).toBeVisible();
  });

  test("⌘K finds what was said under In transcripts, and ⌘↵ searches all sessions", async ({ page }) => {
    await openPage(page, "/");
    await page.keyboard.press("ControlOrMeta+k");
    const pal = page.getByRole("dialog", { name: "Command palette" });
    await expect(pal).toBeVisible();
    await page.keyboard.type("webhook");
    await expect(pal.locator(".pal-section", { hasText: "In transcripts" })).toBeVisible({ timeout: 15_000 });
    await expect(pal.getByRole("option", { name: "Search all sessions for “webhook”" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page).toHaveURL(/\/search\?q=webhook$/);
    await expect(field(page)).toHaveValue("webhook");
  });

  test("Review's `/` goes to Search; ⌘⇧F from anywhere opens it focused", async ({ page }) => {
    await openPage(page, "/review");
    await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
    await page.keyboard.press("/");
    await expect(page).toHaveURL(/\/search$/);
    await openPage(page, "/inbox");
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await expect(page).toHaveURL(/\/search$/);
    await expect(field(page)).toBeFocused();
  });

  test("first paint under 100 ms per keystroke (p95 of 50 queries) and nothing shifts while typing", async ({
    page,
  }) => {
    await openPage(page, "/search");
    await page.evaluate(() => {
      const w = window as unknown as { __cls: number; __clsAll: number };
      w.__cls = 0;
      w.__clsAll = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
          w.__clsAll += e.value;
          if (!e.hadRecentInput) w.__cls += e.value;
        }
      }).observe({ type: "layout-shift", buffered: false });
    });
    const words = ["webhook", "retry", "stripe", "cache", "test", "deploy", "focus", "token", "build", "queue"];
    const queries: string[] = [];
    for (let i = 0; i < 50; i++)
      queries.push(`${words[i % words.length]}${i >= 10 ? ` ${words[(i * 3) % 10]!.slice(0, 3)}` : ""}`);
    await field(page).click();
    for (const q of queries) {
      const before = await page.evaluate(
        () => (window as unknown as { __spSearchPaints: number[] }).__spSearchPaints.length,
      );
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type(q, { delay: 0 });
      await page.waitForFunction(
        (n) => (window as unknown as { __spSearchPaints: number[] }).__spSearchPaints.length > n,
        before,
      );
    }
    const paints = await page.evaluate(() => (window as unknown as { __spSearchPaints: number[] }).__spSearchPaints);
    const sorted = [...paints].sort((a, b) => a - b);
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    test.info().annotations.push({
      type: "search-paint",
      description: `n=${paints.length} p50=${p(0.5)}ms p95=${p(0.95)}ms max=${sorted.at(-1)}ms cls=${cls.toFixed(4)}`,
    });
    console.log(`search keystroke→paint n=${paints.length} p50=${p(0.5)} p95=${p(0.95)} cls=${cls}`);
    expect(p(0.95)).toBeLessThan(100);
    expect(cls).toBe(0);
  });
});

test.describe("search: the history transcript (mock)", () => {
  test("opens at the hit with the find bar, steps 2 of N with ⌘G, and offers the resume line", async ({ page }) => {
    await page.goto("/search?mock=1&q=webhook%20409");
    await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
    await field(page).focus();
    await page.keyboard.press("Enter");
    const find = page.getByRole("search", { name: "Find in this session" });
    await expect(find).toBeVisible();
    await expect(find.getByRole("searchbox")).toHaveValue("webhook 409");
    await expect(find.locator(".hx-count")).toHaveText(/^1 of \d+$/);
    await page.keyboard.press("ControlOrMeta+g");
    await expect(find.locator(".hx-count")).toHaveText(/^2 of \d+$/);
    await page.keyboard.press("ControlOrMeta+Shift+g");
    await expect(find.locator(".hx-count")).toHaveText(/^1 of \d+$/);
    // The current hit has the selection fill; the others the text's own ink.
    await expect(page.locator(".hx-current mark.sx-mark").first()).toBeVisible();
    await expect(page.locator(".hx-foot")).toContainText("Resume it in a terminal:");
    await expect(page.locator(".hx-foot code")).toHaveText(/claude --resume /);
    await find.getByRole("button", { name: "Done" }).click();
    await expect(find).toHaveCount(0);
  });
});

test.describe("search: the phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("Search is a tab, the field is full width, rows clamp, nothing scrolls sideways", async ({ page }) => {
    await page.goto("/?mock=1");
    const bar = page.locator("nav.tabbar");
    await expect(bar.getByRole("link", { name: "Search" })).toBeVisible();
    await bar.getByRole("link", { name: "Search" }).click();
    await expect(page).toHaveURL(/\/search/);
    const f = field(page);
    await f.fill("webhook");
    await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
    const box = (await page.locator(".sx-search").boundingBox())!;
    expect(box.width).toBeGreaterThan(300);
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    // At most two moments per row on a phone.
    const shown = await rows(page)
      .first()
      .locator(".sx-hit")
      .evaluateAll((els) => els.filter((el) => getComputedStyle(el).display !== "none").length);
    expect(shown).toBeLessThanOrEqual(2);
    // Tapping a row pushes its transcript.
    await rows(page).first().tap();
    await expect(page.getByRole("search", { name: "Find in this session" })).toBeVisible();
  });
});
