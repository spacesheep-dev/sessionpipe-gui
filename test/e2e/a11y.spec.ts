// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Accessibility: axe on every page (zero serious or critical violations), then a
// keyboard-only walk: Tab from the top reaches the skip link, the main region, the rail
// and a card (New session between the brand and the pages); `g f` navigates; `?` opens the help; a rebinding on /shortcuts takes
// effect (and the old key stops); a conflict is refused; Esc gives focus back.
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { EVENTS, INFO, openBoard, openPage, sessionUrl, tier1Batch, ulid } from "./helpers.js";

const SHORTCUTS_KEY = "sessionpipe-gui.shortcuts";

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = results.violations.map((v) => `${v.impact}:${v.id}×${v.nodes.length}`).join(" ");
  console.log(`[axe] ${label}: ${results.violations.length} violations (${bad.length} serious/critical) ${summary}`);
  if (process.env.AXE_VERBOSE)
    for (const v of bad)
      for (const n of v.nodes) console.log(`  ${v.id} ${n.target.join(" ")} :: ${n.any[0]?.message ?? ""}`);
  expect
    .soft(
      bad.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })),
      `${label}: serious/critical axe violations`,
    )
    .toEqual([]);
}

/** The first board card's session path. */
async function firstSessionPath(page: Page): Promise<string> {
  await openBoard(page);
  const href = (await page.locator("article.card a.card-link").first().getAttribute("href"))!;
  return href.split("?")[0]!;
}

