// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// A window resized across the phone layout's width (lib/device.ts), with a mouse: every
// part of the page changes form in the same render, and nothing of the form it left stays
// behind. Settings drops a choice the phone had pushed, in no frame a dead end; Search's
// field takes the focus when the page is entered and is not given it again, and one being
// typed in keeps it; the command palette's list is fitted for the layout the window now
// has. (The Labels sheet that becomes the dialog is in labels.spec.ts: a spec that opens
// "Edit labels…" runs in order with the others that do.)
import { expect, test } from "@playwright/test";
import { openBoard, openPage, resizeWindow } from "./helpers.js";

const PHONE = { width: 700, height: 800 };
const WIDE = { width: 1000, height: 800 };

test.describe("a window resized across the phone layout's width", () => {
  test("Settings: a choice pushed on the phone is gone in the wide window, and the section is back", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await openPage(page, "/settings");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("tab", { name: "General" }).click();
    await dialog.getByRole("button", { name: /^Mode:/ }).click();
    const picks = dialog.locator(".settings-picks");
    await expect(picks.getByRole("radio", { name: "Advanced" })).toBeChecked();
    await expect(dialog.locator(".settings-bar-title")).toHaveText("Mode");
    // Every frame from here on, as it is about to be drawn: the pushed page in the wide
    // window is a frame with no way back.
    await page.evaluate((wide) => {
      const w = window as unknown as { __deadEnds: number };
      w.__deadEnds = 0;
      const look = () => {
        if (innerWidth >= wide && document.querySelector(".settings-picks")) w.__deadEnds++;
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    }, WIDE.width);

    await resizeWindow(page, WIDE);
    // No pushed page: the General pane beside the list of sections, Mode a control in it.
    await expect(picks).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __deadEnds: number }).__deadEnds)).toBe(0);
    await expect(dialog.getByRole("tab", { name: "General" })).toBeVisible();
    await expect(dialog.getByRole("tab", { selected: true })).toHaveText("General");
    await expect(dialog.getByRole("tabpanel", { name: "General" })).toBeVisible();
    await expect(dialog.getByRole("tabpanel").getByRole("radio", { name: "Advanced" })).toBeChecked();

    await resizeWindow(page, PHONE);
    // The phone's General again, as it was before the choice was pushed.
    await expect(picks).toHaveCount(0);
    await expect(dialog.locator(".settings-bar-title")).toHaveText("General");
    await expect(dialog.getByRole("button", { name: /^Mode:/ })).toBeVisible();
    await expect(dialog.locator(".settings-back")).toHaveText("Settings");
  });

  test("Search: the field has the focus on entering, is not focused again, and the list keeps its place", async ({
    page,
  }) => {
    // A short window, so the results run past its foot at either width.
    const wide = { ...WIDE, height: 480 };
    const phone = { ...PHONE, height: 480 };
    await page.setViewportSize(wide);
    // Every form the page passes through, read after each change to it: the bar and the
    // page under it are a phone's together or a desktop's together.
    await page.addInitScript(() => {
      const w = window as unknown as { __mixed: string[] };
      w.__mixed = [];
      const look = () => {
        // The page itself: its stand-in while the module arrives has a bar and no form yet.
        const sx = document.querySelector(".page.sx:not([aria-busy])");
        if (!sx) return;
        const phonePage = sx.classList.contains("sx--phone");
        const phoneBar = !!sx.querySelector(".bar-below");
        if (phonePage !== phoneBar)
          w.__mixed.push(`page ${phonePage ? "phone" : "wide"}, bar ${phoneBar ? "phone" : "wide"}`);
      };
      document.addEventListener("DOMContentLoaded", () =>
        new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true }),
      );
    });
    // The demo's own sessions (the mock, which ships in every build): the same rows each run.
    await page.goto("/search?mock=1&q=the");
    const field = page.getByRole("combobox", { name: /Search prompts, replies and tool calls/ });
    await expect(field).toBeFocused();
    await expect(page.locator("ol.sx-list a.sx-row").nth(5)).toBeVisible({ timeout: 30_000 });

    // Reading down the list, the field put down. The browser's own scroll anchoring is
    // off, so anything that moves the page from here on is the app's doing.
    await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
    await field.blur();
    await page.evaluate(() => window.scrollTo(0, 240));
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(240);

    await resizeWindow(page, phone);
    await expect(page.locator(".sx-phonefield")).toBeVisible();
    await expect(field).not.toBeFocused();
    await resizeWindow(page, wide);
    await expect(page.locator(".sx-phonefield")).toHaveCount(0);
    await expect(page.locator(".bar-tools").getByRole("combobox")).toBeVisible();
    await expect(field).not.toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(240);
    expect(await page.evaluate(() => (window as unknown as { __mixed: string[] }).__mixed)).toEqual([]);
  });

  test("Search: a field being typed in keeps the focus and the caret, and the list its place", async ({ page }) => {
    // A short window, so the results run past its foot at either width.
    const wide = { ...WIDE, height: 480 };
    const phone = { ...PHONE, height: 480 };
    await page.setViewportSize(wide);
    await page.goto("/search?mock=1");
    const field = page.getByRole("combobox", { name: /Search prompts, replies and tool calls/ });
    await expect(field).toBeFocused();
    await page.keyboard.type("the");
    await expect(page.locator("ol.sx-list a.sx-row").nth(5)).toBeVisible({ timeout: 30_000 });
    // Its last two letters selected: a place in the words to keep.
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    const selected = () => field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
    expect(await selected()).toEqual([1, 3]);
    // Reading down the list by the wheel, the field still in hand. The browser's own scroll
    // anchoring is off, so anything that moves the page from here on is the app's doing.
    await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
    await page.evaluate(() => window.scrollTo(0, 240));
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(240);

    await resizeWindow(page, phone);
    await expect(page.locator(".sx-phonefield")).toBeVisible();
    await expect(field).toBeFocused();
    expect(await selected()).toEqual([1, 3]);
    // Having the focus again did not bring the field, and the top of the page with it,
    // into view.
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);

    await resizeWindow(page, wide);
    await expect(page.locator(".bar-tools").getByRole("combobox")).toBeVisible();
    await expect(field).toBeFocused();
    expect(await selected()).toEqual([1, 3]);
    expect(await page.evaluate(() => scrollY)).toBe(240);
    // What is typed next goes where it would have.
    await page.keyboard.type("o");
    await expect(field).toHaveValue("to");
  });

  test("Command palette: its list ends on a whole row in the wide window, and fills the phone's sheet again", async ({
    page,
  }) => {
    // A short window, so the list runs past its foot at either width. Each resize is one
    // step, as a window snapped to a side or made full: the page hears "resize" before it
    // hears of the layout.
    const phone = { ...PHONE, height: 600 };
    const wide = { ...WIDE, height: 600 };
    await page.setViewportSize(phone);
    await openBoard(page);
    await page.keyboard.press("ControlOrMeta+k");
    const list = page.getByRole("dialog", { name: "Command palette" }).locator("#pal-list");
    await expect(list.locator(".pal-row").nth(12)).toBeAttached();
    /** The height the list was fitted to (none: it fills what it is given), and the rows
     *  its foot cuts through. The fit leaves 4 px under its last whole row, where the next
     *  one begins: that much of a row is not a cut. */
    const fit = () =>
      list.evaluate((el: HTMLElement) => {
        const foot = el.getBoundingClientRect().bottom;
        const cut = Array.from(el.querySelectorAll(".pal-row")).filter((row) => {
          const box = row.getBoundingClientRect();
          return box.top < foot - 6 && box.bottom > foot + 1;
        }).length;
        return { fitted: el.style.maxHeight !== "", cut, runsOn: el.scrollHeight > el.clientHeight + 1 };
      });
    expect(await fit()).toMatchObject({ fitted: false, runsOn: true });

    await resizeWindow(page, wide);
    expect(await fit()).toEqual({ fitted: true, cut: 0, runsOn: true });

    await resizeWindow(page, phone);
    expect(await fit()).toMatchObject({ fitted: false, runsOn: true });
  });
});
