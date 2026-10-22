// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Colour labels (ORGANIZE-SPEC.md §3.6): set from a row's menu, the dot shows on the board,
// the session bar, the split tab and the palette, survives a reload and reaches a second
// page live; ⌥⌘3 / ⌥⌘0 on the cursor; renaming red in "Edit labels…" changes the menu and
// the chip and `label:<name>` filters; the keyboard path through Shift+F10; forgetting a
// session takes its label away. The specs share one receiver, so they run in order and
// each clears the labels it set.
import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { EVENTS, INFO, openBoard, tier1Batch } from "./helpers.js";

const LABELS = "/api/ui/labels";
const menu = (page: Page) => page.getByRole("menu").last();

/** Every label off, every name back to its colour's. */
async function clearLabels(request: APIRequestContext) {
  const doc = (await (await request.get(LABELS)).json()) as { sessions: Record<string, string> };
  const sessions = Object.fromEntries(Object.keys(doc.sessions).map((k) => [k, null]));
  const names = Object.fromEntries(
    ["red", "orange", "yellow", "green", "blue", "purple", "grey"].map((c) => [c, null]),
  );
  const res = await request.patch(LABELS, { data: { sessions, names } });
  expect(res.status()).toBe(200);
}

/** A session of the test's own (tier 1, its turn ended a minute ago: an idle row that
 *  stays put while the demo's rows move), and its row on the board. */
async function ownRow(page: Page, title: string) {
  const { sinkToken } = (await (await page.request.get(INFO)).json()) as { sinkToken: string };
  const b = tier1Batch({ title });
  const res = await page.request.post(EVENTS, {
    headers: { authorization: `Bearer ${sinkToken}` },
    data: { events: b.events },
  });
  expect(res.status()).toBe(202);
  await openBoard(page);
  const href = `/s/${encodeURIComponent(b.harness)}/${encodeURIComponent(b.sessionId)}`;
  const card = page.locator(`article.card:has(a.card-link[href^="${href}"])`);
  await expect(card).toBeVisible();
  return { card, href, key: `${b.harness}:${b.sessionId}`, harness: b.harness, id: b.sessionId };
}

/** A row's Label submenu, open. The demo keeps the board moving (a scroll closes a menu,
 *  as a native one does), so a menu that closed under the pointer is opened again. */
