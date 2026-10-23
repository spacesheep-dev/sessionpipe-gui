// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The inbox: the demo's permission prompts appear as rows (Allow disabled with the
// unpaired reason, since no demo machine is paired), leave when the demo clears them, and
// count in the tab title's "(n)" and the nav badge. Notifications: the "Notify me" switch,
// behind the bell in the page bar, asks the browser once and persists; a new prompt
// notifies a background tab. The browser's Notification is mocked, since Chromium would
// never grant it here.
import { expect, type Page, test } from "@playwright/test";
import { openPage } from "./helpers.js";

declare global {
  interface Window {
    __notifications: { title: string; body?: string; tag?: string; onclick: (() => void) | null }[];
    __permissionRequests: number;
  }
}

/** A Notification that records itself; its permission lives in localStorage so it survives
 *  a reload like the real one would. `focused: false` makes the page look like a background tab. */
const mockNotifications = (page: Page, opts: { permission?: string; focused?: boolean } = {}) =>
  page.addInitScript(
    ({ permission, focused }) => {
      window.__notifications = [];
      window.__permissionRequests = 0;
      const key = "__e2e.notification.permission";
      if (permission) localStorage.setItem(key, permission);
      class MockNotification {
        static get permission() {
          return localStorage.getItem(key) ?? "default";
        }
        static requestPermission() {
          window.__permissionRequests++;
          localStorage.setItem(key, "granted");
          return Promise.resolve("granted");
        }
        onclick: (() => void) | null = null;
        constructor(
          public title: string,
          public options: { body?: string; tag?: string } = {},
        ) {
          window.__notifications.push(this as never);
        }
        close() {}
      }
      Object.defineProperty(window, "Notification", { value: MockNotification, configurable: true });
      if (focused === false) document.hasFocus = () => false;
    },
    { permission: opts.permission, focused: opts.focused },
  );

/** Reads the first answerable row in one go (it may vanish any moment: the demo's windows
 *  last about two seconds), or null when there is none yet. */
/** The bell's popover in the page bar, opened. */
const bell = async (page: Page) => {
  const head = page.locator(".inbox-head");
  const btn = head.getByRole("button", { name: "Notifications" });
  if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
  return head.getByRole("dialog", { name: "Notifications" });
};

const readRow = async (page: Page) => {
  const row = page.locator(".inbox-row--answerable").first();
  if ((await row.count()) === 0) return null;
  try {
    return {
      id: await row.getAttribute("data-attention", { timeout: 500 }),
      title: await row.locator(".inbox-title").textContent({ timeout: 500 }),
      machine: await row.locator(".inbox-machine").textContent({ timeout: 500 }),
      kind: await row.locator(".inbox-kind").textContent({ timeout: 500 }),
      tool: await row.locator(".inbox-what code").textContent({ timeout: 500 }),
      msg: await row.locator(".inbox-msg").textContent({ timeout: 500 }),
      age: await row.locator(".inbox-age").textContent({ timeout: 500 }),
      answer: await row.locator(".inbox-answer").getAttribute("data-answer", { timeout: 500 }),
      allowDisabled: await row.getByRole("button", { name: "Allow" }).isDisabled({ timeout: 500 }),
      denyDisabled: await row.getByRole("button", { name: "Deny" }).isDisabled({ timeout: 500 }),
      // Why Allow / Deny are off is said once under the page bar, not on every row.
      note: await page.locator(".inbox-reason").first().textContent({ timeout: 500 }),
      group: await row.locator("xpath=ancestor::section[1]").getAttribute("aria-label", { timeout: 500 }),
      title_: await page.title(),
      badge: await page.locator("nav.rail a[data-nav='inbox'] .nav-badge").textContent({ timeout: 500 }),
    };
  } catch {
    return null;
  }
};

