// SPDX-License-Identifier: Apache-2.0
// The phone's own screens for a spacesheep account, each state of each, with no GUI server
// anywhere: the first run's other way in (start, the hand-off to the browser, the wait and
// its cancel, coming back, the board; and every way the hub says a connect can end),
// Settings › App (who, where, since when, how it stands, Disconnect), and "Approve this
// iPhone" (the ask, the number, the wait, the hour a new device waits, approved, removed;
// a phone that cannot sign). The page's own code runs against the stand-ins of
// test/account (the hub, spacesheep, the shell); nothing here is native.
//
// With ACCOUNT_SCREENS=<folder> every state is also saved as a picture there, at the size
// and scheme ACCOUNT_SCREENS_SIZE (WxH) and ACCOUNT_SCREENS_SCHEME name: the pages the
// owner approves the screens from.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { FakeSpacesheep, NEW_DEVICE_WAIT_MS } from "../account/fake-spacesheep.js";
import { HubRefused, HubStandIn, UNUSED_KEY_NOTE } from "../account/hub.js";
import { type AccountServer, startAccountServer } from "../account/serve.js";
import { fakeShell, type ShellInitOptions } from "../account/shell-init.js";
import { Session } from "../events.js";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/web");
const SHOTS = process.env.ACCOUNT_SCREENS ?? "";
const [W, H] = (process.env.ACCOUNT_SCREENS_SIZE ?? "390x844").split("x").map(Number) as [number, number];
const SCHEME = process.env.ACCOUNT_SCREENS_SCHEME === "dark" ? "dark" : "light";
const MACHINE = "m_studio0123456789abcd";
const NAME = "studio-mac";
/** The account's origin as a person reads it. Nothing is asked of it: spacesheep is stood in. */
const ORIGIN = "https://spacesheep.dev";
const HOST = "spacesheep.dev";

test.describe.configure({ mode: "serial" });

interface Bed {
  ss: FakeSpacesheep;
  hub: HubStandIn;
  server: AccountServer;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/** A phone with the app on it: spacesheep and the hub stood in, the built page, the shell. */
async function bed(browser: Browser, o: { platform?: string; shell?: ShellInitOptions; features?: string[] } = {}) {
  const ss = new FakeSpacesheep();
  ss.rpId = HOST;
  ss.machines = [
    {
      id: MACHINE,
      name: NAME,
      online: true,
      last_seen: Date.now(),
      folders: ["/Users/me"],
      mode: "safe",
      agents: ["claude-code"],
      cli_version: "sessionpipe 0.15.0",
      modes: ["waiter"],
      passkey_ids: ["a-passkey-made-on-spacesheep"],
      key_types: ["passkey", "device"],
    },
  ];
  const s = new Session("s-invoice");
  const on = {
    tier: 2 as const,
    session: { machine: NAME, cwd: "/Users/me/billing", title: "Fix the invoice webhook" },
  };
  ss.push([
    s.ev("session.started", { source: "startup" }, on),
    s.ev("turn.started", { turn_id: "t1" }, on),
    s.ev(
      "turn.transcript",
      { turn: 1, user: "The invoice webhook retries forever.", assistant: "Found the loop." },
      on,
    ),
    s.ev("turn.ended", { turn_id: "t1" }, on),
  ]);
  const hub = new HubStandIn({
    upstream: { origin: ORIGIN, ask: (req) => ss.handle(req) },
    ...(o.platform ? { platform: o.platform } : {}),
    ...(o.features ? { features: o.features } : {}),
  });
  const server = await startAccountServer({ web: WEB, hub });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    colorScheme: SCHEME,
    // A phone: a finger, not a mouse (`(pointer: coarse)` matches, so every small button
    // is as tall as the app makes it for touch).
    hasTouch: true,
    isMobile: true,
    storageState: { cookies: [], origins: [] },
  });
  // Nothing leaves this machine: a link to the account's origin is never followed.
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (r) => r.abort(),
  );
  await context.addInitScript(fakeShell, o.shell ?? {});
  const page = await context.newPage();
  const b: Bed = {
    ss,
    hub,
    server,
    context,
    page,
    close: async () => {
      await context.close();
      await server.close();
    },
  };
  return b;
}

let n = 0;
/** The state on screen, as a picture, when pictures are asked for. */
async function shot(page: Page, name: string): Promise<void> {
  n++;
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // Let a sheet or a row finish moving.
  await page.waitForTimeout(350);
  await page.screenshot({
    path: path.join(SHOTS, `${String(n).padStart(2, "0")}-${name}-${W}x${H}-${SCHEME}.png`),
  });
}

const step = (page: Page, name: string) => page.locator(`.onb[data-step='${name}']`);
const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name });
/** The app comes back to the front (from the browser). */
const foreground = (page: Page) =>
  page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __invoked: string[] }).__invoked);
const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

