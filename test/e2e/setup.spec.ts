// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The first-run page: six steps with the right marks on the demo server (sessions green,
// TLS off → "Turn on", the optional sixth quiet), step 2 further along on the TLS instance, the this-machine guard
// (a LAN address → 403, through the test door's remote-address header), the one-time
// redirect from / and its dismissal, and the https link the pairing page and the pending
// list offer when passkeys cannot work on the origin the daemon printed.
import { expect, test } from "@playwright/test";
import { E2E_TLS_PORT, SETUP_SEEN_KEY } from "../../playwright.config.js";
import { INFO, openPage } from "./helpers.js";

const TLS_HTTPS = `https://localhost:${E2E_TLS_PORT}`;
const TLS_HTTP = `http://127.0.0.1:${E2E_TLS_PORT}`;
const STATUS = "/api/ui/setup/status";
const CONTROL = "/api/sessionpipe/v1/control";

test.describe("setup on the demo server (TLS off)", () => {
  test("six steps: sessions green, secure needs you with Turn on, the rest wait, the sixth optional", async ({
    page,
  }) => {
    await openPage(page, "/setup");
    await expect(page.getByRole("heading", { name: "Set up sessionpipe gui" })).toBeVisible();
    const steps = page.locator("li.step");
    await expect(steps).toHaveCount(6);
    for (const [i, k] of ["sessions", "secure", "pair", "phone", "try", "remote"].entries())
      await expect(steps.nth(i)).toHaveAttribute("data-step", k);
    await expect(steps.nth(0)).toHaveAttribute("data-mark", "done", { timeout: 15_000 });
    await expect(steps.nth(1)).toHaveAttribute("data-mark", "needs");
    await expect(steps.nth(1).getByRole("button", { name: "Turn on" })).toBeVisible();
    await expect(steps.nth(2)).toHaveAttribute("data-mark", "todo");
    await expect(steps.nth(2)).toContainText("finish step 2 first");
    await expect(steps.nth(3)).toHaveAttribute("data-mark", "todo");
    await expect(steps.nth(3).getByRole("img", { name: "QR code for your phone" })).toBeVisible();
    await expect(steps.nth(4)).toHaveAttribute("data-mark", "todo");
    await expect(steps.nth(4)).toContainText("finish steps 2 and 3 first");
    // Step 6 is optional: "todo", never "needs you", the word "optional" in its heading instead.
    await expect(steps.nth(5)).toHaveAttribute("data-mark", "todo");
    await expect(steps.nth(5).locator(".step-title")).toContainText("From anywhere");
    await expect(steps.nth(5).locator(".step-optional")).toHaveText("optional");
    await expect(steps.nth(5).locator(".step-needs")).toHaveCount(0);
    await expect(page.locator("[data-setup-done]")).toHaveCount(0);
    await expect(page.locator("[data-setup-skip]")).toBeVisible();
    // The rail shows the entry with its dot while steps remain.
    await expect(page.locator(".rail [data-nav=setup]")).toBeVisible();
    await expect(page.locator(".rail [data-nav=setup] .nav-dot")).toBeVisible();
    // "why isn't this green?" folds open to the facts.
    await steps.nth(1).locator("summary").click();
    await expect(steps.nth(1).locator(".step-facts")).toContainText("TLS mode");
    await expect(steps.nth(1).locator(".step-facts")).toContainText("off");
  });

  test("the status is this machine's: a LAN address is refused on every setup route", async ({ request }) => {
    // The TLS instance runs with --test-door, whose header stands in for the remote address.
    const lan = await request.get(`${TLS_HTTP}${STATUS}`, { headers: { "x-spgui-test-remote": "192.168.1.9" } });
    expect(lan.status()).toBe(403);
    expect((await lan.json()).reason).toBe("local_only");
    for (const p of ["/tls/on", "/tls/trust", "/pair", "/pair/cancel"]) {
      const r = await request.post(`${TLS_HTTP}/api/ui/setup${p}`, {
        headers: { "x-spgui-test-remote": "192.168.1.9" },
      });
      expect(r.status(), p).toBe(403);
    }
    const here = await request.get(STATUS);
    expect(here.status()).toBe(200);
    const s = await here.json();
    expect(s.events.total).toBeGreaterThan(0);
    expect(s.tls.on).toBe(false);
    expect(s.daemon.pairedHere).toBe(false);
    expect(typeof s.viewers.phones).toBe("number");
    expect(typeof s.tried.delivered).toBe("number");
  });

  test("step 6 shows Tailscale's state on this machine and its actions are this machine's", async ({
    page,
    request,
  }) => {
    const s = (await (await request.get(STATUS)).json()) as {
      remote?: { publicUrl?: string; tailscale: { installed: boolean; running: boolean; dnsName?: string } };
    };
    // TODO(server): drop the skip once /api/ui/setup/status reports `remote` (the server side of step 6).
    test.skip(!s.remote, "the server does not report `remote` yet");
    const r = s.remote!;
    for (const p of ["/remote", "/remote/off"]) {
      const lan = await request.post(`${TLS_HTTP}/api/ui/setup${p}`, {
        headers: { "x-spgui-test-remote": "192.168.1.9", "content-type": "application/json" },
        data: { url: "https://box.tail1234.ts.net" },
      });
      expect(lan.status(), p).toBe(403);
    }
    await openPage(page, "/setup");
    const step = page.locator("li.step[data-step=remote]");
    await expect(step).toBeVisible();
    if (r.publicUrl) {
      await expect(step).toHaveAttribute("data-mark", "done");
      await expect(step).toContainText(r.publicUrl);
    } else if (!r.tailscale.installed) {
      await expect(step.getByRole("link", { name: "tailscale.com/download" })).toHaveAttribute(
        "href",
        "https://tailscale.com/download",
      );
      await expect(step).toContainText("X-Forwarded-For");
    } else if (!r.tailscale.running) {
      await expect(step).toContainText("installed but not connected");
    } else if (r.tailscale.dnsName) {
      await expect(step).toContainText("tailscale serve --bg");
      await expect(step.getByRole("button", { name: `Use https://${r.tailscale.dnsName}` })).toBeEnabled();
    }
    await step.locator("summary").click();
    await expect(step.locator(".step-facts")).toContainText("tailscale");
  });

  test.describe("first run", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("a device that never saw setup is sent from / to /setup once; Skip setup remembers", async ({ page }) => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/setup$/, { timeout: 15_000 });
      await expect(page.getByRole("heading", { name: "Set up sessionpipe gui" })).toBeVisible();
      expect(await page.evaluate((k) => localStorage.getItem(k), SETUP_SEEN_KEY)).toBe("1");
      // The second visit stays on the board.
      await page.goto("/");
      await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator("section.group").first()).toBeVisible();

      // A fresh device again, opening setup by hand and skipping it.
      await page.evaluate((k) => localStorage.removeItem(k), SETUP_SEEN_KEY);
      await openPage(page, "/setup");
      await page.locator("[data-setup-skip]").click();
      await expect(page).toHaveURL(/\/$/);
      expect(await page.evaluate((k) => localStorage.getItem(k), SETUP_SEEN_KEY)).toBe("1");
      // Connect offers the way back.
      await openPage(page, "/connect");
      await expect(page.locator(".connect-setup")).toContainText("Setup");
    });
  });
});

