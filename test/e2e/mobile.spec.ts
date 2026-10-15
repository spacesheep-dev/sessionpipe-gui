// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// On a phone (the `phone` project, 390×844): the bottom tab bar is on every page with at
// most five tabs (the rest behind More), nothing scrolls sideways, and the session page's
// control strip sits above the tabs. Then the session as a chat on a machine paired through
// the test door: a failed send can be dismissed and a stale one is not shown by default, and
// the composer stays inside the viewport with the tab bar stepping aside while it has focus.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { E2E_PORT, SETTINGS_KEY } from "../../playwright.config.js";
import { EVENTS, INFO, openBoard, sessionUrl, ulid } from "./helpers.js";

const noSidewaysScroll = async (page: Page) => {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `scrollWidth ${scrollWidth} must not exceed innerWidth ${innerWidth}`).toBeLessThanOrEqual(
    innerWidth,
  );
};

const tabBarIsOn = async (page: Page) => {
  const bar = page.locator("nav.tabbar");
  await expect(bar).toBeVisible();
  // Never more than five tabs: the first four pages, then More for everything else.
  const tabs = bar.locator(":scope > a.nav-link, :scope > .more > .more-tab");
  expect(await tabs.count()).toBeLessThanOrEqual(5);
  // The first pages of the shell's list are the tabs; Board leads and the inbox (with its
  // badge) is beside it, whatever else the list carries.
  for (const label of ["Board", "Inbox"]) await expect(bar.getByRole("link", { name: label })).toBeVisible();
  // No tab's label is cut short.
  const clipped = await bar
    .locator(".nav-label")
    .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent));
  expect(clipped).toEqual([]);
  const box = (await bar.boundingBox())!;
  const vh = await page.evaluate(() => window.innerHeight);
  expect(box.y + box.height, "the tab bar is pinned to the bottom edge").toBeGreaterThanOrEqual(vh - 1);
  await expect(page.locator("nav.rail")).toBeHidden();
};