test.describe("accessibility", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project only");

  test("axe: board, inbox, feed, review, machines, connect, setup, views, shortcuts", async ({ page }) => {
    test.slow();
    // Dialogs fade in; axe must sample text at full opacity, not mid-animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openBoard(page);
    await axe(page, "board");
    for (const [path, marker] of [
      ["/inbox", ".inbox, .page-note"],
      ["/feed", "ol.rows li"],
      ["/review", ".rv-tabs"],
      ["/machines", "section.machine, .machines, .page"],
      ["/connect", ".connect"],
      ["/setup", ".setup, .page"],
      ["/themes", ".themes"],
      ["/shortcuts", ".sc-page"],
    ] as const) {
      await page.goto(path);
      await expect(page.locator(marker).first()).toBeVisible();
      await axe(page, path);
    }
  });

  test("axe: a session page, the palette open, and a view page", async ({ page }) => {
    test.slow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const path = await firstSessionPath(page);
    await page.goto(path);
    await expect(page.locator("h1.sess-title")).toBeVisible();
    await axe(page, "session");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await axe(page, "palette");
    await page.keyboard.press("Escape");
    await openPage(page, "/t/e2e-counter");
    await expect(page.locator(".e2e-counter")).toBeVisible();
    await axe(page, "view");
    // The help (a view page owns `?`, so from the feed).
    await openPage(page, "/feed");
    await page.locator("body").click({ position: { x: 700, y: 600 } });
    await page.keyboard.press("Shift+?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await axe(page, "help");
  });

  test("axe: a session that opens on its New line", async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // A session read up to its first turn, then a second turn with an answer: unread at
    // open, the line above that answer. (One never looked at gets no line: lib/newLine.ts.)
    const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
    const post = async (events: Record<string, unknown>[]) => {
      const res = await request.post(EVENTS, {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sinkToken}`,
          "sessionpipe-protocol": "1",
        },
        data: { events },
      });
      expect(res.ok()).toBeTruthy();
    };
    const batch = tier1Batch({ title: "New line" });
    for (const e of batch.events) e.tier = 3;
    await post(batch.events);
    const key = `${batch.harness}:${batch.sessionId}`;
    const snap = (await (await request.get("/api/ui/snapshot")).json()) as {
      sessions: { key: string; newsAt?: string }[];
    };
    const read = snap.sessions.find((s) => s.key === key)?.newsAt;
    expect(read).toBeTruthy();
    expect((await request.patch("/api/ui/marks", { data: { read: { [key]: read } } })).ok()).toBeTruthy();
    const last = batch.events[batch.events.length - 1]!;
    const turnId = randomUUID();
    let seq = batch.events.length;
    let clock = Date.now() - 30_000;
    const ev = (type: string, data: Record<string, unknown>, hook: string) => {
      clock += 1000;
      return {
        ...last,
        id: ulid(clock),
        type,
        time: new Date(clock).toISOString(),
        harness: { ...(last.harness as Record<string, unknown>), event: hook },
        session: { ...(last.session as Record<string, unknown>), seq: seq++ },
        data,
      };
    };
    await post([
      ev("turn.started", { turn_id: turnId, prompt_chars: 5 }, "UserPromptSubmit"),
      ev("turn.transcript", { turn: 2, turn_id: turnId, user: "More?", assistant: "The rest." }, "Stop"),
      ev("turn.ended", { turn_id: turnId, reason: "stop", ms: 2000 }, "Stop"),
    ]);
    await openPage(page, sessionUrl(batch.harness, batch.sessionId));
    const line = page.getByRole("separator", { name: "New since you looked" });
    await expect(line).toBeVisible();
    // Under the second turn's prompt, above its answer.
    const top = async (text: string) => (await page.getByText(text, { exact: true }).boundingBox())!.y;
    const at = (await line.boundingBox())!.y;
    expect(at).toBeGreaterThan(await top("More?"));
    expect(at).toBeLessThan(await top("The rest."));
    await axe(page, "session, New line");
  });

  test("keyboard-only: skip link, main, rail, a card; g f navigates; ? opens the help", async ({ page }) => {
    await openBoard(page);
    // Tab from the top: the skip link first, which lands on main.
    await page.keyboard.press("Tab");
    const skip = page.locator("a.skip");
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
    // From the skip link, Tab walks the rail: the brand, New session, then the pages.
    await skip.focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("nav.rail a.rail-brand")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("nav.rail [data-compose]")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("nav.rail a[data-nav='board']")).toBeFocused();
    // The board's cards are one tab stop: Tab goes into the list, arrows move inside it.
    const card = page.locator("article.card a.card-link[tabindex='0']");
    await card.focus();
    await expect(card).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("article.card[aria-current='true']")).toHaveAttribute("data-cursor", "1");
    await expect(page.locator("article.card a.card-link").nth(1)).toBeFocused();

    // `g f` is the feed; the title is announced and main takes focus.
    await page.keyboard.press("g");
    await page.keyboard.press("f");
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.locator("main#main")).toBeFocused();
    await expect(page.locator("[data-announcer]")).toHaveText(/Feed/);

    // `?` opens the help, lists the bindings, Esc closes it and gives focus back.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    const search = page.locator("[data-search]");
    await search.focus();
    await page.keyboard.press("Escape"); // leaves the field, keeps the list
    await expect(search).not.toBeFocused();
    // Typing `?` in the field is text, not a shortcut; from the page it opens the help.
    await search.focus();
    await page.keyboard.press("Shift+?");
    await expect(search).toHaveValue("?");
    await search.fill("");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+?");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(help).toBeVisible();
    await expect(help.getByRole("searchbox")).toBeFocused();
    await expect(help.locator("kbd", { hasText: /^g$/ }).first()).toBeVisible();
    await help.getByRole("searchbox").fill("feed");
    await expect(help.locator(".sc-row", { hasText: "Feed" }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
  });

  test("/shortcuts: rebinding g f to g x works, g f stops, a conflict is refused, Esc restores focus", async ({
    page,
  }) => {
    await openPage(page, "/shortcuts");
    const row = page.locator(".sc-row[data-action='nav.feed']");
    await expect(row).toBeVisible();
    const chip = row.locator("button.sc-key").first();
    await chip.click();
    await expect(row.locator(".sc-recorder")).toBeVisible();
    await page.keyboard.press("g");
    await page.keyboard.press("x");
    await expect(row.locator("button.sc-key").first()).toHaveText(/g\s*x/);
    // Persisted as an override.
    const stored = await page.evaluate((k) => localStorage.getItem(k), SHORTCUTS_KEY);
    expect(JSON.parse(stored!)["nav.feed"]).toEqual(["g x"]);

    // A conflict is refused: `g x` on Board stays unbound and says why.
    const board = page.locator(".sc-row[data-action='nav.board']");
    await board.locator("button.sc-add").click();
    await page.keyboard.press("g");
    await page.keyboard.press("x");
    await expect(board.locator(".sc-conflict")).toHaveText(/Feed/);
    await page.keyboard.press("Escape");
    await expect(board.locator(".sc-recorder")).toHaveCount(0);
    await expect(board.locator("button.sc-add")).toBeFocused();
    await expect(board.locator("button.sc-key")).toHaveText([/g\s*b/]);

    // A browser essential is refused too.
    await board.locator("button.sc-add").click();
    await page.keyboard.press("ControlOrMeta+l");
    await expect(board.locator(".sc-conflict")).toHaveText(/browser/);
    await page.keyboard.press("Escape");

    // Now `g x` goes to the feed and `g f` does not.
    await page.goto("/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("g");
    await page.keyboard.press("f");
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press("g");
    await page.keyboard.press("x");
    await expect(page).toHaveURL(/\/feed$/);

    // Reset all puts `g f` back.
    await page.goto("/shortcuts");
    await page.locator("button", { hasText: "Reset all" }).click();
    await expect(row.locator("button.sc-key").first()).toHaveText(/g\s*f/);
    expect(await page.evaluate((k) => localStorage.getItem(k), SHORTCUTS_KEY)).toBeNull();
  });

  test("a view's own keys win on its page: ? is the view's legend there, not the host's help", async ({ page }) => {
    await openPage(page, "/t/e2e-counter");
    await expect(page.locator(".e2e-counter")).toBeVisible();
    const legend = page.locator("[data-legend]");
    await expect(legend).toBeHidden();
    await page.locator("body").click({ position: { x: 700, y: 600 } });
    await page.keyboard.press("Shift+?");
    await expect(legend).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    // The host's mod chords and its `g …` sequences still work from the view.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("g");
    await page.keyboard.press("f");
    await expect(page).toHaveURL(/\/feed$/);
    // Off the view, `?` is the help again.
    await page.locator("body").click({ position: { x: 700, y: 600 } });
    await page.keyboard.press("Shift+?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  });

  test("a long page keeps its scroll through stream events and a panel (?s=) change", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    await openPage(page, "/connect");
    // The groups arrive whole once the receiver's info and the setup status are in.
    await expect(page.locator(".connect .form-group").first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 600));
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(300);
    // A stream event re-renders the app; a `?s=` change re-renders the shell and the panel.
    const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
    const batch = tier1Batch({ title: "Scroll keeper" });
    const res = await request.post(EVENTS, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sinkToken}`,
        "sessionpipe-protocol": "1",
      },
      data: { events: batch.events },
    });
    expect(res.ok()).toBeTruthy();
    await page.evaluate((key) => {
      history.pushState(null, "", `${location.pathname}?s=${encodeURIComponent(key)}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `${batch.harness}:${batch.sessionId}`);
    await page.waitForTimeout(1500);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThanOrEqual(2);
  });

  test("dialogs trap focus and give it back: quick settings, the More sheet is phone-only", async ({ page }) => {
    await openBoard(page);
    const trigger = page.locator("nav.rail button[aria-label='Quick settings']");
    await trigger.focus();
    await page.keyboard.press("Enter");
    const pop = page.getByRole("dialog", { name: "Quick settings" });
    await expect(pop).toBeVisible();
    await expect(pop).toHaveAttribute("aria-modal", "true");
    // Focus is inside and stays inside through a full Tab cycle.
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".qs-pop"))).toBe(true);
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".qs-pop"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