test.describe("setup on the TLS instance", () => {
  test.use({ baseURL: TLS_HTTPS, ignoreHTTPSErrors: true });

  test("step 2 is past Turn on: trust, open the secure address, or already green", async ({ page }) => {
    await openPage(page, "/setup");
    const secure = page.locator("li.step[data-step=secure]");
    await expect(secure).toBeVisible();
    await expect(secure.getByRole("button", { name: "Turn on" })).toHaveCount(0);
    const mark = await secure.getAttribute("data-mark");
    if (mark === "done") {
      await expect(secure).toContainText("Passkeys work here");
    } else {
      const trust = secure.getByRole("button", { name: "Trust on this Mac" });
      const open = secure.getByRole("link", { name: "Open the secure address" });
      await expect(trust.or(open)).toBeVisible();
    }
    await secure.locator("summary").click();
    await expect(secure.locator(".step-facts")).toContainText("on");
    await expect(secure.locator(".step-facts")).toContainText(
      new RegExp(`https://[a-z0-9.-]+\\.local:${E2E_TLS_PORT}`),
    );
    // Step 3 is gated on step 2 unless step 2 is green.
    const pair = page.locator("li.step[data-step=pair]");
    if (mark !== "done") await expect(pair).toContainText("finish step 2 first");
    else await expect(pair.getByRole("button", { name: "Pair this Mac" }).or(pair.locator(".step-note"))).toBeVisible();
  });

  test("the daemon's http link offers the https origin on the pairing page and in the pending list", async ({
    page,
    request,
  }) => {
    const info = (await (await request.get(`${TLS_HTTP}${INFO}`)).json()) as {
      sinkToken: string;
      tls: { httpsUrl: string };
    };
    const started = await request.post(`${TLS_HTTP}${CONTROL}/pair`, {
      headers: { authorization: `Bearer ${info.sinkToken}`, "content-type": "application/json" },
      data: { name: "setup-e2e-box", harnesses: ["claude-code"], modes: ["waiter"], version: "0.8.0" },
    });
    expect(started.status()).toBe(201);
    const { code } = (await started.json()) as { code: string };
    const httpsHost = new URL(info.tls.httpsUrl).host;

    // Plain http on 127.0.0.1: not a secure context, and not the rp id (localhost) either.
    await page.goto(`${TLS_HTTP}/pair?code=${encodeURIComponent(code)}`);
    await expect(page.locator("[data-check]")).toBeVisible();
    const link = page.locator(".pair-https a");
    await expect(link).toHaveText(`Open on ${httpsHost} →`);
    await expect(link).toHaveAttribute("href", new RegExp(`^${info.tls.httpsUrl}/pair\\?code=${code}&k=`));
    await expect(page.getByRole("button", { name: /Approve with passkey/ })).toBeDisabled();

    await page.goto(`${TLS_HTTP}/machines`);
    const item = page.locator(`.pending-item[data-code="${code}"]`);
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item.locator(".pending-link")).toHaveText(`Approve on ${httpsHost} →`);
    await expect(item.locator(".pending-link")).toHaveAttribute("href", new RegExp(`^${info.tls.httpsUrl}/pair`));

    await request.post(`${TLS_HTTP}/api/ui/control/pair/${encodeURIComponent(code)}/reject`);
  });
});
