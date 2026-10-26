// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The Mac app's device key end to end (CONTROL.md §2, §3.2), through the test door's
// software TestDeviceKey standing in for the Secure Enclave: the app asks to be trusted
// (/devices) with its device key, a browser whose passkey the machine trusts approves it
// (a signed key.add carrying the key whole), the machine's delivered ack settles it, and
// then the app sends a start the receiver verifies through the device key's day grant.
// And the one muted line where a daemon predates device keys.
// Run with test/e2e/control-device.config.ts against a demo receiver on the identity port.
import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { CONTROL_BASE, fakeDaemon, passkeyPage, seenSetupHere, sinkToken } from "./control-helpers.js";
import { asMacApp } from "./control-shell.js";

// The receiver's test door holds ONE device key, as a Mac has one: asking to be trusted
// again renews the same key's request and drops the first one's digits. So these tests
// take turns, also under the main config's fullyParallel.
test.describe.configure({ mode: "default" });

// Device keys are on only where the receiver's sessionpipe-core verifies them
// (server/control/devicekeys.ts): Info.control.keyTypes says which. Today's core doesn't,
// so the device path is skipped and the fallback below runs instead.
let device = false;
test.beforeAll(async ({ request }) => {
  const info = (await (await request.get(`${CONTROL_BASE}/api/ui/info`)).json()) as {
    control?: { keyTypes?: string[] };
  };
  device = !!info.control?.keyTypes?.includes("device");
});

const SHOTS = process.env.DEVICE_SHOTS ?? "";
const tag = () => randomUUID().slice(0, 6);
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};
const hello = (name: string, keyTypes?: string[]) => ({
  name,
  harnesses: ["claude-code"],
  folders: ["/Users/e2e/code"],
  home: "/Users/e2e",
  mode: "auto" as const,
  files: true,
  ...(keyTypes ? { key_types: keyTypes } : { version: "0.9.0" }),
});

async function theMacApp(browser: import("@playwright/test").Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  await asMacApp(ctx, CONTROL_BASE);
  return { ctx, page: await ctx.newPage() };
}

async function askToBeTrusted(app: Page): Promise<string> {
  await app.goto(`${CONTROL_BASE}/add-device`);
  await expect(app.getByRole("button", { name: "Add this Mac" })).toBeEnabled();
  await app.getByRole("button", { name: "Add this Mac" }).click();
  const digits = app.locator(".pair-digits");
  await expect(digits).toBeVisible();
  return (await digits.getAttribute("data-check")) ?? "";
}

test("the app's device key: asked for, approved from a browser, key.add delivered, then a start under its grant", async ({
  browser,
}) => {
  test.skip(!device, "this receiver's sessionpipe-core can't verify device keys yet");
  const person = await browser.newContext();
  await seenSetupHere(person);
  const browserPage = await person.newPage();
  const key = await passkeyPage(person, browserPage);
  const sink = await sinkToken();
  const name = `studio-mac-${tag()}`;
  const m = await fakeDaemon(key, hello(name, ["passkey", "device"]), { sinkToken: sink });
  const app = await theMacApp(browser);
  try {
    const check = await askToBeTrusted(app.page);
    await expect(app.page.locator(".pair-lead")).toContainText("Secure Enclave");
    await shot(app.page, "1-app-add-this-mac");
    const calls = () =>
      app.page.evaluate(() => (window as unknown as { __identityCalls: { cmd: string }[] }).__identityCalls);
    expect((await calls()).map((c) => c.cmd)).toContain("plugin:identity|key");

    await browserPage.goto(`${CONTROL_BASE}/machines`);
    const row = browserPage.locator("li.pending-item--device", { hasText: `${check.slice(0, 3)} ${check.slice(3)}` });
    await expect(row.locator(".pending-name")).toHaveText("Mac app");
    await expect(row.locator(".pending-who .pending-meta")).toHaveText("Secure Enclave");
    const target = row.getByRole("combobox", { name: "Machine to trust it on" });
    if (await target.count()) {
      await target.click();
      await browserPage.locator(".sel-opt", { hasText: name }).first().click();
    }
    await shot(browserPage, "2-browser-approves-the-mac-app");
    await row.getByRole("button", { name: "Approve" }).click();

    // The machine got the key whole, inside the signed bytes.
    await expect
      .poll(() => m.seen.find((c) => c.kind === "key.add")?.key as Record<string, unknown> | undefined, {
        timeout: 15_000,
      })
      .toMatchObject({ type: "device", store: "hardware", uv: "each-use", alg: -7 });
    await expect(app.page.locator("[data-added]")).toBeVisible({ timeout: 15_000 });
    await shot(app.page, "3-app-added");

    // The app sends: a start, signed under the device key's day grant (no passkey anywhere).
    const sends: Record<string, unknown>[] = [];
    app.page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/ui/control/send"))
        sends.push(JSON.parse(r.postData() ?? "{}"));
    });
    await app.page.goto(`${CONTROL_BASE}/?new=1&machine=${name}`);
    const sheet = app.page.locator("[data-new-session]");
    await expect(sheet).toBeVisible();
    await sheet.locator("[data-ns-text]").fill("Signed by the Mac app.");
    await expect(sheet.locator("[data-ns-start]")).toBeEnabled();
    await shot(app.page, "4-app-new-session");
    await sheet.locator("[data-ns-start]").click();
    await expect.poll(() => m.seen.some((c) => c.kind === "start"), { timeout: 15_000 }).toBe(true);
    const added = m.seen.find((c) => c.kind === "key.add");
    expect(added).toBeDefined();
    const deviceKey = (added!.key as { id: string }).id;
    expect(sends[0]?.grant).toEqual({ cred: deviceKey, sig: expect.any(String), str: expect.any(String) });
    expect(JSON.parse((sends[0]!.grant as { str: string }).str)).toMatchObject({
      t: "sessionpipe.grant",
      rp: "localhost",
    });
    expect(sends[0]?.confirm).toBeUndefined();
    const signs = (await calls()).filter((c) => c.cmd === "plugin:identity|sign") as unknown as {
      args: { mode: string; receiver: string; rp: string };
    }[];
    expect(signs.at(-1)?.args).toMatchObject({ mode: "grant", receiver: "rxe2e000", rp: "localhost" });
    await shot(app.page, "5-app-started");
  } finally {
    await m.stop();
    await app.ctx.close();
    await person.close();
  }
});

