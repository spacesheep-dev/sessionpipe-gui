// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The /phone page against stubbed phone routes (the scenes the mock also knows): the lane
// it recommends, the two sides, the waiting digits, the trusted list, axe on each, a
// keyboard walk to the one button, and the wrong-origin guard on the session composer.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { openBoard, openPage } from "./helpers.js";

type Scene = "tailscale" | "serving" | "wifi" | "waiting" | "trusted";

function phoneInfo(scene: Scene) {
  const serving = scene === "serving";
  const ts = scene === "tailscale" || serving;
  const at = Date.now();
  return {
    lan: { url: "http://192.168.1.20:7373/?k=uik_demo0000000000000000", qr: "/api/ui/qr.svg" },
    rpId: serving ? "studio-mac.tail1234.ts.net" : "studio-mac.local",
    tls: true,
    publicUrl: serving ? "https://studio-mac.tail1234.ts.net" : null,
    tailscale: ts
      ? { installed: true, running: true, name: "studio-mac.tail1234.ts.net", serving }
      : { installed: false, running: false, name: null, serving: false },
    trusted: scene === "trusted" ? [{ id: "k1", name: "iPhone", addedAt: new Date(at - 95_000).toISOString() }] : [],
    pending:
      scene === "waiting"
        ? [{ id: "req1", name: "iPhone", digits: "482913", since: new Date(at - 20_000).toISOString() }]
        : [],
  };
}

/** Stubs the phone routes, the info's control block and (phone side) the setup status. */
async function stub(page: Page, scene: Scene, side: "laptop" | "phone" = "laptop") {
  const info = phoneInfo(scene);
  const origin = info.publicUrl ?? "https://studio-mac.local:7373";
  await page.route("**/api/ui/phone", (r) => r.fulfill({ json: info }));
  await page.route("**/api/ui/phone/device/*", (r) =>
    r.fulfill({
      json:
        scene === "trusted"
          ? { state: "trusted", digits: "482913", machine: "studio-mac" }
          : { state: "pending", digits: "482913", machine: null },
    }),
  );
  await page.route("**/api/ui/info", async (r) => {
    const real = await (await r.fetch()).json();
    await r.fulfill({ json: { ...real, control: { ...real.control, rpId: info.rpId, origins: [origin] } } });
  });
  await page.route("**/api/ui/control/devices", (r) =>
    r.fulfill({
      json: {
        devices: info.pending.map((p) => ({
          requestId: p.id,
          check: p.digits,
          key: { id: "c1", alg: -7, spki: "" },
          name: p.name,
          device: "iPhone · Safari",
          fromIp: "192.168.1.31",
          createdAt: p.since,
          expiresAt: new Date(Date.parse(p.since) + 600_000).toISOString(),
          status: "pending",
        })),
      },
    }),
  );
  if (side === "phone")
    await page.route("**/api/ui/setup/status", (r) => r.fulfill({ status: 403, json: { reason: "not_this_machine" } }));
  return { info, origin };
}

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect
    .soft(
      bad.map((v) => ({ id: v.id, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })),
      `${label}: axe`,
    )
    .toEqual([]);
}

test.describe("the phone page", () => {
  // The info route re-fetches the real answer; one may still be in flight as a test ends.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("recommends Tailscale when it runs here, with one button and a chip", async ({ page }) => {
    await stub(page, "tailscale");
    await openPage(page, "/phone");
    const lane = page.locator(".ph-lane[data-lane=tailscale]").first();
    await expect(page.locator(".phone-page")).toHaveAttribute("data-lane", "tailscale");
    await expect(lane.getByRole("button", { name: "Use Tailscale" })).toBeVisible();
    await expect(lane.locator(".ph-chip")).toHaveText("running");
    await expect(page.locator(".ph-other summary")).toHaveText("Other ways");
    await axe(page, "phone/tailscale");
  });

  test("falls back to the same Wi-Fi with the trust QR and both phones' steps, iPhone first", async ({ page }) => {
    await stub(page, "wifi");
    await openPage(page, "/phone");
    await expect(page.locator(".phone-page")).toHaveAttribute("data-lane", "wifi");
    const lane = page.locator(".ph-lane[data-lane=wifi]").first();
    await expect(lane.getByRole("img", { name: /trust page/ })).toBeVisible();
    const lists = lane.locator("ol.step-list");
    await expect(lists).toHaveCount(2);
    await expect(lists.nth(0)).toHaveAttribute("data-os", "iphone");
    await expect(lists.nth(0)).toContainText("Certificate Trust Settings");
    await expect(lists.nth(1)).toContainText("Install from storage");
    // On the laptop there is no Check: that is the phone's button.
    await expect(lane.getByRole("button", { name: "Check" })).toHaveCount(0);
    await axe(page, "phone/wifi");
  });

  test("shows a waiting device with its six digits and one Approve, and the trusted list", async ({ page }) => {
    await stub(page, "waiting");
    await openPage(page, "/phone");
    const row = page.locator(".pending-devices .pending-item").first();
    await expect(row).toContainText("iPhone");
    await expect(row.locator(".pending-digits")).toHaveText("482 913");
    await expect(row.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(page.locator("[data-nothing-pending]")).toHaveCount(0);
    await axe(page, "phone/waiting");

    await page.unroute("**/api/ui/phone");
    await stub(page, "trusted");
    await page.reload();
    await expect(page.locator(".ph-trusted li").first()).toContainText("iPhone");
    await expect(page.locator("[data-phone-step='3']")).toHaveAttribute("data-mark", "done");
  });

  test("the phone side: its own OS's steps, a Check, and step 3 gated until https", async ({ page }) => {
    await stub(page, "wifi", "phone");
    await openPage(page, "/phone");
    await expect(page.locator(".phone-page")).toHaveAttribute("data-side", "phone", { timeout: 15_000 });
    const lane = page.locator(".ph-lane[data-lane=wifi]").first();
    await expect(lane.locator("ol.step-list")).toHaveCount(1);
    await expect(lane.getByRole("button", { name: "Check" })).toBeVisible();
    await expect(page.locator("[data-phone-step='3']")).toContainText("After step 2");
    // Keyboard: Tab reaches Check.
    await lane.getByRole("link", { name: /trust page/ }).focus();
    await page.keyboard.press("Tab");
    await expect(lane.getByRole("button", { name: "Check" })).toBeFocused();
    await axe(page, "phone/side=phone");
  });

  test("the wrong-origin guard: the composer names where sending works and offers no device", async ({ page }) => {
    const { origin } = await stub(page, "wifi");
    await openBoard(page);
    const href = (await page.locator("article.card a.card-link").first().getAttribute("href"))!;
    await page.goto(href.split("?")[0]!);
    const hint = page.locator(".ctl-hint[data-wrong-origin]").first();
    await expect(hint).toContainText(`Sending works from ${origin}; open it there.`);
    const there = await hint.getByRole("link").getAttribute("href");
    expect(there?.startsWith(`${origin}/s/`)).toBe(true);
    await expect(page.getByRole("link", { name: /Add this device|Add it/ })).toHaveCount(0);
  });
});