test.describe("the first run with a spacesheep account", () => {
  let b: Bed;
  test.beforeAll(async ({ browser }) => {
    // A fresh install: no receiver, the first-run sheet not yet seen.
    b = await bed(browser, { shell: { settled: false } });
  });
  test.afterAll(async () => b?.close());

  test("the welcome offers it as the other way in, under the ways to a computer", async () => {
    const { page } = b;
    await page.goto(b.server.url);
    await expect(step(page, "welcome")).toBeVisible();
    const scan = button(page, "Scan the code on your computer");
    const address = button(page, "Enter an address");
    const account = button(page, "Use a spacesheep account");
    for (const x of [scan, address, account]) await expect(x).toBeVisible();
    // The computer's ways first; the account below them, after the divider; one primary.
    const ys = await Promise.all([scan, address, account].map(async (x) => (await x.boundingBox())!.y));
    expect(ys[0]).toBeLessThan(ys[1]!);
    expect(ys[1]).toBeLessThan(ys[2]!);
    await expect(scan).toHaveClass(/btn--primary/);
    await expect(account).not.toHaveClass(/btn--primary/);
    for (const x of [scan, address, account]) expect((await x.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Nothing scrolls sideways, and nothing was asked of spacesheep yet.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(b.ss.log.filter((l) => l.includes("/api/gui/connect"))).toEqual([]);
    await shot(page, "welcome");
  });

  test("a tap says what it is before anything is asked; Continue shows the number and hands off to the browser", async () => {
    const { page } = b;
    await button(page, "Use a spacesheep account").click();
    await expect(step(page, "account-intro")).toBeVisible();
    await expect(page.getByText(/spacesheep then holds what those machines send/)).toBeVisible();
    expect(await calls(page)).not.toContain("acct_connect_start");
    await shot(page, "intro");
    // Back is back, with nothing started.
    await button(page, "Back").click();
    await expect(step(page, "welcome")).toBeVisible();
    await button(page, "Use a spacesheep account").click();

    // Continue: the hub asks spacesheep; while it does, the page says so.
    let release = () => {};
    b.hub.holdStart = new Promise<void>((r) => {
      release = r;
    });
    await button(page, "Continue").click();
    await expect(step(page, "account-starting")).toBeVisible();
    await expect(page.getByText(`Connecting to ${HOST}…`)).toBeVisible();
    await shot(page, "connecting");
    b.hub.holdStart = null;
    release();

    const number = step(page, "account-number");
    await expect(number).toBeVisible();
    await expect(page.locator(".onb-digits")).toHaveAttribute("data-digits", /^\d{4}$/);
    await expect(page.getByText("Confirm on spacesheep")).toBeVisible();
    await expect(button(page, "Open in Safari")).toHaveClass(/btn--primary/);
    await shot(page, "number");
    // The link is the hub's: the page asks it to open, and never holds it.
    await button(page, "Open in Safari").click();
    await expect(number).toHaveAttribute("data-opened", "true");
    expect(b.hub.opened).toHaveLength(1);
    expect(await opened(page)).toEqual([]);
    await expect(page.getByText("Waiting for you to confirm on spacesheep.")).toBeVisible();
    await expect(button(page, "Open the page again")).toBeVisible();
    await expect(button(page, "Cancel")).toBeVisible();
    await shot(page, "waiting");
  });

  test("Cancel stops it; a connect under way when the app opens again is picked up where it was", async () => {
    const { page } = b;
    await button(page, "Cancel").click();
    await expect(step(page, "welcome")).toBeVisible();
    expect(await calls(page)).toContain("acct_connect_cancel");
    expect((b.hub.status().connect as unknown) ?? null).toBeNull();
    // Started again, then the app is closed while the person is in the browser.
    await button(page, "Use a spacesheep account").click();
    await button(page, "Continue").click();
    await expect(step(page, "account-number")).toBeVisible();
    const digits = (await page.locator(".onb-digits").getAttribute("data-digits"))!;
    await page.goto(b.server.url);
    await expect(step(page, "account-number")).toBeVisible();
    await expect(page.locator(".onb-digits")).toHaveAttribute("data-digits", digits);
  });

  test("confirmed on spacesheep, the hub asks whose account it is on this phone; yes opens the board", async () => {
    const { page } = b;
    const digits = (await page.locator(".onb-digits").getAttribute("data-digits"))!;
    // The hub's own alert cannot be shown yet (the app is behind the browser): it holds the approval.
    b.hub.alert = () => null;
    b.ss.approve(digits);
    await b.hub.pollConnect();
    await foreground(page);
    await expect(step(page, "account-asking")).toBeVisible();
    await expect(page.getByText("Confirmed on spacesheep")).toBeVisible();
    await expect(page.getByText("Answer the question on this iPhone to finish.")).toBeVisible();
    await shot(page, "asking");
    // "Use it" in the alert: the account is kept, and the shell opens the window on it.
    b.hub.alert = () => true;
    await Promise.all([page.waitForEvent("load"), Promise.resolve(b.hub.nudge())]);
    await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
    expect(b.hub.accounts.size).toBe(1);
    // The first run's last word: reading works, and the one step left before it can send.
    const sheet = page.locator("[data-first-run='phone']");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("You're in.")).toBeVisible();
    await expect(
      sheet.getByText("Reading works now. To send from this iPhone, approve it once on spacesheep."),
    ).toBeVisible();
    await expect(sheet.getByText(/Machines ›/)).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Approve this iPhone" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Later" })).toBeVisible();
    await shot(page, "connected");
    // No GUI server was asked for anything, start to board.
    expect(b.server.strays).toEqual([]);
  });

  test("'Approve this iPhone' on that sheet asks at once and shows the number to type on spacesheep", async () => {
    const { page } = b;
    await page.locator("[data-first-run='phone']").getByRole("button", { name: "Approve this iPhone" }).click();
    const approve = page.locator("[data-approve='waiting']");
    await expect(approve).toBeVisible();
    await expect(page.locator(".approve-code")).toHaveAttribute("data-code", /^\d{2}$/);
    expect(b.ss.deviceRequests.size).toBe(1);
  });
});

