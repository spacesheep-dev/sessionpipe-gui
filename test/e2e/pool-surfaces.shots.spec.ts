// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Screenshots of the pool's smaller surfaces (UX-SPEC §14: D12–D16, P5, P6) from the demo
// alone, written only when POOL_SHOTS=<dir> is set; otherwise every test here is skipped.
// Desktop 1440×900 light and dark, the phone at 390 pt light and dark.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openPage, sessionUrl } from "./helpers.js";

const SHOTS = process.env.POOL_SHOTS ?? "";
test.skip(!SHOTS, "POOL_SHOTS=<dir> writes the screenshots");
test.describe.configure({ mode: "serial" });

const SETTINGS_KEY = "sessionpipe-gui.settings";
const schemes = ["light", "dark"] as const;
type Scheme = (typeof schemes)[number];

async function shot(
  page: Page,
  name: string,
  scheme: Scheme,
  clip?: { x: number; y: number; width: number; height: number },
) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`), ...(clip ? { clip } : {}) });
}

async function poolSession(page: Page): Promise<{ harness: string; id: string }> {
  await expect
    .poll(async () => {
      const snap = (await (await page.request.get("/api/ui/snapshot")).json()) as {
        sessions: { title?: string; servedBy?: unknown }[];
      };
      return snap.sessions.find((s) => s.title?.includes("--sink") && s.servedBy) ?? null;
    })
    .not.toBeNull();
  const snap = (await (await page.request.get("/api/ui/snapshot")).json()) as {
    sessions: { harness: string; id: string; title?: string }[];
  };
  const s = snap.sessions.find((x) => x.title?.includes("--sink"))!;
  return { harness: s.harness, id: s.id };
}

/** The Select's popover or sheet has finished opening (its slide is 200 ms or so). */
async function settled(page: Page) {
  await expect(page.locator(".sel-pop, .sel-sheet").first()).toBeVisible();
  await page.waitForTimeout(600);
}

const chatMode = (page: Page) =>
  page.addInitScript(([k]) => localStorage.setItem(k, JSON.stringify({ mode: "simple" })), [SETTINGS_KEY] as const);

for (const scheme of schemes) {
  test.describe(`desktop, ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    test("D12 the Agent menu on lab-mac", async ({ page }) => {
      await openPage(page, "/?new=1&machine=lab-mac");
      const sheet = page.locator("[data-new-session]");
      await sheet.locator("[data-ns-row=agent] button.sel").click();
      await expect(page.locator(".sel-opt", { hasText: "Claude Code" }).locator(".sel-opt-detail")).toContainText(
        "with room",
      );
      await settled(page);
      await shot(page, "D12-new-agent-pooled", scheme);
    });

    test("D13 the session page served by another account, D14 the chat's swap row", async ({ page }) => {
      const s = await poolSession(page);
      await openPage(page, sessionUrl(s.harness, s.id));
      await expect(page.locator(".page-note[data-served]")).toBeVisible();
      await page.locator("[data-swap]").first().scrollIntoViewIfNeeded();
      await shot(page, "D13-session-served", scheme);
    });

    test("D14 the chat's swap row", async ({ page }) => {
      await chatMode(page);
      const s = await poolSession(page);
      await openPage(page, sessionUrl(s.harness, s.id));
      const row = page.locator(".chat-note[data-swap]");
      await expect(row).toBeVisible();
      await row.scrollIntoViewIfNeeded();
      await shot(page, "D14-chat-switched", scheme);
    });

    test("D15 the sidebar's pooled line with its tooltip", async ({ page }) => {
      await openPage(page, "/");
      const lab = page.locator('.glance-line[data-glance="pool:lab-mac"]');
      await expect(lab).toBeVisible();
      await lab.hover();
      await expect(page.locator(".tip, [role=tooltip]").first()).toBeVisible();
      await shot(page, "D15-sidebar-pooled", scheme);
    });

    test("D16 Machines' Accounts row with pooled", async ({ page }) => {
      await openPage(page, "/machines");
      const lab = page.locator("section.machine[aria-label='lab-mac']");
      await expect(lab.locator(".machine-accounts")).toContainText("pooled");
      await lab.scrollIntoViewIfNeeded();
      await shot(page, "D16-machines-pooled", scheme);
    });
  });

  test.describe(`phone, ${scheme}`, () => {
    test.use({
      colorScheme: scheme,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });

    test("P5 New session's Agent sheet", async ({ page }) => {
      await openPage(page, "/?new=1&machine=lab-mac");
      await page.locator("[data-new-session] [data-ns-row=agent] button.sel").click();
      await expect(page.locator(".sel-opt", { hasText: "Claude Code" }).locator(".sel-opt-detail")).toContainText(
        "with room",
      );
      await settled(page);
      await shot(page, "P5-new-agent", scheme);
    });

    test("P6 the chat's swap row and the served-by note", async ({ page }) => {
      await chatMode(page);
      const s = await poolSession(page);
      await openPage(page, sessionUrl(s.harness, s.id));
      const row = page.locator(".chat-note[data-swap]");
      await expect(row).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, "P6-session-served", scheme);
      await row.scrollIntoViewIfNeeded();
      await shot(page, "P6-chat-switched", scheme);
    });

    test("P6b the timeline's swap row", async ({ page }) => {
      const s = await poolSession(page);
      await openPage(page, sessionUrl(s.harness, s.id));
      const row = page.locator(".marker--swap");
      await expect(row).toBeVisible();
      await row.scrollIntoViewIfNeeded();
      await shot(page, "P6b-timeline-switched", scheme);
    });
  });
}