test.describe("phone", () => {
  test.skip(({ isMobile }) => !isMobile, "phone project only");

  test("tab bar on every page, no horizontal scroll", async ({ page }) => {
    await openBoard(page);
    await tabBarIsOn(page);
    await noSidewaysScroll(page);
    await expect(page.locator("nav.tabbar a[aria-current='page']")).toHaveText(/Board/);
    // What each page shows once open; a page without an entry is checked by its URL alone.
    const MARKER: Record<string, string> = {
      inbox: ".inbox",
      feed: "ol.rows",
      machines: "section.machine",
      connect: ".sect--phone",
    };
    const bar = page.locator("nav.tabbar");
    const onBar = (
      await bar.locator(":scope > a.nav-link").evaluateAll((els) => els.map((el) => el.getAttribute("data-nav")))
    ).filter((k): k is string => !!k && k !== "board");
    for (const key of onBar) {
      await bar.locator(`a[data-nav='${key}']`).click();
      await expect(page).toHaveURL(new RegExp(`/${key}$`));
      if (MARKER[key]) await expect(page.locator(MARKER[key]).first()).toBeVisible();
      await tabBarIsOn(page);
      await noSidewaysScroll(page);
      await expect(bar.locator("a[aria-current='page']")).toHaveAttribute("data-nav", key);
    }
    // The pages past the fourth sit behind More, which then carries the current mark.
    const behindMore = ["inbox", "feed", "review", "machines", "connect"].filter((k) => !onBar.includes(k));
    for (const key of behindMore) {
      await bar.getByRole("button", { name: "More" }).click();
      await page.getByRole("dialog", { name: "More" }).locator(`a[data-nav='${key}']`).click();
      await expect(page).toHaveURL(new RegExp(`/${key}$`));
      if (MARKER[key]) await expect(page.locator(MARKER[key]).first()).toBeVisible();
      await tabBarIsOn(page);
      await noSidewaysScroll(page);
      await expect(bar.locator("[aria-current='page']")).toHaveText(/More/);
    }
  });

  test("every installed view and the quick settings are reachable through More", async ({ page }) => {
    await openBoard(page);
    const bar = page.locator("nav.tabbar");
    const more = bar.getByRole("button", { name: "More" });
    await expect(more).toBeVisible();
    const { themes } = (await (await page.request.get("/api/ui/themes")).json()) as {
      themes: { id: string; name: string; error?: string }[];
    };
    for (const t of themes.filter((x) => !x.error)) {
      await more.click();
      const sheet = page.getByRole("dialog", { name: "More" });
      await expect(sheet).toBeVisible();
      await sheet.locator(`a[data-nav='t:${t.id}']`).click();
      await expect(page).toHaveURL(new RegExp(`/t/${t.id}$`));
      await expect(sheet).toHaveCount(0);
      // The active page lives inside More, so More carries the current mark.
      await expect(bar.locator("[aria-current='page']")).toHaveText(/More/);
      await tabBarIsOn(page);
      await noSidewaysScroll(page);
    }
    // Display opens the quick settings from the sheet; Esc closes the popover.
    await more.click();
    await page
      .getByRole("dialog", { name: "More" })
      .getByRole("button", { name: /Display/ })
      .click();
    const pop = page.getByRole("dialog", { name: "Quick settings" });
    await expect(pop).toBeVisible();
    await expect(page.getByRole("dialog", { name: "More" })).toHaveCount(0);
    await expect(pop.locator(".qs-theme").first()).toHaveText(/Spacesheep/);
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    // Esc closes the sheet too.
    await more.click();
    await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "More" })).toHaveCount(0);
  });

  test("the session page keeps its control strip above the tab bar", async ({ page }) => {
    await openBoard(page);
    const link = page.locator("article.card a.card-link").first();
    await link.click();
    await expect(page).toHaveURL(/\/s\//);
    await expect(page.locator("h1.sess-title")).toBeVisible();
    await expect(page.locator("ol.timeline li.turn").first()).toBeVisible();
    await tabBarIsOn(page);
    await noSidewaysScroll(page);
    const ctl = page.locator(".sess-ctl");
    await expect(ctl).toBeVisible();
    await expect(ctl.getByRole("form", { name: "Control" })).toBeVisible();
    const check = async () => {
      const c = (await ctl.boundingBox())!;
      const t = (await page.locator("nav.tabbar").boundingBox())!;
      expect(c.y + c.height, `control strip bottom ${c.y + c.height} vs tab bar top ${t.y}`).toBeLessThanOrEqual(
        t.y + 1,
      );
      expect(c.y + c.height, "the strip is on screen, not pushed under the fold").toBeLessThanOrEqual(t.y + 1);
      expect(c.y).toBeGreaterThanOrEqual(0);
    };
    await check();
    // After scrolling to the end of the timeline the sticky strip still sits above the tabs.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await check();
    // The input is reachable and not hidden behind the tab bar.
    const input = ctl.getByRole("textbox", { name: "Message for the next turn" });
    await expect(input).toBeVisible();
    const ib = (await input.boundingBox())!;
    const tb = (await page.locator("nav.tabbar").boundingBox())!;
    expect(ib.y + ib.height).toBeLessThanOrEqual(tb.y);
  });
});

// ---------- the session as a chat on a paired machine ----------

const CONTROL = "/api/sessionpipe/v1/control";
/** A secure context needs localhost in the address: the suite's storage state covers both origins. */
const LOCAL = `http://localhost:${E2E_PORT}`;
const MACHINE = "acme-laptop";
const UNSUPPORTED = "the session is open and this harness can't copy it";