test.describe("each way a connect can end, with what to do next", () => {
  let b: Bed;
  test.beforeAll(async ({ browser }) => {
    b = await bed(browser);
  });
  test.afterAll(async () => b?.close());

  /** The welcome's other way in, with nothing under way and the hub's counts at nought. */
  const intro = async () => {
    b.hub.resetLimits();
    await b.hub.invoke("acct_connect_cancel");
    await b.page.goto(b.server.url);
    await button(b.page, "Use a spacesheep account").click();
    await expect(step(b.page, "account-intro")).toBeVisible();
    // The tap led somewhere: focus is on the new screen's title, which is what is read out.
    await expect(b.page.locator(".onb-title")).toBeFocused();
  };
  /** From there to a started connect (or to how the start was refused). */
  const start = async () => {
    await intro();
    await button(b.page, "Continue").click();
  };
  const ended = (why: string) => b.page.locator(`.onb[data-step='account-ended'][data-why='${why}']`);
  const digits = async () => {
    await expect(step(b.page, "account-number")).toBeVisible();
    return (await b.page.locator(".onb-digits").getAttribute("data-digits"))!;
  };

  test("spacesheep cannot be reached: said, with Try again", async () => {
    b.hub.down = true;
    await start();
    await expect(ended("unreachable")).toBeVisible();
    await expect(b.page.getByText(`Couldn't reach ${HOST}`)).toBeVisible();
    await expect(b.page.getByText("Check this iPhone's connection, then try again.")).toBeVisible();
    await shot(b.page, "end-unreachable");
    // Try again, with spacesheep back: the number.
    b.hub.down = false;
    await button(b.page, "Try again").click();
    await digits();
  });

  test("too many tries: when to try again, and no button that would only be refused", async () => {
    await intro();
    b.hub.startRefusal = new HubRefused("too_many_starts", "Too many tries. Wait a while, then connect again.", {
      retryAfterS: 1500,
    });
    await button(b.page, "Continue").click();
    await expect(ended("wait")).toBeVisible();
    await expect(b.page.getByText("Too many tries")).toBeVisible();
    await expect(b.page.getByText(/^Try again at \d{1,2}:\d{2}( [AP]M)?/)).toBeVisible();
    await expect(button(b.page, "Try again")).toHaveCount(0);
    await shot(b.page, "end-wait");
  });

  test("another question is open on the phone", async () => {
    await intro();
    b.hub.startRefusal = new HubRefused("busy", "Another question is open on this device. Answer it first.");
    await button(b.page, "Continue").click();
    await expect(ended("busy")).toBeVisible();
    await expect(b.page.getByText("Another question is open on this iPhone. Answer it, then try again.")).toBeVisible();
    await shot(b.page, "end-busy");
  });

  test("refused on spacesheep's page", async () => {
    await start();
    b.ss.approve(await digits(), false);
    await b.hub.pollConnect();
    await expect(ended("denied")).toBeVisible();
    await expect(b.page.getByText("The request was refused on spacesheep.")).toBeVisible();
    await shot(b.page, "end-denied");
  });

  test("refused here, in the hub's own question: a key was made, and the page says where to revoke it", async () => {
    await start();
    b.hub.alert = () => false;
    b.ss.approve(await digits());
    await b.hub.pollConnect();
    await expect(ended("declined")).toBeVisible();
    await expect(b.page.getByText(UNUSED_KEY_NOTE)).toBeVisible();
    await shot(b.page, "end-declined");
    await button(b.page, "Open API keys on spacesheep").click();
    expect(await opened(b.page)).toEqual([`${ORIGIN}/settings/api-keys`]);
    expect(b.hub.accounts.size).toBe(0);
    b.hub.alert = () => true;
  });

  test("Cancel after spacesheep confirmed, before the hub's question was answered: the key that was made is said, with where to revoke it", async () => {
    await start();
    // The hub's own alert cannot be shown yet: it holds the approval, and the page says to answer it.
    b.hub.alert = () => null;
    b.ss.approve(await digits());
    await b.hub.pollConnect();
    await foreground(b.page);
    await expect(step(b.page, "account-asking")).toBeVisible();
    await button(b.page, "Cancel").click();
    // Not the welcome: the hub's note, and the way to the key.
    await expect(b.page.locator(".onb[data-step='account-ended']")).toBeVisible();
    await expect(b.page.getByText(UNUSED_KEY_NOTE)).toBeVisible();
    await expect(button(b.page, "Open API keys on spacesheep")).toBeVisible();
    expect(b.hub.accounts.size).toBe(0);
    b.hub.alert = () => true;
  });

  test("found on opening: a connect that ended with a key made and not kept shows its note, once", async () => {
    await start();
    b.hub.alert = () => false;
    b.ss.approve(await digits());
    await b.hub.pollConnect();
    await expect(ended("declined")).toBeVisible();
    // The app is closed there and opened again: the note is the first thing shown.
    await b.page.goto(b.server.url);
    await expect(b.page.locator(".onb[data-step='account-ended']")).toBeVisible();
    await expect(b.page.getByText(UNUSED_KEY_NOTE)).toBeVisible();
    await expect(button(b.page, "Open API keys on spacesheep")).toBeVisible();
    // Left, it is not shown again.
    await b.page
      .locator(".onb[data-step='account-ended'] .onb-back, .onb[data-step='account-ended'] [data-back]")
      .first()
      .click();
    await expect(b.page.locator(".onb[data-step='account-ended']")).toHaveCount(0);
    await b.page.goto(b.server.url);
    await expect(step(b.page, "welcome")).toBeVisible();
    await expect(b.page.getByText(UNUSED_KEY_NOTE)).toHaveCount(0);
    b.hub.alert = () => true;
  });

  test("back from the browser the hub is asked at once: a word of its that never arrived is not waited for", async () => {
    await start();
    const number = await digits();
    // Confirmed on spacesheep while the app was behind the browser, and the hub's word for
    // it never reached the page.
    b.hub.alert = () => null;
    b.hub.mute = true;
    b.ss.approve(number);
    await b.hub.pollConnect();
    b.hub.mute = false;
    await b.page.waitForTimeout(300);
    await expect(step(b.page, "account-number")).toBeVisible();
    // In front again: asked, and the screen is where the connect is.
    await foreground(b.page);
    await expect(step(b.page, "account-asking")).toBeVisible();
    // Each new step starts at its title, for a screen reader and the keyboard alike.
    expect(await b.page.evaluate(() => document.activeElement?.className)).toBe("onb-title");
    await expect(b.page.locator(".onb [role='status']")).toHaveCount(0);
    b.hub.alert = () => true;
    await button(b.page, "Cancel").click();
  });

  test("two taps on the hand-off to the browser ask the hub once, and Connecting has a way out", async () => {
    await start();
    await digits();
    const opens = async () => (await calls(b.page)).filter((c) => c === "acct_connect_open").length;
    const before = await opens();
    // Two taps before the first has answered.
    await b.page.evaluate(() => {
      const open = Array.from(document.querySelectorAll("button")).find((x) => /^Open in /.test(x.textContent ?? ""))!;
      open.click();
      open.click();
    });
    await expect(step(b.page, "account-number")).toHaveAttribute("data-opened", "true");
    expect((await opens()) - before).toBe(1);
    await button(b.page, "Cancel").click();
    // A start that does not answer: the screen says Connecting, and Cancel leaves it.
    await expect(step(b.page, "welcome")).toBeVisible();
    b.hub.startMs = 60_000;
    await button(b.page, "Use a spacesheep account").click();
    await button(b.page, "Continue").click();
    await expect(step(b.page, "account-starting")).toBeVisible();
    await button(b.page, "Cancel").click();
    await expect(step(b.page, "account-starting")).toHaveCount(0);
    await expect(step(b.page, "welcome")).toBeVisible();
    b.hub.startMs = 0;
  });

  test("nobody confirmed in time", async () => {
    await start();
    b.ss.expire(await digits());
    await b.hub.pollConnect();
    await expect(ended("expired")).toBeVisible();
    await expect(b.page.getByText("Not confirmed in time")).toBeVisible();
    await expect(b.page.getByText("Try again for a new number.")).toBeVisible();
    await shot(b.page, "end-expired");
  });

  test("approved, and the phone could not keep it: the same note, the same way to revoke", async () => {
    await start();
    b.hub.keep = "keystore";
    b.ss.approve(await digits());
    await b.hub.pollConnect();
    await expect(ended("not-kept")).toBeVisible();
    await expect(b.page.getByText("Couldn't keep the account on this iPhone")).toBeVisible();
    await expect(b.page.getByText(UNUSED_KEY_NOTE)).toBeVisible();
    await expect(button(b.page, "Open API keys on spacesheep")).toBeVisible();
    await shot(b.page, "end-not-kept");
    b.hub.keep = "ok";
  });

  test("an answer this version cannot use", async () => {
    b.ss.connectAnswer = { status: 500, headers: {}, body: "{}" };
    await start();
    await expect(ended("unexpected")).toBeVisible();
    await expect(b.page.getByText(`${HOST} didn't answer as expected`)).toBeVisible();
    await expect(b.page.getByText("Try again. If it keeps happening, update sessionpipe.")).toBeVisible();
    await shot(b.page, "end-unexpected");
    // Back leaves nothing behind: the welcome, and no outcome held at the hub.
    await button(b.page, "Back").click();
    await expect(step(b.page, "welcome")).toBeVisible();
  });

  test("an app that takes no account offers none", async ({ browser }) => {
    const plain = await bed(browser, { features: ["notifications", "signer", "haptics", "scanner"] });
    try {
      await plain.page.goto(plain.server.url);
      await expect(step(plain.page, "welcome")).toBeVisible();
      await expect(button(plain.page, "Use a spacesheep account")).toHaveCount(0);
      await expect(plain.page.locator(".onb-or")).toHaveCount(0);
    } finally {
      await plain.close();
    }
  });
});

