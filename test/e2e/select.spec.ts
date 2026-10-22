// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The custom select (web/src/components/Select.tsx) on the board's harness filter: the
// trigger is a combobox and opens a listbox; arrows and Enter pick "Codex" and the board
// filters to it; typing jumps to a row; Esc closes and gives focus back; axe finds nothing
// new with the list open. On the phone project the same list is a bottom sheet.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { openBoard } from "./helpers.js";

const trigger = (page: Page) => page.getByRole("combobox", { name: "Harness" });
const list = (page: Page) => page.getByRole("listbox", { name: "Harness" });
const active = (page: Page) => page.locator("[role=option].sel-opt--active");

/** The harnesses of the cards on view, by the glyph's title; empty while none is on view. */
const cardHarnesses = (page: Page) =>
  page
    .locator("article.card:visible .glyph-wrap")
    .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute("title") ?? "?"))]);
/** Every card on view is `name`'s (the demo decides how many that is at the moment). */
const onlyCards = async (page: Page, name: string) => {
  await expect(page.locator("section.group").first()).toBeVisible();
  await expect.poll(() => cardHarnesses(page).then((hs) => hs.filter((h) => h !== name))).toEqual([]);
};

test.describe("select", () => {
  test.beforeEach(async ({ page }) => {
    await openBoard(page);
    await expect(trigger(page)).toBeVisible();
  });

  test("the harness filter is a combobox over a listbox; arrows and Enter pick Codex and the board follows", async ({
    page,
    isMobile,
  }) => {
    test.skip(!!isMobile, "desktop project only");
    const t = trigger(page);
    await expect(t).toHaveAttribute("aria-haspopup", "listbox");
    await expect(t).toHaveAttribute("aria-expanded", "false");

    await t.focus();
    await page.keyboard.press("ArrowDown");
    await expect(t).toHaveAttribute("aria-expanded", "true");
    const l = list(page);
    await expect(l).toBeVisible();
    await expect(l.locator("[aria-selected=true]")).toHaveText("All harnesses");
    // The list sits under the trigger and is a hairline popover, not a sheet.
    const tb = (await t.boundingBox())!;
    const lb = (await l.boundingBox())!;
    expect(lb.y).toBeGreaterThanOrEqual(tb.y + tb.height);
    expect(lb.width).toBeGreaterThanOrEqual(tb.width - 1);
    // Focus stays on the trigger; the cursor row is named through aria-activedescendant.
    await expect(t).toBeFocused();
    const names = await l.getByRole("option").allInnerTexts();
    expect(names).toContain("Codex");
    for (let i = 0; i < names.length; i++) {
      if ((await active(page).innerText()) === "Codex") break;
      await page.keyboard.press("ArrowDown");
    }
    await expect(active(page)).toHaveText("Codex");
    await expect(t).toHaveAttribute("aria-activedescendant", (await active(page).getAttribute("id"))!);
    await page.keyboard.press("Enter");
    await expect(l).toHaveCount(0);
    await expect(t).toHaveAttribute("aria-expanded", "false");
    await expect(t).toHaveAttribute("data-value", "codex");
    await expect(t).toContainText("Codex");
    await expect(t).toBeFocused();
    await onlyCards(page, "Codex");

    // Open again: the current option carries the check, and Home/End reach the edges.
    await page.keyboard.press(" ");
    await expect(list(page).locator("[aria-selected=true]")).toHaveText("Codex");
    await page.keyboard.press("End");
    await expect(active(page)).toHaveText(names[names.length - 1]!);
    await page.keyboard.press("Home");
    await expect(active(page)).toHaveText(names[0]!);
    await page.keyboard.press("Escape");
    await expect(list(page)).toHaveCount(0);
  });

  test("typing jumps to the row that starts with the letters; Esc closes and gives focus back", async ({
    page,
    isMobile,
  }) => {
    test.skip(!!isMobile, "desktop project only");
    const t = trigger(page);
    await t.click();
    const names = (await list(page).getByRole("option").allInnerTexts()).slice(1); // past "All harnesses"
    // A prefix that names exactly one row.
    let target = "";
    let prefix = "";
    for (const n of names) {
      for (let k = 1; k <= n.length && !target; k++) {
        const p = n.slice(0, k).toLowerCase();
        if (names.filter((m) => m.toLowerCase().startsWith(p)).length === 1) {
          target = n;
          prefix = p;
        }
      }
      if (target) break;
    }
    expect(target).not.toBe("");
    await page.keyboard.type(prefix);
    await expect(active(page)).toHaveText(target);

    await page.keyboard.press("Escape");
    await expect(list(page)).toHaveCount(0);
    await expect(t).toBeFocused();
    await expect(t).toHaveAttribute("aria-expanded", "false");
    await expect(t).toHaveAttribute("data-value", ""); // nothing was picked

    // A click outside closes it too.
    await t.click();
    await expect(list(page)).toBeVisible();
    await page
      .locator("h1, .page")
      .first()
      .click({ position: { x: 2, y: 2 } });
    await expect(list(page)).toHaveCount(0);
  });

  test("axe: nothing new with the list open", async ({ page, isMobile }) => {
    test.skip(!!isMobile, "desktop project only");
    const scan = async () => {
      const r = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      return r.violations.flatMap((v) => v.nodes.map((n) => `${v.impact}:${v.id} ${n.target.join(" ")}`));
    };
    // The board's own findings (a card footer's contrast, say) are not the select's.
    const before = new Set(await scan());
    await trigger(page).click();
    await expect(list(page)).toBeVisible();
    const after = await scan();
    const fresh = after.filter((v) => !before.has(v) && !/\.card/.test(v));
    expect(fresh, "axe findings that appear only with the select open").toEqual([]);
    expect(
      after.filter((v) => /\.sel/.test(v)),
      "axe findings on the select itself",
    ).toEqual([]);
  });

  test("phone: the list is a bottom sheet with 44 px rows, still a listbox", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone project only");
    const t = trigger(page);
    await t.click();
    const sheet = page.locator(".sel-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".sel-grab")).toBeVisible();
    const l = list(page);
    await expect(l).toBeVisible();
    const vh = await page.evaluate(() => window.innerHeight);
    const sb = (await sheet.boundingBox())!;
    expect(sb.y + sb.height, "the sheet is pinned to the bottom edge").toBeGreaterThanOrEqual(vh - 1);
    expect(sb.width).toBeGreaterThanOrEqual((await page.evaluate(() => window.innerWidth)) - 1);
    const rows = l.getByRole("option");
    const h = (await rows.first().boundingBox())!.height;
    expect(h).toBeGreaterThanOrEqual(44);
    await rows.filter({ hasText: "Codex" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(t).toHaveAttribute("data-value", "codex");
    await onlyCards(page, "Codex");
  });
});
