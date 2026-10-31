// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The phone app's first run (the `phone` project, 390×844, with the fake phone shell of
// phone-shell.ts): the welcome's three ways in, scan → connecting → the board and the
// connected sheet, a code that isn't from sessionpipe, the TLS code's trust page, a
// refused camera, a scan that can't run, the address path with its failures, and the
// Mac's words never on the phone. The last tests are the phone shell at tablet width.
import { expect, type Page, test } from "@playwright/test";
import {
  haptics,
  openInPhone,
  PHONE_FEATURES,
  setAdd,
  settleAdd,
  settleScan,
  shellCallArgs,
  shellCalls,
} from "./phone-shell.js";

const welcome = (page: Page) => page.locator(".onb[data-step='welcome']");
const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name });

/** The app comes back to the foreground (from Safari, from Settings). */
const foreground = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
const setCamera = (page: Page, camera: string) =>
  page.evaluate((c) => {
    (window as unknown as { __fake: { camera: string } }).__fake.camera = c;
  }, camera);

test.describe("the phone's first run", () => {
  test("the welcome: the lockup, one line, three ways in, nothing fetched", async ({ page }) => {
    const hits: string[] = [];
    page.on("request", (r) => {
      if (/\/(api|themes|skins|attachments)\//.test(new URL(r.url()).pathname)) hits.push(r.url());
    });
    await openInPhone(page, "/");
    await expect(welcome(page)).toBeVisible();
    await expect(page.getByRole("img", { name: "sessionpipe" })).toBeVisible();
    await expect(page.getByText("Every coding agent you run, on one board.")).toBeVisible();
    const scan = button(page, "Scan the code on your computer");
    const address = button(page, "Enter an address");
    const demo = button(page, "Try the demo");
    for (const b of [scan, address, demo]) await expect(b).toBeVisible();
    // One primary action, the app's ink primary (never an orange fill); the demo is the quiet one.
    await expect(scan).toHaveClass(/btn--primary/);
    await expect(address).not.toHaveClass(/btn--primary/);
    await expect(demo).toHaveClass(/btn--ghost/);
    expect(await scan.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 90, 31)");
    // Stacked, in that order, each a full-width finger target.
    const boxes = await Promise.all([scan, address, demo].map((b) => b.boundingBox()));
    expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
    expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
    for (const b of boxes) expect(b!.height).toBeGreaterThanOrEqual(44);
    expect(boxes[0]!.width).toBeGreaterThan(300);
    // The disclosure sits between the ways in and the demo.
    const help = button(page, "No sessionpipe on your computer yet?");
    const hb = await help.boundingBox();
    expect(hb!.y).toBeGreaterThan(boxes[1]!.y);
    expect(hb!.y).toBeLessThan(boxes[2]!.y);
    // Nothing of the Mac's welcome, and no request left the phone.
    await expect(page.getByText("This Mac")).toHaveCount(0);
    await expect(page.getByText(/\bMac\b/)).toHaveCount(0);
    expect(hits).toEqual([]);
    // The camera was not asked for.
    expect(await shellCalls(page)).not.toContain("plugin:barcode-scanner|check_permissions");
    // Nothing scrolls.
    const { scrollHeight, innerHeight } = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    expect(scrollHeight).toBeLessThanOrEqual(innerHeight);
  });

  test("without a scanner the address is the primary way; the demo opens offline", async ({ page }) => {
    await openInPhone(page, "/", { features: PHONE_FEATURES.filter((f) => f !== "scanner") });
    await expect(welcome(page)).toBeVisible();
    await expect(button(page, "Scan the code on your computer")).toHaveCount(0);
    await expect(button(page, "Enter an address")).toHaveClass(/btn--primary/);
    await page.route(/\/(api|\.well-known|themes|skins|attachments)\//, (r) => r.abort());
    await button(page, "Try the demo").click();
    await expect(page).toHaveURL(/\?mock=1/);
    await expect(page.locator("section.group").first()).toBeVisible({ timeout: 15_000 });
  });

  test("the install card: three steps, the command, the site", async ({ page }) => {
    await openInPhone(page, "/");
    const help = button(page, "No sessionpipe on your computer yet?");
    await expect(help).toHaveAttribute("aria-expanded", "false");
    await help.click();
    await expect(help).toHaveAttribute("aria-expanded", "true");
    const card = page.getByRole("region", { name: "Three steps on your computer" });
    await expect(card).toBeVisible();
    await expect(card.getByText("Install sessionpipe on your computer")).toBeVisible();
    await expect(card.getByText("Open sessionpipe there and choose Connect")).toBeVisible();
    await expect(card.getByText("Connect shows a code made for this phone.")).toBeVisible();
    await expect(card.getByText("Scan it with this phone")).toBeVisible();
    const cmd = card.locator(".cmdwell-text");
    await expect(cmd).toHaveText("npx -y sessionpipe-gui service install");
    // The command wraps instead of scrolling, and there is nothing to copy with.
    expect(await cmd.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(card.getByRole("button")).toHaveCount(0);
    await card.getByRole("link", { name: "sessionpipe.org/gui" }).click();
    expect(await shellCallArgs(page, "app_open_external")).toEqual([{ url: "https://sessionpipe.org/gui" }]);
    // The question is the toggle.
    await help.click();
    await expect(card).toBeHidden();
    await expect(help).toHaveAttribute("aria-expanded", "false");
  });

  test("scan → connecting → the board, then the connected sheet", async ({ page }) => {
    await openInPhone(page, "/", { firstRunDone: false, scan: { hold: true } });
    await button(page, "Scan the code on your computer").click();
    // The camera is asked for only now, and the page is transparent under the viewfinder.
    await expect(page.locator("html")).toHaveAttribute("data-scanning", "");
    const calls = await shellCalls(page);
    expect(calls).toContain("plugin:barcode-scanner|check_permissions");
    expect(calls).not.toContain("plugin:barcode-scanner|request_permissions");
    expect(calls.indexOf("plugin:barcode-scanner|check_permissions")).toBeLessThan(
      calls.indexOf("plugin:barcode-scanner|scan"),
    );
    const finder = page.getByRole("dialog", { name: "Scan the code on your computer" });
    await expect(finder).toBeVisible();
    await expect(finder.getByText("Point the camera at the code under Connect.")).toBeVisible();
    await expect(finder).toHaveAttribute("aria-describedby", "onb-scan-caption");
    await expect(finder.getByRole("button", { name: "Cancel" })).toBeVisible();
    for (const el of ["html", "body", ".onb"])
      expect(await page.locator(el).evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    // The cut-out is a square, centred, with four orange corners.
    const cut = await finder.locator(".onb-cutout").boundingBox();
    expect(Math.abs(cut!.width - cut!.height)).toBeLessThan(1);
    expect(Math.abs(cut!.x + cut!.width / 2 - 195)).toBeLessThan(2);
    await expect(finder.locator(".onb-corner")).toHaveCount(4);
    expect(
      await finder
        .locator(".onb-corner")
        .first()
        .evaluate((e) => getComputedStyle(e).borderTopColor),
    ).toBe("rgb(255, 90, 31)");
    // The code: connecting to the computer, named from the address.
    await settleScan(page, "{origin}/?k=uik_e2e_test");
    await expect(page.locator("html")).not.toHaveAttribute("data-scanning");
    await expect(page.getByRole("heading", { name: "Connecting to 127.0.0.1…" })).toBeVisible();
    expect(await haptics(page)).toContain("success");
    expect(await shellCallArgs(page, "rx_add")).toEqual([{ url: `${page.url().replace(/\/$/, "")}/?k=uik_e2e_test` }]);
    // The shell rebuilt the window on it: the board streams.
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await expect(page.locator("section.group").first()).toBeVisible();
    // The connected sheet: one step left, in the phone's words, where to do it in the
    // computer's own labels, and the one action that files the request.
    const sheet = page.getByRole("dialog", { name: "You're in." });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(
      "Reading works now. To answer prompts from this iPhone, studio-mac has to approve it once.",
    );
    await expect(sheet).toContainText("On studio-mac: Machines › studio-mac › Devices › Approve.");
    await expect(sheet.getByRole("switch")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Later" })).toBeVisible();
    const ask = sheet.getByRole("button", { name: "Ask studio-mac to approve" });
    await expect(ask).toHaveClass(/btn--primary/);
    // It is a sheet: on the bottom edge.
    const box = await sheet.boundingBox();
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(843);
    await ask.click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/add-device\?ask=1$/);
    await expect(page.getByRole("heading", { name: "Approve this iPhone" })).toBeVisible();
    expect(await shellCalls(page)).toContain("app_first_run_done");
  });

  test("Later closes the sheet for good, and nothing was asked for", async ({ page }) => {
    await openInPhone(page, "/", { receiver: true, firstRunDone: false });
    const sheet = page.getByRole("dialog", { name: "You're in." });
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    expect(await shellCalls(page)).not.toContain("app_notify_request");
    await sheet.getByRole("button", { name: "Later" }).click();
    await expect(sheet).toBeHidden();
    expect(await shellCalls(page)).toContain("app_first_run_done");
    await expect(page).toHaveURL(/\/$/);
  });

  test("a code that isn't from sessionpipe says so; Scan again scans again", async ({ page }) => {
    await openInPhone(page, "/", { scan: { text: "WIFI:S:home;T:WPA;P:secret;;" } });
    await button(page, "Scan the code on your computer").click();
    await expect(page.getByRole("heading", { name: "That code isn't from sessionpipe" })).toBeVisible();
    expect(await haptics(page)).toContain("error");
    expect(await shellCalls(page)).not.toContain("rx_add");
    await expect(button(page, "Scan again")).toHaveClass(/btn--primary/);
    await expect(button(page, "Enter an address")).toBeVisible();
    await button(page, "Scan again").click();
    await expect
      .poll(async () => (await shellCalls(page)).filter((c) => c === "plugin:barcode-scanner|scan").length)
      .toBe(2);
    await expect(page.getByRole("heading", { name: "That code isn't from sessionpipe" })).toBeVisible();
    await button(page, "Back").click();
    await expect(welcome(page)).toBeVisible();
  });

  test("the TLS code, in two beats: open the trust page in Safari; back again, Connect", async ({ page }) => {
    await openInPhone(page, "/", { scan: { text: "https://studio-mac.local:7373/trust?k=uik_e2e" }, add: "hold" });
    await button(page, "Scan the code on your computer").click();
    await expect(page.getByRole("heading", { name: "Trust studio-mac on this phone" })).toBeVisible();
    await expect(
      page.getByText("Safari opens a page that installs studio-mac's certificate. Follow it, then come back here."),
    ).toBeVisible();
    // The first beat: one button.
    await expect(button(page, "Open in Safari")).toHaveClass(/btn--primary/);
    await expect(button(page, "Connect")).toHaveCount(0);
    await button(page, "Open in Safari").click();
    expect(await shellCallArgs(page, "app_open_external")).toEqual([
      { url: "https://studio-mac.local:7373/trust?k=uik_e2e" },
    ]);
    // The second beat, once the app is back in front.
    await foreground(page);
    await expect(button(page, "Connect")).toHaveClass(/btn--primary/);
    await expect(button(page, "Open in Safari")).toHaveCount(0);
    await button(page, "Open the page again").click();
    expect(await shellCallArgs(page, "app_open_external")).toHaveLength(2);
    await button(page, "Connect").click();
    await expect(page.getByRole("heading", { name: "Connecting to studio-mac…" })).toBeVisible();
    expect(await shellCallArgs(page, "rx_add")).toEqual([{ url: "https://studio-mac.local:7373/trust?k=uik_e2e" }]);
    await settleAdd(page, { error: "connection refused (os error 61)" });
    await expect(page.getByRole("heading", { name: "Couldn't reach studio-mac" })).toBeVisible();
  });

  test("a cancelled scan goes back to the welcome", async ({ page }) => {
    await openInPhone(page, "/", { scan: { hold: true } });
    await button(page, "Scan the code on your computer").click();
    await expect(page.locator("html")).toHaveAttribute("data-scanning", "");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(welcome(page)).toBeVisible();
    expect(await shellCalls(page)).toContain("plugin:barcode-scanner|cancel");
  });

  test("the camera refused: a plain reason, Open Settings, the address instead", async ({ page }) => {
    await openInPhone(page, "/", { camera: "prompt", grant: "denied" });
    await button(page, "Scan the code on your computer").click();
    await expect(page.getByRole("heading", { name: "sessionpipe can't use the camera" })).toBeVisible();
    await expect(page.getByText("Turn it on in Settings to scan the code on your computer.")).toBeVisible();
    const calls = await shellCalls(page);
    expect(calls).toContain("plugin:barcode-scanner|request_permissions");
    expect(calls).not.toContain("plugin:barcode-scanner|scan");
    await button(page, "Open Settings").click();
    expect(await shellCalls(page)).toContain("plugin:barcode-scanner|open_app_settings");
    // Back from Settings with the camera still off: the screen stays.
    await foreground(page);
    await expect(page.getByRole("heading", { name: "sessionpipe can't use the camera" })).toBeVisible();
    expect(await shellCalls(page)).not.toContain("plugin:barcode-scanner|scan");
    await button(page, "Enter the address instead").click();
    await expect(page.getByRole("heading", { name: "Your computer's address" })).toBeVisible();
  });

  test("the camera turned on in Settings: back in the app, the scan starts by itself", async ({ page }) => {
    await openInPhone(page, "/", { camera: "denied", scan: { hold: true } });
    await button(page, "Scan the code on your computer").click();
    await expect(page.getByRole("heading", { name: "sessionpipe can't use the camera" })).toBeVisible();
    await setCamera(page, "granted");
    await foreground(page);
    await expect(page.locator("html")).toHaveAttribute("data-scanning", "");
    await expect(page.getByRole("dialog", { name: "Scan the code on your computer" })).toBeVisible();
  });

  test("a scan that can't run (the simulator) is said, with the address as the way out", async ({ page }) => {
    await openInPhone(page, "/", { scan: { throws: "No camera available on this device" } });
    await button(page, "Scan the code on your computer").click();
    await expect(page.getByRole("heading", { name: "The camera isn't available" })).toBeVisible();
    await expect(page.getByText("Enter the address from Connect instead.")).toBeVisible();
    await expect(page.getByText("No camera available on this device")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-scanning");
    await button(page, "Enter the address instead").click();
    await expect(page.getByRole("heading", { name: "Your computer's address" })).toBeVisible();
  });

  test("the address: the field, a refusal in words, a computer out of reach, then the board", async ({ page }) => {
    await openInPhone(page, "/", { add: { error: "failed to connect to studio-mac.local:7373" } });
    await button(page, "Enter an address").click();
    const field = page.getByRole("textbox", { name: "Your computer's address" });
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("inputmode", "url");
    await expect(field).toHaveAttribute("enterkeyhint", "go");
    // The form sits under the title, in the upper half, Connect right under the field.
    const fb = await field.boundingBox();
    expect(fb!.y).toBeLessThan(844 / 2);
    const cb = await button(page, "Connect").boundingBox();
    expect(cb!.y - (fb!.y + fb!.height)).toBeLessThan(24);
    await expect(field).toHaveAttribute("placeholder", "studio-mac.local:7373");
    await expect(page.getByText("It's under Connect in sessionpipe on your computer.")).toBeVisible();
    await expect(button(page, "Connect")).toBeDisabled();
    await field.fill("not an address");
    await button(page, "Connect").click();
    await expect(page.getByRole("alert")).toContainText("That isn't an address.");
    expect(await shellCalls(page)).not.toContain("rx_add");
    await field.fill("studio-mac.local:7373");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await button(page, "Connect").click();
    await expect(page.getByRole("heading", { name: "Couldn't reach studio-mac" })).toBeVisible();
    await expect(
      page.getByText(
        "Check that sessionpipe is running on studio-mac and that both are on the same Wi-Fi (or the same tailnet).",
      ),
    ).toBeVisible();
    expect(await shellCallArgs(page, "rx_add")).toEqual([{ url: "http://studio-mac.local:7373/" }]);
    // After a typed address, Try again is the one action (Back keeps the address).
    await expect(button(page, "Try again")).toHaveClass(/btn--primary/);
    await expect(button(page, "Enter an address")).toHaveCount(0);
    await setAdd(page, "ok");
    await button(page, "Try again").click();
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
  });

  test("Cancel in the shell's own sheet is not an error: back to the address, still typed", async ({ page }) => {
    await openInPhone(page, "/", { add: "cancel" });
    await button(page, "Enter an address").click();
    await page.getByRole("textbox", { name: "Your computer's address" }).fill("10.0.0.128:7397");
    await button(page, "Connect").click();
    await expect(page.getByRole("textbox", { name: "Your computer's address" })).toHaveValue("http://10.0.0.128:7397/");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await button(page, "Back").click();
    await expect(welcome(page)).toBeVisible();
  });

  test("Android: the phone's own words", async ({ page }) => {
    await openInPhone(page, "/", { platform: "android", receiver: true, firstRunDone: false });
    const sheet = page.getByRole("dialog", { name: "You're in." });
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    await expect(sheet).toContainText("To answer prompts from this phone, studio-mac has to approve it once.");
  });

  test("never a Mac on the phone: Settings › App", async ({ page }) => {
    await openInPhone(page, "/settings?section=app", { receiver: true });
    const pane = page.getByRole("tabpanel", { name: "App" });
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByRole("switch", { name: "Notify me when a session needs me" })).toBeVisible();
    for (const words of [/Dock/, /menu bar/i, /window is closed/, /Open at login/, /Touch ID/, /\bMac\b/])
      await expect(pane.getByText(words)).toHaveCount(0);
    await expect(pane.getByRole("switch", { name: "Show count on the Dock icon" })).toHaveCount(0);
    await expect(pane.getByRole("switch", { name: "Keep running when the window is closed" })).toHaveCount(0);
  });
});

test.describe("the phone shell at tablet width", () => {
  const tablet = async (page: Page) => {
    await page.setViewportSize({ width: 1032, height: 1376 });
    await openInPhone(page, "/", { receiver: true });
    await page.evaluate(() => document.documentElement.style.setProperty("--safe-top", "24px"));
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
  };

  test("the rail's head keeps the mark inside and clears the status bar", async ({ page }) => {
    await tablet(page);
    const rail = page.locator(".rail");
    await expect(rail).toBeVisible();
    const mark = await page.locator(".rail-brand .mark").boundingBox();
    expect(mark!.x).toBeGreaterThanOrEqual(0);
    const railBox = await rail.boundingBox();
    expect(mark!.x + mark!.width).toBeLessThanOrEqual(railBox!.x + railBox!.width);
    // The compose glyph sits beside the mark, inside the rail, and still gets a finger's target.
    const compose = page.locator(".rail-compose");
    const cb = await compose.boundingBox();
    expect(cb!.x + cb!.width).toBeLessThanOrEqual(railBox!.x + railBox!.width);
    expect(cb!.x).toBeGreaterThanOrEqual(mark!.x + mark!.width);
    const target = await compose.evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      const r = el.getBoundingClientRect();
      return r.height - Number.parseFloat(after.top) - Number.parseFloat(after.bottom);
    });
    expect(target).toBeGreaterThanOrEqual(44);
    // Under the status bar: the head starts at the safe inset, and the mark below it.
    const head = page.locator(".rail-head");
    expect(await head.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingTop))).toBe(24);
    expect(mark!.y).toBeGreaterThanOrEqual(24);
  });

  test("the connected sheet is a centred form sheet, and a step keeps to one glance", async ({ page }) => {
    await page.setViewportSize({ width: 1032, height: 1376 });
    await openInPhone(page, "/", { receiver: true, firstRunDone: false });
    const sheet = page.getByRole("dialog", { name: "You're in." });
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    const box = await sheet.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(440);
    expect(Math.abs(box!.x + box!.width / 2 - 516)).toBeLessThan(2);
    expect(box!.y + box!.height).toBeLessThan(1376 - 200);
    expect(box!.y).toBeGreaterThan(200);
  });

  test("a step at tablet width keeps its title and actions together", async ({ page }) => {
    await page.setViewportSize({ width: 1032, height: 1376 });
    await openInPhone(page, "/", { camera: "denied" });
    await button(page, "Scan the code on your computer").click();
    const title = await page.getByRole("heading", { name: "sessionpipe can't use the camera" }).boundingBox();
    const action = await button(page, "Open Settings").boundingBox();
    expect(action!.y + action!.height - title!.y).toBeLessThanOrEqual(720);
  });

  test("the page bar starts under the status bar", async ({ page }) => {
    await tablet(page);
    const bar = page.locator(".main > .page > .bar").first();
    await expect(bar).toBeVisible();
    expect(await bar.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingTop))).toBe(24);
    const title = await bar.locator(".bar-title").first().boundingBox();
    expect(title!.y).toBeGreaterThanOrEqual(24);
  });
});