test.describe("Settings and 'Approve this iPhone' on a connected account", () => {
  let b: Bed;
  const approve = (state: string) => b.page.locator(`[data-approve='${state}']`);
  /** This phone's key, as the test shell made it. */
  const keyId = () => [...b.hub.accounts.values()][0]!.deviceKeyId!;
  test.beforeAll(async ({ browser }) => {
    b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
  });
  test.afterAll(async () => b?.close());

  test("Settings › App says who, where, since when and how it stands, and what Disconnect removes", async () => {
    const { page } = b;
    await page.goto(`${b.server.url}/settings?section=app`);
    const group = page.locator("[data-account-settings]");
    await expect(group).toBeVisible();
    await expect(group.getByText("me@example.com")).toBeVisible();
    // (The day is written as the phone's own language writes one.)
    await expect(group.getByText(/^spacesheep\.dev · since (3 Nov 2026|Nov 3, 2026)$/)).toBeVisible();
    await expect(group.locator(".acct-state--ok").first()).toHaveText("Connected");
    await expect(
      group.getByText(
        "Disconnect removes the account from this iPhone: its key, its sessions, labels and read marks, drafts and recent searches. The key keeps working until you revoke it on spacesheep: Settings → API keys.",
      ),
    ).toBeVisible();
    await expect(group.getByRole("button", { name: "Disconnect" })).toBeVisible();
    // Its own group is where it is: not a second time under Receivers.
    await expect(page.getByText("me@example.com")).toHaveCount(1);
    await expect(page.getByText("No receivers yet")).toBeVisible();
    // The receiver's own group for an account, and the receiver's signing row with its command, are not here.
    await expect(page.getByText(/sessionpipe control keys remove/)).toHaveCount(0);
    await group.scrollIntoViewIfNeeded();
    await shot(page, "settings");
    await page.goto(`${b.server.url}/settings?section=data`);
    await expect(page.getByText(/Connected as/)).toHaveCount(0);
  });

  test("Approve this iPhone: the ask, then the number and the two things to do on spacesheep", async () => {
    const { page } = b;
    await page.goto(`${b.server.url}/settings?section=app`);
    await page.locator("[data-account-settings] [data-approve]").click();
    await expect(approve("idle")).toBeVisible();
    await expect(
      page.getByText("Approve this iPhone once on spacesheep, and Face ID signs what you send from here."),
    ).toBeVisible();
    // Nothing was asked of spacesheep by opening the page: each ask notifies the account.
    expect(b.ss.deviceRequests.size).toBe(0);
    await shot(page, "approve-ask");
    await button(page, "Ask spacesheep to approve").click();
    await expect(approve("waiting")).toBeVisible();
    const code = (await page.locator(".approve-code").getAttribute("data-code"))!;
    expect(code).toBe([...b.ss.deviceRequests.values()][0]!.code);
    await expect(page.getByText("Waiting for approval")).toBeVisible();
    await expect(page.getByText("Open Devices on spacesheep")).toBeVisible();
    await expect(page.getByText(`Type ${code} beside this request`)).toBeVisible();
    await expect(page.getByText("Requests last 24 hours.")).toBeVisible();
    await expect(page.locator("[data-machine='not-yet']")).toContainText(NAME);
    await shot(page, "approve-waiting");
    await page.locator("[data-devices]").click();
    expect(await opened(page)).toEqual([`https://${HOST}/devices`]);
  });

  test("approved while the page is open: seen within seconds, with the time it can send from", async () => {
    const { page } = b;
    const before = b.hub.log.filter((l) => l.startsWith("GET /api/gui/device")).length;
    b.ss.approveDevice(keyId());
    await expect(approve("cooling")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/^This iPhone can send from \d{1,2}:\d{2}( [AP]M)?/)).toBeVisible();
    await expect(page.getByText("New devices wait an hour, so a stolen sign-in can't act at once.")).toBeVisible();
    // The computer has approved it and the hour runs: its row does not say the phone can send.
    const row = page.locator("[data-machine='waits']");
    await expect(row).toContainText(NAME);
    await expect(row).toHaveText(/Approved · sends from \d{1,2}:\d{2}( [AP]M)?$/);
    await expect(page.getByText("Can send", { exact: true })).toHaveCount(0);
    await shot(page, "approve-cooling");
    // It looked every few seconds while it waited, through the device door, never the relay.
    expect(b.hub.log.filter((l) => l.startsWith("GET /api/gui/device")).length).toBeGreaterThan(before);
    // And it stops once nothing is waited for.
    const after = b.hub.log.filter((l) => l.startsWith("GET /api/gui/device")).length;
    await page.waitForTimeout(6500);
    expect(b.hub.log.filter((l) => l.startsWith("GET /api/gui/device")).length).toBe(after);
  });

  test("the session's composer says the same before a send is refused for it", async () => {
    const { page } = b;
    await page.goto(`${b.server.url}/s/claude-code/s-invoice`);
    await expect(page.getByText("Found the loop.").first()).toBeVisible();
    await expect(page.getByText(/This iPhone can send from \d{1,2}:\d{2}( [AP]M)?/).first()).toBeVisible();
    await shot(page, "composer-cooling");
    expect(b.ss.jobs).toHaveLength(0);
    // Machines says which devices a computer trusts, and nothing of sending; Settings' row
    // for the phone's key says the same time.
    await page.goto(`${b.server.url}/machines`);
    await expect(page.getByText(NAME).first()).toBeVisible();
    await expect(page.getByText(/can send/i)).toHaveCount(0);
    await shot(page, "machines-cooling");
    await page.goto(`${b.server.url}/settings?section=app`);
    await expect(page.locator("[data-account-settings] .acct-state--wait")).toHaveText(
      /^This iPhone can send from \d{1,2}:\d{2}( [AP]M)?$/,
    );
  });

  test("approved while the page was not looking: the latest it can be, said as that", async () => {
    const { page } = b;
    // What the page remembered of watching is gone (as after the app was closed for a while).
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sessionpipe-gui.account.device."))!;
      const memo = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
      delete memo.trustedAt;
      delete memo.watched;
      localStorage.setItem(key, JSON.stringify(memo));
    });
    await page.goto(`${b.server.url}/add-device`);
    await expect(approve("cooling")).toBeVisible();
    await expect(page.getByText(/^This iPhone can send by \d{1,2}:\d{2}( [AP]M)? at the latest\./)).toBeVisible();
    await expect(page.locator("[data-machine='waits']")).toHaveText(/Approved · sends by \d{1,2}:\d{2}( [AP]M)?$/);
    await expect(page.getByText("Can send", { exact: true })).toHaveCount(0);
    await shot(page, "approve-cooling-bound");
  });

  test("where spacesheep says when the hour ends, that is the time", async () => {
    const { page } = b;
    b.ss.saysCooling = true;
    await page.goto(`${b.server.url}/add-device`);
    await expect(approve("cooling")).toBeVisible();
    const until = new Date(b.ss.coolingUntil(keyId())!).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
    await expect(page.getByText(`This iPhone can send from ${until}.`)).toBeVisible();
  });

  test("the hour over: it can send, and the page says how to take the phone off again", async () => {
    const { page } = b;
    // An hour on, as spacesheep counts it.
    const real = Date.now;
    try {
      const later = real() + NEW_DEVICE_WAIT_MS + 60_000;
      Date.now = () => later;
      expect(b.ss.coolingUntil(keyId())).toBeNull();
      await page.goto(`${b.server.url}/add-device`);
      await expect(approve("approved")).toBeVisible();
    } finally {
      Date.now = real;
    }
    await expect(page.getByText("This iPhone can send.")).toBeVisible();
    await expect(page.locator("[data-machine='can']")).toHaveText(/Can send$/);
    await expect(page.getByText("Remove this iPhone")).toBeVisible();
    await expect(
      page.getByText("On spacesheep: Devices → Remove. It stops carrying anything this iPhone sends, right away."),
    ).toBeVisible();
    await shot(page, "approve-done");
    await page.locator("[data-remove]").click();
    expect((await opened(page)).at(-1)).toBe(`https://${HOST}/devices`);
  });

  test("removed on spacesheep: said, with Ask again", async () => {
    const { page } = b;
    b.ss.saysCooling = false;
    b.ss.removeDevice(keyId());
    await page.goto(`${b.server.url}/add-device`);
    await expect(approve("dropped")).toBeVisible();
    await expect(page.getByText("Not approved", { exact: true })).toBeVisible();
    await expect(page.getByText("The request was removed on spacesheep, or ran out after 24 hours.")).toBeVisible();
    await shot(page, "approve-removed");
    // Asking again is a new request, with a number.
    b.hub.forgetAsk();
    await button(page, "Ask again").click();
    await expect(approve("waiting")).toBeVisible();
  });

  test("spacesheep will not take it: its own sentence, and the way on; too many asks: when to ask again", async () => {
    const { page } = b;
    // Talking to computers is switched off on the account: spacesheep says so at the door.
    b.ss.talk = "talk_off";
    await page.goto(`${b.server.url}/add-device`);
    await expect(page.locator(".approve-line .acct-state--warn")).toContainText("Talk to your sessions");
    await expect(page.locator("[data-elsewhere]")).toHaveText(`Open on ${HOST}`);
    await expect(button(page, "Ask spacesheep to approve")).toHaveCount(0);
    await shot(page, "approve-refused");
    b.ss.talk = "on";
    // More asks in an hour than the app makes: said with the time to ask again.
    const id = [...b.hub.accounts.keys()][0]!;
    for (let i = 0; i < 6; i++) {
      b.hub.forgetAsk();
      await b.hub.invoke("acct_device_ask", { id }).catch(() => {});
    }
    b.ss.removeDevice(keyId());
    b.hub.forgetAsk();
    await page.goto(`${b.server.url}/add-device`);
    await expect(approve("dropped")).toBeVisible();
    await button(page, "Ask again").click();
    await expect(page.getByRole("alert")).toHaveText(/^Too many tries\. Ask again at \d{1,2}:\d{2}( [AP]M)?\.$/);
    await shot(page, "approve-too-many");
    b.hub.resetLimits();
  });

  test("a key spacesheep no longer takes: Settings says so and connects again in place; a send says where", async () => {
    const { page } = b;
    b.ss.revoked = true;
    await page.goto(`${b.server.url}/settings?section=app`);
    const group = page.locator("[data-account-settings]");
    await expect(group.locator(".acct-state--warn").first()).toHaveText("The key was revoked on spacesheep", {
      timeout: 15_000,
    });
    await expect(group.locator("[data-again]")).toBeVisible();
    await group.scrollIntoViewIfNeeded();
    await shot(page, "settings-revoked");
    // Connect again: straight to a number, no disconnect first.
    b.ss.revoked = false;
    await group.locator("[data-again]").click();
    await expect(step(page, "account-number")).toBeVisible();
    await shot(page, "connect-again");
    // It is a dialog: focus is inside it, the Settings behind are out of reach, and Tab stays in.
    const inside = () => page.evaluate(() => !!document.activeElement?.closest(".acct-over"));
    expect(await inside()).toBe(true);
    expect(await page.evaluate(() => document.getElementById("root")?.hasAttribute("inert"))).toBe(true);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await inside()).toBe(true);
    }
    // Escape is its Cancel: the connect is stopped at the hub, and Settings stays as it was.
    const cancels = async () => (await calls(page)).filter((c) => c === "acct_connect_cancel").length;
    const before = await cancels();
    await page.keyboard.press("Escape");
    await expect(step(page, "account-number")).toHaveCount(0);
    expect((await cancels()) - before).toBe(1);
    await expect(group).toBeVisible();
    expect(await page.evaluate(() => document.getElementById("root")?.hasAttribute("inert"))).toBe(false);
    expect(await page.locator("main").count()).toBe(1);
  });

  test("Disconnect asks in the app's own alert, and after a yes says what became of the key", async () => {
    const { page } = b;
    await page.goto(`${b.server.url}/settings?section=app`);
    const group = page.locator("[data-account-settings]");
    // No: nothing changes, nothing is said.
    b.hub.alert = () => false;
    await group.locator("[data-disconnect]").click();
    await expect(group.locator("[data-disconnect]")).toBeEnabled();
    await expect(group.getByRole("alert")).toHaveCount(0);
    expect(b.hub.accounts.size).toBe(1);
    // The alert could not be shown: said, in the app's words.
    b.hub.alert = () => null;
    await group.locator("[data-disconnect]").click();
    await expect(group.getByRole("alert")).toHaveText("The question could not be shown. Try again.");
    // Yes.
    b.hub.alert = () => true;
    await group.locator("[data-disconnect]").click();
    const gone = step(page, "account-disconnected");
    await expect(gone).toBeVisible();
    await expect(page.getByText("Disconnected")).toBeVisible();
    await expect(
      page.getByText(
        "The key is forgotten on this device. It keeps working until you revoke it on spacesheep: Settings → API keys.",
      ),
    ).toBeVisible();
    await shot(page, "disconnected");
    await button(page, "Open API keys on spacesheep").click();
    expect((await opened(page)).at(-1)).toBe(`${ORIGIN}/settings/api-keys`);
    await button(page, "Done").click();
    await expect(step(page, "welcome")).toBeVisible();
    // Said once: the welcome opens as the welcome from then on.
    await page.goto(b.server.url);
    await expect(step(page, "welcome")).toBeVisible();
    expect(b.hub.accounts.size).toBe(0);
    expect(b.server.strays).toEqual([]);
  });
});

