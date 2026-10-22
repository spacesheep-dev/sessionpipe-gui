// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Machines: both demo machines with harness versions and the pair hint. Connect: the QR
// image, the sink command behind Reveal, the demo toggle, copy buttons.
import { expect, test } from "@playwright/test";
import { INFO, openPage } from "./helpers.js";

interface Info {
  urls: { local: string; lan: string[] };
  sinkCommand: string;
  sinkToken: string;
  uiKey: string;
  sources: { demo: boolean };
}

test.describe("connect keeps its scroll", () => {
  test.use({ viewport: { width: 1100, height: 600 } });
  test("scrolled to the bottom, the page stays put through eight seconds of live events", async ({ page, request }) => {
    await openPage(page, "/connect");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    const y = await page.evaluate(() => window.scrollY);
    expect(y).toBeGreaterThan(200);
    // A stream event lands meanwhile (the demo keeps them coming; one more for good measure).
    const info = (await (await request.get(INFO)).json()) as Info;
    await request.get(INFO, { headers: { accept: "application/json" } });
    expect(info.sinkToken.length).toBeGreaterThan(0);
    await page.waitForTimeout(8000);
    expect(await page.evaluate(() => window.scrollY)).toBe(y);
  });
});

test.describe("machines", () => {
  test("lists both demo machines with harness versions and the pair command", async ({ page, request }) => {
    const info = (await (await request.get(INFO)).json()) as Info;
    const lan = info.urls.lan[0] ?? info.urls.local;
    await openPage(page, "/machines");
    for (const name of ["studio-mac", "build-box"]) {
      const block = page.locator("section.machine", { has: page.locator("h2.machine-name", { hasText: name }) });
      await expect(block).toBeVisible();
      await expect(block.locator(".machine-last")).toHaveText(/(online|quiet) · last event/);
      await expect(block.locator(".machine-harness").first()).toBeVisible();
      await expect(block.locator(".machine-ver").first()).toHaveText(/^\d+\.\d+\.\d+$/);
      await expect(block.locator(".unpaired")).toHaveText("Not paired");
      await expect(block.locator(".machine-ctl-row code")).toHaveText(`sessionpipe control pair ${lan}`);
    }
    const versions = await page.locator(".machine-ver").allInnerTexts();
    expect(versions).toEqual(expect.arrayContaining(["2.1.296", "0.157.1"]));
  });
});

test.describe("connect", () => {
  test("QR image loads as SVG, the sink command reveals the token, demo is on, copy buttons", async ({
    page,
    request,
  }) => {
    const qr = await request.get("/api/ui/qr.svg");
    expect(qr.status()).toBe(200);
    expect(qr.headers()["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(await qr.text()).toContain("<svg");
    const info = (await (await request.get(INFO)).json()) as Info;
    expect(info.sinkToken).toMatch(/^spg_/);

    await openPage(page, "/connect");
    const img = page.getByRole("img", { name: /^QR code with the LAN address/ });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const cmd = page.locator(".cmd-text");
    await expect(cmd).toContainText("sessionpipe sink add");
    await expect(cmd).not.toContainText(info.sinkToken);
    await page.getByRole("button", { name: "Reveal" }).click();
    await expect(cmd).toHaveText(info.sinkCommand);
    await expect(cmd).toContainText(info.sinkToken);
    await expect(page.locator(".token-text")).toHaveText(info.sinkToken);
    await page.getByRole("button", { name: "Hide" }).click();
    await expect(cmd).not.toContainText(info.sinkToken);

    const demo = page.getByRole("switch", { name: "Demo mode" });
    await expect(demo).toHaveAttribute("aria-checked", String(info.sources.demo));
    await expect(demo).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("dd.demo > span")).toHaveText(/^on ·/);

    const copies = page.getByRole("button", { name: /^Copy( command)?$/ });
    expect(await copies.count()).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole("button", { name: "Copy command" })).toBeVisible();
    await expect(page.locator(".urls code.url").first()).toHaveText(/^http:\/\//);
  });
});
