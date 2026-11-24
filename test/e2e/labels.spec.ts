// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Colour labels (ORGANIZE-SPEC.md §3.6): set from a row's menu, the dot shows on the board,
// the session bar, the split tab and the palette, survives a reload and reaches a second
// page live; ⌥⌘3 / ⌥⌘0 on the cursor; renaming red in "Edit labels…" changes the menu and
// the chip and `label:<name>` filters; the keyboard path through Shift+F10; forgetting a
// session takes its label away; a name given on another device stays when its field here
// was only looked at; a name the server refuses stays in its field to try again; the "Edit
// labels…" sheet becomes the dialog as the window is widened, with the field in hand still
// in hand. The specs share one receiver, so they run in order and each clears the labels it
// set: a spec that opens "Edit labels…" belongs here.
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { EVENTS, INFO, openBoard, openPage, openPrompt, resizeWindow, tier1Batch, ulid } from "./helpers.js";

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

/** A working parent of the test's own with two child sessions (`parent_id`, the spec's
 *  other subagent shape), both still at work, so its row opens to them. */
async function parentWithKids(page: Page, title: string) {
  const { sinkToken } = (await (await page.request.get(INFO)).json()) as { sinkToken: string };
  const harness = "cursor";
  const ids = [randomUUID(), randomUUID(), randomUUID()] as const;
  let clock = Date.now() - 20_000;
  const seqs = new Map<string, number>();
  const ev = (id: string, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    clock += 500;
    seqs.set(id, (seqs.get(id) ?? -1) + 1);
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 1,
      harness: { name: harness, version: "1.0.0", event: "hook" },
      session: { id, seq: seqs.get(id), machine: "e2e-box", cwd: "~/code/e2e", ...extra },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const [parent, ...kids] = ids;
  const events = [
    ev(parent, "session.started", { source: "startup" }, { title, title_source: "custom" }),
    ev(parent, "turn.started", { turn_id: "t1", prompt_chars: 40 }, { title, title_source: "custom" }),
  ];
  for (const [i, k] of kids.entries()) {
    const kid = { parent_id: parent, title: `E2E kid ${i}`, title_source: "custom" };
    events.push(ev(k, "session.started", { source: "fork" }, kid));
    events.push(ev(k, "tool.started", { tool: "Read", call_id: `c${i}` }, kid));
  }
  const res = await page.request.post(EVENTS, {
    headers: { authorization: `Bearer ${sinkToken}` },
    data: { events },
  });
  expect(res.status()).toBe(202);
  return {
    row: page.locator(`article.card[data-flip="${harness}:${parent}"]`),
    kids: kids.map((k) => ({ key: `${harness}:${k}`, id: k })),
  };
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
    const dot = card.locator(".card-head .label-dot--blue");
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute("aria-label", "Label: Blue");
    await expect(
      other.locator(`article.card:has(a.card-link[href^="${href}"]) .card-head .label-dot--blue`).first(),
    ).toBeVisible();
    // The receiver holds it.
    const doc = (await (await page.request.get(LABELS)).json()) as { sessions: Record<string, string> };
    expect(doc.sessions[key]).toBe("blue");
    await other.close();

    // The Filter menu has a Label submenu once a label exists.
    await page.locator(".page.board > .bar").getByRole("button", { name: "Filter", exact: true }).click();
    await expect(page.getByRole("menu").getByRole("menuitem", { name: "Label", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

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

  test("a label sits after the title: a labelled row's title starts where an unlabelled one's does", async ({
    page,
  }) => {
    const plain = await ownRow(page, "E2E label align plain");
    const short = await ownRow(page, "E2E label align short");
    const long = await ownRow(page, `E2E label align long ${"and longer still ".repeat(30)}`);
    await labelFromMenu(page, short.card, /^Red/);
    await labelFromMenu(page, long.card, /^Orange/);
    await expect(short.card.locator(".card-head .label-dot--red")).toBeVisible();
    await expect(long.card.locator(".card-head .label-dot--orange")).toBeVisible();
    // The lead holds only the state.
    await expect(page.locator(".card-state .label-dot")).toHaveCount(0);

    const box = async (l: Locator) => (await l.boundingBox())!;
    const x0 = (await box(plain.card.locator(".card-title"))).x;
    for (const { card } of [short, long]) {
      const title = await box(card.locator(".card-title"));
      const dot = await box(card.locator(".card-head .label-dot"));
      const link = await box(card.locator("a.card-link"));
      expect(Math.abs(title.x - x0)).toBeLessThanOrEqual(0.5);
      // After the title, whole, inside the row.
      expect(dot.x).toBeGreaterThanOrEqual(title.x + title.width);
      expect(dot.width).toBe(8);
      expect(dot.x + dot.width).toBeLessThanOrEqual(link.x + link.width);
    }
    // The long one is cut, and its dot still follows it.
    expect(
      await long.card.locator(".card-title").evaluate((el) => el.scrollWidth > el.clientWidth),
      "the long title is ellipsized",
    ).toBe(true);
    // The heading's name is the title alone: the dot is beside it, not in it.
    await expect(short.card.getByRole("heading", { name: "E2E label align short", exact: true })).toBeVisible();
  });

  test("in the Inbox too, a labelled prompt's title starts where an unlabelled one's does", async ({
    page,
    request,
  }) => {
    const plain = await openPrompt(request, { machine: "e2e-label-box", title: "E2E inbox align plain" });
    const marked = await openPrompt(request, { machine: "e2e-label-box", title: "E2E inbox align marked" });
    try {
      expect((await request.patch(LABELS, { data: { sessions: { [marked.key]: "purple" } } })).status()).toBe(200);
      await openPage(page, "/inbox");
      const row = (k: string) => page.locator(`.inbox-row[data-session="${k}"]`).first();
      await expect(row(marked.key).locator(".inbox-row-head .label-dot--purple")).toBeVisible();
      await expect(page.locator(".inbox-lead .label-dot")).toHaveCount(0);
      const a = (await row(plain.key).locator(".inbox-title").boundingBox())!;
      const b = (await row(marked.key).locator(".inbox-title").boundingBox())!;
      const dot = (await row(marked.key).locator(".label-dot").boundingBox())!;
      expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(0.5);
      expect(dot.x).toBeGreaterThanOrEqual(b.x + b.width);
    } finally {
      await plain.clear();
      await marked.clear();
    }
  });

  test("a child session's label follows its text, which starts where its sibling's does", async ({ page, request }) => {
    const { row, kids } = await parentWithKids(page, "E2E label kids");
    expect((await request.patch(LABELS, { data: { sessions: { [kids[1]!.key]: "green" } } })).status()).toBe(200);
    await openBoard(page);
    const kid = (id: string) => row.locator(`li[data-agent="${id}"]`);
    await expect(kid(kids[1]!.id).locator(".kid-head .label-dot--green")).toBeVisible();
    const a = (await kid(kids[0]!.id).locator(".agent-text").boundingBox())!;
    const b = (await kid(kids[1]!.id).locator(".agent-text").boundingBox())!;
    const dot = (await kid(kids[1]!.id).locator(".label-dot").boundingBox())!;
    expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(0.5);
    expect(dot.x).toBeGreaterThanOrEqual(b.x + b.width);
  });

  test("⌥⌘3 labels the row under the cursor yellow and ⌥⌘0 clears it", async ({ page }) => {
    const { card } = await ownRow(page, "E2E label by key");
    // Focus puts the list's cursor on the row.
    await card.locator("a.card-link").focus();
    await expect(card).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Alt+ControlOrMeta+3");
    await expect(card.locator(".card-head .label-dot--yellow")).toBeVisible();
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

    // The Filter menu's Label › lists it by its name and filters to it; the button and the
    // submenu then say it.
    const bar = page.locator(".page.board > .bar");
    await bar.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Label", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /^Urgent/ }).click();
    await expect(page.locator("article.card")).toHaveCount(1);
    const filter = bar.getByRole("button", { name: "Filter: Urgent" });
    await expect(filter).toHaveText("Urgent");
    await filter.click();
    await expect(page.getByRole("menu").getByRole("menuitem", { name: "Label: Urgent" })).toBeVisible();
    await page.getByRole("menu").getByRole("menuitem", { name: "Clear filters" }).click();
    await expect(bar.getByRole("button", { name: "Filter", exact: true })).toBeVisible();

    // So does the search: label:urgent keeps that one row, -label:urgent leaves it out.
    const search = page.getByRole("searchbox", { name: "Filter sessions" });
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

  test("a name given on another device stays when its field here was only looked at", async ({ page, request }) => {
    await openBoard(page);
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitem", { name: "Edit labels…" }).click();
    const dialog = page.getByRole("dialog", { name: "Labels" });
    // The dialog opens with its first field in hand.
    const red = dialog.getByRole("textbox", { name: "Red label name" });
    await expect(red).toBeFocused();

    // Another device names the colour: the field shows it.
    expect((await request.patch(LABELS, { data: { names: { red: "Urgent" } } })).status()).toBe(200);
    await expect(red).toHaveValue("Urgent");
    // Left untouched for the next field, then the dialog closed: nothing is saved over it.
    await dialog.getByRole("textbox", { name: "Grey label name" }).click();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    const doc = (await (await request.get(LABELS)).json()) as { names: Record<string, string> };
    expect(doc.names).toEqual({ red: "Urgent" });
  });

  test("a name the server refuses stays in its field, and Enter tries again", async ({ page, request }) => {
    await openBoard(page);
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitem", { name: "Edit labels…" }).click();
    const dialog = page.getByRole("dialog", { name: "Labels" });
    const red = dialog.getByRole("textbox", { name: "Red label name" });
    await page.route(`**${LABELS}`, (route) =>
      route.request().method() === "PATCH" ? route.fulfill({ status: 500, body: "" }) : route.fallback(),
    );
    await red.fill("Urgent");
    await red.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText("Not saved; try again");
    await expect(red).toHaveValue("Urgent");
    // The server answers again: Enter saves what is still in the field.
    await page.unroute(`**${LABELS}`);
    await red.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect
      .poll(async () => ((await (await request.get(LABELS)).json()) as { names: Record<string, string> }).names)
      .toEqual({ red: "Urgent" });
    await expect(red).toHaveValue("Urgent");
  });

  test("the sheet becomes the dialog as the window is widened, with the field in hand and its words kept", async ({
    page,
  }) => {
    // A window with a mouse, on either side of the phone layout's width (lib/device.ts).
    const phone = { width: 700, height: 800 };
    const wide = { width: 1000, height: 800 };
    await page.setViewportSize(phone);
    await openBoard(page);
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitem", { name: "Edit labels…" }).click();
    const dialog = page.getByRole("dialog", { name: "Labels" });
    await expect(dialog).toHaveClass(/labels-sheet/);
    // Typed and not yet saved: a field saves when it is left.
    const grey = dialog.getByRole("textbox", { name: "Grey label name" });
    await grey.click();
    await grey.pressSequentially("Later");
    await expect(grey).toBeFocused();

    await resizeWindow(page, wide);
    await expect(dialog).toHaveClass(/labels-dialog/);
    await expect(dialog).not.toHaveClass(/labels-sheet/);
    await expect(page.locator(".menu-scrim--dialog")).toBeVisible();
    await expect(grey).toBeFocused();
    await expect(grey).toHaveValue("Later");

    await resizeWindow(page, phone);
    await expect(dialog).toHaveClass(/labels-sheet/);
    await expect(grey).toBeFocused();
    await expect(grey).toHaveValue("Later");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});
