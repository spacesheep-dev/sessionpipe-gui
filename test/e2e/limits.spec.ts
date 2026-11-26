// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Usage limits: what each account has left, from limits.observed as the demo and a sink send
// it. The sidebar's lines (the wide sidebar only, none without numbers), the Usage page and
// its ways in (g u, ⌘K), a report changing both without a reload, New session's agent hints
// (two Claude Code accounts on lab-mac: no one number, each its own; Codex its own), the
// menus (Copy usage, Forget these numbers, Hide usage in the sidebar), Enter starting a
// session, a long name in the sidebar, a short window, and storage that throws. The
// phone's More › Usage is in mobile.spec.ts.
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { CONTROL_BASE, seenSetupHere } from "./control-helpers.js";
import { EVENTS, INFO, openPage, ulid } from "./helpers.js";

// One demo receiver for the file: a report or a Forget here must not race another test's read.
test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => !!isMobile, "desktop project; the phone's page is in mobile.spec.ts");
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const tag = () => randomUUID().slice(0, 8);
const section = (page: Page, key: string) => page.locator(`section.usage-acct[data-account="${key}"]`);
const glance = (page: Page, key: string) => page.locator(`.glance-line[data-glance="${key}"]`);

/** One Claude Code status line report from an account no hello names, on its own machine;
 *  with `fable`, this week's Fable window too. */
async function report(
  page: Page,
  o: { account: string; machine: string; fiveHour: number; fable?: number; seq?: number; at?: number },
): Promise<void> {
  const { sinkToken } = (await (await page.request.get(INFO)).json()) as { sinkToken: string };
  const t = o.at ?? Date.now() - 2000;
  const res = await page.request.post(EVENTS, {
    headers: { "content-type": "application/json", authorization: `Bearer ${sinkToken}`, "sessionpipe-protocol": "1" },
    data: {
      events: [
        {
          protocol: 1,
          id: ulid(t),
          type: "limits.observed",
          time: new Date(t).toISOString(),
          tier: 1,
          harness: { name: "claude-code", version: "2.1.296", event: "StatusLine" },
          session: { id: `limits-${o.account}`, seq: o.seq ?? 0, machine: o.machine, account_id: o.account },
          privacy: { rulesets: ["secrets@1"], pii: false },
          data: {
            windows: [
              {
                id: "five_hour",
                used_percent: o.fiveHour,
                window_minutes: 300,
                resets_at: new Date(t + 2 * H + 30 * MIN).toISOString(),
              },
              {
                id: "seven_day",
                used_percent: 20,
                window_minutes: 10_080,
                resets_at: new Date(t + 3 * D).toISOString(),
              },
              ...(o.fable === undefined
                ? []
                : [
                    {
                      id: "seven_day_fable",
                      used_percent: o.fable,
                      window_minutes: 10_080,
                      resets_at: new Date(t + 3 * D).toISOString(),
                    },
                  ]),
            ],
          },
        },
      ],
    },
  });
  expect(res.status()).toBe(202);
  expect(((await res.json()) as { accepted: number }).accepted).toBe(1);
}

test("the sessions column's foot says, in one line, the account with the least left", async ({ page }) => {
  await openPage(page, "/");
  const block = page.locator(".tree-col .usage-line");
  await expect(block).toBeVisible();
  // One line of all the accounts: studio-mac's, none left, wins over any with some left.
  const line = block.locator(".glance-line");
  await expect(line).toHaveCount(1);
  await expect(line.locator(".glance-name")).toHaveText(/^studio-mac/);
  await expect(line.locator(".glance-out")).toHaveText("None left");
  // One line: no bar and no reset line under it (its tooltip says when it resets).
  await expect(line.locator(".glance-bar")).toHaveCount(0);
  await expect(line.locator(".glance-sub")).toHaveCount(0);
  await expect(block).not.toContainText("used");
  // The line is the way in, so there is no Usage row in the rail beside it.
  await expect(page.locator(".rail-nav [data-nav=usage]")).toHaveCount(0);

  // With no column beside the rail there is no line: Usage is a row there, after Machines.
  await page.setViewportSize({ width: 860, height: 800 });
  await expect(page.locator(".usage-line")).toHaveCount(0);
  const row = page.locator(".rail-nav > a[data-nav=usage]");
  await expect(row).toBeVisible();
  await expect(page.locator(".rail-nav > a[data-nav=machines] + a")).toHaveAttribute("data-nav", "usage");
  await expect(row).toHaveAttribute("data-tip", /^Usage {3}G U$/i);
  await row.click();
  await expect(page).toHaveURL(/\/usage$/);
  await expect(row).toHaveAttribute("aria-current", "page");
});

