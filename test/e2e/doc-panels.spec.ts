// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The document pages are grouped forms at every width: on a desktop each group's rows are
// one inset panel (the raised ground, a hairline edge, the popover radius) on the grouped
// ground, as the Settings window's pane is, and nothing in a panel draws a panel of its
// own. A phone keeps its inset groups as they were: no edge, 16 px insets.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { openPage } from "./helpers.js";
import { openInPhone } from "./phone-shell.js";

/** A token as the browser computes it for a background. */
const tokenColor = (page: Page, token: string) =>
  page.evaluate((t) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${t})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  }, token);

const look = (el: Locator) =>
  el.evaluate((n) => {
    const cs = getComputedStyle(n);
    return {
      bg: cs.backgroundColor,
      border: cs.borderTopWidth,
      left: cs.borderLeftWidth,
      radius: cs.borderTopLeftRadius,
      bottomRadius: cs.borderBottomLeftRadius,
    };
  });

/** A panel: the raised ground and a 1 px edge all round. */
async function expectPanel(el: Locator, bg2: string) {
  await expect(el).toBeVisible();
  const l = await look(el);
  expect(l.bg).toBe(bg2);
  expect(l.border).toBe("1px");
  expect(l.left).toBe("1px");
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`a desktop's document pages, ${colorScheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme });

    test("a machine's facts are one panel on the grouped ground", async ({ page }) => {
      await openPage(page, "/machines");
      const bg2 = await tokenColor(page, "--bg-2");
      await expectPanel(page.locator(".machines .machine-facts").first(), bg2);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        await tokenColor(page, "--grouped-ground"),
      );
    });

    test("a pool is one panel, and its account rows are its ground", async ({ page }) => {
      await openPage(page, "/usage");
      const bg2 = await tokenColor(page, "--bg-2");
      const panel = page.locator(".pool-section > .form-list").first();
      await expectPanel(panel, bg2);
      const acct = panel.locator(".pool-acct").first();
      await expect(acct).toBeVisible();
      expect((await look(acct)).bg).toBe((await look(panel)).bg);
    });

    test("Connect: the QR and its addresses are one panel, an opened fold hangs from its head", async ({ page }) => {
      await openPage(page, "/connect");
      const bg2 = await tokenColor(page, "--bg-2");
      await expectPanel(page.locator(".connect .connect-phone"), bg2);
      // The addresses are rows in it, not a panel in a panel; the caption sits under it.
      const urls = await look(page.locator(".connect-phone .urls"));
      expect(urls.bg).toBe("rgba(0, 0, 0, 0)");
      expect(urls.border).toBe("0px");
      await expect(page.locator(".sect--phone > .connect-phone + .caption")).toHaveText(/^Scan, or open an address/);

      const fold = page.locator(".sect--passkeys");
      const head = fold.locator(".fold-head");
      await expectPanel(head, bg2);
      await head.click();
      const list = fold.locator(".fold-body > .form-list");
      await expect(list).toBeVisible();
      const [h, b] = [await head.boundingBox(), await list.boundingBox()];
      if (!h || !b) throw new Error("no box");
      // One panel: the rows start where the head ends, edge to edge, on the same ground.
      expect(Math.abs(b.y - (h.y + h.height))).toBeLessThan(1);
      expect(b.x).toBeCloseTo(h.x, 0);
      expect(b.width).toBeCloseTo(h.width, 0);
      const [hl, bl] = [await look(head), await look(list)];
      expect(bl.bg).toBe(hl.bg);
      expect(hl.bottomRadius).toBe("0px");
      expect(bl.radius).toBe("0px");
      expect(bl.border).toBe("0px");
    });

    test("Setup's steps are one panel, and step 1's harnesses have no fill of their own", async ({ page }) => {
      // Step 1 lists the agents installed on the receiver's computer: two, whatever the
      // computer running the suite has.
      await page.route("**/api/ui/setup/status", async (r) => {
        const res = await r.fetch();
        const real = (await res.json()) as { harnesses: { name: string; installed: boolean; hooks: string }[] };
        const on: Record<string, string> = { "claude-code": "on", codex: "off" };
        const harnesses = real.harnesses.map((h) =>
          h.name in on ? { ...h, installed: true, hooks: on[h.name] } : { ...h, installed: false },
        );
        await r.fulfill({ response: res, json: { ...real, harnesses } });
      });
      await openPage(page, "/setup");
      const bg2 = await tokenColor(page, "--bg-2");
      const steps = page.locator(".setup .steps");
      await expectPanel(steps, bg2);
      const first = steps.locator(".step").first();
      if ((await first.getAttribute("data-open")) === null) await first.locator(".step-toggle").click();
      const harnesses = first.locator(".step-harnesses");
      await expect(harnesses).toBeVisible();
      const l = await look(harnesses);
      expect(l.bg).toBe("rgba(0, 0, 0, 0)");
      expect(l.border).toBe("0px");
      // The way on under the panel draws no rule of its own: the panel's edge is the divider.
      const end = page.locator(".setup-end, .setup-done").first();
      if (await end.count()) expect((await look(end)).border).toBe("0px");
      // The page asks for its status every two seconds: one in flight at the end is no failure.
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });
  });
}

for (const [width, height] of [
  [390, 844],
  [320, 568],
] as const) {
  test.describe(`the phone at ${width}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });

    test("keeps its inset groups: no edge, 16 px insets", async ({ page }) => {
      await openInPhone(page, "/machines", { receiver: true });
      await expect(page.locator("html")).toHaveAttribute("data-shell", "ios");
      const list = page.locator(".machine-facts").first();
      await expect(list).toBeVisible();
      const l = await list.evaluate((n) => {
        const cs = getComputedStyle(n);
        return { border: cs.borderTopWidth, left: cs.borderLeftWidth, pad: cs.paddingLeft };
      });
      expect(l).toEqual({ border: "0px", left: "0px", pad: "16px" });
    });
  });
}