test("a daemon that predates device keys: Approve waits, with one line", async ({ browser }) => {
  test.skip(!device, "this receiver's sessionpipe-core can't verify device keys yet");
  const person = await browser.newContext();
  await seenSetupHere(person);
  const browserPage = await person.newPage();
  const key = await passkeyPage(person, browserPage);
  const name = `old-box-${tag()}`;
  const m = await fakeDaemon(key, hello(name), { offline: true });
  const app = await theMacApp(browser);
  try {
    const check = await askToBeTrusted(app.page);
    await browserPage.goto(`${CONTROL_BASE}/machines`);
    const row = browserPage.locator("li.pending-item--device", { hasText: `${check.slice(0, 3)} ${check.slice(3)}` });
    await expect(row).toBeVisible();
    const target = row.getByRole("combobox", { name: "Machine to trust it on" });
    if (await target.count()) {
      await target.click();
      await browserPage.locator(".sel-opt", { hasText: name }).first().click();
    }
    await expect(row).toContainText(`Update sessionpipe on ${name} to send from the app.`);
    await expect(row.getByRole("button", { name: "Approve" })).toBeDisabled();
    await shot(browserPage, "6-browser-old-daemon");
  } finally {
    await m.stop();
    await app.ctx.close();
    await person.close();
  }
});

test("a receiver that takes passkeys only: the app offers no device key and points to a browser, with no error", async ({
  browser,
}) => {
  test.skip(device, "this receiver takes device keys");
  const person = await browser.newContext();
  await seenSetupHere(person);
  const browserPage = await person.newPage();
  const key = await passkeyPage(person, browserPage);
  // A sessionpipe 0.9 / 0.10 daemon: no key_types in its hello.
  const name = `today-${tag()}`;
  const m = await fakeDaemon(key, hello(name), { offline: true });
  const app = await theMacApp(browser);
  const errors: string[] = [];
  app.page.on("pageerror", (e) => errors.push(e.message));
  // The stand-in signer asks the test door for a key it doesn't have (a 404 the real plugin,
  // which reads the keychain, never makes); any other failed request or error counts.
  app.page.on("console", (c) => {
    if (c.type() === "error" && !c.text().startsWith("Failed to load resource")) errors.push(c.text());
  });
  app.page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("/_test/device/")) errors.push(`${r.status()} ${r.url()}`);
  });
  try {
    const fallback = "This receiver takes passkeys only: send from a browser.";
    await app.page.goto(`${CONTROL_BASE}/add-device`);
    await expect(app.page.getByText(fallback.slice(0, -1), { exact: true })).toBeVisible();
    await expect(app.page.getByRole("button", { name: "Add this Mac" })).toBeDisabled();
    await app.page.goto(`${CONTROL_BASE}/machines`);
    await expect(app.page.locator(".machines-note")).toHaveText(fallback);
    // Nothing asked the signer to make, sign or pair with a key.
    const calls = await app.page.evaluate(
      () => (window as unknown as { __identityCalls: { cmd: string }[] }).__identityCalls,
    );
    expect(calls.map((c) => c.cmd).filter((c) => !c.endsWith("|status"))).toEqual([]);
    // The browser beside it still shows the machine as one it can send to with its passkey.
    await browserPage.goto(`${CONTROL_BASE}/machines`);
    await expect(browserPage.locator(".machines-note")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await m.stop();
    await app.ctx.close();
    await person.close();
  }
});
