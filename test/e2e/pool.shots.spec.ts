// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Screenshots of the pooled section and the Add account sheet (UX-SPEC §14), for review:
// run with POOL_SHOTS=<dir>; nothing runs without it. Every state comes from demo data or
// the fake daemon of pool-helpers.ts, never a real machine: the section light and dark on
// a desktop and a phone, the menus, the Remove ask, a drag mid-way and the held order, the
// offline Notice, every account out, the first run's footnote, and the sheet's states.
import { expect, type Page, test } from "@playwright/test";
import { CONTROL_BASE, passkeyPage, seenSetupHere } from "./control-helpers.js";
import { openPage } from "./helpers.js";
import { accts, poolDaemon } from "./pool-helpers.js";

const SHOTS = process.env.POOL_SHOTS ?? "";
test.skip(!SHOTS, "POOL_SHOTS=<dir> writes the review screenshots");
test.describe.configure({ mode: "serial" });

const section = (page: Page, machine: string) => page.locator(`section[data-pool="${machine}"]`);
const row = (page: Page, machine: string, name: string) =>
  section(page, machine).locator("li.pool-acct", { has: page.locator(".pool-title", { hasText: name }) });
const settle = (page: Page) => page.waitForTimeout(350);
const shot = async (page: Page, name: string, o: { full?: boolean; of?: ReturnType<Page["locator"]> } = {}) => {
  await settle(page);
  if (o.of) await o.of.screenshot({ path: `${SHOTS}/${name}.png` });
  else await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: !!o.full });
};
/** A `name` like "lab-1" hides in the machine name; the real demo names stay. */
const dark = (page: Page) => page.emulateMedia({ colorScheme: "dark" });

test("the demo: the section in every demo state, light and dark, desktop and phone", async ({ page, isMobile }) => {
  test.setTimeout(180_000);
  const p = isMobile ? "P" : "D";
  await openPage(page, "/usage");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await shot(page, `${p}1-usage-pooled`, { full: true });
  if (!isMobile) {
    await shot(page, "D1-usage-pooled-lab-mac", { of: section(page, "lab-mac") });
    await shot(page, "D2-usage-pooled-off", { of: section(page, "desk-pc") });
    await shot(page, "D3-usage-error-off", { of: section(page, "mini-mac") });
    // D6: the row menu; D6b: the section menu.
    await row(page, "lab-mac", "Spacesheep").locator(".pool-row").click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await shot(page, "D6-row-menu");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(450);
    await section(page, "lab-mac").locator(".usage-head .icon-btn").click();
    await expect(page.getByRole("menu")).toBeVisible();
    await shot(page, "D6b-section-menu");
    await page.keyboard.press("Escape");
    // D7, D8: the Remove ask and the drag need a page that can sign: the fake daemon below.
  } else {
    await shot(page, "P1-usage-pooled-lab-mac", { of: section(page, "lab-mac") });
    // P2: the row's menu as a sheet (a long press on the cell).
    const cell = row(page, "lab-mac", "Spacesheep").locator(".pool-row");
    await cell.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await cell.locator(".pool-title").evaluate((el) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "touch",
          clientX: r.left + 4,
          clientY: r.top + 4,
        }),
      );
    });
    await expect(page.locator(".menu-sheet")).toBeVisible();
    await shot(page, "P2-longpress");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(450);
  }
  await dark(page);
  await page.goto("/usage");
  await page.waitForFunction(() => document.querySelector(".conn")?.textContent === "live");
  await shot(page, `${p}1-usage-pooled-dark`, { full: true });
  if (!isMobile) await shot(page, "D1-usage-pooled-lab-mac-dark", { of: section(page, "lab-mac") });
});