/** Watches the sidebar from navigation on: whether its first drawn list (the app's, not the
 *  boot frame's) had a Usage row, and whether one was ever there before the lines were. */
async function watchUsageRow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { usageRow: { first: boolean | null; early: boolean } };
    w.usageRow = { first: null, early: false };
    let lines = false;
    const look = () => {
      const row = !!document.querySelector(".rail-nav [data-nav=usage]");
      if (w.usageRow.first === null && document.querySelector(".rail-nav a[data-nav]")) w.usageRow.first = row;
      lines ||= !!document.querySelector(".glance, .usage-line");
      if (!lines && row) w.usageRow.early = true;
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  });
}
const usageRow = (page: Page) =>
  page.evaluate(() => (window as unknown as { usageRow: { first: boolean | null; early: boolean } }).usageRow);

test("Usage is drawn once: no row the lines then replace, and with the lines hidden the row from the start", async ({
  page,
}) => {
  // The first snapshot comes 300 ms late, as from a receiver far away: the store has no
  // numbers until then, and the sidebar must not take that for "none".
  await page.route("**/api/ui/stream", async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });
  await watchUsageRow(page);
  // A first visit, then a reload that remembers there were numbers.
  for (const go of [() => openPage(page, "/"), () => page.reload()]) {
    await go();
    await expect(page.locator(".glance-line").first()).toBeVisible({ timeout: 15_000 });
    expect(await usageRow(page)).toEqual({ first: false, early: false });
  }

  // With the lines hidden, the row is there from the app's first frame.
  await page.evaluate(() => {
    const key = "sessionpipe-gui.settings";
    localStorage.setItem(
      key,
      JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || "{}"), usageInSidebar: false }),
    );
  });
  await page.reload();
  await expect(page.locator(".rail-nav > a[data-nav=usage]")).toBeVisible({ timeout: 15_000 });
  expect((await usageRow(page)).first).toBe(true);
  // A stream still waiting out its 300 ms when the test ends is no failure.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("with no numbers there is no sidebar block, and the page says how to get them", async ({ context, page }) => {
  // The control instance runs no demo and no hello there names an account.
  await seenSetupHere(context);
  await page.goto(`${CONTROL_BASE}/usage`);
  await expect(page.locator(".state-title")).toHaveText("No limits yet");
  await expect(page.locator(".cmdwell")).toContainText("sessionpipe install --status-line");
  await expect(page.locator(".bar")).not.toContainText("account");
  await expect(page.locator(".glance, .usage-line")).toHaveCount(0);
});

