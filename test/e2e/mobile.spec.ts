// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// On a phone (the `phone` project, 390×844): the bottom tab bar is on every page with at
// most five tabs (the rest behind More), nothing scrolls sideways, the session page's
// control strip sits above the tabs, New session is a full-height sheet, a pull down a
// list refreshes it, and an inbox row pushes its session's page (never the desktop's
// panel as a sheet, and nothing of that panel comes back on the next launch).
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { CONTROL_BASE, fakeDaemon, passkeyPage, seenSetupHere, sinkToken } from "./control-helpers.js";
import { openBoard, openPage, sessionUrl, ulid } from "./helpers.js";

/** A finger down the page from its top, as touch events (page.touchscreen only taps):
 *  lands at y 200, moves `by` px in steps, and stays down until `lift` is called. */
async function pullDown(page: Page, by: number): Promise<{ lift: () => Promise<void> }> {
  const step = async (y: number, type: "touchstart" | "touchmove" | "touchend") => {
    await page.evaluate(
      ({ y, type }) => {
        const target = document.querySelector(".page") ?? document.body;
        const t = new Touch({ identifier: 1, target, clientX: 195, clientY: y });
        const live = type === "touchend" ? [] : [t];
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: live,
            targetTouches: live,
            changedTouches: [t],
          }),
        );
      },
      { y, type },
    );
  };
  await step(200, "touchstart");
  for (let d = 20; d <= by; d += 20) await step(200 + d, "touchmove");
  await step(200 + by, "touchmove");
  return { lift: () => step(200 + by, "touchend") };
}

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
    await expect(pop.locator(".qs-theme").first()).toHaveText(/sessionpipe/);
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

  test("an inbox row pushes its session's page, with Inbox behind Back; no panel survives a relaunch", async ({
    page,
  }) => {
    await openPage(page, "/inbox");
    await expect.poll(() => page.locator(".inbox-row").count(), { timeout: 60_000 }).toBeGreaterThan(0);
    const row = page.locator(".inbox-row").first();
    const key = await row.getAttribute("data-session");
    await row.locator(".inbox-main").click();
    // The session's own page, pushed: its URL, its title in the bar, Inbox as the way back.
    await expect(page).toHaveURL(/\/s\//);
    await expect(page.locator("h1.sess-title")).toBeVisible();
    await expect(page.locator(".bar-back-label")).toHaveText("Inbox");
    // Not the desktop's panel as a sheet, and nothing of it in the URL or the mirror.
    await expect(page.locator(".panel--open")).toHaveCount(0);
    expect(page.url()).not.toContain("?s=");
    expect(await page.evaluate(() => localStorage.getItem("sessionpipe-gui.splitTabs"))).toBeNull();
    await tabBarIsOn(page);
    await noSidewaysScroll(page);
    // Back pops to the inbox.
    await page.locator(".bar-back").click();
    await expect(page).toHaveURL(/\/inbox$/);
    // A relaunch on another page: even a desktop visit's mirror of the panel (the same
    // origin, seen wide) opens nothing over it on the phone.
    await page.evaluate(
      (k) => localStorage.setItem("sessionpipe-gui.splitTabs", JSON.stringify({ tabs: [k], active: 0 })),
      key,
    );
    await openPage(page, "/machines");
    await expect(page.locator("section.machine").first()).toBeVisible();
    await expect(page.locator(".session--panel")).toHaveCount(0);
    await expect(page.locator(".panel--open")).toHaveCount(0);
    await expect(page).toHaveURL(/\/machines$/);
  });

  test("a pull down the board past the arm distance reopens the stream; a short one does nothing", async ({ page }) => {
    await openBoard(page);
    const html = page.locator("html");
    const ring = page.locator(".pull");
    const conn = page.locator(".conn").first();
    const streams: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/ui/stream")) streams.push(r.url());
    });
    // Short of the arm distance: the page follows, the ring shows, letting go does nothing.
    let finger = await pullDown(page, 60);
    await expect(html).toHaveAttribute("data-pull", "pulling");
    await expect(ring).toBeVisible();
    await expect(ring).not.toHaveAttribute("data-armed", "");
    await finger.lift();
    await expect(html).not.toHaveAttribute("data-pull", /./);
    await page.waitForTimeout(500);
    expect(streams, "a short pull reopens nothing").toEqual([]);
    await expect(conn).toHaveText("live");
    // Past it: armed, said, and on release the stream reopens and lands live again.
    finger = await pullDown(page, 160);
    await expect(html).toHaveAttribute("data-pull", "pulling");
    await expect(ring).toHaveAttribute("data-armed", "");
    await expect(ring).toHaveText("Release to refresh");
    const reopened = page.waitForRequest((r) => r.url().includes("/api/ui/stream"));
    await finger.lift();
    await expect(html).toHaveAttribute("data-pull", "refreshing");
    await expect(page.locator("main#main")).toHaveAttribute("aria-busy", "true");
    await expect(ring.locator(".spinner")).toBeVisible();
    await reopened;
    await expect(ring).toHaveText("Up to date");
    await expect(html).not.toHaveAttribute("data-pull", /./);
    await expect(page.locator("main#main")).not.toHaveAttribute("aria-busy", /./);
    await expect(conn).toHaveText("live");
    await noSidewaysScroll(page);
  });
});