test("the fake daemon: the held order, a drag, the sheet, offline, none with room, the first run", async ({
  context,
  page,
  isMobile,
}) => {
  test.setTimeout(180_000);
  await seenSetupHere(context);
  const key = await passkeyPage(context, page);
  const p = isMobile ? "P" : "D";
  // Names unique per run: the desktop and phone projects run this at the same time.
  const tag = Math.random().toString(36).slice(2, 6);
  const slowName = `lab-slow-${tag}`;
  const slow = await poolDaemon(key, slowName, { pauseMs: 6000 });
  try {
    await page.goto(`${CONTROL_BASE}/usage`);
    const s = section(page, slowName);
    await expect(s).toBeVisible();
    if (!isMobile) {
      // D8: Fiction lifted and riding under the pointer, Spacesheep slid up.
      const fiction = row(page, slowName, "Fiction").locator(".pool-row");
      const box = (await fiction.boundingBox())!;
      await page.mouse.move(box.x + 200, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + box.height / 2 + 10, { steps: 3 });
      await page.mouse.move(box.x + 200, box.y + box.height / 2 + box.height * 1.5, { steps: 6 });
      await shot(page, "D8-drag", { of: s });
      await page.mouse.up();
      // D8b: the held order with "saving order…" while the machine takes its time.
      await expect(s.locator("[data-pool-meta]")).toHaveText("saving order…");
      await shot(page, "D8b-saving-order", { of: s });
      await expect(s.locator("[data-pool-meta]")).toHaveText(/accounts/, { timeout: 15_000 });
    }
    // D7 / P4: the Remove ask: an alert on a desktop, an action sheet at a phone's width
    // (the same page narrowed, so a real click reaches the sheet's item).
    if (!isMobile) {
      await page.waitForTimeout(450);
      await row(page, slowName, "Fiction").locator(".icon-btn").last().click();
      await page.getByRole("menu").getByRole("menuitem", { name: "Remove…" }).click();
      await expect(page.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
      await shot(page, "D7-remove-confirm");
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(450);
      await row(page, slowName, "Fiction").locator(".pool-row").click({ button: "right" });
      await page.getByRole("menu").getByRole("menuitem", { name: "Remove…" }).click();
      await expect(page.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
      await shot(page, "P4-remove-sheet");
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(450);
    }
    // The sheet: ready, link, error.
    await s.locator("[data-pool-add]").click();
    const sheet = page.locator("[data-pool-sheet]");
    await expect(sheet).toBeVisible();
    if (isMobile) {
      // Sign in is the bar's trailing button, 44 pt tall, as New session's Start is.
      const btn = (await sheet.locator("[data-pool-signin]").boundingBox())!;
      expect(btn.height).toBeGreaterThanOrEqual(44);
      expect(await sheet.locator(".ns-bar [data-pool-signin]").count()).toBe(1);
    } else {
      // The desktop dialog is New session's: 640 wide under the title bar, the scrim over
      // the whole window, Cancel and Sign in in the footer.
      const box = (await sheet.boundingBox())!;
      expect(box.width).toBe(640);
      expect(box.y).toBe(48);
      const scrim = (await page.locator(".ns-scrim").boundingBox())!;
      expect(scrim.x).toBe(0);
      expect(scrim.width).toBe(1440);
      await expect(sheet.locator(".ns-foot [data-pool-cancel]")).toHaveText("Cancel");
      await expect(sheet.locator(".ns-foot [data-pool-signin]")).toHaveText("Sign in to Claude…");
    }
    await shot(page, `${p}9-sheet-ready`);
    await sheet.locator("[data-pool-signin]").click();
    await expect(sheet.locator(".ns-status")).toHaveText(/Sending to lab-slow-/);
    await shot(page, `${p}9b-sheet-sending`);
    await expect(sheet.locator("[data-pool-code]")).toBeVisible({ timeout: 15_000 });
    await sheet.locator("[data-pool-code]").fill("expired#state");
    await shot(page, `${p}10-sheet-link`);
    await sheet.locator("[data-pool-done]").click();
    await expect(sheet.locator("[data-pool-error]")).toBeVisible({ timeout: 15_000 });
    await shot(page, `${p}11-sheet-error`);
    if (isMobile) await sheet.locator("[data-pool-cancel]").click();
    else await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  } finally {
    await slow.stop();
  }
  if (isMobile) return;

  // D5: the daemon offline, the Notice, and a queued "Waiting for … to come online."
  const offName = `lab-off-${tag}`;
  const off = await poolDaemon(key, offName, { offline: true });
  try {
    await page.goto(`${CONTROL_BASE}/usage`);
    const s = section(page, offName);
    await expect(s.locator(".notice")).toContainText(`${offName}'s sessionpipe is offline`);
    await s.getByRole("switch").click();
    await expect(s.locator("[data-pool-note]")).toHaveText(`Waiting for ${offName} to come online.`);
    await shot(page, "D5-usage-offline", { of: s });
  } finally {
    await off.stop();
  }

  // D4: every account out.
  const soon = new Date(Date.now() + 2 * 3_600_000 + 10 * 60_000).toISOString();
  const out = accts().map((a, i) => ({
    ...a,
    current: false,
    status: i === 1 ? "error" : "limited",
    ...(i === 1 ? {} : { until: soon }),
  }));
  const outName = `lab-out-${tag}`;
  const none = await poolDaemon(key, outName, { accounts: out });
  try {
    await page.goto(`${CONTROL_BASE}/usage`);
    const s = section(page, outName);
    await expect(s.locator("[data-pool-meta]")).toHaveText(/^3 accounts, none with room · first back in 2 h/);
    await shot(page, "D4-usage-none-with-room", { of: s });
  } finally {
    await none.stop();
  }

  // D17: the first run: a machine that could pool, the footnote's "Set it up…", the
  // free-standing section's menu item, the sheet command-first.
  const newName = `lab-new-${tag}`;
  const first = await poolDaemon(key, newName, {
    accounts: [],
    on: false,
    logins: [{ harness: "claude-code", id: "01K8E2EFIRSTRUN0000000000", email: "misha@example.com" }],
  });
  try {
    await page.goto(`${CONTROL_BASE}/usage`);
    const note = page.locator(`[data-pool-setup="${newName}"]`);
    await expect(note).toContainText(`${newName} can switch between several Claude accounts.`);
    const acct = page.locator("section.usage-acct", { hasText: "misha@example.com" });
    await acct.locator(".usage-head").click({ button: "right" });
    await expect(
      page.getByRole("menu").getByRole("menuitem", { name: `Switch accounts on ${newName}…` }),
    ).toBeVisible();
    await shot(page, "D17-first-run");
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: `Switch accounts on ${newName}…` })
      .dispatchEvent("click");
    const sheet = page.locator("[data-pool-sheet]");
    await expect(sheet.locator("section").first()).toHaveAttribute("data-pool-command", "");
    await shot(page, "D17b-first-run-sheet");
    await page.keyboard.press("Escape");
  } finally {
    await first.stop();
  }
});