async function openLabelMenu(page: Page, card: Locator) {
  await expect(async () => {
    await page.keyboard.press("Escape");
    await card.locator("a.card-link").click({ button: "right" });
    await menu(page).getByRole("menuitem", { name: "Label", exact: true }).click({ timeout: 2000 });
    await expect(page.getByRole("menuitemradio").first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}

async function labelFromMenu(page: Page, card: Locator, name: RegExp) {
  await openLabelMenu(page, card);
  await page.getByRole("menuitemradio", { name }).click();
}

test.describe("colour labels", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project only");
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ request }) => clearLabels(request));
  test.afterAll(async ({ request }) => clearLabels(request));

  test("a row's menu sets it; the dot shows on every surface, after a reload and on a second page", async ({
    page,
    browser,
  }) => {
    const { card, key, href } = await ownRow(page, "E2E label on every surface");
    // A second page, open before the change: it hears it live.
    const other = await browser.newPage();
    await openBoard(other);

    await labelFromMenu(page, card, /^Blue/);
    const dot = card.locator(".card-state .label-dot--blue");
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute("aria-label", "Label: Blue");
    await expect(
      other.locator(`article.card:has(a.card-link[href^="${href}"]) .card-state .label-dot--blue`).first(),
    ).toBeVisible();
    // The receiver holds it.
    const doc = (await (await page.request.get(LABELS)).json()) as { sessions: Record<string, string> };
    expect(doc.sessions[key]).toBe("blue");
    await other.close();

    // The chip appears once a label exists, and filters to it.
    const chip = page.getByRole("combobox", { name: "Label" });
    await expect(chip).toBeVisible();

    // The split tab and the panel head.
    await card.locator("a.card-link").click({ modifiers: ["Shift"] });
    await expect(page.locator("aside.panel .panel-head .label-dot--blue")).toBeVisible();

    // The palette.
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    const pal = page.getByRole("dialog", { name: "Command palette" });
    await page.keyboard.type("label:blue");
    await expect(pal.locator(".pal-row .label-dot--blue").first()).toBeVisible();
    await page.keyboard.press("Escape");

    // The session bar, after a reload.
    await page.goto(href);
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    const bar = page.locator("h1.sess-title .label-dot--blue");
    await expect(bar).toBeVisible();
    // Its dot opens the Label menu.
    await page.locator("h1.sess-title .bar-label-btn").click();
    await expect(page.getByRole("menuitemradio", { name: /^Blue/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");

    // axe: the dot is named, nothing serious.
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("⌥⌘3 labels the row under the cursor yellow and ⌥⌘0 clears it", async ({ page }) => {
    const { card } = await ownRow(page, "E2E label by key");
    // Focus puts the list's cursor on the row.
    await card.locator("a.card-link").focus();
    await expect(card).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Alt+ControlOrMeta+3");
    await expect(card.locator(".card-state .label-dot--yellow")).toBeVisible();
    await page.keyboard.press("Alt+ControlOrMeta+0");
    await expect(card.locator(".label-dot")).toHaveCount(0);
  });

  test("renaming red in Edit labels changes the menu and the chip; label:<name> filters", async ({ page }) => {
    const { card, href } = await ownRow(page, "E2E label renamed");
    await labelFromMenu(page, card, /^Red/);
    await expect(card.locator(".label-dot--red")).toBeVisible();

    // The board's own menu has "Edit labels…".
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitem", { name: "Edit labels…" }).click();
    const dialog = page.getByRole("dialog", { name: "Labels" });
    await expect(dialog).toBeVisible();
    const red = dialog.getByRole("textbox", { name: "Red label name" });
    await expect(red).toHaveAttribute("placeholder", "Red");
    await red.fill("x".repeat(40));
    await red.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText("Up to 32 characters");
    await red.fill("Urgent");
    await red.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    // The menu and the dot's name say it.
    await openLabelMenu(page, card);
    await expect(page.getByRole("menuitemradio", { name: /^Urgent/ })).toHaveAttribute("aria-checked", "true");
    // Esc closes the submenu, then the menu.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(card.locator(".label-dot--red")).toHaveAttribute("aria-label", "Label: Urgent");

    // The chip lists it by its name and filters to it.
    await page.getByRole("combobox", { name: "Label" }).click();
    await page.getByRole("option", { name: "Urgent" }).click();
    await expect(page.locator("article.card")).toHaveCount(1);
    await expect(page.getByRole("combobox", { name: "Label" })).toContainText("Urgent");
    await page.getByRole("button", { name: "Clear", exact: true }).click();

    // So does the search: label:urgent keeps that one row, -label:urgent leaves it out.
    const search = page.getByRole("searchbox", { name: "Search sessions" });
    await search.fill("label:urgent");
    await expect(page.locator("article.card")).toHaveCount(1);
    await expect(page.locator("article.card a.card-link").first()).toHaveAttribute("href", new RegExp(`^${href}`));
    await search.fill("-label:urgent");
    await expect(page.locator(`article.card a.card-link[href^="${href}"]`)).toHaveCount(0);
  });

  test("the keyboard path: Shift+F10 on a row, into Label, Enter", async ({ page }) => {
    const { card } = await ownRow(page, "E2E label from the keyboard");
    await card.locator("a.card-link").focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu(page)).toBeVisible();
    // Type-ahead to Label, open it, take the first colour.
    await page.keyboard.type("Lab");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menuitemradio", { name: /^Red/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card.locator(".label-dot--red")).toBeVisible();
  });

  test("forgetting a session takes its label away", async ({ page, request }) => {
    const { card: row, key, harness, id } = await ownRow(page, "E2E labelled and forgotten");
    expect((await request.patch(LABELS, { data: { sessions: { [key]: "green" } } })).status()).toBe(200);
    await expect(row.locator(".label-dot--green")).toBeVisible();
    const forget = await request.post(`/api/ui/sessions/${harness}/${id}/forget`);
    expect(forget.ok()).toBe(true);
    await expect
      .poll(
        async () => ((await (await request.get(LABELS)).json()) as { sessions: Record<string, string> }).sessions[key],
      )
      .toBeUndefined();
    await expect(row).toHaveCount(0);
  });
});
