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

test("the sidebar says what each account has left, in the wide sidebar only", async ({ page }) => {
  await openPage(page, "/");
  const block = page.locator(".glance");
  await expect(block).toBeVisible();
  // lab-mac pools dev@example.com as "Misha": its numbers are the pooled machine's one line
  // (pool-surfaces.spec.ts), never a line of their own.
  const dev = block.locator('.glance-line[data-glance="pool:lab-mac"]');
  await expect(dev.locator(".glance-name")).toHaveText("Misha");
  await expect(dev.locator(".glance-val")).toHaveText(/^5h (\d+|<1)% left$/);
  await expect(dev.locator(".glance-bar")).toBeVisible();
  await expect(block.locator(".glance-line", { hasText: /^dev\b/ })).toHaveCount(0);
  // studio-mac's account, which no hello names, by its machine: none left, and when it resets in the bar's place.
  const studio = block.locator(".glance-line", { hasText: /^studio-mac/ }).filter({ hasText: "None left" });
  await expect(studio.locator(".glance-out")).toHaveText("None left");
  await expect(studio.locator(".glance-sub")).toHaveText(/^resets in /);
  await expect(block).not.toContainText("used");

  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.locator(".glance")).toHaveCount(0);
});

test("with no numbers there is no sidebar block, and the page says how to get them", async ({ context, page }) => {
  // The control instance runs no demo and no hello there names an account.
  await seenSetupHere(context);
  await page.goto(`${CONTROL_BASE}/usage`);
  await expect(page.locator(".state-title")).toHaveText("No limits yet");
  await expect(page.locator(".cmdwell")).toContainText("sessionpipe install --status-line");
  await expect(page.locator(".bar")).not.toContainText("account");
  await expect(page.locator(".glance")).toHaveCount(0);
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
  // Never a figure for a harness with no source, never "used".
  await expect(main.locator("section.usage-acct", { hasText: "Gemini" })).toHaveCount(0);
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

test("a report updates the page and the sidebar without a reload; Copy usage and Forget", async ({ page }) => {
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
  await expect(glance(page, key)).toContainText("5h 57% left");

  // The next report is the whole set: none left now, on both, in the attention colour.
  await report(page, { account, machine, fiveHour: 100, seq: 1, at: Date.now() - 1000 });
  await expect(s.locator('[data-window="five_hour"] .usage-out')).toHaveText("None left");
  await expect(glance(page, key).locator(".glance-out")).toHaveText("None left");
  await expect(glance(page, key).locator(".glance-sub")).toHaveText(/^resets in 2 h \d{2} m$/);

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
  await expect(sheet.locator("[data-ns-left]")).toHaveText("74% left");
  await expect(sheet.locator("[data-ns-left]")).not.toHaveClass(/ns-aside--out/);
});

test("New session on a one-account machine: none left, in the attention colour", async ({ page }) => {
  await page.goto("/?mock=1&new=1&machine=misha-air&harness=claude-code");
  const sheet = page.locator("[data-new-session]");
  await expect(sheet.locator("[data-ns-left]")).toHaveText("None left");
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
  // lab-mac pools dev@example.com as "Misha", so its line is the pooled machine's: the
  // tooltip is the pool's (the account, where, its windows, the others, the age).
  const dev = page.locator('.glance-line[data-glance="pool:lab-mac"]');
  await expect(dev).toHaveAttribute(
    "data-tip",
    /^Misha, Claude Code on lab-mac, in use\.\n5 hours: .*\nFiction has room\.\nSpacesheep is used up, .*\nAs of .*\.$/s,
  );
  await dev.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    /^Open lab-mac's accounts/,
    "New session on lab-mac…",
    "Copy usage",
    "Hide usage in the sidebar",
  ]);
  await menu.getByRole("menuitem", { name: "Hide usage in the sidebar" }).click();
  await expect(page.locator(".glance")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
  await expect(page.locator(".glance")).toHaveCount(0);

  await page.goto("/settings");
  const toggle = page.getByRole("switch", { name: "Usage in the sidebar" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".glance")).toBeVisible();
  await dev.click();
  await expect(page).toHaveURL(/\/usage#pool%3Alab-mac$/);
});

test("a long name keeps its room in the sidebar; the window's name gives way", async ({ page }) => {
  const account = `e2e-${tag()}`;
  const key = `claude-code a:${account}`;
  await openPage(page, "/");
  // No hello names it, so the sidebar names it by its machine; its tightest is this week's Fable.
  await report(page, { account, machine: "misha-personal", fiveHour: 10, fable: 62 });
  const line = glance(page, key);
  await expect(line.locator(".glance-name")).toHaveText("misha-personal");
  await expect(line.locator(".glance-val")).toHaveText("week Fable 38% left");
  const cut = (sel: string) => line.locator(sel).evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(await cut(".glance-name")).toBe(false);
  expect(await cut(".glance-fig")).toBe(false);
  await page.request.post("/api/ui/limits/forget", { data: { key } });
  await expect(line).toHaveCount(0);
});

test("in a short window the sidebar's block gives way, never the navigation", async ({ page }) => {
  const navScrolls = () => page.locator(".rail-nav").evaluate((el) => el.scrollHeight > el.clientHeight);
  await page.setViewportSize({ width: 1440, height: 700 });
  await openPage(page, "/");
  await expect(page.locator(".glance-line")).toHaveCount(2);
  await expect(page.locator(".glance-more")).toHaveText(/^\d+ more$/);
  expect(await navScrolls()).toBe(false);
  await page.setViewportSize({ width: 1440, height: 600 });
  await expect(page.locator(".glance")).toHaveCount(0);
  expect(await navScrolls()).toBe(false);
  await expect(page.locator(".rail-nav [data-nav]").last()).toBeInViewport();
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
  await expect(page.locator(".glance")).toBeVisible();
});
