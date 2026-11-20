// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The segmented control's geometry (bits.tsx Segmented, shared.css .seg), as tests a spec
// declares for its own browser: every segment is as wide as the widest label, so no label
// runs out of its segment, and a control that spans its row fills it.
import { expect, type Page, test } from "@playwright/test";
import { openBoard, openPage } from "./helpers.js";

/** Each segment on the page with the room its label has inside it, left and right. */
const labelRooms = (page: Page) =>
  page.locator("fieldset.seg label.seg-opt").evaluateAll((labels) =>
    labels
      .filter((label) => label.getClientRects().length > 0)
      .map((label) => {
        // The words alone: the label also holds its radio, which is off to one side.
        const words = Array.from(label.childNodes).find((n) => n.nodeType === Node.TEXT_NODE)!;
        const range = document.createRange();
        range.selectNodeContents(words);
        const text = range.getBoundingClientRect();
        const box = label.getBoundingClientRect();
        return { label: label.textContent ?? "", left: text.left - box.left, right: box.right - text.right };
      }),
  );

/** The tests of the control's geometry, declared in the file that calls this: once for
 *  Chromium (segmented.spec.ts) and once for WebKit (segmented.webkit.spec.ts). */
export function segmentTests() {
  for (const [name, path, labels] of [
    ["Search", "/search", ["Best match", "Newest"]],
    ["Settings › General", "/settings?section=general", ["Simple", "Advanced", "Beside", "As a page"]],
    ["Settings › Tier lens", "/settings?section=lens", ["All", "0", "1", "2", "3"]],
  ] as const) {
    test(`${name}: every label sits inside its segment, and the segments are equal`, async ({ page }) => {
      await openPage(page, path);
      await expect(page.locator("fieldset.seg").first()).toBeVisible();
      const rooms = await labelRooms(page);
      // The page may hold other switches; these are the ones measured.
      expect(rooms.map((r) => r.label)).toEqual(expect.arrayContaining([...labels]));
      for (const r of rooms) {
        expect(r.left, `"${r.label}" has room on its left`).toBeGreaterThanOrEqual(8);
        expect(r.right, `"${r.label}" has room on its right`).toBeGreaterThanOrEqual(8);
      }
      for (const track of await page.locator("fieldset.seg").all()) {
        const widths = await track
          .locator("label.seg-opt")
          .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
        expect(Math.max(...widths) - Math.min(...widths), "one track's segments are equal").toBeLessThanOrEqual(1);
      }
    });
  }

  test("Quick settings: the appearance switch fills its row in three equal segments", async ({ page }) => {
    await openBoard(page);
    await page.locator("nav.rail button[aria-label='Quick settings']").click();
    const pop = page.getByRole("dialog", { name: "Quick settings" });
    const track = pop.locator("fieldset.seg");
    await expect(track).toBeVisible();
    const [row, box, ...segments] = await Promise.all([
      pop.locator(".qs-sect", { has: page.locator("fieldset.seg") }).boundingBox(),
      track.boundingBox(),
      ...(await track.locator("label.seg-opt").all()).map((s) => s.boundingBox()),
    ]);
    expect(segments).toHaveLength(3);
    expect(Math.abs(box!.width - row!.width), "the track spans its row").toBeLessThanOrEqual(1);
    const last = segments[2]!;
    expect(
      box!.x + box!.width - (last.x + last.width),
      "the last segment ends at the track's inset",
    ).toBeLessThanOrEqual(3);
    const widths = segments.map((s) => s!.width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });
}