test.describe("a phone that cannot sign", () => {
  let b: Bed;
  test.beforeAll(async ({ browser }) => {
    b = await bed(browser, {
      platform: "android",
      shell: { signer: "Sending from this phone comes in a later version" },
    });
    b.hub.add("me@example.com", b.ss.key);
  });
  test.afterAll(async () => b?.close());

  test("one honest line and the way on, and nothing is asked of spacesheep for it", async () => {
    const { page } = b;
    await page.goto(`${b.server.url}/add-device`);
    await expect(page.locator("[data-approve='cannot']")).toBeVisible();
    await expect(page.getByText("Approve this phone").first()).toBeVisible();
    await expect(page.getByText("Sending from this phone comes in a later version.")).toBeVisible();
    await expect(page.locator("[data-elsewhere]")).toHaveText(`Open on ${HOST}`);
    await expect(button(page, "Ask spacesheep to approve")).toHaveCount(0);
    expect(b.ss.deviceRequests.size).toBe(0);
    await shot(page, "approve-cannot");
  });
});

test("the Approve page's blocks are panels that start at one edge, at any width", async ({ browser }) => {
  const b = await bed(browser);
  b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
  try {
    // Asked, and waiting: where it stands, the computers, and taking the phone off again.
    await b.page.goto(`${b.server.url}/add-device?ask=1`);
    await expect(b.page.locator("[data-approve='waiting']")).toBeVisible({ timeout: 15_000 });
    const groups = b.page.locator(".approve > .form-group");
    await expect.poll(() => groups.count()).toBeGreaterThanOrEqual(2);
    const boxes = await groups.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const first = el.firstElementChild?.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          inner: (first?.left ?? r.left) - r.left,
          radius: getComputedStyle(el).borderTopLeftRadius,
        };
      }),
    );
    // One left edge and one right edge for all of them; and on a wide screen, where the
    // page draws no panels of its own, each is one, and what is inside starts equally far in.
    for (const k of W >= 840 ? (["left", "right", "inner"] as const) : (["left", "right"] as const))
      expect(new Set(boxes.map((x) => Math.round(x[k]))).size, `${k}: ${JSON.stringify(boxes)}`).toBe(1);
  } finally {
    await b.close();
  }
});

