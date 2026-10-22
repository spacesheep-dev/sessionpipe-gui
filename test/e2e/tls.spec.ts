// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// TLS mode against the second e2e instance (playwright.config.ts: --tls --rp-id localhost
// on E2E_TLS_PORT): the same port answers http and https, the https origin is a secure
// context, /trust and /ca.crt do what a phone needs, Info.tls is there, and a passkey
// registration (a CDP virtual authenticator) verifies on the https origin, which is the
// whole point. Skipped when the TLS instance could not make certificates (no openssl).
import { expect, test } from "@playwright/test";
import { INFO, WELL_KNOWN } from "./helpers.js";

/** The TLS instance's port, as playwright.config.ts (E2E_TLS_PORT) starts it. */
const E2E_TLS_PORT = Number(process.env.SPGUI_E2E_TLS_PORT ?? 7312);
const E2E_TLS_BASE = `https://localhost:${E2E_TLS_PORT}`;
const HTTP_BASE = `http://127.0.0.1:${E2E_TLS_PORT}`;
const CONTROL = "/api/sessionpipe/v1/control";

interface Info {
  uiKey: string;
  sinkToken: string;
  control: { rpId: string };
  urls: { local: string; lan: string[]; https?: string };
  tls?: { on: boolean; hostname: string; httpsUrl: string; caUrl: string; caFingerprint: string; expiresAt: string };
}

test.use({ baseURL: E2E_TLS_BASE, ignoreHTTPSErrors: true });

test.describe("TLS mode", () => {
  test("one port, both protocols; Info.tls; the rp id stays localhost under --rp-id", async ({ request }) => {
    const plain = await request.get(`${HTTP_BASE}${INFO}`);
    expect(plain.status()).toBe(200);
    const secure = await request.get(`${E2E_TLS_BASE}${INFO}`);
    expect(secure.status()).toBe(200);
    const info = (await secure.json()) as Info;
    expect(info.tls).toMatchObject({ on: true, httpsUrl: expect.stringMatching(/^https:\/\/[a-z0-9.-]+\.local:\d+$/) });
    expect(info.tls?.caFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(info.urls.https).toBe(info.tls?.httpsUrl);
    expect(info.control.rpId).toBe("localhost");
    const wk = (await (await request.get(`${E2E_TLS_BASE}${WELL_KNOWN}`)).json()) as {
      control: { signing: { rp_id: string } };
    };
    expect(wk.control.signing.rp_id).toBe("localhost");
  });

  test("/ca.crt downloads the CA; /trust has the steps and the fingerprint, and knows when it is on https", async ({
    request,
  }) => {
    const info = (await (await request.get(`${HTTP_BASE}${INFO}`)).json()) as Info;
    const ca = await request.get(`${HTTP_BASE}/ca.crt`);
    expect(ca.status()).toBe(200);
    expect(ca.headers()["content-type"]).toBe("application/x-x509-ca-cert");
    expect(ca.headers()["content-disposition"]).toMatch(/^attachment; filename="sessionpipe-gui-[a-z0-9-]+\.crt"$/);
    expect(await ca.text()).toMatch(/^-----BEGIN CERTIFICATE-----/);

    const trust = await request.get(`${HTTP_BASE}/trust`);
    expect(trust.status()).toBe(200);
    const html = await trust.text();
    expect(html).toContain("Passkeys from this phone");
    expect(html).toContain(info.tls!.caFingerprint);
    for (const step of [
      "Download the certificate",
      "Profile Downloaded",
      "Certificate Trust Settings",
      info.tls!.httpsUrl,
    ])
      expect(html).toContain(step);
    expect(html).toContain("Install a certificate"); // Android
    expect(html).toContain("sessionpipe-gui tls trust"); // Mac
    expect(html).toContain("update-ca-certificates"); // Linux

    const here = await request.get(`${E2E_TLS_BASE}/trust`);
    expect(await here.text()).toContain("Passkeys are available here");
  });

  test("the https origin is a secure context and the board loads there", async ({ page }) => {
    await page.goto("/");
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    expect(await page.evaluate(() => location.protocol)).toBe("https:");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await page.goto("/trust");
    await expect(page.getByRole("heading", { name: "Passkeys are available here" })).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/secure/);
  });

  test("Connect shows the passkeys block with the https address and the trust link", async ({ page, request }) => {
    const info = (await (await request.get(`${HTTP_BASE}${INFO}`)).json()) as Info;
    await page.goto("/connect");
    const block = page.locator(".sect--passkeys");
    await expect(block).toBeVisible();
    await expect(block).toContainText("HTTPS");
    await expect(block).toContainText("On · rp id localhost");
    await expect(block.locator(".passkeys-url code")).toHaveText(`${info.tls!.httpsUrl}/?k=${info.uiKey}`);
    await expect(block.locator(".passkeys-fp")).toHaveText(info.tls!.caFingerprint);
    await expect(block.locator(".passkeys-trust")).toHaveAttribute("href", /\/trust\?k=/);
    await expect(block).toContainText("sessionpipe control pair http://localhost");
    // Trust page via the QR path: the SVG encodes the trust url, not the board.
    const qr = await request.get(`${HTTP_BASE}/api/ui/qr.svg`);
    expect(qr.status()).toBe(200);
    expect(await qr.text()).toContain("<svg");
  });

  test("a passkey made on the https origin verifies here (pairing approved with a virtual authenticator)", async ({
    page,
    context,
    request,
  }) => {
    const info = (await (await request.get(`${HTTP_BASE}${INFO}`)).json()) as Info;
    // The machine's daemon, as far as pairing needs it: one POST with the sink token.
    const started = await request.post(`${HTTP_BASE}${CONTROL}/pair`, {
      headers: { authorization: `Bearer ${info.sinkToken}`, "content-type": "application/json" },
      data: {
        name: "tls-e2e-box",
        harnesses: ["claude-code"],
        modes: ["sdk"],
        version: "0.7.0",
        folders: ["/tmp/proj"],
        mode: "safe",
      },
    });
    expect(started.status()).toBe(201);
    const { code, check } = (await started.json()) as { code: string; check: string };

    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(`/pair?code=${encodeURIComponent(code)}`);
    await expect(page.locator("[data-check]")).toHaveAttribute("data-check", check);
    await expect(page.locator(".pair-note--err")).toHaveCount(0);
    await page.getByRole("button", { name: "Approve with passkey" }).click();
    await expect(page.locator(".pair-note--ok")).toContainText("Approved", { timeout: 20_000 });

    // The daemon's status poll now carries the key the https origin registered.
    const status = await request.get(`${HTTP_BASE}${CONTROL}/pair?code=${encodeURIComponent(code)}`, {
      headers: { authorization: `Bearer ${info.sinkToken}` },
    });
    expect(status.status()).toBe(200);
    const paired = (await status.json()) as { status: string; key?: { id: string; alg: number } };
    expect(paired.status).toBe("paired");
    expect(paired.key?.alg).toBe(-7);
  });
});
