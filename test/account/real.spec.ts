// SPDX-License-Identifier: Apache-2.0
// The page on an account, run once against a real spacesheep on this machine (never
// spacesheep.dev, staging or beta: the origin must be loopback). What stands in: the hub
// (test/account/hub.ts, with the real spacesheep upstream of its doors), the phone's
// Secure Enclave key (a software P-256 key that spacesheep's computer already trusts), and
// the computer (a script that takes its jobs and sends its hooks). spacesheep itself, its
// relay, its jobs, its second look and its verifier are the real ones. See manual.config.ts.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { FakeAnswer, FakeRequest } from "./fake-spacesheep.js";
import { HubStandIn } from "./hub.js";
import { startAccountServer } from "./serve.js";
import { fakeShell } from "./shell-init.js";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/web");
const ORIGIN = process.env.ACCOUNT_REAL_ORIGIN ?? "";
const SHOTS = process.env.ACCOUNT_REAL_SHOTS ?? "";

/** A real spacesheep as the hub's upstream: the request as it is, the answer as it came. */
async function ask(req: FakeRequest): Promise<FakeAnswer> {
  const res = await fetch(`${ORIGIN}${req.path}`, {
    method: req.method,
    headers: {
      accept: "application/json",
      ...(req.authorization ? { authorization: req.authorization } : {}),
      ...(req.body ? { "content-type": "application/json" } : {}),
    },
    ...(req.body ? { body: req.body } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
    redirect: "manual",
  });
  const headers: Record<string, string> = {};
  for (const h of ["content-type", "retry-after"]) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return { status: res.status, headers, body: await res.text() };
}

test("the page on an account against a real local spacesheep", async ({ browser }) => {
  test.skip(!ORIGIN, "set ACCOUNT_REAL_ORIGIN (see manual.config.ts)");
  expect(new URL(ORIGIN).hostname, "a spacesheep on this machine only").toMatch(/^(localhost|127\.0\.0\.1)$/);
  const link = JSON.parse(readFileSync(process.env.ACCOUNT_REAL_KEY!, "utf8")) as { key: string; email: string };
  const device = readFileSync(process.env.ACCOUNT_REAL_DEVICE!, "utf8");
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const hub = new HubStandIn({ upstream: { origin: ORIGIN, ask } });
  hub.add(link.email, link.key);
  const server = await startAccountServer({ web: WEB, hub });
  const report: Record<string, unknown> = {};

  // One launch, so the relay is read from its start once (a real spacesheep counts the reads).
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
  });
  // The device key the computer already trusts, where the software signer keeps its own.
  await context.addInitScript((k) => localStorage.setItem("account-test.devicekey", k), device);
  await context.addInitScript(fakeShell, {});
  const page = await context.newPage();
  // ACCOUNT_REAL_THROTTLE=4: the page's CPU slowed, as a phone's is next to this machine's.
  const throttle = Number(process.env.ACCOUNT_REAL_THROTTLE ?? 1);
  if (throttle > 1)
    await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const view = () =>
    page.evaluate(() =>
      (window as unknown as { __sessionpipeAccount: { view(): unknown } }).__sessionpipeAccount.view(),
    ) as Promise<{ catching: boolean }>;
  /** The page as it is now, in both schemes. */
  const shots = async (name: string) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: "light" });
  };

  // The board, from the relay: the first launch reads all the relay holds.
  await page.goto(server.url);
  await expect(page.getByText("Phone app on a spacesheep account").first()).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => (await view()).catching, { timeout: 300_000 }).toBe(false);
  report.board = await view();
  await shots("board");

  // A session's page.
  await page.getByText("Phone app on a spacesheep account").first().click();
  const box = page.getByLabel("Message for the next turn");
  await expect(box).toBeEnabled();
  await page.waitForTimeout(800);
  await shots("session");

  // A message: spacesheep's own second look holds it (locally it always does), the page
  // shows it held, and the confirm sends it; the computer takes it and its answer comes back.
  const text = "ping from the page on an account";
  await box.fill(text);
  await box.press("Enter");
  const notice = page.locator("[data-held]");
  await expect(notice).toBeVisible();
  await expect(notice.locator("[data-held-what]")).toHaveText(text);
  await shots("held");
  await notice.locator("[data-held-confirm]").click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByText(`Got it from the phone: "${text}"`).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await shots("send-result");
  report.taps = await page.evaluate(() =>
    (window as unknown as { __taps: { purpose: string }[] }).__taps.map((t) => t.purpose),
  );
  report.errors = errors;
  report.asked = await page.evaluate(() => [
    ...(window as unknown as { __sessionpipeAccount: { asked: Map<string, number> } }).__sessionpipeAccount.asked,
  ]);
  await context.close();
  report.doors = [...new Set(hub.log)];
  report.strays = server.strays;
  console.log(`REPORT ${JSON.stringify(report)}`);
  expect(server.strays).toEqual([]);
  await server.close();
});
