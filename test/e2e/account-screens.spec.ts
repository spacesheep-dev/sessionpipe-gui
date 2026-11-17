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
/** What an ended connect says where a key was made and is not kept here, beside the button
 *  to it (the hub's own note says the way there in words, and is shown only without one). */
const UNUSED_KEY = "Revoke the unused key on spacesheep.";

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

  test("approved with the app open and nothing reloaded: Machines, New session and the composer say what the Approve page says", async () => {
    const { page } = b;
    // From here on the page is never loaded again: what it knows of its own key is what the
    // ask left it (the hub made the key then, where the page does not see it).
    let loads = 0;
    page.on("load", () => loads++);
    b.ss.approveDevice([...b.hub.accounts.values()][0]!.deviceKeyId!);
    await expect(page.locator("[data-approve='cooling']")).toBeVisible({ timeout: 12_000 });
    // Machines, by its tab: one row says the phone's hour, and nothing offers to approve it again.
    await page.locator("a[data-nav='machines']:visible").click();
    await expect(page.locator("[data-this-phone='cooling']")).toHaveText(/^This iPhone can send from \d{1,2}:\d{2}/);
    await expect(page.locator("[data-setup]")).toHaveCount(0);
    await expect(page.getByText(/Approve this iPhone/)).toHaveCount(0);
    // New session, from the Board's bar: nothing says the computer does not trust the phone.
    await page.locator("a[data-nav='board']:visible").click();
    await page.locator(".page.board .compose-btn--phone").click();
    const sheet = page.locator("[data-new-session]");
    await expect(sheet.locator(".ns-status")).toBeVisible();
    await expect(sheet).not.toContainText(/doesn't trust|can't send yet/);
    await sheet.locator("[data-ns-cancel]").click();
    await expect(sheet).toHaveCount(0);
    // A session, from the board: the composer says the hour, and nothing of trust.
    await page.getByText("Fix the invoice webhook").first().click();
    await expect(page.getByText("Found the loop.").first()).toBeVisible();
    await expect(page.getByText(/This iPhone can send from \d{1,2}:\d{2}( [AP]M)?/).first()).toBeVisible();
    await expect(page.getByText(/doesn't trust|can't send yet|Approve this iPhone/)).toHaveCount(0);
    expect(loads).toBe(0);
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
    await expect(b.page.getByText("Check your connection, then try again.")).toBeVisible();
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
    b.hub.startRefusal = new HubRefused("busy", "Another question is open on this iPhone. Answer it first.");
    await button(b.page, "Continue").click();
    await expect(ended("busy")).toBeVisible();
    await expect(b.page.getByText("Another question is open", { exact: true })).toBeVisible();
    await expect(b.page.getByText("Answer it, then try again.")).toBeVisible();
    await shot(b.page, "end-busy");
  });

  test("Not now on spacesheep's page: said as the person's own choice", async () => {
    await start();
    b.ss.approve(await digits(), false);
    await b.hub.pollConnect();
    await expect(ended("denied")).toBeVisible();
    await expect(b.page.getByText("You chose Not now on spacesheep.")).toBeVisible();
    await shot(b.page, "end-denied");
  });

  test("refused here, in the hub's own question: a key was made, and the page says to revoke it, once, with the way there", async () => {
    await start();
    b.hub.alert = () => false;
    b.ss.approve(await digits());
    await b.hub.pollConnect();
    await expect(ended("declined")).toBeVisible();
    await expect(b.page.getByText(UNUSED_KEY)).toBeVisible();
    // The button says the way there, so the words do not: the hub's note is not shown.
    await expect(b.page.getByText(UNUSED_KEY_NOTE)).toHaveCount(0);
    // Try again where it is on every ended screen, the way to the key under it.
    await expect(ended("declined").locator(".onb-primary, .onb-secondary")).toHaveText(["Try again", "Open API keys"]);
    await shot(b.page, "end-declined");
    await button(b.page, "Open API keys").click();
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
    // Not the welcome: the key that was made, and the way to it.
    await expect(b.page.locator(".onb[data-step='account-ended']")).toBeVisible();
    await expect(b.page.getByText(UNUSED_KEY)).toBeVisible();
    await expect(button(b.page, "Open API keys")).toBeVisible();
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
    await expect(b.page.getByText(UNUSED_KEY)).toBeVisible();
    await expect(button(b.page, "Open API keys")).toBeVisible();
    // Left, it is not shown again.
    await b.page
      .locator(".onb[data-step='account-ended'] .onb-back, .onb[data-step='account-ended'] [data-back]")
      .first()
      .click();
    await expect(b.page.locator(".onb[data-step='account-ended']")).toHaveCount(0);
    await b.page.goto(b.server.url);
    await expect(step(b.page, "welcome")).toBeVisible();
    await expect(b.page.getByText(UNUSED_KEY)).toHaveCount(0);
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

  test("the browser could not be opened: the number keeps its button, and nothing says an answer is waited for there", async () => {
    await start();
    await digits();
    const said = async () => calls(b.page);
    const before = b.hub.opened.length;
    const asked = (await said()).length;
    // The hub's `not_opened`: the system browser did not take the link.
    b.hub.openFails = true;
    await button(b.page, "Open in Safari").click();
    // The page asked the hub to open, was refused, and read where the connect stands.
    await expect
      .poll(async () => {
        const since = (await said()).slice(asked);
        const open = since.indexOf("acct_connect_open");
        return open >= 0 && since.indexOf("acct_status", open) > open;
      })
      .toBe(true);
    expect(b.hub.opened).toHaveLength(before);
    await expect(step(b.page, "account-number")).not.toHaveAttribute("data-opened", "true");
    await expect(b.page.getByText("Waiting for you to confirm on spacesheep.")).toHaveCount(0);
    await expect(button(b.page, "Open in Safari")).toHaveClass(/btn--primary/);
    // The next tap, with the browser there, hands off as any other.
    b.hub.openFails = false;
    await button(b.page, "Open in Safari").click();
    await expect(step(b.page, "account-number")).toHaveAttribute("data-opened", "true");
    expect(b.hub.opened).toHaveLength(before + 1);
    await button(b.page, "Cancel").click();
  });

  test("nobody confirmed in time", async () => {
    // Its end has passed when spacesheep says it ran out.
    b.ss.connectTtlMs = 0;
    await start();
    b.ss.expire(await digits());
    await b.hub.pollConnect();
    await expect(ended("expired")).toBeVisible();
    await expect(b.page.getByText("Time ran out")).toBeVisible();
    await expect(b.page.getByText("Try again for a new number.")).toBeVisible();
    await expect(button(b.page, "Open API keys")).toHaveCount(0);
    await shot(b.page, "end-expired");
    b.ss.connectTtlMs = 600_000;
  });

  test("approved, and the phone could not keep it: the same note, the same way to revoke", async () => {
    await start();
    b.hub.keep = "keystore";
    b.ss.approve(await digits());
    await b.hub.pollConnect();
    await expect(ended("not-kept")).toBeVisible();
    await expect(b.page.getByText("Couldn't save the account on this iPhone")).toBeVisible();
    await expect(b.page.getByText(UNUSED_KEY)).toBeVisible();
    await expect(ended("not-kept").locator(".onb-primary, .onb-secondary")).toHaveText(["Try again", "Open API keys"]);
    await shot(b.page, "end-not-kept");
    b.hub.keep = "ok";
  });

  test("an answer this version cannot use", async () => {
    b.ss.connectAnswer = { status: 500, headers: {}, body: "{}" };
    await start();
    await expect(ended("unexpected")).toBeVisible();
    await expect(b.page.getByText("Couldn't connect")).toBeVisible();
    await expect(b.page.getByText("If it keeps happening, update this app.")).toBeVisible();
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

test("a wait that names no time offers its try a few minutes on, and one that names a time when it has come", async ({
  browser,
}) => {
  const b = await bed(browser);
  try {
    // The page's clock is this test's to move: nobody waits three minutes here.
    await b.page.clock.install();
    await b.page.goto(b.server.url);
    await button(b.page, "Use a spacesheep account").click();
    // spacesheep asked the app to wait and named no time (no Retry-After).
    b.hub.startRefusal = new HubRefused("rate_limited", "spacesheep asked to wait a bit. Try again in a minute.");
    await button(b.page, "Continue").click();
    await expect(b.page.locator(".onb[data-step='account-ended'][data-why='wait']")).toBeVisible();
    await expect(b.page.getByText("Try again in a few minutes.")).toBeVisible();
    await expect(button(b.page, "Try again")).toHaveCount(0);
    await b.page.clock.fastForward(170_000);
    await expect(button(b.page, "Try again")).toHaveCount(0);
    // A few minutes on the try is there: the screen is not a dead end with only Back.
    await b.page.clock.fastForward(15_000);
    await expect(button(b.page, "Try again")).toBeVisible();
    // Tried, and refused with a time: no button until that time, then the button.
    b.hub.startRefusal = new HubRefused("too_many_starts", "Too many tries. Wait a while, then connect again.", {
      retryAfterS: 600,
    });
    await button(b.page, "Try again").click();
    await expect(b.page.getByText(/^Try again at \d{1,2}:\d{2}( [AP]M)?/)).toBeVisible();
    await expect(button(b.page, "Try again")).toHaveCount(0);
    await b.page.clock.fastForward(590_000);
    await expect(button(b.page, "Try again")).toHaveCount(0);
    await b.page.clock.fastForward(15_000);
    await expect(button(b.page, "Try again")).toBeVisible();
  } finally {
    await b.close();
  }
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
    // Machines says the same time once, in its one row for the phone, and no computer says
    // it again; Settings' row for the phone's key says the same time, in a row's few words.
    await page.goto(`${b.server.url}/machines`);
    await expect(page.getByText(NAME).first()).toBeVisible();
    const phone = page.locator("[data-this-phone]");
    await expect(phone).toHaveCount(1);
    await expect(phone).toHaveAttribute("data-this-phone", "cooling");
    await expect(phone).toHaveText(/^This iPhone can send from \d{1,2}:\d{2}( [AP]M)?$/);
    await expect(phone).toHaveAttribute("href", "/add-device");
    await expect(page.getByText(/can send/i)).toHaveCount(1);
    await expect(page.locator("[data-setup]")).toHaveCount(0);
    await shot(page, "machines-cooling");
    await page.goto(`${b.server.url}/settings?section=app`);
    await expect(page.locator("[data-account-settings] .acct-state--wait")).toHaveText(
      /^Can send from \d{1,2}:\d{2}( [AP]M)?$/,
    );
  });

  test("approved while the page was not looking: the latest it can be, said as that", async () => {
    const { page } = b;
    // The page last saw the request open ten minutes before it saw it trusted (the app was
    // closed in between): what it remembered of watching is that.
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sessionpipe-gui.account.device."))!;
      const memo = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
      delete memo.trustedAt;
      delete memo.watched;
      memo.openAt = Date.now() - 600_000;
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
    // Yes. The account's view turns to "gone" a moment before the window is replaced, and
    // the group is drawn once more in between: as nothing, with the rest of Settings still
    // there, and without a throw that takes the whole page down. The reload is held back
    // so that the old page lives long enough to draw it; what it drew is told from inside
    // (a page whose navigation is held answers no question from here).
    const thrown: string[] = [];
    const drawn: string[] = [];
    const onError = (e: Error) => thrown.push(e.message);
    const onConsole = (m: { text(): string }) => {
      if (m.text().startsWith("group gone:")) drawn.push(m.text());
    };
    page.on("pageerror", onError);
    page.on("console", onConsole);
    await page.evaluate(() => {
      new MutationObserver((_, o) => {
        if (document.querySelector("[data-account-settings]")) return;
        o.disconnect();
        console.log(`group gone: the pane is ${document.querySelector(".settings-pane") ? "drawn" : "not drawn"}`);
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.route(
      (url) => url.pathname === "/",
      async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      },
      { times: 1 },
    );
    b.hub.alert = () => true;
    await group.locator("[data-disconnect]").click();
    const gone = step(page, "account-disconnected");
    await expect(gone).toBeVisible({ timeout: 15_000 });
    expect(thrown).toEqual([]);
    expect(drawn).toEqual(["group gone: the pane is drawn"]);
    page.off("pageerror", onError);
    page.off("console", onConsole);
    await expect(page.getByText("Disconnected")).toBeVisible();
    await expect(
      page.getByText(
        "The key is forgotten on this iPhone. It keeps working until you revoke it on spacesheep: Settings → API keys.",
      ),
    ).toBeVisible();
    await shot(page, "disconnected");
    await button(page, "Open API keys").click();
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
    // Nothing asked yet. On a tablet the page's large button is a button, a phone's column
    // wide at most, not a bar across the panel.
    await b.page.goto(`${b.server.url}/add-device`);
    await expect(b.page.locator("[data-approve='idle']")).toBeVisible({ timeout: 15_000 });
    const ask = button(b.page, "Ask spacesheep to approve");
    await expect(ask).toBeEnabled();
    expect((await ask.boundingBox())!.width).toBeLessThanOrEqual(360.5);
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
    // A row's button is one line of label, whole: the words beside it wrap, not it.
    for (const name of ["Open Devices"]) {
      const sizes = await b.page.getByRole("button", { name }).evaluateAll((els) =>
        els.map((el) => ({
          h: el.getBoundingClientRect().height,
          lines: el.getClientRects().length,
          w: el.scrollWidth <= el.clientWidth + 1,
          lh: Number.parseFloat(getComputedStyle(el).lineHeight),
        })),
      );
      expect(sizes.length).toBeGreaterThanOrEqual(2);
      for (const z of sizes) {
        expect(z.w, JSON.stringify(z)).toBe(true);
        // Tall enough for a finger, and not grown by a label broken over lines.
        expect(z.h, JSON.stringify(z)).toBeGreaterThanOrEqual(44);
        expect(z.h, JSON.stringify(z)).toBeLessThan(50);
      }
    }
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

  test("approved long ago, where the page never saw it wait: every screen says it can send, and no hour is made up", async ({
    browser,
  }) => {
    const b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(b.server.url);
      await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
      await trusted(b);
      await page.goto(`${b.server.url}/settings?section=app`);
      await expect(page.locator("[data-account-settings] .acct-state--ok").last()).toHaveText("Can send");
      await expect(page.getByText(/can send (by|from)/i)).toHaveCount(0);
      await page.goto(`${b.server.url}/add-device`);
      await expect(page.locator("[data-approve='approved']")).toBeVisible();
      await page.goto(`${b.server.url}/s/claude-code/s-invoice`);
      await expect(page.getByText("Found the loop.").first()).toBeVisible();
      await expect(composer(page)).toBeEnabled();
      await expect(page.getByText(/can send (by|from)|doesn't trust|can't send yet/i)).toHaveCount(0);
      await page.goto(`${b.server.url}/machines`);
      await expect(page.locator("[data-this-phone='approved']")).toHaveText("This iPhone can send");
      await expect(page.locator("[data-setup]")).toHaveCount(0);
    } finally {
      await b.close();
    }
  });

  /** Each right-detail row of Machines: how far its key's top is from its value's. */
  const rowDrift = (page: Page) =>
    page
      .locator(".machine-facts > .form-row--kv")
      .evaluateAll((rows) =>
        rows.map((r) =>
          Math.abs(
            r.querySelector(".form-key")!.getBoundingClientRect().top -
              r.querySelector(".form-kv")!.getBoundingClientRect().top,
          ),
        ),
      );

  test("Machines, not approved: one row for the phone above the computers, no key named, and rows that keep their shape at 320 and 393", async ({
    browser,
  }) => {
    const b = await bed(browser);
    // A second computer: the one row is said once, not once a computer.
    b.ss.machines.push({
      ...b.ss.machines[0]!,
      id: "m_build0123456789abcdef",
      name: "build-box",
      mode: "auto",
      passkey_ids: ["another-passkey-of-this-account"],
    });
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      for (const [width, height] of [
        [320, 568],
        [393, 852],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.goto(`${b.server.url}/machines`);
        await expect(page.locator("section.machine")).toHaveCount(2);
        const row = page.locator("[data-this-phone]");
        await expect(row).toHaveCount(1);
        await expect(row).toHaveAttribute("data-this-phone", "idle");
        await expect(row).toHaveText("Approve this iPhone to send");
        expect((await row.boundingBox())!.height, `${width}`).toBeGreaterThanOrEqual(44);
        // One way to Approve this iPhone on the page, and it is that row.
        await expect(page.locator("a[href='/add-device']")).toHaveCount(1);
        // No key is named, by any part of its id; nothing says paired, devices or "this one".
        const text = await page.locator(".page.machines").innerText();
        for (const m of b.ss.machines)
          for (const id of m.passkey_ids as string[]) expect(text).not.toContain(id.slice(0, 8));
        expect(text).not.toMatch(/paired on|Paired|Devices|this one|queued/);
        // Status and Sessions, as iOS right-detail rows: each key level with its value.
        await expect(page.locator("[data-status='online']")).toHaveCount(2);
        const counts = page.locator(".machine-facts > .form-row--kv .form-kv.num");
        await expect(counts).toHaveCount(2);
        expect((await counts.allInnerTexts()).sort()).toEqual(["1", "None yet"]);
        const drift = await rowDrift(page);
        expect(drift).toHaveLength(4);
        for (const d of drift) expect(d, `${width}`).toBeLessThanOrEqual(2);
        await expect(page.locator(".machine-more summary").first()).toHaveText("Details");
        expect((await page.locator(".machine-more summary").first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
    } finally {
      await b.close();
    }
  });

  test("Machines, approved on spacesheep before its list carries the key: the phone's hour, and no Approve this iPhone", async ({
    browser,
  }) => {
    const b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(`${b.server.url}/add-device`);
      await button(page, "Ask spacesheep to approve").click();
      await expect(page.locator("[data-approve='waiting']")).toBeVisible();
      // Approved on Devices: the device door says so, the computer's key list not yet.
      const keyId = [...b.hub.accounts.values()][0]!.deviceKeyId!;
      b.ss.trusting.set(keyId, [MACHINE]);
      b.ss.deviceRequests.delete(keyId);
      await expect(page.locator("[data-approve='cooling']")).toBeVisible({ timeout: 12_000 });
      expect(b.ss.machines[0]!.passkey_ids).not.toContain(keyId);
      await page.goto(`${b.server.url}/machines`);
      await expect(page.locator("[data-this-phone='cooling']")).toHaveText(
        /^This iPhone can send from \d{1,2}:\d{2}( [AP]M)?$/,
      );
      await expect(page.getByText(/Approve this iPhone/)).toHaveCount(0);
      await expect(page.locator("[data-not-here]")).toHaveCount(0);
    } finally {
      await b.close();
    }
  });

  test("Machines in inherit mode: what it means is in sight with Details closed, and Details is closed again on the next visit", async ({
    browser,
  }) => {
    const b = await bed(browser);
    b.ss.machines[0]!.mode = "inherit";
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(`${b.server.url}/machines`);
      await expect(
        page.getByText(
          `Sessions run as your own do on ${NAME}: the agents' own settings decide, which can mean no permission checks.`,
        ),
      ).toBeVisible();
      const details = page.locator(".machine-more details");
      await expect(details).not.toHaveAttribute("open");
      await page.locator(".machine-more summary").click();
      await expect(details).toHaveAttribute("open");
      await expect(details.locator(".form-row--kv").first()).toHaveText(/^Mode\s*Inherit$/);
      // To the Board and back, inside the app: Details is closed again.
      await page.locator("a[data-nav='board']:visible").click();
      await expect(page.locator(".page.board")).toBeVisible();
      await page.goBack();
      await expect(page.locator(".machine-more details")).toHaveCount(1);
      await expect(page.locator(".machine-more details")).not.toHaveAttribute("open");
    } finally {
      await b.close();
    }
  });

  test("the board's offline line leads to Machines, which says the same computer is offline", async ({ browser }) => {
    const b = await bed(browser);
    // The computer's sessionpipe is down while a session there is still working: its events
    // keep arriving, and it is offline all the same.
    Object.assign(b.ss.machines[0]!, { online: false, last_seen: Date.now() - 3 * 3_600_000 });
    const s = new Session("s-retry");
    const on = { tier: 2 as const, session: { machine: NAME, cwd: "/Users/me/billing", title: "Retry the export" } };
    b.ss.push([s.ev("session.started", { source: "startup" }, on), s.ev("turn.started", { turn_id: "t1" }, on)]);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      for (const [width, height] of [
        [320, 568],
        [393, 852],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.goto(b.server.url);
        await expect(page.locator(".offline-line")).toHaveText(new RegExp(`${NAME} is offline`));
        await page.locator(".offline-line-text").click();
        await expect(page).toHaveURL(/\/machines$/);
        await expect(page.getByText("0 of 1 online", { exact: true })).toBeVisible();
        const status = page.locator("section.machine [data-status]");
        await expect(status).toHaveAttribute("data-status", "offline");
        await expect(status.locator(".form-kv")).toHaveText("Offline");
        await expect(status.locator(".dot--stale")).toBeVisible();
        expect(await status.locator(".form-kv").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expect(page.getByText(/online ·|daemon offline|last event/)).toHaveCount(0);
        for (const d of await rowDrift(page)) expect(d, `${width}`).toBeLessThanOrEqual(2);
      }
    } finally {
      await b.close();
    }
  });

  test("not approved yet: the composer and New session say it in one sentence, with Approve this iPhone as the way on", async ({
    browser,
  }) => {
    const b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(`${b.server.url}/s/claude-code/s-invoice`);
      await expect(page.getByText("Found the loop.").first()).toBeVisible();
      const foot = page.locator(".ctl-foot[data-reason='unapproved']");
      await expect(foot).toHaveText(/^This iPhone can't send yet\.\s*Approve this iPhone$/);
      await expect(foot.getByRole("link", { name: "Approve this iPhone" })).toHaveAttribute("href", "/add-device");
      await expect(page.getByText(/doesn't trust/)).toHaveCount(0);
      // New session: the same sentence, and its way on closes the sheet and opens the page.
      await page.goto(b.server.url);
      await page.locator(".page.board .compose-btn--phone").click();
      const sheet = page.locator("[data-new-session]");
      await expect(sheet.locator(".ns-status")).toHaveText(/^This iPhone can't send yet\.\s*Approve this iPhone$/);
      await expect(sheet.locator("[data-ns-start]")).toBeDisabled();
      await sheet.locator("[data-ns-approve]").click();
      await expect(page.locator("[data-approve='idle']")).toBeVisible();
      await expect(sheet).toHaveCount(0);
    } finally {
      await b.close();
    }
  });

  /** In another session the agent asks to run something, now (well inside its hook's wait):
   *  that session's id. */
  const asks = (b: Bed, id = "s-refund"): string => {
    const s = new Session(id, "claude-code", Date.now() - 4_000);
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
    return id;
  };
  const signs = async (page: Page) => (await calls(page)).filter((c) => c === "plugin:identity|sign").length;

  test("not approved, at every width: the prompt's card offers Approve this iPhone in place of Allow and Deny, the field is off, and the Inbox says it once", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      for (const [w, h] of [
        [320, 568],
        [390, 844],
        [820, 1180],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        const at = `${w}x${h}`;
        // The prompt: its question, one sentence, and the one way on, as wide as the card.
        const sid = asks(b, `s-refund-${w}`);
        await page.goto(`${b.server.url}/s/claude-code/${sid}`);
        const card = page.locator(".ctl-answer[data-attention='perm-1']");
        await expect(card, at).toHaveAttribute("data-answer", "unapproved");
        await expect(card.locator(".ctl-answer-note"), at).toHaveText("This iPhone can't answer yet.");
        const approve = card.getByRole("link", { name: "Approve this iPhone" });
        await expect(approve, at).toHaveAttribute("href", "/add-device");
        expect((await approve.boundingBox())!.height, at).toBeGreaterThanOrEqual(44);
        // Read in that order: the question, the sentence, the link.
        expect(await card.evaluate((el) => Array.from(el.children, (c) => c.className.split(" ").pop())), at).toEqual([
          "ctl-q",
          "ctl-answer-note",
          "ctl-approve",
        ]);
        // Nothing that would only be refused: no Allow, no Deny, no field to type in.
        await expect(page.getByRole("button", { name: /^(Allow|Deny)/ }), at).toHaveCount(0);
        await expect(page.locator("textarea"), at).toHaveCount(0);
        if (w === 390) await shot(page, "also-unapproved-prompt");
        // No prompt: the field and Send are off, and the line under it says why.
        await page.goto(`${b.server.url}/s/claude-code/s-invoice`);
        await expect(page.getByText("Found the loop.").first()).toBeVisible();
        const box = composer(page);
        await expect(box, at).toBeDisabled();
        await expect(page.getByRole("button", { name: "Send" }), at).toBeDisabled();
        const foot = page.locator(".ctl-foot[data-reason='unapproved']");
        await expect(foot, at).toHaveText(/^This iPhone can't send yet\.\s*Approve this iPhone$/);
        const described = await box.getAttribute("aria-describedby");
        await expect(page.locator(`[id='${described}']`), at).toHaveText("This iPhone can't send yet.");
        // The Inbox: the row opens its session and offers no answer; the notice says why, once.
        await page.goto(`${b.server.url}/inbox`);
        const row = page.locator(`.inbox-row[data-session='claude-code:${sid}']`);
        await expect(row, at).toBeVisible();
        await expect(row.getByRole("button", { name: /^(Allow|Deny)$/ }), at).toHaveCount(0);
        const notice = page.locator(".inbox-notes .notice").first();
        await expect(notice.locator(".notice-text"), at).toHaveText("This iPhone can't answer yet");
        await expect(notice.getByRole("link", { name: "Approve this iPhone" }), at).toHaveAttribute(
          "href",
          "/add-device",
        );
        await expect(page.getByText("Allow and Deny are off"), at).toHaveCount(0);
        if (w === 390) await shot(page, "also-unapproved-inbox");
        await row.locator(".inbox-main").click();
        await expect(page, at).toHaveURL(new RegExp(`/s/claude-code/${sid}`));
      }
      // The way on is the Approve page, and nothing on the way was signed.
      await page.locator(".ctl-approve").click();
      await expect(page.locator("[data-approve='idle']")).toBeVisible();
      expect(await signs(page)).toBe(0);
      expect(b.ss.log.filter((l) => l.startsWith("POST /api/machines/"))).toEqual([]);
    } finally {
      await b.close();
    }
  });

  test("approved, and this computer has not added the key yet: Allow, Deny and Send wait, disabled, with one sentence and no Approve", async ({
    browser,
  }) => {
    const b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(b.server.url);
      await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
      // Approved on spacesheep by another computer of the account, long ago; studio-mac has
      // not taken the key yet.
      const id = [...b.hub.accounts.keys()][0]!;
      const asked = await page.evaluate(
        (account) =>
          (
            window as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> } }
          ).__TAURI_INTERNALS__.invoke("acct_device_ask", { id: account }) as Promise<{ keyId: string }>,
        id,
      );
      const other = { ...b.ss.machines[0]!, id: "m_attic0123456789abcde", name: "attic-mini" };
      b.ss.machines.push({ ...other, passkey_ids: [asked.keyId] });
      b.ss.trusting.set(asked.keyId, [other.id]);
      b.ss.deviceRequests.delete(asked.keyId);
      asks(b);
      await page.goto(`${b.server.url}/s/claude-code/s-refund`);
      const line = "studio-mac adds this iPhone when it's next online.";
      const card = page.locator(".ctl-answer[data-attention='perm-1']");
      await expect(card.locator(".ctl-answer-note")).toHaveText(line, { timeout: 15_000 });
      await expect(card.getByRole("button", { name: "Allow" })).toBeDisabled();
      await expect(card.getByRole("button", { name: "Deny" })).toBeDisabled();
      await expect(composer(page)).toBeDisabled();
      await expect(page.locator(".ctl-foot[data-reason='catching-up']")).toHaveText(line);
      await expect(page.getByText(/Approve this iPhone|can't answer yet/)).toHaveCount(0);
      await shot(page, "also-catching-up-prompt");
      await page.goto(`${b.server.url}/inbox`);
      const row = page.locator(".inbox-row[data-attention='perm-1']");
      await expect(row.getByRole("button", { name: "Allow" })).toBeDisabled();
      await expect(page.getByText(`Allow and Deny are off: ${line}`)).toBeVisible();
      expect(await signs(page)).toBe(0);
    } finally {
      await b.close();
    }
  });

  test("approved, and the key read is slow at launch: Allow stays, and neither the Approve card nor the line under the field ever says to approve it", async ({
    browser,
  }) => {
    const b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(b.server.url);
      await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
      await trusted(b);
      // Connected again: the hub has no word of the phone's key under the new account, so what
      // the page knows of it is the computer's list against the key the signer reads.
      b.hub.accounts.clear();
      b.hub.active = null;
      b.hub.add("me@example.com", b.ss.key);
      asks(b);
      // The signer takes three seconds to say which key it holds; whatever offers to approve
      // the phone meanwhile is noted.
      await b.context.addInitScript(() => {
        const w = window as unknown as {
          __TAURI_INTERNALS__: { invoke(c: string, a?: unknown): Promise<unknown> };
          __sawApprove?: boolean;
        };
        const inner = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
        w.__TAURI_INTERNALS__.invoke = async (c, a) => {
          if (c === "plugin:identity|status") await new Promise((r) => setTimeout(r, 3000));
          return inner(c, a);
        };
        new MutationObserver(() => {
          if (document.querySelector(".ctl-approve, [data-answer='unapproved'], .ctl-foot a[href='/add-device']"))
            w.__sawApprove = true;
        }).observe(document, { subtree: true, childList: true, attributes: true });
      });
      await page.goto(`${b.server.url}/s/claude-code/s-refund`);
      const allow = page.locator(".ctl-answer[data-attention='perm-1']").getByRole("button", { name: "Allow" });
      await expect(allow).toBeVisible();
      await page.waitForTimeout(3500);
      await expect(allow).toBeEnabled();
      expect(await page.evaluate(() => (window as unknown as { __sawApprove?: boolean }).__sawApprove ?? false)).toBe(
        false,
      );
    } finally {
      await b.close();
    }
  });

  test("a send spacesheep refuses for a key the computer does not list: one Face ID, and the words say so", async ({
    browser,
  }) => {
    const b = await bed(browser);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(`${b.server.url}/s/claude-code/s-invoice`);
      await expect(page.getByText("Found the loop.").first()).toBeVisible();
      await trusted(b);
      await page.reload();
      const box = composer(page);
      await expect(box).toBeEnabled();
      // spacesheep no longer lists the phone's key for studio-mac; the page has not read that yet.
      b.ss.machines[0]!.passkey_ids = ["a-passkey-made-on-spacesheep"];
      const taps = () => page.evaluate(() => (window as unknown as { __taps: unknown[] }).__taps.length);
      const before = await taps();
      await box.fill("Does the retry stop now?");
      await box.press("Enter");
      await expect(page.locator(".ctl-foot")).toContainText("Not sent: studio-mac hasn't added this iPhone yet.", {
        timeout: 15_000,
      });
      // The first send of the day takes the grant: that one Face ID, and no second for a new one.
      expect((await taps()) - before).toBe(1);
      await expect(page.getByText(/day grant/)).toHaveCount(0);
    } finally {
      await b.close();
    }
  });

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

  /** Three pages of history on spacesheep: a question asked in the first and answered in
   *  the last, so a board drawn from part of it would say the session needs the person.
   *  Its relay reads: at spacesheep's limit while `limited`; past the first one answered,
   *  held until `release`. */
  const longHistory = (b: Bed) => {
    const asked = new Session("s-asked");
    const busy = new Session("s-busy", "claude-code", Date.now() - 2 * 3_600_000);
    const at = (title: string) => ({ tier: 2 as const, session: { machine: NAME, cwd: "/Users/me/billing", title } });
    const payout = at("Rename the payout job");
    const ledger = at("Index the ledger");
    b.ss.push([
      asked.ev("session.started", { source: "startup" }, payout),
      asked.ev("turn.started", { turn_id: "t1" }, payout),
      asked.ev(
        "attention.needed",
        { attention_id: "perm-1", kind: "permission", tool: "Bash", message: "Bash npm test" },
        payout,
      ),
      busy.ev("session.started", { source: "startup" }, ledger),
      ...Array.from({ length: 1000 }, (_, i) => busy.ev("tool.started", { tool: "Read", call_id: `c${i}` }, ledger)),
      asked.ev("attention.cleared", { attention_id: "perm-1" }, payout),
      asked.ev("turn.ended", { turn_id: "t1" }, payout),
    ]);
    const g = { limited: false, release: () => {} };
    const held = new Promise<void>((y) => {
      g.release = y;
    });
    let reads = 0;
    const handle = b.ss.handle.bind(b.ss);
    b.ss.handle = async (req) => {
      if (!req.path.startsWith("/api/sessionpipe/v1/relay?")) return handle(req);
      if (g.limited)
        return {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "1" },
          body: JSON.stringify({ error: "Too many requests.", code: "rate_limited" }),
        };
      if (reads++ > 0) await held;
      return handle(req);
    };
    return g;
  };
  const tab = (page: Page, name: string) => page.locator(".tabbar").getByRole("link", { name: new RegExp(`^${name}`) });

  test("a first connect with a long history: loading rows under 'Catching up…' and no badge, then the whole board once", async ({
    browser,
  }) => {
    const b = await bed(browser);
    const g = longHistory(b);
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(b.server.url);
      const catching = page.getByRole("status").filter({ hasText: "Catching up…" });
      await expect(catching).toBeVisible();
      // The rows stand in for the board; the bar is what says why, so they are not said too.
      const rows = page.locator(".board-skeleton");
      await expect(rows).toBeVisible();
      await expect(rows).toHaveAttribute("aria-label", "Catching up");
      await expect(rows).toHaveAttribute("aria-hidden", "true");
      // Past the wait after which a receiver would be said to be slow: still the loading rows.
      await page.waitForTimeout(6500);
      await expect(page.getByText("Still connecting to the receiver…")).toHaveCount(0);
      await expect(catching).toBeVisible();
      await expect(page.locator(".nav-badge")).toHaveCount(0);
      expect(await page.title()).not.toMatch(/^\(/);
      await shot(page, "also-catching-up");
      // Another tab says it as it opens, not a second after: it has been catching up a while.
      await tab(page, "Inbox").click();
      await expect(page.locator(".page.inbox").getByRole("status").filter({ hasText: "Catching up…" })).toBeVisible({
        timeout: 600,
      });
      await tab(page, "Board").click();
      await expect(page.locator(".page.board").getByRole("status").filter({ hasText: "Catching up…" })).toBeVisible({
        timeout: 600,
      });
      // The rest of the history: the board, once, with nobody waiting, and the line gone.
      g.release();
      await expect(page.getByText("Rename the payout job").first()).toBeVisible({ timeout: 15_000 });
      await expect(catching).toHaveCount(0);
      await expect(page.locator(".group--needs_you")).toHaveCount(0);
      await expect(page.locator(".nav-badge")).toHaveCount(0);
      // The hub's starting point for notifications is that board.
      await expect.poll(() => b.hub.needs.map((x) => x.sessions)).toEqual([[]]);
    } finally {
      g.release();
      await b.close();
    }
  });

  test("spacesheep's limit at the first read, then a long history: its line, then loading rows under 'Catching up…', never the first run", async ({
    browser,
  }) => {
    const b = await bed(browser);
    const g = longHistory(b);
    g.limited = true;
    b.hub.add("me@example.com", b.ss.key, Date.parse("2026-11-03T09:00:00Z"));
    const { page } = b;
    try {
      await page.goto(b.server.url);
      // Nothing read yet: the board says what stands in the way (also-first-limited).
      const limit = page.getByText("This app is reading too often for spacesheep");
      await expect(limit).toBeVisible();
      // The limit lifts into the history: the loading rows over that empty board, not
      // "Waiting for your first session" with its way to start one.
      g.limited = false;
      const catching = page.getByRole("status").filter({ hasText: "Catching up…" });
      await expect(catching).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".board-skeleton")).toBeVisible();
      await expect(limit).toHaveCount(0);
      await expect(page.getByText("Waiting for your first session")).toHaveCount(0);
      await expect(page.getByRole("button", { name: `Start a session on ${NAME}` })).toHaveCount(0);
      await expect(page.locator(".nav-badge")).toHaveCount(0);
      await shot(page, "also-catching-up-after-limit");
      // The Inbox the same: its loading rows, not "Nothing needs you".
      await tab(page, "Inbox").click();
      await expect(page.locator(".page.inbox .skeleton")).toBeVisible();
      await expect(page.getByText("Nothing needs you")).toHaveCount(0);
      await shot(page, "also-catching-up-inbox");
      await tab(page, "Board").click();
      g.release();
      await expect(page.getByText("Rename the payout job").first()).toBeVisible({ timeout: 15_000 });
      await expect(catching).toHaveCount(0);
      await expect(page.locator(".board-skeleton")).toHaveCount(0);
      await expect(page.getByText("Waiting for your first session")).toHaveCount(0);
      await expect(page.locator(".group--needs_you")).toHaveCount(0);
      await expect.poll(() => b.hub.needs.map((x) => x.sessions)).toEqual([[]]);
    } finally {
      g.release();
      await b.close();
    }
  });
});

test("back after spacesheep stopped keeping an approval for the app, before the code's end: time ran out, and the key that was made is said, with the way to it", async ({
  browser,
}) => {
  const b = await bed(browser);
  try {
    await b.page.goto(b.server.url);
    await button(b.page, "Use a spacesheep account").click();
    await button(b.page, "Continue").click();
    await expect(step(b.page, "account-number")).toBeVisible();
    const number = (await b.page.locator(".onb-digits").getAttribute("data-digits"))!;
    // Confirmed there; the app comes back after spacesheep dropped the key it held for it.
    b.ss.approve(number);
    b.ss.expire(number);
    await b.hub.pollConnect();
    const end = step(b.page, "account-ended");
    await expect(end).toHaveAttribute("data-why", "expired");
    await expect(b.page.getByText("Time ran out")).toBeVisible();
    await expect(b.page.getByText(UNUSED_KEY)).toBeVisible();
    await expect(end.locator(".onb-primary, .onb-secondary")).toHaveText(["Try again", "Open API keys"]);
    await shot(b.page, "end-expired-key");
    await button(b.page, "Open API keys").click();
    expect(await opened(b.page)).toEqual([`${ORIGIN}/settings/api-keys`]);
  } finally {
    await b.close();
  }
});