// New session on a phone (STEER-SPEC B.6): the compose glyph in the Board's bar opens a
// full-height sheet, Start sits in its top bar, and Start pushes the session's page in its
// starting state. Signed for real, against the test-door instance (control-helpers.ts).
test.describe("phone: new session", () => {
  test.skip(({ isMobile }) => !isMobile, "phone project only");

  test("compose glyph → full-height sheet → Start in the top bar → the session page", async ({ context, page }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const d = await fakeDaemon(
      key,
      {
        name: `ns-phone-${Math.random().toString(36).slice(2, 8)}`,
        harnesses: ["claude-code"],
        folders: ["/Users/e2e/code"],
        mode: "auto",
        start: { "claude-code": { permissions: ["read", "safe", "auto"], permission: "auto", any_model: true } },
      },
      { sinkToken: await sinkToken() },
    );
    try {
      await page.goto(`${CONTROL_BASE}/?new=1&machine=${d.name}`);
      const sheet = page.locator("[data-new-session]");
      await expect(sheet).toHaveClass(/ns-sheet--phone/);
      await page.locator("[data-ns-cancel]").click();
      await page.locator(".page.board .compose-btn--phone").click();
      await expect(sheet).toBeVisible();
      const box = (await sheet.boundingBox())!;
      const vh = await page.evaluate(() => window.innerHeight);
      expect(box.height, "full height").toBeGreaterThanOrEqual(vh - 1);
      await expect(sheet.locator(".ns-bar [data-ns-start]")).toBeDisabled();
      await sheet.locator("[data-ns-row=machine] button.sel").click();
      await page.locator(".sel-sheet .sel-opt", { hasText: d.name }).click();
      await sheet.locator("[data-ns-text]").fill("Run the e2e suite and tell me what fails.");
      await expect(sheet.locator("[data-ns-row=permission]")).toBeVisible();
      await sheet.locator(".ns-bar [data-ns-start]").click();
      await expect(page).toHaveURL(/\/s\/claude-code\//);
      await expect(page.locator(".starting .chat-bubble")).toHaveText("Run the e2e suite and tell me what fails.");
      await noSidewaysScroll(page);
    } finally {
      await d.stop();
    }
  });
});

// A plan review on a phone (tier 3, the plan in the call's input): unfolded, the strip
// stays about half the screen, as a command's does, and its pair sits side by side.
test.describe("phone: a plan review", () => {
  test.skip(({ isMobile }) => !isMobile, "phone project only");

  test("the whole plan scrolls inside half the screen, Keep planning | Approve plan", async ({ context, page }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const token = await sinkToken();
    const d = await fakeDaemon(key, {
      name: `plan-phone-${Math.random().toString(36).slice(2, 8)}`,
      harnesses: ["claude-code"],
    });
    try {
      const id = randomUUID();
      const turn = randomUUID();
      // Headings and paragraphs: their margins put the lines off any grid of whole lines.
      const plan = Array.from(
        { length: 8 },
        (_, i) => `### Part ${i + 1}\n\nWhat part ${i + 1} changes, and why.\n\n1. One step.\n2. \`Another\` step.`,
      ).join("\n\n");
      let seq = 0;
      let clock = Date.now() - 30_000;
      const ev = (type: string, data: Record<string, unknown>, hook: string) => {
        clock += 500;
        return {
          protocol: 1,
          id: ulid(clock),
          type,
          time: new Date(clock).toISOString(),
          tier: 3,
          harness: { name: "claude-code", version: "2.1.296", event: hook },
          session: {
            id,
            seq: seq++,
            machine: d.name,
            cwd: "/Users/e2e/code",
            title: "Plan on a phone",
            title_source: "custom",
          },
          privacy: { rulesets: ["secrets@1"], pii: false },
          data,
        };
      };
      const events = [
        ev("session.started", { source: "startup" }, "SessionStart"),
        ev("turn.started", { turn_id: turn, prompt_chars: 20 }, "UserPromptSubmit"),
        ev(
          "tool.started",
          { tool: "ExitPlanMode", call_id: "toolu_plan", turn_id: turn, input: { plan } },
          "PreToolUse",
        ),
        ev(
          "attention.needed",
          { attention_id: `perm-${id.slice(0, 8)}`, kind: "permission", tool: "ExitPlanMode", message: "ExitPlanMode" },
          "PermissionRequest",
        ),
      ];
      await fetch(`${CONTROL_BASE}/api/sessionpipe/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "sessionpipe-protocol": "1" },
        body: JSON.stringify({ events }),
      });
      await page.goto(`${CONTROL_BASE}${sessionUrl("claude-code", id)}`);
      await page.getByRole("button", { name: "Show the whole plan" }).click();
      await expect(page.getByRole("button", { name: "Show less" })).toBeVisible();
      const text = page.locator(".ctl-plan-text");
      expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight), "the plan scrolls inside").toBe(true);
      // It ends halfway down a line, so the line cut in half says there is more, at any
      // phone's height.
      const halved = () =>
        text.evaluate((el) => {
          const foot = el.getBoundingClientRect().bottom;
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const r = document.createRange();
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            r.selectNodeContents(n);
            for (const b of Array.from(r.getClientRects())) if (b.top + 4 < foot && foot < b.bottom - 4) return true;
          }
          return false;
        });
      for (const height of [667, 700, 740, 780, 812, 844]) {
        await page.setViewportSize({ width: 390, height });
        await expect.poll(halved, `a line is cut in half at the plan's foot, ${height} tall`).toBe(true);
      }
      const vh = await page.evaluate(() => window.innerHeight);
      const strip = (await page.locator(".sess-ctl").boundingBox())!;
      expect(strip.height, `the strip is ${strip.height} of ${vh}`).toBeLessThanOrEqual(vh / 2 + 24);
      const pair = page.locator(".ctl-answer-btns");
      const keep = (await pair.getByRole("button", { name: "Keep planning" }).boundingBox())!;
      const approve = (await pair.getByRole("button", { name: "Approve plan" }).boundingBox())!;
      expect(Math.abs(keep.y - approve.y), "one row").toBeLessThan(1);
      expect(keep.x, "Approve plan on the right").toBeLessThan(approve.x);
    } finally {
      await d.stop();
    }
  });
});

// Usage on a phone: More › Usage, after Machines, opens the page as inset groups, nothing
// scrolls sideways, and a long press on an account's header is its menu as a sheet.
test.describe("phone: usage", () => {
  test.skip(({ isMobile }) => !isMobile, "phone project only");

  test("More › Usage, grouped, and a long press opens the account's sheet", async ({ page }) => {
    await openBoard(page);
    await page.locator("[data-nav=more]").click();
    await expect(page.locator(".more-sheet [data-nav=usage]")).toBeVisible();
    const rows = page.locator(".more-sheet .more-row");
    const names = await rows.locator(".more-row-name").allTextContents();
    expect(names.indexOf("Usage")).toBeGreaterThan(-1);
    if (names.includes("Machines")) expect(names.indexOf("Usage")).toBe(names.indexOf("Machines") + 1);
    await page.locator(".more-sheet [data-nav=usage]").click();
    await expect(page).toHaveURL(/\/usage$/);
    // A free-standing account (dev@example.com is pooled on lab-mac now, pool.spec.ts).
    const dev = page.locator("section.usage-acct", { hasText: "api.z.ai" });
    await expect(dev.locator(".usage-win").first()).toBeVisible();
    await noSidewaysScroll(page);
    // The where-line is the group's footer, under its windows.
    const list = (await dev.locator(".form-list").boundingBox())!;
    const where = (await dev.locator(".usage-where").boundingBox())!;
    expect(where.y).toBeGreaterThan(list.y + list.height - 1);

    const head = dev.locator(".usage-head");
    await head.scrollIntoViewIfNeeded();
    // Held still for the long-press (a scroll cancels one).
    await page.waitForTimeout(300);
    await head.locator(".usage-title").evaluate((el) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "touch",
          clientX: r.left + 4,
          clientY: r.top + 4,
        }),
      );
    });
    const sheet = page.locator(".menu-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Copy usage");
    await expect(sheet).toContainText("Forget these numbers");
  });
});
