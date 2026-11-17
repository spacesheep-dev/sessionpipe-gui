// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Subagents first-class (ORGANIZE-SPEC.md §4.7), on the demo's "Search: review the BM25
// cache": three agents inside one session (two in the background, one in the
// foreground). The board's parent row says how many run and opens to its agents on the
// tree guide; the session view puts each agent's block under the turn that spawned it,
// its tools inside, and reads Claude Code's <task-notification> turns as "Subagent
// finished"; an agent opens beside as a tab right after its parent's; the palette lists
// agents under their session and `is:subagent` keeps only them. Parents of the test's own
// show when a tree opens by itself (only while an agent runs), how a phone folds the
// finished agents (but for those a search found), and the chevron's 44 pt target.
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { EVENTS, holdBoard, INFO, openBoard, openPage, ulid } from "./helpers.js";

const TITLE = "Search: review the BM25 cache";
const parent = (page: Page) => page.locator("article.card", { hasText: TITLE }).first();

/** The BM25 row on the board (the done group opened when it ended a while ago). `live`
 *  moves the pointer off the list afterwards: the board holds still under it, and a new
 *  run of the scene would wait there. */
async function bm25(page: Page, { live = false } = {}) {
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
  if (live) await page.mouse.move(5, 5);
  return parent(page);
}

/** A parent session of the test's own, sent as a sink would, with `running` agents still
 *  at work, `quiet` ones and `finished` ones. A quiet parent's events are all 30 minutes
 *  old (it and its open agents read stale); one with no open agent ended its turn (idle).
 *  `scouts` are finished agents of a type of its own (for a search), older than the other
 *  finished ones; `tool` leaves the parent's Agent call running with nothing on line 2. */
async function postParent(
  page: Page,
  o: { running?: number; quiet?: number; finished: number; scouts?: number; tool?: boolean },
): Promise<{ title: string; scout: string; row: ReturnType<Page["locator"]> }> {
  const { sinkToken } = (await (await page.request.get(INFO)).json()) as { sinkToken: string };
  const id = randomUUID();
  const title = `E2E tree ${id.slice(0, 8)}`;
  const quiet = (o.quiet ?? 0) > 0;
  let clock = Date.now() - (quiet ? 30 * 60_000 : 2 * 60_000);
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>, hook: string) => {
    clock += 1000;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 1,
      harness: { name: "claude-code", version: "2.1.296", event: hook },
      session: { id, seq: seq++, machine: "e2e-box", cwd: "~/code/e2e", title, title_source: "custom" },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const scout = `Scout${id.slice(0, 6)}`;
  const start = (n: string, t = "general-purpose") =>
    ev("subagent.started", { agent_type: t, agent_id: n }, "SubagentStart");
  const stop = (n: string, t = "general-purpose") =>
    ev("subagent.ended", { agent_type: t, agent_id: n }, "SubagentStop");
  const events = [
    ev("session.started", { source: "startup" }, "SessionStart"),
    ev("turn.started", { turn_id: "t1", prompt_chars: 40 }, "UserPromptSubmit"),
  ];
  for (let i = 0; i < (o.scouts ?? 0); i++) events.push(start(`scout${i}`, scout), stop(`scout${i}`, scout));
  for (let i = 0; i < o.finished; i++) events.push(start(`done${i}`), stop(`done${i}`));
  if (o.tool) events.push(ev("tool.started", { tool: "Agent", call_id: "toolu_e2e", turn_id: "t1" }, "PreToolUse"));
  for (let i = 0; i < (o.quiet ?? 0); i++) events.push(start(`quiet${i}`));
  for (let i = 0; i < (o.running ?? 0); i++) events.push(start(`run${i}`));
  if (!quiet && !o.running) events.push(ev("turn.ended", { turn_id: "t1", reason: "stop", ms: 3000 }, "Stop"));
  const res = await page.request.post(EVENTS, {
    headers: { authorization: `Bearer ${sinkToken}` },
    data: { events },
  });
  expect(res.status()).toBe(202);
  return { title, scout, row: page.locator("article.card", { hasText: title }) };
}

