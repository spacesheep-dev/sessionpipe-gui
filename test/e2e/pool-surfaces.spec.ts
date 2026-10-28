// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The pool's smaller surfaces (UX-SPEC §6, §7), on the demo: the session lab-mac's pool
// moved from Spacesheep's login to Misha's says "Served by Misha since …" under its bar
// and marks the switch once in the chat and in the timeline; New session's Agent menu
// reads lab-mac's pool (the count, the current account's window); the sidebar glances a
// pooled machine as one line, its accounts nowhere else, with the others in the tooltip;
// Machines says "pooled" only while the switch is on. The phone sees the same rows.
import { expect, type Page, test } from "@playwright/test";
import { openPage, sessionUrl } from "./helpers.js";

const SETTINGS_KEY = "sessionpipe-gui.settings";

/** The demo's pooled session (sim.ts poolScene): the one asking about the `--sink` flag. */
async function poolSession(page: Page): Promise<{ harness: string; id: string }> {
  await expect
    .poll(
      async () => {
        const snap = (await (await page.request.get("/api/ui/snapshot")).json()) as {
          sessions: { harness: string; id: string; title?: string; servedBy?: unknown }[];
        };
        return snap.sessions.find((s) => s.title?.includes("--sink") && s.servedBy) ?? null;
      },
      { timeout: 20_000, message: "the demo's pooled session, once another account serves it" },
    )
    .not.toBeNull();
  const snap = (await (await page.request.get("/api/ui/snapshot")).json()) as {
    sessions: { harness: string; id: string; title?: string }[];
  };
  const s = snap.sessions.find((x) => x.title?.includes("--sink"))!;
  return { harness: s.harness, id: s.id };
}

/** Simple mode (the chat) for this page alone; the suite's storage state says advanced. */
const chatMode = (page: Page) =>
  page.addInitScript(([k]) => localStorage.setItem(k, JSON.stringify({ mode: "simple" })), [SETTINGS_KEY] as const);

