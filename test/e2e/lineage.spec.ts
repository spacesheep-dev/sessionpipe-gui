// SPDX-License-Identifier: Apache-2.0
// Lineage on the demo server (server/demo/sim.ts): a Claude Code session on lab-mac asks
// Codex from inside its turn (sessionpipe ask) and another gets a handoff's answer back.
// The asking session's page shows the row; the asked session's page says who asked, with
// a link back; the board nests it under its parent; Machines says lab-mac's agents can
// ask each other; the Feed words the two events. Desktop only.
import { expect, type Page, test } from "@playwright/test";
import { openBoard, openPage } from "./helpers.js";

test.skip(({ isMobile }) => isMobile, "desktop project");

interface Snap {
  sessions: {
    key: string;
    harness: string;
    id: string;
    title?: string;
    delegatedBy?: string;
    delegations?: { via: string; harness: string; to?: string; endedAt?: string; relayed?: string }[];
  }[];
}
const snap = async (page: Page): Promise<Snap> => (await (await page.request.get("/api/ui/snapshot")).json()) as Snap;

/** The demo's asking session (its delegation has reached the receiver) and the asked one. */
async function lineage(page: Page) {
  await expect
    .poll(
      async () => (await snap(page)).sessions.some((s) => (s.delegations?.length ?? 0) > 0 && s.delegations![0]!.to),
      {
        timeout: 60_000,
      },
    )
    .toBe(true);
  const all = (await snap(page)).sessions;
  const asker = all.find((s) => (s.delegations?.length ?? 0) > 0 && s.delegations![0]!.to)!;
  const child = all.find((s) => s.key === asker.delegations![0]!.to);
  return { asker, child };
}

test("the asking session shows the row; the asked session says who asked", async ({ page }) => {
  await openPage(page, "/");
  const { asker, child } = await lineage(page);
  await openPage(page, `/s/${asker.harness}/${asker.id}`);
  const row = page.locator(".ask").first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/asked Codex/i);
  await expect(row.locator(".ask-state")).toHaveText(/running|answered|failed/);
  // The row links to the asked session, whose bar says whom it works for.
  if (child) {
    await expect(page.locator(`.ask a[href*="${child.id}"]`).first()).toBeVisible();
    await openPage(page, `/s/${child.harness}/${child.id}`);
    await expect(page.locator(".sess-for")).toContainText("for ");
    await expect(page.locator(`.sess-for a[href*="${asker.id}"]`)).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Open the asking session" })).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

test("the board nests the asked session under its parent", async ({ page }) => {
  await openPage(page, "/");
  const { asker, child } = await lineage(page);
  test.skip(!child, "the asked session is not on the board yet");
  await openBoard(page);
  const card = page.locator(`article.card[data-flip="${asker.key}"]`);
  if ((await card.count()) === 0) test.skip(true, "the asking session is folded away on the board");
  await expect(card.locator("ul.card-kids li", { hasText: child!.title ?? "" }).first()).toBeVisible();
});

test("Machines: lab-mac's agents can ask each other; the Feed words the events", async ({ page }) => {
  await openPage(page, "/machines");
  const lab = page.locator("section.machine[aria-label='lab-mac']");
  await expect(lab.locator(".machine-caution", { hasText: "Agents here can ask each other" })).toBeVisible();
  await openPage(page, "/feed");
  const ev = page.locator('li.ev[data-type="delegation.started"]').first();
  await expect(ev).toBeVisible({ timeout: 30_000 });
  // The kind column says who was asked; the detail column says how the ask is going.
  await expect(ev).toContainText(/asked Codex/i);
  await expect(ev).toContainText(/running/);
});