test.describe("subagents", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project only");

  test("the parent says how many run and opens to its agents on the tree guide", async ({ page }) => {
    test.setTimeout(90_000);
    const row = await bm25(page, { live: true });
    // The scene comes back every few seconds at the suite's speed: catch it with agents running.
    await expect(row.locator(".card-agents")).toHaveText(/^\d+ subagents? running$/, { timeout: 60_000 });
    // Open while an agent runs: the rows on the tree guide, glyph · Type · description · now.
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

  test("a parent whose agents went quiet stays folded and says nothing of them", async ({ page }) => {
    const { row } = await postParent(page, { quiet: 2, finished: 5 });
    await openBoard(page);
    const disclose = row.locator("button.card-disclose");
    await expect(row).toHaveClass(/card--stale/);
    await expect(disclose).toHaveAttribute("aria-expanded", "false");
    await expect(row.locator("li[data-agent]")).toHaveCount(0);
    // No "2 subagents · 2 quiet" on the board: none of them runs.
    await expect(row.locator(".card-agents")).toHaveCount(0);
    // Opened by hand: the quiet ones, the three newest finished, and "Show 2 more" at its
    // own 28 px (a mouse needs no 44); the chevron's touch box is a coarse pointer's only.
    await disclose.click();
    await expect(row.locator("li[data-agent]")).toHaveCount(5);
    const more = row.locator(".kid-more-btn");
    await expect(more).toHaveText("Show 2 more");
    expect(Math.round((await more.boundingBox())!.height)).toBe(28);
    expect(await disclose.evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");
  });

  test("a search for an agent's description finds its parent, open", async ({ page }) => {
    await bm25(page);
    await page.getByRole("searchbox", { name: "Search sessions" }).fill("hot path");
    // The run may end meanwhile and go under the folded done group: open it then.
    const done = page.locator("section.group--done button.group-toggle");
    await expect
      .poll(async () => {
        if ((await parent(page).count()) === 0 && (await done.getAttribute("aria-expanded")) === "false")
          await done.click();
        return parent(page).isVisible();
      })
      .toBe(true);
    await expect(
      parent(page).locator(".agent-desc", { hasText: "Profile the scoring hot path" }).first(),
    ).toBeVisible();
  });

  test("the session view puts each agent under its turn and reads the notifications", async ({ page }) => {
    // The demo's background agents report back on their own clock: slower on a loaded runner.
    test.setTimeout(150_000);
    const row = await bm25(page);
    const href = (await row.locator("a.card-link").getAttribute("href"))!;
    // Wait for a run with both background agents back (their notification turns).
    await expect
      .poll(
        async () => {
          await openPage(page, href.split("?")[0]!);
          return page.locator(".agent-notice").count();
        },
        { timeout: 120_000, intervals: [2000] },
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
    // One run of the scene by its key: a newer run may come in above it meanwhile.
    const key = await (await bm25(page)).getAttribute("data-flip");
    const row = page.locator(`article.card[data-flip="${key}"]`);
    // The parent's tab first, then one of its agents, on a board held still under the pointer.
    // Clicks dispatched on the element, as split.spec does: what this checks is the tabs and the
    // URL, and a live card's height (its counts, its agents) keeps a pointer chasing it on CI.
    await holdBoard(page);
    const press = (l: ReturnType<typeof page.locator>, shiftKey = false) =>
      l.dispatchEvent("click", { bubbles: true, cancelable: true, button: 0, shiftKey });
    await press(row.locator("a.card-link"), true);
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    const disclose = row.locator("button.card-disclose");
    if ((await disclose.getAttribute("aria-expanded")) === "false") await press(disclose);
    await expect(row.locator(".agent-row").first()).toBeVisible();
    await press(row.locator(".agent-row").first());
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

/** How far the chevron's middle sits from the glyph's, in px. */
const chevronOff = (row: ReturnType<Page["locator"]>) =>
  row.locator(".card-row").evaluate((r) => {
    const mid = (q: string) => {
      const b = r.querySelector(q)!.getBoundingClientRect();
      return b.y + b.height / 2;
    };
    return Math.abs(mid(".card-disclose svg") - mid(".card-state .dot"));
  });

// The desktop project's file (the phone project does not run it), with a phone of its own.
test.describe("subagents on a phone", () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });

  test("a working parent shows its running agent and one 44 pt row for the finished ones", async ({ page }) => {
    const { title, row } = await postParent(page, { running: 1, finished: 19 });
    await openBoard(page);
    // The board filtered to this row: the demo's rows (and other tests') never move it.
    await page.getByRole("searchbox", { name: "Search sessions" }).fill(title);
    await expect(page.locator("article.card")).toHaveCount(1);
    const disclose = row.locator("button.card-disclose");
    await expect(disclose).toHaveAttribute("aria-expanded", "true");
    await expect(row.locator("ul.card-kids > li")).toHaveCount(2);
    await expect(row.locator("li[data-agent]")).toHaveCount(1);
    const more = row.locator(".kid-more-btn");
    await expect(more).toHaveText("Show 19 finished");
    expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // The chevron's target is the row's leading 44 pt, from the screen's edge to the title,
    // on the chevron's line.
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const line = row.locator(".card-row");
    // The chevron sits level with the glyph, whether line 2 shows the fact or nothing.
    expect(await chevronOff(row)).toBeLessThanOrEqual(1.5);
    const { x0, y, hits } = await line.evaluate((r) => {
      const svg = r.querySelector(".card-disclose svg")!.getBoundingClientRect();
      const y = svg.y + svg.height / 2;
      const hit = (x: number) => {
        const e = document.elementFromPoint(x, y);
        return e?.closest(".card-disclose") ? "chevron" : e?.closest(".card-link") ? "row" : String(e?.className);
      };
      const box = r.getBoundingClientRect();
      return { x0: box.x, y: y - box.y, hits: [1, 22, 43, 60].map(hit) };
    });
    expect(hits).toEqual(["chevron", "chevron", "chevron", "row"]);
    const tapAt = (x: number) => line.tap({ position: { x: x - x0, y } });
    // A tap on the glyph folds the tree and stays on the board.
    const board = page.url();
    await tapAt(22);
    await expect(disclose).toHaveAttribute("aria-expanded", "false");
    await expect(row.locator("li[data-agent]")).toHaveCount(0);
    expect(page.url()).toBe(board);
    // Folded, the row says what runs, on line 2.
    await expect(row.locator(".card-agents")).toHaveText("1 subagent running");
    await expect(row.locator(".card-agents")).not.toHaveClass(/sr-only/);
    expect(await chevronOff(row)).toBeLessThanOrEqual(1.5);
    await tapAt(22);
    await expect(disclose).toHaveAttribute("aria-expanded", "true");
    // "Show 19 finished" lists every one in place.
    await more.tap();
    await expect(row.locator("li[data-agent]")).toHaveCount(20);
    await expect(row.locator(".kid-more-btn")).toHaveCount(0);
    // The title, right of the chevron's target, opens the session.
    await tapAt(60);
    await expect(page).toHaveURL(/\/s\/claude-code\//);
  });

  test("a tree opened by hand with nothing running shows the three newest finished", async ({ page }) => {
    const { title, row } = await postParent(page, { finished: 20 });
    await openBoard(page);
    await page.getByRole("searchbox", { name: "Search sessions" }).fill(title);
    const disclose = row.locator("button.card-disclose");
    await expect(disclose).toHaveAttribute("aria-expanded", "false");
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await disclose.tap();
    await expect(disclose).toHaveAttribute("aria-expanded", "true");
    await expect(row.locator("li[data-agent]")).toHaveCount(3);
    await expect(row.locator(".kid-more-btn")).toHaveText("Show 17 more");
  });

  test("a search lists the finished agents it found, and the chevron stays level over a tool", async ({ page }) => {
    // One agent running, three finished, and two finished before them of a type the search finds.
    const { scout, row } = await postParent(page, { running: 1, finished: 3, scouts: 2, tool: true });
    await openBoard(page);
    await page.getByRole("searchbox", { name: "Search sessions" }).fill(scout);
    await expect(page.locator("article.card")).toHaveCount(1);
    await expect(row.locator("button.card-disclose")).toHaveAttribute("aria-expanded", "true");
    // The running one and the two it found, older than the three left under "Show 3 more".
    await expect(row.locator("li[data-agent]")).toHaveCount(3);
    const found = row.locator("li[data-agent] .agent-type", { hasText: scout });
    await expect(found).toHaveCount(2);
    await expect(found.first()).toBeVisible();
    await expect(row.locator(".kid-more-btn")).toHaveText("Show 3 more");
    // Line 2 is the tool it runs and nothing else (the fact is a screen reader's while the
    // tree is open), and the row has three lines: the chevron moves up with line 1.
    await expect(row.locator(".card-tool")).toBeVisible();
    await expect(row.locator(".card-text, .card-attn")).toHaveCount(0);
    await expect(row.locator(".card-agents")).toHaveClass(/sr-only/);
    expect(await chevronOff(row)).toBeLessThanOrEqual(1.5);
  });
});