/** A machine paired through the test door (loopback only): its id and token. */
async function pairMachine(request: APIRequestContext, sinkToken: string): Promise<{ id: string; token: string }> {
  const facts = {
    name: MACHINE,
    harnesses: ["claude-code"],
    modes: ["sdk", "resume"],
    version: "0.7.0",
    folders: ["/home/dev/acme/site"],
    mode: "safe",
  };
  const auth = { authorization: `Bearer ${sinkToken}` };
  const pair = await request.post(`${CONTROL}/pair`, { headers: auth, data: facts });
  expect(pair.status()).toBe(201);
  const { code, machine } = (await pair.json()) as { code: string; machine: string };
  expect((await request.post(`${CONTROL}/_test/approve`, { data: { code, as: "e2e-phone" } })).status()).toBe(200);
  const status = await request.get(`${CONTROL}/pair?code=${encodeURIComponent(code)}`, { headers: auth });
  const { token } = (await status.json()) as { token: string };
  const hello = await request.post(`${CONTROL}/hello`, {
    headers: { authorization: `Bearer ${token}` },
    data: { ...facts, waiting: [] },
  });
  expect(hello.status()).toBe(204);
  return { id: machine, token };
}

/** One tier-3 session on MACHINE with three ended turns; its id. */
async function postSession(request: APIRequestContext, sinkToken: string): Promise<string> {
  const id = randomUUID();
  let seq = 0;
  let clock = Date.now() - 30 * 60_000;
  const ev = (type: string, data: Record<string, unknown>) => {
    clock += 20_000;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 3,
      harness: { name: "claude-code", version: "2.1.296", event: "Hook" },
      session: {
        id,
        seq: seq++,
        machine: MACHINE,
        cwd: "~/acme/site",
        repo: "github.com/acme/site",
        branch: "main",
        title: "Kickoff: brand refresh for the acme site",
        title_source: "harness",
      },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const events = [
    ev("session.started", { source: "startup" }),
    ev("turn.started", { turn_id: "t1", prompt_chars: 447 }),
    ev("turn.ended", { turn_id: "t1", reason: "stop", ms: 42_000 }),
    ev("turn.started", { turn_id: "t2", prompt_chars: 88 }),
    ev("turn.ended", { turn_id: "t2", reason: "stop", ms: 61_000 }),
    ev("turn.started", { turn_id: "t3", prompt_chars: 23 }),
    ev("turn.ended", { turn_id: "t3", reason: "stop", ms: 4_000 }),
  ];
  const res = await request.post(EVENTS, {
    headers: { authorization: `Bearer ${sinkToken}`, "sessionpipe-protocol": "1" },
    data: { events },
  });
  expect([200, 202]).toContain(res.status());
  return id;
}

/** A prompt the machine acked `outcome` at `at`; the message's id. */
async function sendAcked(
  request: APIRequestContext,
  m: { id: string; token: string },
  session: string,
  text: string,
  outcome: string,
  at: Date,
): Promise<string> {
  const q = await request.post(`${CONTROL}/_test/enqueue`, {
    data: { machine: m.id, message: { kind: "prompt", session, text } },
  });
  expect(q.status()).toBe(201);
  const { id } = (await q.json()) as { id: string };
  const ack = await request.post(`${CONTROL}/ack`, {
    headers: { authorization: `Bearer ${m.token}` },
    data: { acks: [{ id, outcome, at: at.toISOString(), mode: "resume", detail: UNSUPPORTED }] },
  });
  expect(ack.status()).toBe(202);
  return id;
}

test.describe("phone · the session as a chat", () => {
  test.skip(({ isMobile }) => !isMobile, "phone project only");
  // One worker: the machine is paired once, and every test reads the same session.
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: LOCAL });

  let sinkToken: string;
  let machine: { id: string; token: string };
  let session: string;
  let stale: string;
  let fresh: string;

  test.beforeAll(async ({ request }) => {
    sinkToken = ((await (await request.get(INFO)).json()) as { sinkToken: string }).sinkToken;
    machine = await pairMachine(request, sinkToken);
    session = await postSession(request, sinkToken);
    const key = `claude-code:${session}`;
    stale = await sendAcked(
      request,
      machine,
      key,
      "Whats going on here",
      "unsupported",
      new Date(Date.now() - 11 * 60_000),
    );
    fresh = await sendAcked(request, machine, key, "And now?", "unsupported", new Date());
  });

  /** The session page in Simple mode (the default for a device that has not chosen). */
  const openChat = async (page: Page) => {
    await page.addInitScript((k) => localStorage.removeItem(k), SETTINGS_KEY);
    await page.goto(sessionUrl("claude-code", session));
    await expect(page.locator(".page.session")).toHaveAttribute("data-ui", "simple");
    await expect(page.locator("ol.timeline--chat .chat-you").first()).toBeVisible();
  };

  test("a failed send can be dismissed; a stale one is behind 'show' and stays away after a reload", async ({
    page,
  }) => {
    await openChat(page);
    const acts = page.locator("ol.ctl-acts");
    const row = (id: string) => acts.locator(`li[data-message="${id}"]`);
    await expect(row(fresh)).toHaveAttribute("data-outcome", "unsupported");
    await expect(row(fresh)).toContainText(`unsupported · ${MACHINE} has no way to prompt`);
    // Eleven minutes old: not pinned under the composer, one tap away.
    await expect(row(stale)).toHaveCount(0);
    const more = acts.getByRole("button", { name: /1 earlier message · show/ });
    await expect(more).toBeVisible();
    await more.click();
    await expect(row(stale)).toBeVisible();
    await acts.getByRole("button", { name: "Show fewer" }).click();
    await expect(row(stale)).toHaveCount(0);
    await row(fresh).getByRole("button", { name: "Dismiss" }).click();
    await expect(row(fresh)).toHaveCount(0);
    await expect(acts.getByRole("button", { name: /2 earlier messages · show/ })).toBeVisible();
    await page.reload();
    await expect(page.locator("ol.timeline--chat .chat-you").first()).toBeVisible();
    await expect(acts.getByRole("button", { name: /2 earlier messages · show/ })).toBeVisible();
    await expect(row(fresh)).toHaveCount(0);
  });

  test("the composer stays inside the viewport; the tab bar steps aside while it has focus", async ({ page }) => {
    await openChat(page);
    const ctl = page.locator(".sess-ctl");
    const box = ctl.getByRole("textbox", { name: "Message for the next turn" });
    await expect(box).toBeEnabled();
    const inside = async () => {
      const c = (await ctl.boundingBox())!;
      const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      expect(c.y + c.height, "the composer's bottom edge is on screen").toBeLessThanOrEqual(h + 1);
      expect(c.x + c.width, "the composer's right edge is on screen").toBeLessThanOrEqual(w + 1);
      const ask = (await ctl.locator(".ctl-ask").boundingBox())!;
      expect(ask.x + ask.width).toBeLessThanOrEqual(w + 1);
      expect(ask.x).toBeGreaterThanOrEqual(0);
      await noSidewaysScroll(page);
    };
    await expect(page.locator("nav.tabbar")).toBeVisible();
    await expect(page.locator(".ctl-context")).toContainText("Messages go to");
    await inside();
    // The field reads at 16 px or more: WebKit zooms into anything smaller on focus.
    expect(await box.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await box.focus();
    await expect(page.locator("html")).toHaveAttribute("data-composing", "");
    await expect(page.locator("nav.tabbar")).toBeHidden();
    await expect(page.locator(".ctl-context-why")).toBeHidden();
    await expect(page.locator(".ctl-context")).toContainText("Add it");
    await box.fill("Whats going on in this session, and what is left to do before the review tomorrow?");
    await inside();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.locator("html")).not.toHaveAttribute("data-composing", "");
    await expect(page.locator("nav.tabbar")).toBeVisible();
    await inside();
  });
});
