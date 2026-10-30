// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The board as a person sees it: groups by state, a working card's current tool, an
// attention banner when the demo asks for a permission, the collapsed done group,
// live counts without a reload (with Advanced → Show counts), a list that holds still
// under the pointer, the search that finds nothing, the keyboard (e with Hidden open
// too), and the Hidden header's own menu.
import { expect, test } from "@playwright/test";
import { holdBoard, openBoard } from "./helpers.js";

test.describe("board", () => {
  test("groups demo sessions by state and collapses done with a count", async ({ page }) => {
    await openBoard(page);
    // The demo's backfill makes a done group at once; its cards stay hidden until asked for.
    const done = page.locator("section.group--done");
    await expect(done).toBeVisible();
    const toggle = done.locator("button.group-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle.locator(".group-count")).toHaveText(/^[1-9]\d*$/);
    await expect(done.locator(".grid--done")).toHaveCount(0);
    await expect(done.locator("article.card")).toHaveCount(0);
    await expect(toggle).toContainText("Done");
    // Live groups: at least one of working/idle is there and each heading carries a count.
    await expect(page.locator("section.group--working, section.group--idle").first()).toBeVisible();
    for (const group of await page.locator("section.group:not(.group--done)").all()) {
      await expect(group.locator("h2.group-head")).toHaveText(/^(Needs? you|Working|Stale|Idle)\s*[1-9]\d*$/);
      expect(await group.locator("article.card").count()).toBeGreaterThan(0);
    }
    // Every card in a state group wears that state's dot and label.
    const working = page.locator("section.group--working article.card").first();
    if (await working.isVisible()) {
      await expect(working.locator(".card-state .dot--working")).toBeVisible();
      await expect(working.locator(".card-state")).toContainText("working");
    }
    // Expanding done shows the cards and the count still matches.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const n = Number(await toggle.locator(".group-count").innerText());
    await expect(done.locator("article.card--done")).toHaveCount(n);
  });

  test("Done's head says how many are unread only while it is folded", async ({ page }) => {
    await openBoard(page);
    const done = page.locator("section.group--done");
    const toggle = done.locator("button.group-toggle");
    await toggle.click();
    // A session that just finished lands in Done unread already, and its menu offers
    // "Mark as read"; so take a row that is read (another worker on the same server may
    // mark it first, so each try takes one afresh), and keep to it by its link as rows
    // re-sort. A scroll closes a menu, as a native one does, so one that closed is opened
    // again.
    let href: string | null = null;
    const link = () => done.locator(`a.card-link[href="${href}"]`);
    await expect(async () => {
      await page.keyboard.press("Escape");
      href = await done
        .locator("article.card--done:not(:has(.dot--unread)) a.card-link")
        .first()
        .getAttribute("href", { timeout: 2000 });
      await link().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Mark as unread" }).click({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    // Open, the row's filled dot says it; the head does not say it again.
    await expect(link().locator(".dot--unread")).toBeVisible();
    await expect(toggle.locator(".group-note")).toHaveCount(0);
    await toggle.click();
    await expect(toggle.locator(".group-note")).toHaveText(/^[1-9]\d* unread$/);
  });

  test("a working card shows the tool it is running", async ({ page }) => {
    await openBoard(page);
    // The status of a working row: the glyph (its state word for assistive tech), the
    // tool, and its time. The element lays its parts out across the row (display:
    // contents), so the tool is what is visible.
    const status = page.locator("article.card--working .card-status:has(code)");
    await expect(status.first().locator("code")).toBeVisible({ timeout: 30_000 });
    await expect(status.first().locator("code")).toHaveText(/^\S+$/);
    await expect(status.first().locator(".card-state")).toContainText("working");
    await expect(status.first().locator(".num").last()).toHaveText(/\d/);
  });

  test("a needs-you card appears with its attention banner", async ({ page }) => {
    test.setTimeout(90_000);
    await openBoard(page);
    // The demo's permission windows last ~2 s of wall time at speed 20 and recur every
    // 6–20 s; read the banner in one go so a vanished card just makes the poll retry.
    await expect
      .poll(
        async () => {
          const card = page.locator("section.group--needs_you article.card--needs_you").first();
          if ((await card.count()) === 0) return null;
          try {
            // textContent, not innerText: labels may be transformed by CSS.
            return {
              status: await card.locator(".card-status").textContent({ timeout: 500 }),
              tool: await card.locator(".card-status code").textContent({ timeout: 500 }),
              msg: await card.locator(".card-attn").textContent({ timeout: 500 }),
              dot: await card.locator(".card-state .dot--needs_you").count(),
            };
          } catch {
            return null;
          }
        },
        { timeout: 60_000, message: "a needs_you card with its attention banner" },
      )
      .toMatchObject({
        status: expect.stringMatching(/needs you\s*·?\s*permission/),
        tool: expect.stringMatching(/^\S+$/),
        msg: expect.stringMatching(/\S/),
        dot: 1,
      });
  });

  test("counts on a working card change live, without a reload", async ({ page }) => {
    // Turns and tools are the row's tooltip by default; "Show counts" prints them.
    await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.board.counts", "1"));
    await openBoard(page);
    await expect(page.locator(".conn").first()).toHaveText("live");
    const foot = async () => {
      const out = new Map<string, string>();
      for (const card of await page.locator("article.card--working").all()) {
        const href = await card.locator("a.card-link").getAttribute("href");
        const text = await card
          .locator(".card-foot")
          .innerText()
          .catch(() => "");
        if (href && text) out.set(href, text);
      }
      return out;
    };
    await expect.poll(async () => (await foot()).size, { timeout: 30_000 }).toBeGreaterThan(0);
    const before = await foot();
    const navigations: string[] = [];
    page.on("framenavigated", (f) => f === page.mainFrame() && navigations.push(f.url()));
    await expect
      .poll(
        async () => {
          const now = await foot();
          for (const [href, text] of before) {
            const cur = now.get(href);
            if (cur && cur !== text) return `${text} -> ${cur}`;
          }
          return null;
        },
        { timeout: 30_000, message: "a working card's footer counts to change" },
      )
      .toMatch(/\d+ (turn|tool|file|subagent)/);
    expect(navigations, "no reload or navigation happened").toEqual([]);
  });

  test("by default a row says two facts; Show counts in the view menu adds the columns", async ({ page }) => {
    await openBoard(page);
    await expect(page.locator("article.card .card-foot:not(.card-foot--mark)")).toHaveCount(0);
    // The counts are the row's tooltip instead.
    await expect(page.locator("article.card a.card-link").first()).toHaveAttribute("title", /\d+ (turn|tool)/);
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Show counts" }).click();
    await expect(page.locator("article.card .card-foot:not(.card-foot--mark)").first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("sessionpipe-gui.board.counts"))).toBe("1");
  });

  test("the list holds still under the pointer: no row moves while it rests on one", async ({ page }) => {
    test.setTimeout(60_000);
    await openBoard(page);
    // The first row: nothing above it is the pointer's to hold but the section header.
    const row = page.locator("section.group:not(.group--done) article.card").first();
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    if (!box) throw new Error("no row");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".page.board")).toHaveAttribute("data-held", "");
    const key = await row.getAttribute("data-flip");
    const card = page.locator(`article.card[data-flip="${key}"]`);
    // A move that was already playing when the pointer arrived finishes first.
    await page.waitForTimeout(600);
    const at = Math.round((await card.boundingBox())?.y ?? -1);
    const tops: number[] = [];
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      tops.push(Math.round((await card.boundingBox())?.y ?? -1));
    }
    // The demo changes states every few seconds; the row under the pointer stays put.
    expect(new Set(tops)).toEqual(new Set([at]));
    // Leaving lets the list take its real order again.
    await page.mouse.move(5, 5);
    await expect(page.locator(".page.board")).not.toHaveAttribute("data-held", "", { timeout: 5_000 });
  });

  test("a search that finds nothing says so, with Clear search", async ({ page }) => {
    await openBoard(page);
    await page.getByRole("searchbox", { name: "Search sessions" }).fill("zzzz-nothing");
    await expect(page.locator(".board-nomatch .state-title")).toHaveText("No sessions match “zzzz-nothing”");
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.locator("section.group").first()).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search sessions" })).toHaveValue("");
  });

  test("a filter that finds nothing hands the words to Search, which reads every session", async ({ page }) => {
    await openBoard(page);
    await page.getByRole("searchbox", { name: "Search sessions" }).fill("zzzz nothing");
    await page.getByRole("button", { name: "Search every session for “zzzz nothing”" }).click();
    await expect(page).toHaveURL((u) => u.pathname === "/search" && u.searchParams.get("q") === "zzzz nothing");
  });

  test("keyboard: / focuses search, j/k move the cursor, Enter opens the session", async ({ page }) => {
    await openBoard(page);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("/");
    await expect(page.locator("input[data-search]")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("input[data-search]")).not.toBeFocused();
    await expect(page.locator("article.card[aria-current='true']")).toHaveCount(0);
    await page.keyboard.press("j");
    await expect(page.locator("article.card[aria-current='true']")).toHaveAttribute("data-cursor", "0");
    await page.keyboard.press("j");
    await expect(page.locator("article.card[aria-current='true']")).toHaveAttribute("data-cursor", "1");
    await page.keyboard.press("k");
    await expect(page.locator("article.card[aria-current='true']")).toHaveAttribute("data-cursor", "0");
    // `.` opens the row's own menu at the row; Esc closes it.
    await page.keyboard.press(".");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    const opened = await page.locator("article.card[aria-current='true'] a.card-link").getAttribute("href");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/s\/[^/]+\/.+/);
    await expect(page.locator("h1.sess-title")).toBeVisible();
    // Back puts the cursor on the row it was on (wherever the live list has put it since).
    await page.goBack();
    await expect(page.locator("article.card[aria-current='true'] a.card-link")).toHaveAttribute("href", opened!);
  });

  test("with Hidden open, e leaves the cursor in its place, so e again hides the next row", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.board.hiddenOpen", "1"));
    await openBoard(page);
    await page.locator("section.group--working article.card a.card-link").first().focus();
    // The cursor stays on the row that took the hidden one's place, not on the row in Hidden
    // (the live demo may still bring a row back above it, so this reads rows, not indexes).
    const cursor = page.locator("article.card[aria-current='true']");
    const link = cursor.locator("a.card-link");
    const section = cursor.locator("xpath=ancestor::section");
    const first = await link.getAttribute("href");
    await page.keyboard.press("e");
    await expect(link).not.toHaveAttribute("href", first!);
    await expect(section).not.toHaveClass(/group--hidden/);
    const second = await link.getAttribute("href");
    await page.keyboard.press("e");
    await expect(link).not.toHaveAttribute("href", second!);
    await expect(link).not.toHaveAttribute("href", first!);
    await expect(section).not.toHaveClass(/group--hidden/);
  });

  test("e and ⇧E leave the board alone while you work in the panel beside it", async ({ page }) => {
    await openBoard(page);
    await holdBoard(page);
    const card = page.locator("section.group--working article.card").first();
    const href = (await card.locator("a.card-link").getAttribute("href"))!;
    await page.locator(`article.card a.card-link[href="${href}"]`).click({ modifiers: ["Shift"] });
    const panel = page.locator("aside.panel");
    await expect(panel).toHaveClass(/panel--open/);
    // Working in the panel: focus on one of its controls, with the board's cursor still set.
    await panel.getByRole("button", { name: "Close panel" }).focus();
    expect(await page.evaluate(() => !!document.activeElement?.closest("aside.panel"))).toBe(true);
    await expect(page.locator("article.card[aria-current='true']")).toHaveCount(1);
    const hiddenStore = () => page.evaluate(() => JSON.parse(localStorage.getItem("sessionpipe-gui.hidden") ?? "{}"));
    await page.keyboard.press("e");
    await page.keyboard.press("Shift+E");
    expect(await hiddenStore()).toEqual({});
    await expect(page.locator('.toast[data-toast="undo"]')).toHaveCount(0);
    await expect(page.locator("section.group--hidden")).toHaveCount(0);
    // Back on the board (focus off the panel), the same key hides the row under the cursor.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    expect(await page.evaluate(() => !!document.activeElement?.closest("aside.panel"))).toBe(false);
    await page.keyboard.press("e");
    await expect.poll(async () => Object.keys(await hiddenStore()).length).toBe(1);
    await expect(page.locator('.toast[data-toast="undo"]')).toContainText("Hidden");
  });

  test("Esc clears the search first, then the cursor", async ({ page }) => {
    await openBoard(page);
    const search = page.getByRole("searchbox", { name: "Search sessions" });
    await search.fill("a");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("j");
    await expect(page.locator("article.card[aria-current='true']")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await expect(page.locator("article.card[aria-current='true']")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("article.card[aria-current='true']")).toHaveCount(0);
    // A third goes nowhere: the board is a place, not a step.
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("section.group").first()).toBeVisible();
  });

  test("the Hidden header has its own menu, as Done's does, not the board's", async ({ page }) => {
    await openBoard(page);
    await page.locator("section.group--working article.card a.card-link").first().focus();
    await page.keyboard.press("Shift+E");
    const toggle = page.locator("section.group--hidden button.group-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click({ button: "right" });
    const item = page.getByRole("menuitemcheckbox", { name: "Show hidden sessions" });
    await expect(item).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("menuitemcheckbox", { name: "Show done sessions" })).toHaveCount(0);
    await item.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