test.describe("session page", () => {
  test("says who serves it, and the timeline marks the switch once", async ({ page }) => {
    const s = await poolSession(page);
    await openPage(page, sessionUrl(s.harness, s.id));
    const note = page.locator(".page-note[data-served]");
    await expect(note).toHaveText(/^Served by Misha since \d{2}:\d{2}$/);
    await expect(note.locator("a")).toHaveAttribute("href", /#pool%3Alab-mac$/);
    await expect(note.locator("time")).toHaveAttribute("title", /\d/);
    const rows = page.locator(".timeline [data-swap]");
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveText("Switched to Misha: Spacesheep's 5 hours are used up");
    await expect(rows).toHaveClass(/marker/);
    // No card, no colour: the row is a marker like any quiet one.
    await expect(rows.locator(".card, .chat-bubble")).toHaveCount(0);
    // The note's link opens the machine's accounts on Usage.
    await note.locator("a").click();
    await expect(page).toHaveURL(/\/usage#pool%3Alab-mac$/);
  });

  test("the chat shows the swap as a note in the turn it fell in", async ({ page }) => {
    await chatMode(page);
    const s = await poolSession(page);
    await openPage(page, sessionUrl(s.harness, s.id));
    await expect(page.locator(".session[data-ui=simple]")).toBeVisible();
    await expect(page.locator(".page-note[data-served]")).toHaveText(/^Served by Misha since \d{2}:\d{2}$/);
    const rows = page.locator(".chat-note[data-swap]");
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveText("Switched to Misha: Spacesheep's 5 hours are used up");
    // Inside the first turn, after that turn's reply.
    const turn = page.locator("li.turn--chat").filter({ has: rows });
    await expect(turn).toHaveCount(1);
    await expect(turn.locator(".chat-you")).toContainText("--sink");
    const reply = await turn.locator(".chat-ai .md, .chat-ai .reply").first().boundingBox();
    const row = await rows.boundingBox();
    expect(row!.y).toBeGreaterThan(reply!.y);
  });

  test("a session the pool never moved has no note", async ({ page }) => {
    const snap = (await (await page.request.get("/api/ui/snapshot")).json()) as {
      sessions: { harness: string; id: string; title?: string; servedBy?: unknown; machine?: string }[];
    };
    const other = snap.sessions.find(
      (s) => s.harness === "claude-code" && !s.servedBy && !s.title?.includes("--sink"),
    )!;
    await openPage(page, sessionUrl(other.harness, other.id));
    await expect(page.locator("h1.sess-title")).toBeVisible();
    await expect(page.locator(".page-note[data-served]")).toHaveCount(0);
    await expect(page.locator("[data-swap]")).toHaveCount(0);
  });
});

test("New session on lab-mac: Claude Code reads the pool, the other agents their own", async ({ page }) => {
  await openPage(page, "/?new=1&machine=lab-mac");
  const sheet = page.locator("[data-new-session]");
  await expect(sheet.locator("[data-ns-row=machine] button.sel")).toHaveText(/lab-mac/);
  await sheet.locator("[data-ns-row=agent] button.sel").click();
  const opt = (name: string) => page.locator(".sel-opt", { hasText: name });
  const claude = opt("Claude Code");
  await expect(claude.locator(".sel-opt-detail")).toHaveText(/^3 accounts, 2 with room · Misha(, .+, resets in .+)?$/);
  // The line wraps like a caption (no time alone on the last line), and an account's
  // email, which has no break in it, folds inside the list instead of running past it.
  const detail = claude.locator(".sel-opt-detail");
  await expect(detail).toHaveCSS("text-wrap", "pretty");
  expect(
    await detail.evaluate((d) => {
      const was = d.textContent;
      d.textContent = (was ?? "").replace(/· [^,]+/, "· firstname.lastname.longer@examplecompany.com");
      const fits = d.scrollWidth <= d.clientWidth;
      d.textContent = was;
      return fits;
    }),
  ).toBe(true);
  // Misha's own numbers come from the demo's status line, which moves; the shape holds.
  const hint = claude.locator(".sel-opt-hint");
  if (await hint.count()) await expect(hint).toHaveText(/^((<1|\d+)% left|None left|\d+% over|Reset)$/);
  await expect(opt("Codex").locator(".sel-opt-detail")).toHaveText(/^This week, resets in /);
  await expect(opt("Gemini CLI").locator(".sel-opt-detail")).toHaveCount(0);
  await expect(claude).not.toHaveAttribute("aria-disabled", "true");
  await claude.click();
  await expect(sheet.locator("[data-ns-row=agent] button.sel")).toHaveAttribute("data-value", "claude-code");
  await expect(sheet.locator("[data-ns-left]")).toHaveText(/^((<1|\d+)% left|None left|\d+% over|Reset)$/);
  // Start is never blocked by the pool: with a message, the one thing that can still hold
  // it on this port is the origin (sending works from the localhost address alone).
  await sheet.locator("textarea").first().fill("Say hello.");
  const start = sheet.getByRole("button", { name: "Start" });
  if (await start.isDisabled()) await expect(sheet).toContainText("Sending works from");
  else await expect(start).toBeEnabled();
});

test("New session on a machine with the pool off keeps the login's own line", async ({ page }) => {
  await openPage(page, "/?new=1&machine=desk-pc");
  const sheet = page.locator("[data-new-session]");
  await expect(sheet.locator("[data-ns-row=machine] button.sel")).toHaveText(/desk-pc/);
  await sheet.locator("[data-ns-row=agent] button.sel").click();
  const claude = page.locator(".sel-opt", { hasText: "Claude Code" });
  await expect(claude).toBeVisible();
  await expect(claude.locator(".sel-opt-detail")).not.toHaveText(/accounts, .* with room/);
});

test("the sidebar glances a pooled machine once, its accounts nowhere else", async ({ page }) => {
  await openPage(page, "/");
  const block = page.locator(".glance");
  await expect(block).toBeVisible();
  const lab = block.locator('.glance-line[data-glance="pool:lab-mac"]');
  await expect(lab).toHaveCount(1);
  await expect(lab.locator(".glance-name")).toHaveText("Misha");
  await expect(lab.locator(".glance-val")).toHaveText(/^(5h|week|week \w+) ((<1|\d+)% left|None left)$|^Reset$/);
  await expect(lab).toHaveAttribute("data-tip", /Misha, Claude Code on lab-mac, in use\./);
  await expect(lab).toHaveAttribute("data-tip", /Fiction has room\./);
  await expect(lab).toHaveAttribute("data-tip", /Spacesheep is used up, resets in \d+ h \d+ m\./);
  await expect(lab).toHaveAttribute("href", /#pool%3Alab-mac$/);
  // mini-mac pools Misha too (in error there) and serves with Work, whose numbers the
  // hello carries (its idle windows feed its entry).
  const mini = block.locator('.glance-line[data-glance="pool:mini-mac"]');
  await expect(mini).toHaveCount(1);
  await expect(mini.locator(".glance-name")).toHaveText("Work");
  await expect(mini.locator(".glance-val")).toHaveText(/^5h \d+% left$/);
  await expect(mini).toHaveAttribute("data-tip", /Misha needs to sign in again\./);
  await expect(mini).toHaveAttribute("data-tip", /Old is off\./);
  // Misha's and Spacesheep's own lines are gone; the account on another API keeps its own.
  await expect(block.locator(".glance-line", { hasText: /^dev\b/ })).toHaveCount(0);
  await expect(block.locator(".glance-line", { hasText: /^spacesheep/ })).toHaveCount(0);
  await expect(block.locator('.glance-line[data-glance^="pool:"]')).toHaveCount(2);
  // The menu offers the machine's accounts; the click opens them.
  await lab.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open lab-mac's accounts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await lab.click();
  await expect(page).toHaveURL(/\/usage#pool%3Alab-mac$/);
});

test("Machines says pooled only while the switch is on", async ({ page }) => {
  await openPage(page, "/machines");
  const lab = page.locator("section.machine[aria-label='lab-mac'] .machine-accounts");
  await expect(lab).toContainText("dev@example.com · Claude Code, pooled");
  await expect(lab).toContainText("fiction@example.com · Claude Code, pooled");
  await expect(lab).toContainText("api.z.ai · Claude Code, API");
  await expect(lab).not.toContainText("API, pooled");
  const desk = page.locator("section.machine[aria-label='desk-pc'] .machine-accounts");
  await expect(desk).toContainText("dev@example.com · Claude Code");
  await expect(desk).not.toContainText("pooled");
  // Never the account id.
  await expect(page.locator(".machine-accounts [title]")).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test("the session page keeps the note and the swap row, nothing scrolls sideways", async ({ page }) => {
    await chatMode(page);
    const s = await poolSession(page);
    await openPage(page, sessionUrl(s.harness, s.id));
    await expect(page.locator(".page-note[data-served]")).toHaveText(/^Served by Misha since \d{2}:\d{2}$/);
    const row = page.locator(".chat-note[data-swap]");
    await expect(row).toHaveText("Switched to Misha: Spacesheep's 5 hours are used up");
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(wide).toBeLessThanOrEqual(0);
  });

  test("New session's sheet shows the pooled line", async ({ page }) => {
    await openPage(page, "/?new=1&machine=lab-mac");
    const sheet = page.locator("[data-new-session]");
    await sheet.locator("[data-ns-row=agent] button.sel").click();
    const claude = page.locator(".sel-opt", { hasText: "Claude Code" });
    await expect(claude.locator(".sel-opt-detail")).toHaveText(/^3 accounts, 2 with room · Misha(, .+)?$/);
  });
});