test.describe("inbox", () => {
  test("a demo permission is a row that needs an answer, Allow disabled until the machine pairs, gone when cleared", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openPage(page, "/inbox");
    await expect(page.locator("nav.rail a[data-nav='inbox']")).toHaveAttribute("aria-current", "page");
    // With nothing open the page says so.
    if ((await page.locator(".inbox-row").count()) === 0)
      await expect(page.locator(".inbox-empty .state-title")).toHaveText("Nothing needs you");
    // The demo asks for a permission every 6–20 s and keeps it open ~2 s; read the row in one go.
    let seen: Awaited<ReturnType<typeof readRow>> = null;
    await expect
      .poll(
        async () => {
          const r = await readRow(page);
          if (r) seen = r;
          return r;
        },
        { timeout: 60_000, message: "an answerable row with its facts" },
      )
      .toMatchObject({
        id: expect.stringMatching(/\S/),
        title: expect.stringMatching(/\S/),
        machine: expect.stringMatching(/\S/),
        kind: "permission",
        tool: expect.stringMatching(/^\S+$/),
        msg: expect.stringMatching(/\S/),
        age: expect.stringMatching(/ago|just now/),
        answer: "unpaired",
        allowDisabled: true,
        denyDisabled: true,
        note: expect.stringMatching(/pair .+ to send messages/),
        group: "Needs an answer",
        title_: expect.stringMatching(/^\(\d+\) Inbox · sessionpipe gui$/),
        badge: expect.stringMatching(/^[1-9]\d*$/),
      });
    // The row leaves with the demo's attention.cleared, live, and the title drops its count
    // once nothing answerable is left.
    await expect(page.locator(`.inbox-row[data-attention="${seen!.id}"]`)).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(
        async () => {
          const n = await page.locator(".inbox-row--answerable").count();
          const t = await page.title();
          return n === 0 ? t : `${n} rows: ${t}`;
        },
        { timeout: 30_000 },
      )
      .toBe("Inbox · sessionpipe gui");
    await expect(page.locator("nav.rail a[data-nav='inbox'] .nav-badge")).toHaveCount(0);
    await expect(page.locator("nav.rail a[data-nav='board'] .nav-badge")).toHaveCount(0);
  });

  test("a row click opens the session beside the page", async ({ page }) => {
    test.setTimeout(90_000);
    await openPage(page, "/inbox");
    await expect.poll(() => page.locator(".inbox-row").count(), { timeout: 60_000 }).toBeGreaterThan(0);
    const row = page.locator(".inbox-row").first();
    const title = (await row.locator(".inbox-title").textContent())!;
    await row.locator(".inbox-main").click();
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    await expect(page.locator("aside.panel .panel-title")).toHaveText(title);
    await expect(page).toHaveURL(/\/inbox\?(.*&)?s=/);
  });

  test("the title prefix follows the open prompts on every page", async ({ page }) => {
    test.setTimeout(90_000);
    await openPage(page, "/feed");
    await expect
      .poll(() => page.title(), { timeout: 60_000, message: "a (n) prefix on the Feed title" })
      .toMatch(/^\(\d+\) Feed · sessionpipe gui$/);
    await expect.poll(() => page.title(), { timeout: 30_000 }).toBe("Feed · sessionpipe gui");
  });

  test("Notify me asks the browser once and persists across a reload", async ({ page }) => {
    await mockNotifications(page);
    await openPage(page, "/inbox");
    const toggle = page.locator(".inbox-head").getByRole("switch", { name: "Notify me" });
    await bell(page);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => window.__permissionRequests)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("sessionpipe-gui.notify"))).toBe("1");

    await page.reload();
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await bell(page);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    // Granted already: turning it on again asks nothing; the Settings dialog's Notifications
    // section (where the header's "Sounds" link goes) shows the same switch.
    expect(await page.evaluate(() => window.__permissionRequests)).toBe(0);
    await (await bell(page)).getByRole("link", { name: "Sounds" }).click();
    await expect(page).toHaveURL(/\/settings\?section=notifications$/);
    const st = page.locator(".ntf").getByRole("switch", { name: "Notify me" });
    await expect(st).toHaveAttribute("aria-checked", "true");
    await st.click();
    await expect(st).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => localStorage.getItem("sessionpipe-gui.notify"))).toBeNull();
    await openPage(page, "/inbox");
    await bell(page);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("a blocked permission keeps the switch off and says why", async ({ page }) => {
    await mockNotifications(page, { permission: "denied" });
    await openPage(page, "/inbox");
    // Said once under the page bar, as a condition with its way out, not beside the switch.
    const notice = page.locator(".page.inbox > .inbox-notes .notify-hint");
    await expect(notice).toContainText("Notifications are off for this site");
    await notice.getByRole("button", { name: "How to allow" }).click();
    await expect(notice).toContainText("set Notifications to Allow");
    const toggle = page.locator(".inbox-head").getByRole("switch", { name: "Notify me" });
    await bell(page);
    await expect(toggle).toBeDisabled();
  });

  test("a new prompt notifies a background tab, and the notification opens the inbox", async ({ page }) => {
    test.setTimeout(90_000);
    await mockNotifications(page, { permission: "granted", focused: false });
    await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.notify", "1"));
    await openPage(page, "/");
    // Nothing for what was already open at the first snapshot…
    expect(await page.evaluate(() => window.__notifications.length)).toBe(0);
    // …one for the next permission the stream brings.
    await expect
      .poll(() => page.evaluate(() => window.__notifications.map((n) => n.title)), {
        timeout: 60_000,
        message: "a notification for a new permission prompt",
      })
      .toContainEqual(expect.stringMatching(/^.+ needs you · \S+$/));
    await page.evaluate(() => window.__notifications[0]!.onclick?.());
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.locator("nav.rail a[data-nav='inbox']")).toHaveAttribute("aria-current", "page");
  });
});

test.describe("installable", () => {
  test("the manifest and the install-only service worker are served", async ({ page, request }) => {
    await openPage(page, "/");
    const link = page.locator("link[rel='manifest']");
    await expect(link).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(link).toHaveAttribute("crossorigin", "use-credentials");
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.status()).toBe(200);
    expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
    const m = (await manifest.json()) as { name: string; display: string; icons: { src: string }[]; start_url: string };
    expect(m.name).toBe("sessionpipe gui");
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    for (const icon of m.icons) expect((await request.get(icon.src)).status()).toBe(200);
    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(sw.headers()["content-type"]).toContain("javascript");
    const body = await sw.text();
    expect(body).not.toMatch(/caches\.|respondWith/);
    // Registered and active on this (secure, loopback) origin.
    await expect
      .poll(
        () => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.active?.scriptURL ?? "")),
        {
          timeout: 15_000,
        },
      )
      .toMatch(/\/sw\.js$/);
  });
});
