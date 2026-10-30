// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Review: the files changed grouped by repo, and the day's digest. Search lives on /search
// (search.spec.ts).
import { expect, test } from "@playwright/test";
import { openPage } from "./helpers.js";

test.describe("review", () => {
  test("the files view groups changed paths by repo with the sessions that touched them", async ({ page }) => {
    await openPage(page, "/review");
    await page.getByRole("tab", { name: "Files" }).click();
    const repos = page.locator("section.rv-repo");
    await expect(repos.first()).toBeVisible({ timeout: 30_000 });
    const heads = await repos.locator("h2.group-head").allInnerTexts();
    expect(heads.length).toBeGreaterThan(0);
    for (const h of heads) expect(h).toMatch(/^acme\/\S+\s+\d+ files?$/);
    const path = repos.first().locator("li.rv-path").first();
    await expect(path.locator("code.rv-file")).toHaveText(/\S+\.\w+$/);
    await expect(path.locator("button.rv-sess").first()).toBeVisible();
    // Every path is under exactly one repo heading, and the range switch keeps the shape.
    // The segmented control's radios are sr-only; the label is what a person clicks.
    await page.locator("fieldset.seg label.seg-opt", { hasText: "30 days" }).click();
    await expect(page.getByRole("radio", { name: "30 days" })).toBeChecked();
    await expect(repos.first()).toBeVisible();
    await expect(page.locator(".rv-head .page-note")).toHaveText(/\d+ paths? in \d+ repos?/);
  });

  test("the day view shows today's sessions with totals per machine and in all", async ({ page }) => {
    await openPage(page, "/review");
    await page.getByRole("tab", { name: "Day" }).click();
    await expect(page.locator(".rv-day")).toHaveText("Today");
    const rows = page.locator("table.rv-table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    // The machine totals add up to the session rows; the last row is the grand total. The
    // count is read from its own span: a machine named "mac-mini-2" runs into it otherwise.
    const machines = page.locator("table.rv-table tfoot tr").filter({ hasText: /^machine/ });
    const sessionsPer = await machines.evaluateAll((trs) =>
      trs.map((tr) => Number(/^(\d+) sessions?/.exec(tr.querySelector(".rv-span")?.textContent ?? "")?.[1] ?? 0)),
    );
    expect(sessionsPer.reduce((a, b) => a + b, 0)).toBe(n);
    await expect(page.locator("table.rv-table tfoot tr.rv-all")).toHaveText(new RegExp(`all\\s*${n} sessions?`));
    // Yesterday is reachable and empty on a fresh demo state; Today comes back.
    await page.getByRole("button", { name: "Previous day" }).click();
    await expect(page.locator(".rv-day")).toHaveText("Yesterday");
    await page.getByRole("button", { name: "Today" }).click();
    await expect(page.locator(".rv-day")).toHaveText("Today");
    await expect(rows.first()).toBeVisible();
  });
});