test("the Approve page is named as itself, wraps its buttons at twice the text size, and keeps its marks apart in forced colours", async ({
  browser,
}) => {
  const b = await bed(browser);
  b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
  try {
    // 390 wide with the text at 200 %.
    await b.page.setViewportSize({ width: 195, height: 422 });
    await b.page.goto(`${b.server.url}/add-device`);
    // The tab, and what a screen reader hears on arriving, is the page's own title.
    await expect(b.page).toHaveTitle(/^Approve this iPhone · /);
    const ask = button(b.page, "Ask spacesheep to approve");
    await expect(ask).toBeVisible({ timeout: 15_000 });
    const box = (await ask.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(195.5);
    expect(await b.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Forced colours draw no background: the warn dot stays filled (by its border), not the wait's ring.
    b.ss.revoked = true;
    await b.page.emulateMedia({ forcedColors: "active" });
    await b.page.setViewportSize({ width: W, height: H });
    await b.page.goto(`${b.server.url}/settings?section=app`);
    const warn = b.page.locator("[data-account-settings] .acct-state--warn").first();
    await expect(warn).toBeVisible({ timeout: 20_000 });
    const mark = await warn.evaluate((el) => {
      const cs = getComputedStyle(el, "::before");
      return { width: cs.width, border: cs.borderTopWidth };
    });
    // Its border is half its width on every side: all border, no hole.
    expect(mark).toEqual({ width: "8px", border: "4px" });
  } finally {
    await b.close();
  }
});

test("connected again with a key the computer still trusts: approved at once, and spacesheep is asked nothing", async ({
  browser,
}) => {
  const b = await bed(browser);
  b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
  const { page } = b;
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
    // Approved long ago: the computer trusts this phone's key.
    const id = [...b.hub.accounts.keys()][0]!;
    const asked = await page.evaluate(
      (account) =>
        (
          window as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> } }
        ).__TAURI_INTERNALS__.invoke("acct_device_ask", { id: account }) as Promise<{ keyId: string }>,
      id,
    );
    (b.ss.machines[0]!.passkey_ids as string[]).push(asked.keyId);
    b.ss.trusting.set(asked.keyId, [MACHINE]);
    // Disconnected and connected again: a new account to the hub, which has no word of the
    // phone's key under it. The key, and the computer's trust in it, are as they were.
    b.hub.accounts.clear();
    b.hub.active = null;
    b.hub.add("me@example.com", b.ss.key);
    const asks = () => b.ss.log.filter((l) => l.startsWith("POST /api/gui/device")).length;
    const before = asks();
    await page.goto(`${b.server.url}/add-device?ask=1`);
    await expect(page.locator("[data-approve='approved']")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("This iPhone can send.")).toBeVisible();
    await expect(page.locator("[data-machine='can']")).toHaveText(/Can send$/);
    await expect(button(page, "Ask spacesheep to approve")).toHaveCount(0);
    // Settings says the same, and nothing was asked of spacesheep (an ask rings and mails the account).
    await page.goto(`${b.server.url}/settings?section=app`);
    await expect(page.locator("[data-account-settings] .acct-state--ok").last()).toHaveText("Can send");
    await expect(page.locator("[data-account-settings]")).not.toContainText("Not approved yet");
    expect(asks()).toBe(before);
  } finally {
    await b.close();
  }
});

