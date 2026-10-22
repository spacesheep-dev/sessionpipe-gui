// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The board as a person sees it: groups by state, a working card's current tool, an
// attention banner when the demo asks for a permission, the collapsed done group,
// live counts without a reload, and the keyboard.
import { expect, test } from "@playwright/test";
import { openBoard } from "./helpers.js";

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
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/s\/[^/]+\/.+/);
    await expect(page.locator("h1.sess-title")).toBeVisible();
  });
});
