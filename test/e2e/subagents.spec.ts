// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Subagents first-class (ORGANIZE-SPEC.md §4.7), on the demo's "Search: review the BM25
// cache": three agents inside one session (two in the background, one in the
// foreground). The board's parent row says how many run and opens to its agents on the
// tree guide; the session view puts each agent's block under the turn that spawned it,
// its tools inside, and reads Claude Code's <task-notification> turns as "Subagent
// finished"; an agent opens beside as a tab right after its parent's; the palette lists
// agents under their session and `is:subagent` keeps only them.
import { expect, type Page, test } from "@playwright/test";
import { openBoard, openPage } from "./helpers.js";

const TITLE = "Search: review the BM25 cache";
const parent = (page: Page) => page.locator("article.card", { hasText: TITLE }).first();

/** The BM25 row on the board (the done group opened when it ended a while ago). */
async function bm25(page: Page) {
  await openBoard(page);
  const done = page.locator("section.group--done button.group-toggle");
  await expect
    .poll(
      async () => {
        if ((await parent(page).count()) > 0) return true;
        if ((await done.count()) > 0 && (await done.getAttribute("aria-expanded")) === "false") await done.click();
        return (await parent(page).count()) > 0;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return parent(page);
}

test.describe("subagents", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project only");

  test("the parent says how many run and opens to its agents on the tree guide", async ({ page }) => {
    test.setTimeout(90_000);
    const row = await bm25(page);
    // The scene comes back every few seconds at the suite's speed: catch it with agents running.
    await expect(row.locator(".card-agents")).toHaveText(/^\d+ subagents? (running|· \d+ quiet)$/, { timeout: 60_000 });
    // Open while any agent is open: the rows on the tree guide, glyph · Type · description · now.
    const disclose = row.locator("button.card-disclose");
    await expect(disclose).toHaveAttribute("aria-expanded", "true");
    // Three agents per run (the third is launched a moment after the first two).
    const agents = row.locator("ul.card-kids > li[data-agent]");
    await expect.poll(() => agents.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await expect(row.locator(".agent-row .agent-type").first()).toHaveText(/^(Explore|general-purpose)$/);
    await expect(row.locator(".agent-row .agent-desc", { hasText: "Check cache invalidation" }).first()).toBeVisible();
    await expect(row.locator(".agent-row .agent-now").first()).toHaveText(/\S/);
    // A click on the chevron folds them, and the choice holds.
    await disclose.click();
    await expect(disclose).toHaveAttribute("aria-expanded", "false");
    await expect(row.locator("li[data-agent]")).toHaveCount(0);
    await disclose.click();
    await expect(row.locator("li[data-agent]").first()).toBeVisible();
  });

  test("a search for an agent's description finds its parent, open", async ({ page }) => {
    await bm25(page);
    await page.getByRole("searchbox", { name: "Search sessions" }).fill("hot path");
    await expect(parent(page)).toBeVisible();
    await expect(
      parent(page).locator(".agent-desc", { hasText: "Profile the scoring hot path" }).first(),
    ).toBeVisible();
  });

  test("the session view puts each agent under its turn and reads the notifications", async ({ page }) => {
    test.setTimeout(90_000);
    const row = await bm25(page);
    const href = (await row.locator("a.card-link").getAttribute("href"))!;
    // Wait for a run with both background agents back (their notification turns).
    await expect
      .poll(
        async () => {
          await openPage(page, href.split("?")[0]!);
          return page.locator(".agent-notice").count();
        },
        { timeout: 60_000, intervals: [2000] },
      )
      .toBeGreaterThanOrEqual(2);
    await expect(page.locator(".agent-notice").first()).toContainText(/^Subagent finished: (Explore|general-purpose)/);
    // The three blocks of a run sit in one turn, the launching calls their heads.
    const turn = page.locator("li.turn", { has: page.locator(".agent-block") }).first();
    await expect(turn.locator(".agent-block")).toHaveCount(3);
    await expect(turn.locator(".agent-block .agent-type").first()).toBeVisible();
    // No "subagent" chip on a tool row any more: the block says it.
    await expect(page.locator(".tool-agent")).toHaveCount(0);
    // A finished block opens to its tools and its result.
    const block = turn.locator(".agent-block", { hasText: "List untested cache paths" });
    const toggle = block.locator("button.agent-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    await expect(block.locator(".agent-items li.tool").first()).toBeVisible();
    await expect(block.locator(".agent-result")).toContainText("Result");
    // A notification goes to its block.
    await page.locator(".agent-notice-btn").first().click();
    await expect(page.locator(".agent-head[data-open], .agent-block.is-open").first()).toBeVisible();
  });

  test("?agent= opens the page on that agent's block", async ({ page }) => {
    const row = await bm25(page);
    const href = (await row.locator("a.card-link").getAttribute("href"))!.split("?")[0]!;
    await openPage(page, href);
    const id = await page.locator(".agent-block").first().getAttribute("data-agent");
    await openPage(page, `${href}?agent=${encodeURIComponent(id!)}`);
    const block = page.locator(`.agent-block[data-agent="${id}"]`);
    await expect(block.locator(".agent-head")).toHaveAttribute("data-open", "");
    await expect(block.locator("button.agent-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(block).toBeInViewport();
  });

  test("an agent opens beside as a tab right after its parent's", async ({ page }) => {
    const row = await bm25(page);
    // The parent's tab first, then one of its agents.
    await row.locator("a.card-link").click({ modifiers: ["Shift"] });
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    const disclose = row.locator("button.card-disclose");
    if ((await disclose.getAttribute("aria-expanded")) === "false") await disclose.click();
    await row.locator(".agent-row").first().click();
    const tabs = page.locator("aside.panel [role=tab]");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveClass(/tab--agent/);
    await expect(tabs.nth(1)).toHaveClass(/tab--paired/);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(1).locator(".tab-title")).toHaveText(/^(Explore|general-purpose)/);
    // The URL names the agent tab after its session's.
    const s = decodeURIComponent(new URL(page.url()).searchParams.get("s") ?? "").split(",");
    expect(s[1]).toBe(`${s[0]}#${s[1]!.split("#")[1]}`);
    // The head: the agent, the parent as the meta, and "Open parent beside" in ⋯.
    await expect(page.locator("aside.panel .panel-parent")).toHaveText(TITLE);
    await page.locator("aside.panel .panel-head").getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Open parent beside" })).toBeVisible();
    await page.keyboard.press("Escape");
    // The view inside is the session's, opened on that agent.
    await expect(page.locator("aside.panel .panel-body:not(.panel-body--off) .agent-head[data-open]")).toBeVisible();
  });

  test("the palette lists agents under their session; is:subagent keeps only them", async ({ page }) => {
    await bm25(page);
    await page.keyboard.press("ControlOrMeta+k");
    const pal = page.getByRole("dialog", { name: "Command palette" });
    await page.keyboard.type("is:subagent invalidation");
    const first = pal.locator(".pal-row").first();
    await expect(first.locator(".pal-label")).toContainText("Explore · Check cache invalidation");
    await expect(first.locator(".pal-detail")).toHaveText(TITLE);
    await page.keyboard.press("Enter");
    await expect(pal).toBeHidden();
    await expect(page.locator("aside.panel [role=tab].tab--agent, aside.panel .panel-parent").first()).toBeVisible();
  });
});