test("an email as long as an email may be wraps beside its state in Settings › App, at any width", async ({
  browser,
}) => {
  for (const email of [
    "firstname.middlename.lastname+phone@a-long-company-name.example",
    `${"a".repeat(64)}@${"long-label.".repeat(16)}${"b".repeat(10)}.example`,
  ]) {
    const b = await bed(browser);
    b.hub.add(email, b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    try {
      await b.page.goto(`${b.server.url}/settings?section=app`);
      const group = b.page.locator("[data-account-settings]");
      const label = group.getByText(email, { exact: true }).first();
      await expect(label).toBeVisible({ timeout: 15_000 });
      const mark = group.locator(".acct-state").first();
      await expect(mark).toBeVisible();
      const [l, m] = [(await label.boundingBox())!, (await mark.boundingBox())!];
      // All of it is on screen, and it ends where its state begins.
      expect(l.x + l.width, email).toBeLessThanOrEqual(m.x + 0.5);
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await b.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await b.close();
    }
  }
});

// What follows is not a screen of its own: it is what the page's own backend says on the
// screens the app already has, each in its place (the pictures page's "What else an
// account shows").
test.describe("what else an account shows", () => {
  const json = { "content-type": "application/json" };
  /** A phone whose key the computer trusts, as after an approval long ago (asked from the
   *  page, where the shell holds the key). */
  const trusted = async (b: Bed): Promise<void> => {
    const id = [...b.hub.accounts.keys()][0]!;
    const asked = await b.page.evaluate(
      (account) =>
        (
          window as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> } }
        ).__TAURI_INTERNALS__.invoke("acct_device_ask", { id: account }) as Promise<{ keyId: string }>,
      id,
    );
    (b.ss.machines[0]!.passkey_ids as string[]).push(asked.keyId);
    b.ss.trusting.set(asked.keyId, [MACHINE]);
  };
  const composer = (page: Page) => page.locator("textarea").first();

  test("a page only a GUI server has, the search, and the files of a session", async ({ browser }) => {
    const b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(`${b.server.url}/setup`);
      await expect(page.getByText("This needs a sessionpipe-gui server")).toBeVisible();
      await expect(page.getByText("This app is showing a spacesheep account, which has none.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Go to Board" }).first()).toBeVisible();
      await shot(page, "also-not-here");
      await page.goto(`${b.server.url}/search`);
      await expect(page.getByText("Prompts, replies and tool calls from every machine on this account.")).toBeVisible();
      await shot(page, "also-search");
      await page.goto(`${b.server.url}/s/claude-code/s-invoice`);
      await expect(page.getByText("Found the loop.").first()).toBeVisible();
      await page.getByRole("button", { name: "Files" }).first().click();
      await expect(
        page.getByText(
          "The files this session reads and changes show here by name. spacesheep is never sent what is in them.",
        ),
      ).toBeVisible();
      await shot(page, "also-files");
    } finally {
      await b.close();
    }
  });

  test("an account with nothing on it: the first board, the same at spacesheep's limit, and no machines", async ({
    browser,
  }) => {
    const b = await bed(browser);
    // Nothing was sent to this account yet, and no computer is paired with it.
    b.ss.drop(b.ss.newest);
    b.ss.machines = [];
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      b.ss.limit = 0;
      await page.goto(b.server.url);
      await expect(page.getByText("This app is reading too often for spacesheep")).toBeVisible();
      await expect(page.getByText("It catches up by itself.")).toBeVisible();
      await shot(page, "also-first-limited");
      b.ss.limit = 240;
      await page.goto(b.server.url);
      await expect(page.getByText("Waiting for your first session")).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText("Start an agent on a computer paired with this account and it appears here."),
      ).toBeVisible();
      await shot(page, "also-empty-board");
      await page.goto(`${b.server.url}/machines`);
      await expect(page.getByText("No machines yet")).toBeVisible();
      await expect(
        page.getByText(`Pair a computer with this account on ${HOST}. Its sessions show up here.`),
      ).toBeVisible();
      await shot(page, "also-no-machines");
    } finally {
      await b.close();
    }
  });

  test("what the phone cannot keep, said once: the sessions, and the labels and read marks", async ({ browser }) => {
    // No storage to keep the sessions in.
    let b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    try {
      await b.context.addInitScript(() => {
        Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true });
      });
      await b.page.goto(b.server.url);
      await expect(b.page.getByText("Sessions are not kept on this phone")).toBeVisible();
      await expect(
        b.page.getByText("Its storage could not be opened, so they load again each time the app opens."),
      ).toBeVisible();
      await shot(b.page, "also-not-kept");
    } finally {
      await b.close();
    }
    // The hub cannot read the person's labels and marks.
    b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    try {
      b.hub.unreadDocs.add("labels").add("marks");
      await b.page.goto(b.server.url);
      await expect(b.page.getByText("Labels and read marks are not being saved")).toBeVisible({ timeout: 15_000 });
      await expect(
        b.page.getByText("This phone could not read the ones it keeps, so changes made now are not kept."),
      ).toBeVisible();
      await shot(b.page, "also-labels-not-saved");
    } finally {
      await b.close();
    }
  });

  test("spacesheep out of reach, a send it took without naming its job, and one nobody heard the answer to", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(`${b.server.url}/s/claude-code/s-invoice`);
      await expect(page.getByText("Found the loop.").first()).toBeVisible();
      await trusted(b);
      await page.reload();
      await expect(page.getByText("Found the loop.").first()).toBeVisible();
      const box = composer(page);
      await expect(box).toBeEnabled();
      // spacesheep takes a send and its answer names no job.
      b.ss.sendAnswers.push(() => ({ status: 202, headers: json, body: "{}" }));
      await box.fill("Does the retry stop now?");
      await box.press("Enter");
      await expect(
        page.getByText("Sent, but this app can't follow it. Check spacesheep.dev to see how it went.").first(),
      ).toBeVisible({ timeout: 15_000 });
      await shot(page, "also-sent-not-followed");
      // A send spacesheep takes, with every answer lost on the way back.
      b.hub.unheard = 99;
      await box.fill("And the payout webhook?");
      await box.press("Enter");
      await expect(
        page.getByText(
          "It may have been sent: spacesheep did not answer in time. Look at the session before you send it again.",
        ),
      ).toBeVisible({ timeout: 20_000 });
      await expect(box).toHaveValue("And the payout webhook?");
      await shot(page, "also-may-have-been-sent");
      // The app hears of it by itself: the words leave the box.
      b.hub.unheard = 0;
      await expect(box).toHaveValue("", { timeout: 60_000 });
      // spacesheep cannot be reached: the board says so, with the way to ask again.
      b.hub.down = true;
      await page.goto(b.server.url);
      await expect(page.locator("text=Reconnecting… >> visible=true").first()).toBeVisible({ timeout: 60_000 });
      await shot(page, "also-reconnecting");
    } finally {
      await b.close();
    }
  });
  test("a permission prompt inside the hour: the hour's line over Deny / Allow, and neither is offered, on the session's page and on the Inbox card", async ({
    browser,
  }) => {
    const b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(`${b.server.url}/s/claude-code/s-invoice`);
      await expect(page.getByText("Found the loop.").first()).toBeVisible();
      // Approved a moment ago, and spacesheep says until when the key waits.
      const id = [...b.hub.accounts.keys()][0]!;
      const asked = await page.evaluate(
        (account) =>
          (
            window as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> } }
          ).__TAURI_INTERNALS__.invoke("acct_device_ask", { id: account }) as Promise<{ keyId: string }>,
        id,
      );
      b.ss.saysCooling = true;
      b.ss.approveDevice(asked.keyId);
      // In another session the agent asks to run something.
      const s = new Session("s-refund");
      const on = {
        tier: 2 as const,
        session: { machine: NAME, cwd: "/Users/me/billing", title: "Refund the double charge" },
      };
      b.ss.push([
        s.ev("session.started", { source: "startup" }, on),
        s.ev("turn.started", { turn_id: "t1" }, on),
        s.ev(
          "attention.needed",
          { attention_id: "perm-1", kind: "permission", tool: "Bash", message: "Bash npm test" },
          on,
        ),
      ]);
      await page.goto(`${b.server.url}/s/claude-code/s-refund`);
      const line = /This iPhone can send from \d{1,2}:\d{2}( [AP]M)?/;
      await expect(page.getByText(line).first()).toBeVisible({ timeout: 15_000 });
      // Over Deny / Allow: the hour's own line, and no button that would be refused.
      await expect(page.getByText("this page cannot sign an answer")).toHaveCount(0);
      const allow = page.getByRole("button", { name: "Allow" }).first();
      await expect(allow).toBeVisible();
      await expect(allow).toBeDisabled();
      await expect(page.getByRole("button", { name: "Deny" }).first()).toBeDisabled();
      expect(await page.getByText(line).count()).toBeGreaterThanOrEqual(2);
      await shot(page, "also-prompt-cooling");
      // The Inbox card: the same reason, and the same two buttons off.
      await page.goto(`${b.server.url}/inbox`);
      const row = page.locator(".inbox-row").first();
      await expect(row).toBeVisible();
      await expect(row.getByRole("button", { name: "Allow" })).toBeDisabled();
      await expect(page.getByText(line).first()).toBeVisible();
      expect(b.ss.log.filter((l) => l.startsWith("POST /api/machines/"))).toEqual([]);
    } finally {
      await b.close();
    }
  });
});