test("g u and ⌘K open Usage: every window named honestly, and nothing for a harness with no source", async ({
  page,
}) => {
  await openPage(page, "/");
  await page.keyboard.press("g");
  await page.keyboard.press("u");
  await expect(page).toHaveURL(/\/usage$/);

  await openPage(page, "/");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("limits");
  await page.locator("[role=option]", { hasText: "what each account has left" }).click();
  await expect(page).toHaveURL(/\/usage$/);

  const main = page.locator("#main");
  await expect(page.locator(".bar")).toContainText(/\d+ accounts?/);
  await expect(main).toContainText("This week, all models");
  await expect(main).toContainText("This week, Fable only");
  await expect(main).toContainText("12% over");
  await expect(
    main.locator("section.usage-acct", { hasText: "Codex on build-box" }).locator(".usage-win--reset"),
  ).toHaveText(/^5 hoursReset \d+ m ago$/);
  await expect(main).toContainText("as of 3 h ago");
  const quiet = main.locator("section.usage-acct", { hasText: "No numbers yet" });
  await expect(quiet).toContainText("On build-box, in a terminal:");
  await expect(quiet.locator(".cmdwell")).toContainText("sessionpipe install --status-line");
  await expect(main.locator(".usage-note")).toContainText(/Gemini CLI.* don't report their limits\./);
  // Antigravity reports Gemini and Claude/GPT quota windows cleanly.
  const ag = main.locator("section.usage-acct", { hasText: "Antigravity on lab-mac" });
  await expect(ag).toContainText("Gemini, 5 hours");
  await expect(ag).toContainText("Claude & GPT, this week");
  // Never a figure for a harness with no source, never "used".
  await expect(main.locator("section.usage-acct", { hasText: "Gemini CLI" })).toHaveCount(0);
  await expect(main).not.toContainText("used");
  // The only colour is on the words that need it.
  await expect(main.locator(".usage-out")).toHaveText(["12% over", "None left"]);
  // Within a harness, the accounts with numbers first, the ones a hello names before the
  // rest, then those with none: the page never opens on a setup block. (dev@example.com is
  // pooled on lab-mac and drawn in that section, pool.spec.ts.)
  const order = await main
    .locator("section.usage-acct")
    .evaluateAll((els) =>
      els.map(
        (el) => `${el.querySelector(".usage-title")?.textContent}${el.querySelector(".usage-win") ? "" : " (none)"}`,
      ),
    );
  expect(order.slice(0, 3)).toEqual(["api.z.ai", "Claude Code account", "Claude Code account (none)"]);
});

test("a report updates the page without a reload, the sidebar keeps its one line; Copy usage and Forget", async ({
  page,
}) => {
  const account = `e2e-${tag()}`;
  const machine = `e2e-limits-${tag()}`;
  const key = `claude-code a:${account}`;
  await openPage(page, "/usage");
  await expect(section(page, key)).toHaveCount(0);

  await report(page, { account, machine, fiveHour: 43 });
  const s = section(page, key);
  await expect(s.locator(".usage-head")).toContainText("Claude Code account");
  await expect(s.locator(".usage-where")).toHaveText(`Claude Code on ${machine}`);
  await expect(s.locator('[data-window="five_hour"] .usage-value')).toHaveText("57% left");
  await expect(s.locator('[data-window="seven_day"] .usage-value')).toHaveText("80% left");
  // The sidebar's one line is the account with the least left (studio-mac's, none): not this.
  await expect(page.locator(".usage-line .glance-line")).toHaveCount(1);
  await expect(glance(page, key)).toHaveCount(0);

  // The next report is the whole set: none left now, on both, in the attention colour.
  await report(page, { account, machine, fiveHour: 100, seq: 1, at: Date.now() - 1000 });
  await expect(s.locator('[data-window="five_hour"] .usage-out')).toHaveText("None left");
  await expect(page.locator(".usage-line .glance-line")).toHaveCount(1);
  await expect(page.locator(".usage-line .glance-out")).toHaveText("None left");

  await s.locator(".usage-head").click({ button: "right" });
  const menu = page.getByRole("menu");
  // Not paired, so there is nowhere to start one; no setup command for an account with numbers.
  await expect(menu.getByRole("menuitem")).toHaveText(["Copy usage", "Forget these numbers"]);
  await menu.getByRole("menuitem", { name: "Copy usage" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(
    /^Claude Code account: 5 hours None left, resets in 2 h \d{2} m; This week, all models 80% left, resets in (2 d 23 h|3 d)$/,
  );

  await expect(page.getByRole("menu")).toHaveCount(0);
  // A second menu within 400 ms of the last one opening is taken for Android's own (ContextMenu.tsx).
  await page.waitForTimeout(450);
  await s.locator(".usage-head").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Forget these numbers" }).click();
  // Its numbers go; the account is still known from its session, so it says how to get them.
  await expect(section(page, key).locator(".usage-win")).toHaveCount(0);
  await expect(section(page, key)).toContainText("No numbers yet");
  await expect(glance(page, key)).toHaveCount(0);
});

test("New session on lab-mac: each agent says what its account has left there", async ({ page }) => {
  await openPage(page, "/?new=1&machine=lab-mac");
  const sheet = page.locator("[data-new-session]");
  await expect(sheet.locator("[data-ns-row=machine] button.sel")).toHaveText(/lab-mac/);
  await sheet.locator("[data-ns-row=agent] button.sel").click();
  const opt = (name: string) => page.locator(".sel-opt", { hasText: name });
  // lab-mac pools its Claude Code accounts with the switch on: a start there goes to the
  // pool's current account, so its line is the pool's (pool-surfaces.spec.ts has the rest).
  await expect(opt("Claude Code").locator(".sel-opt-detail")).toHaveText(/^3 accounts, 2 with room · Misha/);
  await expect(opt("Codex").locator(".sel-opt-hint")).toHaveText("74% left");
  await expect(opt("Codex").locator(".sel-opt-detail")).toHaveText(/^This week, resets in 4 d \d+ h$/);
  await expect(opt("Gemini CLI").locator(".sel-opt-hint")).toHaveCount(0);
  await expect(opt("Gemini CLI").locator(".sel-opt-detail")).toHaveCount(0);
  await opt("Codex").click();
  // 74% left changes nothing about a start: the chosen agent's row says nothing of it.
  await expect(sheet.locator("[data-ns-row=agent] button.sel")).toHaveAttribute("data-value", "codex");
  await expect(sheet.locator("[data-ns-left]")).toHaveCount(0);
});

test("New session on a one-account machine: none left, in the attention colour", async ({ page }) => {
  await page.goto("/?mock=1&new=1&machine=demo-laptop&harness=claude-code");
  const sheet = page.locator("[data-new-session]");
  await expect(sheet.locator("[data-ns-left]")).toHaveText(/^None left, resets in 1 h \d{2} m$/);
  await expect(sheet.locator("[data-ns-left]")).toHaveClass(/ns-aside--out/);
  await sheet.locator("[data-ns-row=agent] button.sel").click();
  const claude = page.locator(".sel-opt", { hasText: "Claude Code" });
  await expect(claude.locator(".sel-opt-hint")).toHaveText("None left");
  await expect(claude.locator(".sel-opt-hint")).toHaveClass(/sel-opt-hint--attention/);
  await expect(claude.locator(".sel-opt-detail")).toHaveText(/^5 hours, resets in 1 h \d{2} m$/);
  // Listed and choosable all the same.
  await expect(claude).not.toHaveAttribute("aria-disabled", "true");
});

test("Enter on an account opens New session there, with its harness", async ({ page }) => {
  await openPage(page, "/usage");
  const dev = page.locator("section.usage-acct", { hasText: "api.z.ai" });
  await dev.locator(".usage-head").focus();
  await expect(dev).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Enter");
  const sheet = page.locator("[data-new-session]");
  await expect(sheet.locator("[data-ns-row=machine] button.sel")).toHaveText(/lab-mac/);
  await expect(sheet.locator("[data-ns-row=agent] button.sel")).toHaveText(/Claude Code/);
});

test("the sidebar line's menu, its tooltip, and hiding it until Settings brings it back", async ({ page }) => {
  await openPage(page, "/");
  // The one line: the account with the least left, its tooltip saying when it resets.
  const line = page.locator(".usage-line .glance-line");
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute("data-tip", /.+/);
  await line.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem").last()).toHaveText("Hide usage in the sidebar");
  await menu.getByRole("menuitem", { name: "Hide usage in the sidebar" }).click();
  await expect(page.locator(".usage-line")).toHaveCount(0);
  // The page is not lost with its line: Usage is a row of the rail's instead.
  const row = page.locator(".rail-nav > a[data-nav=usage]");
  await expect(row).toHaveText("Usage");
  await page.reload();
  await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
  await expect(page.locator(".usage-line")).toHaveCount(0);
  await expect(row).toBeVisible();

  await page.goto("/settings");
  const toggle = page.getByRole("switch", { name: "Usage in the sidebar" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".usage-line")).toBeVisible();
  await expect(row).toHaveCount(0);
  await line.click();
  await expect(page).toHaveURL(/\/usage(#.+)?$/);
});

test("the sidebar's one line keeps its figure whole; the name gives way", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await openPage(page, "/");
  // The narrowest column (220): the figure is never cut.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("sessionpipe-gui.settings") ?? "{}");
    localStorage.setItem("sessionpipe-gui.settings", JSON.stringify({ ...s, sidebarWidth: 220 }));
  });
  await page.reload();
  const line = page.locator(".usage-line .glance-line");
  await expect(line).toHaveCount(1);
  expect(Math.round((await page.locator(".tree-col").boundingBox())!.width)).toBe(220);
  expect(await line.locator(".glance-fig").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
});

test("in a short window the sidebar's line stays, the sessions scroll, and the rail keeps its foot", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await openPage(page, "/");
  await expect(page.locator(".usage-line .glance-line")).toHaveCount(1);
  await expect(page.locator(".usage-line")).toBeInViewport();
  expect(await page.locator(".stree-scroll").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // The rail's icons scroll under its head; Settings, at its foot, stays whole.
  const settings = page.locator(".rail-foot .theme-btn[data-tip^='Settings']");
  await expect(settings).toBeInViewport({ ratio: 1 });
});

test("with storage that throws, the page and the sidebar still draw", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
  });
  await page.goto("/usage");
  await expect(page.locator("section.usage-acct").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".usage-line")).toBeVisible();
});
