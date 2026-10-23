// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// UI auth seen from the LAN: no key is a 401 page, `?k=` sets the cookie and redirects,
// the cookie then opens the board. Needs a LAN IPv4 on this machine; skipped otherwise.
import { expect, test } from "@playwright/test";
import { seenSetup } from "../../playwright.config.js";
import { INFO } from "./helpers.js";

interface Info {
  urls: { local: string; lan: string[] };
  uiKey: string;
}

test.describe("auth from a non-loopback address", () => {
  test("401 without the key, ?k= sets the cookie, the cookie opens the board", async ({
    request,
    playwright,
    browser,
  }) => {
    const info = (await (await request.get(INFO)).json()) as Info;
    const lan = info.urls.lan[0];
    test.skip(!lan, "this machine reports no LAN IPv4 address (GET /api/ui/info urls.lan is empty)");
    if (!lan) return;
    expect(info.uiKey).toMatch(/\S{8,}/);

    const api = await playwright.request.newContext({ baseURL: lan });
    try {
      const bare = await api.get("/", { maxRedirects: 0 });
      expect(bare.status()).toBe(401);
      expect(await bare.text()).toContain("This board needs its key");
      const apiBare = await api.get(INFO);
      expect(apiBare.status()).toBe(401);
      expect(await apiBare.json()).toEqual({ reason: "unauthorized" });

      const wrongKey = await api.get(`/?k=${encodeURIComponent(`${info.uiKey}x`)}`, { maxRedirects: 0 });
      expect(wrongKey.status()).toBe(401);

      const keyed = await api.get(`/machines?k=${encodeURIComponent(info.uiKey)}&x=1`, { maxRedirects: 0 });
      expect(keyed.status()).toBe(302);
      expect(keyed.headers().location).toBe("/machines?x=1");
      expect(keyed.headers()["set-cookie"]).toMatch(new RegExp(`^spgui=${encodeURIComponent(info.uiKey)}; Path=/`));
      const cookies = await api.storageState();
      expect(cookies.cookies.find((c) => c.name === "spgui")?.value).toBe(info.uiKey);

      // The cookie alone now opens the page and the API.
      const withCookie = await api.get("/", { maxRedirects: 0 });
      expect(withCookie.status()).toBe(200);
      expect(withCookie.headers()["content-type"]).toMatch(/^text\/html/);
      expect(await withCookie.text()).toContain('<div id="root"');
      const apiWithCookie = await api.get(INFO);
      expect(apiWithCookie.status()).toBe(200);
      // ?k= on an API route is accepted without a cookie too (the QR's first fetch).
      const fresh = await playwright.request.newContext({ baseURL: lan });
      expect((await fresh.get(`${INFO}?k=${encodeURIComponent(info.uiKey)}`)).status()).toBe(200);
      await fresh.dispose();
    } finally {
      await api.dispose();
    }

    // A browser follows the redirect and lands on the live board, cookie set. The LAN
    // address is one of this machine's own, so the first-run redirect to /setup would
    // meet it like any local browser: this one has seen the setup page, as the suite's
    // other contexts have (playwright.config.ts).
    const ctx = await browser.newContext({ baseURL: lan, storageState: { cookies: [], origins: [seenSetup(lan)] } });
    try {
      const page = await ctx.newPage();
      await page.goto(`/?k=${encodeURIComponent(info.uiKey)}`);
      await expect(page).toHaveURL(`${lan}/`);
      await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
      await expect(page.locator("section.group").first()).toBeVisible();
      const cookie = (await ctx.cookies()).find((c) => c.name === "spgui");
      expect(cookie?.value).toBe(info.uiKey);
      // Navigating by URL again still works: the cookie carries the session.
      await page.goto("/connect");
      await expect(page.locator(".sect--phone")).toBeVisible();
      // A fresh context has not chosen a mode, so it is in Simple: the token block is behind "Advanced".
      const fold = page.locator("[data-connect-advanced]");
      if (await fold.isVisible()) await fold.click();
      // The token's group is folded to one line; it opens in place.
      await page.getByRole("button", { name: /^Sink token/ }).click();
      await expect(page.getByRole("button", { name: /^Rotate/ })).toBeDisabled();
    } finally {
      await ctx.close();
    }
  });
});
