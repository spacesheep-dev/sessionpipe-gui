// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// On a phone (the `phone` project, 390×844): the bottom tab bar is on every page with at
// most five tabs (the rest behind More), nothing scrolls sideways, the session page's
// control strip sits above the tabs (its Return a new line, its line's way on a finger's
// 44 points), New session is a full-height sheet, a pull down a
// list refreshes it, and an inbox row pushes its session's page (never the desktop's
// panel as a sheet, and nothing of that panel comes back on the next launch). An asked
// session that needs you takes its parent's row into Needs you, the tab's badge its count.
import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  CONTROL_BASE,
  fakeDaemon,
  passkeyPage,
  postPrompt,
  postSession,
  seenSetupHere,
  sinkToken,
} from "./control-helpers.js";
import {
  askedPair,
  composer,
  EVENTS,
  fits,
  INFO,
  kidBoxes,
  metaParts,
  openBoard,
  openPage,
  postRuled,
  sessionUrl,
  ulid,
} from "./helpers.js";

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

/** An element's colour and weight, and the tint's colour where it stands. */
const tinted = (l: Locator) =>
  l.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--tint-fg)";
    el.parentElement!.append(probe);
    const tint = getComputedStyle(probe).color;
    probe.remove();
    const s = getComputedStyle(el);
    return { color: s.color, tint, weight: Number(s.fontWeight) };
  });

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
    const behindMore = ["inbox", "feed", "review", "machines"].filter((k) => !onBar.includes(k));
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

  test("a switch is drawn as iOS draws it: on in the tint, off with no edge", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPage(page, "/settings");
    await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "General" }).click();
    const flip = page.getByRole("switch", { name: "Usage in the sidebar" });
    await expect(flip).toHaveAttribute("aria-checked", "true");
    await flip.click();
    await expect(flip).toHaveAttribute("aria-checked", "false");
    const look = await page.locator(".toggle").evaluateAll(async (els) => {
      await Promise.all(els.flatMap((el) => el.getAnimations().map((a) => a.finished)));
      const probe = document.body.appendChild(document.createElement("i"));
      probe.style.backgroundColor = "var(--tint)";
      const tint = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return els.map((el) => {
        const s = getComputedStyle(el);
        return { on: el.getAttribute("aria-checked") === "true", bg: s.backgroundColor, shadow: s.boxShadow, tint };
      });
    });
    expect(look.some((s) => s.on) && look.some((s) => !s.on)).toBe(true);
    for (const s of look) {
      expect(s.shadow, "no edge").toBe("none");
      if (s.on) expect(s.bg, "on is the tint").toBe(s.tint);
    }
  });

  test("the palette's cursor row is the fill alone, even moved by a key", async ({ page }) => {
    await openBoard(page);
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    const selected = dialog.locator(".pal-row[aria-selected='true']");
    await expect(selected).toHaveCSS("box-shadow", "none");
    await page.keyboard.press("ArrowDown");
    await expect(dialog.locator(".pal-row").nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(selected).toHaveCSS("box-shadow", "none");
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
    const input = composer(page);
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

  test("held wide, a tablet or a phone on its side has the same app: a session as its own page, no panel beside the list; the sidebar where it is tall too, the tab bar where not", async ({
    page,
  }) => {
    // An iPad and an Android tablet on their sides, and an Android phone on its: each wider
    // than the width at which a window with a mouse takes the sidebar's layout. The two
    // tablets have the touch app's own sidebar; the phone is too short for one.
    const chrome = async (at: string, regular: boolean) => {
      if (!regular) return tabBarIsOn(page);
      await expect(page.locator("nav.rail"), at).toBeVisible();
      await expect(page.locator("nav.tabbar"), at).toBeHidden();
      await expect(page.locator(".shell--side"), at).toHaveCount(0);
    };
    for (const [size, regular] of [
      [{ width: 1180, height: 820 }, true],
      [{ width: 1280, height: 800 }, true],
      [{ width: 915, height: 412 }, false],
    ] as const) {
      const at = `${size.width}x${size.height}`;
      await page.setViewportSize(size);
      await openBoard(page);
      await chrome(at, regular);
      await noSidewaysScroll(page);
      // New session: the page bar's, or the sidebar's head.
      await expect(
        page.locator(regular ? "nav.rail .rail-compose" : ".page.board .compose-btn--phone"),
        at,
      ).toBeVisible();
      // A row pushes its session's page, with Board behind Back: never a panel beside the list.
      await page.locator("article.card a.card-link").first().click();
      await expect(page, at).toHaveURL(/\/s\//);
      await expect(page.locator(".bar-back-label"), at).toHaveText("Board");
      await expect(page.locator(".panel--open"), at).toHaveCount(0);
      expect(page.url(), at).not.toContain("?s=");
      await chrome(at, regular);
      await noSidewaysScroll(page);
    }
  });

  test("a sidebar with more rows than a short tablet holds scrolls its rows alone: Display and Settings stay at its foot", async ({
    page,
  }) => {
    // Advanced, with the server's views under their headings: more rows than 600 pt hold.
    await page.setViewportSize({ width: 820, height: 600 });
    await openBoard(page);
    await expect(page.locator("nav.rail")).toBeVisible();
    await expect(page.locator("nav.rail .rail-section").first()).toBeVisible();
    const measure = () =>
      page.evaluate(() => {
        const el = (s: string) => document.querySelector<HTMLElement>(s)!;
        const rail = el("nav.rail");
        const nav = el("nav.rail .rail-nav");
        return {
          railScrolls: rail.scrollHeight > rail.clientHeight,
          rowsScroll: nav.scrollHeight > nav.clientHeight,
          settings: el("nav.rail .rail-foot .nav-link[data-nav='settings']").getBoundingClientRect().bottom,
          height: innerHeight,
        };
      });
    const m = await measure();
    expect(m.rowsScroll).toBe(true);
    expect(m.railScrolls).toBe(false);
    expect(m.settings).toBeLessThanOrEqual(m.height);
    // The rows scrolled to their end: the foot has not moved.
    await page.locator("nav.rail .rail-nav").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect((await measure()).settings).toBe(m.settings);
    await expect(page.locator("nav.rail").getByRole("link", { name: "Settings" })).toBeInViewport();
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

  test("a row's long-press menu has no Cancel: a tap outside it, Esc or its Close shuts it", async ({ page }) => {
    await openBoard(page);
    const sheet = page.locator(".menu-sheet");
    const hold = async () => {
      // A finger held on the first row's title; again if the live board redrew it meanwhile.
      await expect(async () => {
        await page
          .locator("article.card .card-title")
          .first()
          .evaluate((el) => {
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
        await expect(sheet.getByRole("menuitem", { name: "Hide", exact: true })).toBeVisible({ timeout: 2_000 });
      }).toPass();
      // The finger lifts: its click is the hold's, not a tap on the row (ContextMenu.tsx).
      await page.evaluate(() => {
        document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
        document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    };
    for (const how of ["tap outside", "Escape", "Close"] as const) {
      await hold();
      await expect(sheet.getByRole("button", { name: "Cancel" }), how).toHaveCount(0);
      await expect(sheet, how).not.toContainText("Cancel");
      if (how === "tap outside") {
        // Above the sheet, on the dimmed page.
        const top = (await sheet.boundingBox())!.y;
        expect(top, how).toBeGreaterThan(40);
        await page.touchscreen.tap(195, top / 2);
      } else if (how === "Escape") {
        await page.keyboard.press("Escape");
      } else {
        // What VoiceOver reaches and activates: the dimmed page is a button named Close.
        await page.getByRole("button", { name: "Close", exact: true }).evaluate((el) => (el as HTMLElement).click());
      }
      await expect(sheet, how).toHaveCount(0);
    }
  });

  test("an asked session that needs you takes its working parent into Needs you, marked under it, a finger's row; the tab's badge is the count", async ({
    page,
    request,
  }) => {
    const pair = await askedPair(request, { machine: `tree-${randomUUID().slice(0, 6)}`, title: "Plan the migration" });
    const parent = page.locator(`section.group--needs_you article.card[data-flip="${pair.parent.key}"]`);
    try {
      await openBoard(page);
      await page.addStyleTag({ content: ".toasts { display: none !important; }" });
      await pair.raise();
      await expect(parent).toBeVisible({ timeout: 15_000 });
      await expect(parent).toHaveClass(/card--working/);
      const kid = parent.locator(".kid[data-needs]");
      await expect(kid).toContainText(pair.child.title);
      expect((await kid.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const num = (sel: string) => Number(document.querySelector(sel)?.textContent ?? 0);
              const badge = num("nav.tabbar a[data-nav='inbox'] .nav-badge");
              const heading = num("section.group--needs_you .group-count");
              return badge > 0 && badge === heading ? "agree" : JSON.stringify({ badge, heading });
            }),
          { timeout: 15_000 },
        )
        .toBe("agree");
      // A tap on it pushes the asked session's page, where its prompt is answered.
      await kid.tap();
      await expect(page).toHaveURL(new RegExp(sessionUrl("codex", pair.child.id)));
    } finally {
      await pair.end();
    }
  });

  test("a nested child's row names its computer on its second line, cut in the middle when long; its prompt's Inbox row says whom it works for, and a tap opens the child", async ({
    page,
    request,
  }) => {
    // 40 characters, as the longest names in use.
    const machine = `tree-${randomUUID().slice(0, 6)}-build-runner-eu-west-1-c5-xl`;
    const pair = await askedPair(request, { machine, title: "Plan the migration" });
    try {
      await openBoard(page);
      await page.addStyleTag({ content: ".toasts { display: none !important; }" });
      const kid = page.locator(`article.card[data-flip="${pair.parent.key}"] .kid`, { hasText: pair.child.title });
      await expect(kid).toBeVisible({ timeout: 15_000 });
      const where = kid.locator(".kid-where");
      await expect(where).toHaveAttribute("title", machine);
      const shown = (await where.locator(".midcut-text").textContent())!;
      // Whole, or cut in its middle: its start and its end kept.
      if (shown !== machine) {
        expect(shown).toContain("…");
        expect(machine.startsWith(shown.split("…")[0]!)).toBe(true);
        expect(machine.endsWith(shown.split("…")[1]!)).toBe(true);
      }
      // Under the title, inside the row, and the row a finger's height; read in one frame,
      // as a sliding card moves all three together.
      const { row, title, chip } = await kidBoxes(kid);
      expect(chip.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
      expect(chip.x + chip.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
      expect(row.height).toBeGreaterThanOrEqual(44);

      await pair.raise();
      await openPage(page, "/inbox");
      const child = page.locator(`li.inbox-row[data-session="${pair.child.key}"]`);
      await expect(child.locator(".inbox-for")).toHaveAttribute("title", `for ${pair.parent.title}`, {
        timeout: 15_000,
      });
      // "for …" has the room the computer leaves on its line: a short one is whole. Nothing
      // drawn is cut at its end or runs past its box.
      const forLine = child.locator(".inbox-for .midcut-text");
      await expect(forLine).toHaveText(`for ${pair.parent.title}`);
      for (const line of [forLine, child.locator(".inbox-machine .midcut-text")]) {
        expect((await line.textContent())!.endsWith("…")).toBe(false);
        expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
      // A 90-character parent is cut once, at its end after a whole word, "for " kept.
      const long = await askedPair(request, {
        machine: "lab-mac",
        title: "Find every page the move to the new docs site broke and fix the links that point to them again",
      });
      try {
        await long.raise();
        const longFor = page.locator(`li.inbox-row[data-session="${long.child.key}"] .inbox-for`);
        await expect(longFor).toHaveAttribute("title", `for ${long.parent.title}`, { timeout: 15_000 });
        const line = longFor.locator(".midcut-text");
        const cut = (await line.textContent())!;
        expect(cut.split("…")).toHaveLength(2);
        expect(cut.endsWith("…")).toBe(true);
        expect(cut.startsWith("for ")).toBe(true);
        expect(`for ${long.parent.title}`.startsWith(`${cut.slice(0, -1)} `)).toBe(true);
        expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        // Its line is as full as whole words allow: with the next word it would not fit.
        // (Measured as the chip measures, in the line's own text node. The room left at the
        // end is the next word's, so it is no fixed number of pixels: it differs by font.)
        const next = await line.evaluate((el, whole) => {
          const node = el.firstChild as Text;
          const shown = node.nodeValue ?? "";
          const head = shown.slice(0, -1);
          const word = whole.slice(head.length).trim().split(/\s+/)[0] ?? "";
          const room = el.parentElement!.getBoundingClientRect().width;
          const r = document.createRange();
          node.nodeValue = `${head} ${word}…`;
          r.selectNodeContents(node);
          const width = r.getBoundingClientRect().width;
          node.nodeValue = shown;
          return { word, width, room };
        }, `for ${long.parent.title}`);
        expect(next.word).not.toBe("");
        expect(next.width).toBeGreaterThan(next.room + 0.5);
        await expect(line).toHaveText(cut);
        // Its box, not only its line, stays inside the row: at or left of the row's end and
        // of the time's.
        for (const row of [child, page.locator(`li.inbox-row[data-session="${long.child.key}"]`)]) {
          const ends = await row.evaluate((li) => {
            const end = (sel: string) => li.querySelector(sel)!.getBoundingClientRect().right;
            return { for: end(".inbox-for"), main: end(".inbox-main"), age: end(".inbox-age") };
          });
          expect(ends.for).toBeLessThanOrEqual(ends.main + 0.5);
          expect(ends.for).toBeLessThanOrEqual(ends.age + 0.5);
        }
      } finally {
        await long.end();
      }
      const main = child.locator(".inbox-main");
      expect((await main.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await main.tap();
      await expect(page).toHaveURL(new RegExp(sessionUrl("codex", pair.child.id)));
    } finally {
      await pair.end();
    }
  });

  test("a rule's mark on a phone: nothing cut while the line holds it; past that the repo goes first, then the name, cut in its middle, title and state in view; the page the same", async ({
    page,
    request,
  }) => {
    // 40 characters, the longest name a rule can have, and a nine-character one.
    const long = `rot-${randomUUID().slice(0, 6)}-nightly-certs-staging-eu-west`;
    const short = `ab-${randomUUID().slice(0, 6)}`;
    expect(long).toHaveLength(40);
    expect(short).toHaveLength(9);
    // And a line that cannot hold it all though the name could keep its width: a long repo.
    const mid = `weekly-backfill-${randomUUID().slice(0, 4)}`;
    const a = await postRuled(request, { rule: short, repo: "github.com/acme/infra" });
    const b = await postRuled(request, { rule: long, repo: "github.com/acme/infra" });
    const c = await postRuled(request, { rule: mid, repo: "github.com/acme/data-pipeline-backfills-eu" });
    // A repo too long for the line beside a short name: it is cut, keeping a few characters.
    const d = await postRuled(request, {
      rule: `cd-${randomUUID().slice(0, 6)}`,
      repo: "github.com/acme/infra-terraform-mod",
    });
    try {
      await openBoard(page);
      await page.addStyleTag({ content: ".toasts { display: none !important; }" });
      for (const r of [a, b, c, d]) {
        const card = page.locator(`article.card[data-flip="claude-code:${r.id}"]`);
        await expect(card).toBeVisible({ timeout: 15_000 });
        await card.scrollIntoViewIfNeeded();
        const meta = card.locator(".card-meta");
        await expect(meta.locator(".card-trigger")).toHaveAttribute("title", `trigger ${r.rule}`);
        const whole = await fits(meta);
        const parts = await metaParts(meta);
        const part = (c: string) => parts.find((p) => p.cls.includes(c))!;
        const [machine, repo, name] = [part("card-machine"), part("card-repo"), part("card-trigger")];
        expect(name.whole).toBe(`trigger ${r.rule}`);
        if (whole) for (const p of parts) expect(p.cut || p.gone, `${p.cls} on a line that holds it`).toBe(false);
        else {
          // The repo gives way first, the name next, the computer last.
          if (name.cut) expect(repo.gone, "the name is cut only once the repo has gone").toBe(true);
          if (machine.cut) expect(name.cut).toBe(true);
        }
        // A repo that stays is never a stub: whole, or a few characters' room (GIVE_WAY_EM).
        if (!repo.gone && repo.cut) {
          const stub = await meta.locator(".card-repo").evaluate((el) => ({
            width: el.getBoundingClientRect().width,
            font: Number.parseFloat(getComputedStyle(el).fontSize),
          }));
          expect(stub.width).toBeGreaterThanOrEqual(3 * stub.font);
        }
        // The long repo cannot stay whole: it is the part that gives way, cut or gone (and the
        // name is cut only once it has gone, above).
        if (r === c) {
          expect(whole).toBe(false);
          expect(repo.cut || repo.gone).toBe(true);
        }
        // The 40-character name never fits its 18em: cut, "trigger " whole, both ends kept.
        if (r === b) {
          expect(name.cut).toBe(true);
          expect(name.shown.startsWith("trigger ")).toBe(true);
          const [head, tail] = name.shown.slice("trigger ".length).split("…");
          expect(tail).toBeDefined();
          expect(head!.length).toBeGreaterThan(0);
          expect(long.startsWith(head!)).toBe(true);
          expect(long.endsWith(tail!)).toBe(true);
        }
        // What it draws stays in its box, and a cut name still ends on the row's right edge.
        expect(name.textRight).toBeLessThanOrEqual(name.right + 0.5);
        if (name.cut) expect(name.textRight).toBeGreaterThanOrEqual(name.right - 1);
        // The row: the mark inside the card and the screen, the title before the time, the
        // state and the time on screen. Read in one frame.
        const box = await card.evaluate((el: HTMLElement) => {
          const r = (sel: string) => {
            const b = el.querySelector(sel)!.getBoundingClientRect();
            return { left: b.left, right: b.right, width: b.width };
          };
          return {
            card: r(".card-link"),
            mark: r(".card-trigger"),
            title: r(".card-title"),
            state: r(".card-state"),
            time: r(".card-time"),
            vw: window.innerWidth,
          };
        });
        expect(box.mark.right).toBeLessThanOrEqual(Math.min(box.card.right, box.vw) + 0.5);
        expect(box.mark.left).toBeGreaterThanOrEqual(box.card.left);
        expect(box.title.width).toBeGreaterThan(0);
        expect(box.title.right).toBeLessThanOrEqual(box.time.left + 0.5);
        expect(box.state.right).toBeLessThanOrEqual(box.title.left + 0.5);
        expect(box.time.right).toBeLessThanOrEqual(box.vw);
        await expect(card.locator(".card-title")).toHaveText(r.title);
        await expect(card.locator(".card-state")).toBeInViewport();
        await expect(card.locator(".card-time")).toBeInViewport();
      }
      await noSidewaysScroll(page);

      // The page under the long name: the sentence in words, the name cut in its middle
      // with its end kept, the repo gone whole rather than a stub, all inside the screen.
      await openPage(page, `/s/claude-code/${b.id}`);
      const where = page.locator(".sess-where").first();
      const chip = where.locator(".sess-trigger .chip");
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute("data-text", `Started by trigger ${long}`);
      await expect(chip).toHaveAttribute(
        "data-tip",
        new RegExp(`^A rule named ${long} on \u2068build-box\u2069 started this session\\. `),
      );
      const pageParts = await metaParts(where);
      const sentence = pageParts.find((p) => p.cls.includes("sess-trigger"))!;
      const pageRepo = pageParts.find((p) => p.cls.includes("sess-repo"));
      expect(await fits(where)).toBe(false);
      expect(sentence.cut).toBe(true);
      expect(sentence.shown.startsWith("Started by trigger ")).toBe(true);
      const [head, tail] = sentence.shown.slice("Started by trigger ".length).split("…");
      expect(tail).toBeDefined();
      expect(long.startsWith(head!)).toBe(true);
      expect(long.endsWith(tail!)).toBe(true);
      expect(tail!.length).toBeGreaterThan(0);
      // The name is cut, so the repo went first, whole: no "· …" left of it.
      expect(pageRepo?.gone ?? true).toBe(true);
      expect(await where.locator(".sess-repo:visible").count()).toBe(0);
      expect(sentence.textRight).toBeLessThanOrEqual(sentence.right + 0.5);
      const end = await where.evaluate((el) => ({ right: el.getBoundingClientRect().right, vw: window.innerWidth }));
      expect(end.right).toBeLessThanOrEqual(end.vw);
      await noSidewaysScroll(page);
      // The same order on the page: with the long repo, the sentence is whole or the repo
      // has gone, never both cut.
      await openPage(page, `/s/claude-code/${c.id}`);
      const cWhere = page.locator(".sess-where").first();
      await expect(cWhere.locator(".sess-trigger .chip")).toHaveAttribute("data-text", `Started by trigger ${mid}`);
      const cParts = await metaParts(cWhere);
      const cSentence = cParts.find((p) => p.cls.includes("sess-trigger"))!;
      const cRepo = cParts.find((p) => p.cls.includes("sess-repo"))!;
      if (cSentence.cut) expect(cRepo.gone, "the sentence is cut only once the repo has gone").toBe(true);
      if (!cRepo.gone && cRepo.cut) {
        const stub = await cWhere.locator(".sess-repo").evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          font: Number.parseFloat(getComputedStyle(el).fontSize),
        }));
        expect(stub.width).toBeGreaterThanOrEqual(3 * stub.font);
      }
    } finally {
      await a.end();
      await b.end();
      await c.end();
      await d.end();
    }
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
      // Taken and delivered, and no hook events after: the page stays in its starting state
      // for the test to read (with them it leaves it within a second, before a loaded runner
      // has looked).
      {
        script: (c) => ({
          pauseMs: 400,
          acks: [
            { outcome: "taken", mode: "sdk" },
            { outcome: "delivered", mode: "sdk", session: c.session },
          ],
        }),
      },
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
      // All is well: under the form at most one line, a browser's passkey note in the line's
      // own size, and nothing that only says the machine is there.
      const line = sheet.locator(".ns-group-foot .ns-status[role='status']");
      await expect(line).toHaveCount(1);
      await expect(line).toHaveText(/^(Start asks for your passkey, once today\.)?$/);
      await expect(sheet.locator(".ns-passkey")).toHaveCount(0);
      await expect(sheet.getByText(/is listening/)).toHaveCount(0);
      await sheet.locator(".ns-bar [data-ns-start]").click();
      await expect(page).toHaveURL(/\/s\/claude-code\//);
      await expect(page.locator(".starting .chat-bubble")).toHaveText("Run the e2e suite and tell me what fails.");
      await noSidewaysScroll(page);
    } finally {
      await d.stop();
    }
  });

  test("Discard draft is an action in the tint, 44 tall; Cancel keeps the draft", async ({ context, page }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const d = await fakeDaemon(key, {
      name: `ns-draft-${Math.random().toString(36).slice(2, 8)}`,
      harnesses: ["claude-code"],
      folders: ["/Users/e2e/code"],
      mode: "auto",
    });
    try {
      await page.goto(`${CONTROL_BASE}/?new=1&machine=${d.name}`);
      const sheet = page.locator("[data-new-session]");
      const text = sheet.locator("[data-ns-text]");
      await text.fill("Rename the export job.");
      const discard = sheet.getByRole("button", { name: "Discard draft" });
      const look = await tinted(discard);
      expect(look.color).toBe(look.tint);
      expect(look.weight).toBeLessThan(600);
      expect((await discard.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // Cancel is no discard: the sheet closes, and opens again with the words.
      await page.locator("[data-ns-cancel]").click();
      await expect(sheet).toHaveCount(0);
      await page.locator(".page.board .compose-btn--phone").click();
      await expect(text).toHaveValue("Rename the export job.");
      await discard.click();
      await expect(text).toHaveValue("");
      await expect(discard).toHaveCount(0);
    } finally {
      await d.stop();
    }
  });
});

// The composer on a phone, a finger's (390 and 320 wide). The line under the field ends
// in its way on, the tint at 600, 44 tall to a finger and taking no tap from the field
// above it or the tab bar below. Return is a new line: Send sends, or ⌘Return.
test.describe("phone: the composer", () => {
  test.skip(({ isMobile }) => !isMobile, "phone project only");

  test("the line's way on is the tint at 600, at its end, 44 tall; Return is a new line and Send sends", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const d = await fakeDaemon(key, {
      name: `keys-phone-${Math.random().toString(36).slice(2, 8)}`,
      harnesses: ["claude-code"],
      folders: ["/Users/e2e/code"],
      mode: "auto",
    });
    try {
      const s = await postSession(await sinkToken(), {
        machine: d.name,
        cwd: "/Users/e2e/code",
        title: "Return on a phone",
      });
      await page.goto(`${CONTROL_BASE}${sessionUrl(s.harness, s.id)}`);
      const box = composer(page);
      await expect(box).toBeEnabled();
      // Focused, the field never glows.
      await box.focus();
      await expect(page.locator(".ctl-field")).toHaveCSS("box-shadow", "none");
      // No grant yet today, in a browser: the line offers Unlock now.
      const foot = page.locator(".ctl-foot[data-reason=passkey]");
      const link = foot.getByRole("button", { name: "Unlock now" });
      for (const size of [
        { width: 390, height: 844 },
        { width: 320, height: 568 },
      ]) {
        await page.setViewportSize(size);
        await expect(link).toBeVisible();
        const look = await tinted(link);
        expect(look.color, `${size.width}: the tint`).toBe(look.tint);
        expect(look.weight, `${size.width}: 600`).toBeGreaterThanOrEqual(600);
        const f = (await foot.boundingBox())!;
        const l = (await link.boundingBox())!;
        expect(f.x + f.width - (l.x + l.width), `${size.width}: at the line's end`).toBeLessThan(5);
        // A finger 8 px over it or 12 px under it lands on it; the field's last pixel and
        // the tab bar are still theirs.
        const hits = await link.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const field = document.querySelector(".ctl-ask")!.getBoundingClientRect();
          const tabs = document.querySelector("nav.tabbar")!.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const at = (y: number) => document.elementFromPoint(x, y);
          return {
            over: at(r.top - 8) === el,
            under: at(r.bottom + 12) === el,
            field: !!at(field.bottom - 1)?.closest(".ctl-ask"),
            tabs: !!at(tabs.top + 1)?.closest("nav.tabbar"),
          };
        });
        expect(hits, `${size.width}`).toEqual({ over: true, under: true, field: true, tabs: true });
      }

      // Return is a new line, and nothing goes.
      await expect(box).toHaveAttribute("enterkeyhint", "enter");
      await box.fill("Run the tests");
      await box.press("Enter");
      await box.pressSequentially("then open a PR");
      await expect(box).toHaveValue("Run the tests\nthen open a PR");
      const prompts = () => d.seen.filter((c) => c.kind === "prompt").map((c) => c.text);
      await page.waitForTimeout(500);
      expect(prompts()).toEqual([]);
      // Send sends both lines; ⌘Return, from a keyboard, sends too.
      await page.locator(".ctl-send").tap();
      await expect.poll(prompts, { timeout: 20_000 }).toEqual(["Run the tests\nthen open a PR"]);
      await expect(box).toHaveValue("");
      await box.fill("and the docs");
      await box.press("Meta+Enter");
      await expect.poll(prompts, { timeout: 20_000 }).toEqual(["Run the tests\nthen open a PR", "and the docs"]);
    } finally {
      await d.stop();
    }
  });

  // A machine that asks, as real ones do: Ask another agent… ends the line. At 390 the
  // sentence and its way on fill the first line and the button wraps under them, 2 px
  // below; at 320 the way on and the button share the second line. The way on's box takes
  // no tap from the field, nor from the top of the button, which keeps all of its 44 px.
  test("beside Ask another agent… the way on, the button and the field each keep their taps", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const d = await fakeDaemon(key, {
      name: `ask-phone-${Math.random().toString(36).slice(2, 8)}`,
      harnesses: ["claude-code", "codex"],
      folders: ["/Users/e2e/code"],
      mode: "auto",
      ask: true,
      handoff: true,
    });
    try {
      const s = await postSession(await sinkToken(), {
        machine: d.name,
        cwd: "/Users/e2e/code",
        title: "Ask on a phone",
      });
      await page.goto(`${CONTROL_BASE}${sessionUrl(s.harness, s.id)}`);
      await expect(composer(page)).toBeEnabled();
      const foot = page.locator(".ctl-foot[data-reason=passkey]");
      const link = foot.getByRole("button", { name: "Unlock now" });
      const ask = foot.getByRole("button", { name: "Ask another agent…" });
      for (const { size, wrapped } of [
        { size: { width: 390, height: 844 }, wrapped: true },
        { size: { width: 320, height: 568 }, wrapped: false },
      ]) {
        await page.setViewportSize(size);
        await expect(link).toBeVisible();
        await expect(ask).toBeVisible();
        const hits = await foot.evaluate((f) => {
          const l = f.querySelector(".ctl-link")!;
          const b = f.querySelector(".ctl-ask-agent")!;
          const r = l.getBoundingClientRect();
          const a = b.getBoundingClientRect();
          const field = document.querySelector(".ctl-ask")!.getBoundingClientRect();
          const at = (x: number, y: number) => document.elementFromPoint(x, y);
          const cx = r.left + r.width / 2;
          // Across the box's width, inside the field.
          const xs = [Math.max(r.left - 6, field.left + 1), cx, Math.min(r.right + 6, field.right - 1)];
          const under = at(cx, r.bottom + 12);
          return {
            wrapped: a.top > r.bottom,
            field: xs.every((x) => !!at(x, field.bottom - 1)?.closest(".ctl-ask")),
            ask: [a.left + 2, a.left + a.width / 2, a.right - 2].every((x) => at(x, a.top + 2) === b),
            over: at(cx, r.top - 8) === l,
            under: under === l ? "link" : under === b ? "ask" : (under?.className ?? null),
          };
        });
        // 12 px under the way on is the button where it wrapped under it, else the way on.
        expect(hits, `${size.width}`).toEqual({
          wrapped,
          field: true,
          ask: true,
          over: true,
          under: wrapped ? "ask" : "link",
        });
      }
    } finally {
      await d.stop();
    }
  });

  // Not paired, with a prompt: the card alone, its line ending in How to pair, over
  // Deny | Allow (off until the machine is paired). The way on's box stops at the pair and
  // at what is over it: the question, or a long command's Show 2 more lines, whose 44 px
  // reach down to the note. Also on an iPad, whose wider card has no extra room above the
  // pair. (Wider still the card is not folded; the hour's card is: account-screens.)
  test("on the folded card, How to pair takes no tap from the question, Show more or the pair", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    for (const command of [
      undefined,
      "cd /Users/e2e/code && npm ci && npm run lint && npm test && npm run build && npm run deploy",
    ]) {
      const p = await postPrompt(await sinkToken(), {
        machine: `unpaired-${Math.random().toString(36).slice(2, 8)}`,
        title: "Folded on a phone",
        agoMs: 5_000,
        message: command,
      });
      const colon = p.key.indexOf(":");
      await page.goto(`${CONTROL_BASE}${sessionUrl(p.key.slice(0, colon), p.key.slice(colon + 1))}`);
      const card = page.locator(".ctl--folded .ctl-answer");
      const link = card.locator(".ctl-answer-note .ctl-link");
      for (const size of [
        { width: 390, height: 844 },
        { width: 820, height: 1180 },
      ]) {
        const at = `${command ? "Show more" : "question"} at ${size.width}`;
        await page.setViewportSize(size);
        await expect(link).toHaveText("How to pair");
        await expect(card.getByRole("button", { name: /^Allow/ })).toBeDisabled();
        if (command) await expect(card.locator(".ctl-more")).toHaveText("Show 2 more lines");
        const hits = await link.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const note = el.closest(".ctl-answer-note")!;
          const above = note.previousElementSibling!.getBoundingClientRect();
          const c = note.parentElement!.getBoundingClientRect();
          const pair = note.parentElement!.querySelector(".ctl-answer-btns")!.getBoundingClientRect();
          const at = (x: number, y: number) => document.elementFromPoint(x, y);
          const cx = r.left + r.width / 2;
          // Across the box's width, inside the card.
          const xs = [Math.max(r.left - 6, c.left + 1), cx, Math.min(r.right + 6, c.right - 1)];
          return {
            over: at(cx, r.top - 8) === el,
            under: at(cx, r.bottom + 12) === el,
            above: xs.every((x) => at(x, above.bottom - 1) !== el),
            pair: xs.every((x) => !!at(x, pair.top + 1)?.closest(".ctl-answer-btns")),
          };
        });
        expect(hits, at).toEqual({ over: true, under: true, above: true, pair: true });
      }
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

// A shell prompt has one shape at every size, "Allow Bash to run:" over its command, so at
// 320 no "?" is left on a line of its own; an Inbox row shows a short request whole beside
// Deny | Allow, and a longer one as two lines and Open, which pushes its session; a board
// row's menu answers only a command its one line does not cut.
test.describe("phone: a request shown whole", () => {
  test.skip(({ isMobile }) => !isMobile, "phone project only");

  const SHORT = "npm run deploy -- --target staging";
  /** 140 characters, a chain of two. */
  const LONG =
    "rsync -avz --delete --exclude .env ./dist/ deploy@staging.acme.dev:/srv/billing/new && ssh deploy@staging.acme.dev systemctl restart billing";

  test("at 320 a shell prompt reads 'Allow Bash to run:' over its command, with no lone '?'; a cut one ends in '…' and says so", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const token = await sinkToken();
    const d = await fakeDaemon(key, { name: `shape-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] });
    const asked = await postPrompt(token, { machine: d.name, title: "Deploy", agoMs: 3_000, message: SHORT });
    // The machine keeps a message's first 200 characters, and marks nothing.
    const cutAt = `${SHORT} --note "${"a".repeat(200)}"`.slice(0, 200);
    const cut = await postPrompt(token, { machine: d.name, title: "Deploy, noted", agoMs: 3_000, message: cutAt });
    const lines = (l: Locator) =>
      l.evaluate((el) =>
        Math.round(el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight)),
      );
    try {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto(`${CONTROL_BASE}${sessionUrl("claude-code", asked.id)}`);
      const card = page.locator(`.ctl-answer[data-attention="${asked.attention}"]`);
      await expect(card.locator(".ctl-q-text")).toHaveText("Allow Bash to run:");
      await expect(card.locator(".ctl-cmd-block")).toHaveText(SHORT);
      // The question and the command each on one line, and no "?" anywhere on the card.
      expect(await lines(card.locator(".ctl-q"))).toBe(1);
      expect(await lines(card.locator(".ctl-cmd-block > div"))).toBe(1);
      expect(await card.innerText()).not.toContain("?");
      await expect(card.getByRole("button", { name: "Allow" })).toBeVisible();
      await noSidewaysScroll(page);
      // One command cut by the machine: the same shape, its end marked.
      await page.goto(`${CONTROL_BASE}${sessionUrl("claude-code", cut.id)}`);
      const block = page.locator(`.ctl-answer[data-attention="${cut.attention}"] .ctl-cmd-block`);
      await expect(block.locator("> div")).toHaveText(`${cutAt}…`);
      await expect(block).toHaveAttribute("title", "The machine sends the first 200 characters");
    } finally {
      await asked.clear();
      await cut.clear();
      await d.stop();
    }
  });

  test("an Inbox row at 320: a short command whole beside Deny | Allow; a 140-character one offers Open, which pushes its session with the whole command", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const token = await sinkToken();
    const d = await fakeDaemon(key, { name: `rows-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] });
    const short = await postPrompt(token, { machine: d.name, title: "Deploy", agoMs: 3_000, message: SHORT });
    // As Claude Code sends it: its first 120 characters, and the whole in the call's input.
    const long = await postPrompt(token, {
      machine: d.name,
      title: "Ship the release",
      agoMs: 4_000,
      message: LONG.slice(0, 120),
      input: { command: LONG },
    });
    try {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto(`${CONTROL_BASE}/inbox`);
      const shortRow = page.locator(`.inbox-row[data-attention="${short.attention}"]`);
      const what = shortRow.locator(".inbox-what");
      // Wrapped whole: no ellipsis, nothing past the row's edge or under a clamp.
      await expect(what.locator(".inbox-msg")).toHaveText(SHORT);
      expect(
        await what.evaluate(
          (el) =>
            el.scrollWidth <= el.clientWidth &&
            el.scrollHeight <= el.clientHeight &&
            getComputedStyle(el.querySelector(".inbox-msg")!).textOverflow !== "ellipsis",
        ),
      ).toBe(true);
      await expect(shortRow.getByRole("button", { name: "Deny" })).toBeVisible();
      await expect(shortRow.getByRole("button", { name: "Allow" })).toBeVisible();
      const longRow = page.locator(`.inbox-row[data-attention="${long.attention}"]`);
      await expect(longRow.getByRole("button", { name: /^(Allow|Deny)$/ })).toHaveCount(0);
      const open = longRow.getByRole("button", { name: "Open" });
      await expect(open).toBeVisible();
      expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await noSidewaysScroll(page);
      // Open is the row's tap: its session's page, pushed, with Inbox behind Back.
      await open.click();
      await expect(page).toHaveURL(new RegExp(`/s/claude-code/${long.id}$`));
      await expect(page.locator(".bar-back-label")).toHaveText("Inbox");
      await expect(page.locator(".ctl-cmd-block")).toHaveText(LONG.replace(" && ", "&& "));
    } finally {
      await short.clear();
      await long.clear();
      await d.stop();
    }
  });

  test("a board row's long-press menu answers a command only where the row's one line shows it whole: not at 320, at 820; the sheet keeps its order, the pair after New session here", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const token = await sinkToken();
    const d = await fakeDaemon(key, { name: `menu-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] });
    const asked = await postPrompt(token, { machine: d.name, title: "Deploy", agoMs: 3_000, message: SHORT });
    // One a 390 wide row shows whole.
    const brief = await postPrompt(token, { machine: d.name, title: "Tests", agoMs: 3_000, message: "npm test" });
    try {
      for (const [w, h, cut, p] of [
        [320, 568, true, asked],
        [820, 1180, false, asked],
        [390, 844, false, brief],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(CONTROL_BASE);
        const card = page.locator(`article.card[data-flip="${p.key}"]`);
        const line = card.locator(".card-attn");
        await expect(line, `${w}`).toHaveText(p === asked ? SHORT : "npm test");
        expect(await line.evaluate((el) => el.scrollWidth > el.clientWidth), `${w}`).toBe(cut);
        // Held still, then a finger down for the long-press.
        await card.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await card.locator(".card-title").evaluate((el) => {
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
        await expect(sheet.getByRole("menuitem", { name: "Hide", exact: true }), `${w}`).toBeVisible();
        await expect(sheet.getByRole("menuitem", { name: /^(Allow|Deny) Bash$/ }), `${w}`).toHaveCount(cut ? 0 : 2);
        // Open leads, as ever (a computer's menu leads with the pair; the phone's does not).
        const names = await sheet.getByRole("menuitem").allTextContents();
        expect(names.slice(0, 3), `${w}`).toEqual(["Open as page", "Preview", "New session here"]);
        if (!cut) expect(names.indexOf("Allow Bash"), `${w}`).toBeGreaterThan(names.indexOf("New session here"));
      }
    } finally {
      await asked.clear();
      await brief.clear();
      await d.stop();
    }
  });
});

// Long turns on a phone, in Simple mode (a phone's default): the person's long message folds
// to eight lines under "Show all", which opens it in place (one the receiver cut is read
// whole first); an older reply the receiver cut ends in "…" and "Show more"; the newest
// reply is whole when the session opens. Never "A preview of N characters" in the chat.
test.describe("phone: long turns", () => {
  test.skip(({ isMobile }) => !isMobile, "phone project only");

  /** About `n` characters of `s` said again and again, in paragraphs, then `last`. */
  const long = (s: string, n: number, last: string) => {
    let out = "";
    for (let i = 1; out.length < n - last.length - 2; i++) out += `${s}${i % 4 ? " " : "\n\n"}`;
    return `${out.trimEnd()}\n\n${last}`;
  };
  /** Whether `words` inside `l` are within its box on screen, not under its fold. */
  const shows = (l: Locator, words: string) =>
    l.evaluate((el, w) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const at = n.textContent!.indexOf(w);
        if (at < 0) continue;
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + w.length);
        return r.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1;
      }
      return false;
    }, words);

  test("a long message folds and opens in place; a cut one is read first; older replies say Show more, the newest is whole", async ({
    context,
    page,
    request,
  }) => {
    await context.addInitScript(() =>
      localStorage.setItem("sessionpipe-gui.settings", JSON.stringify({ mode: "simple" })),
    );
    const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
    const id = randomUUID();
    let seq = 0;
    let clock = Date.now() - 60_000;
    const ev = (type: string, data: Record<string, unknown>) => {
      clock += 1000;
      return {
        protocol: 1,
        id: ulid(clock),
        type,
        time: new Date(clock).toISOString(),
        tier: 3,
        harness: { name: "claude-code", version: "2.1.296" },
        session: { id, seq: seq++, machine: "e2e-box", cwd: "~/code/e2e", title: "Long turns", title_source: "custom" },
        privacy: { rulesets: ["secrets@1"], pii: false },
        data,
      };
    };
    const reply = (last: string) => long("The export now takes a fresh connection for each batch.", 5000, last);
    const turn = (n: number, user: string, assistant: string) => [
      ev("turn.started", { turn_id: `t${n}` }),
      ev("turn.transcript", { turn: n, user, assistant }),
      ev("turn.ended", { turn_id: `t${n}`, reason: "stop" }),
    ];
    const events = [
      ev("session.started", { source: "startup" }),
      ...turn(
        1,
        long("Read the export code, batch by batch.", 3000, "ASKEND is the ask's last line."),
        reply("FIRSTEND closes the first reply."),
      ),
      ...turn(2, long("Resume from the batch that failed.", 3000, "PLANEND is the plan's last line."), reply("OLDEND")),
      ...turn(
        3,
        long("Batch 7 failed: connection reset by peer.", 1500, "LOGEND is the log's last line."),
        reply("NEWEND"),
      ),
    ];
    const res = await request.post(EVENTS, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sinkToken}`,
        "sessionpipe-protocol": "1",
      },
      data: { events },
    });
    expect(res.status()).toBe(202);
    await page.goto(sessionUrl("claude-code", id));
    const bubbles = page.locator(".turn--chat .chat-bubble");
    const cards = page.locator(".turn--chat .chat-card");
    await expect(bubbles).toHaveCount(3);

    // The newest reply is whole as the session opens, with nothing to tap.
    await expect(cards.nth(2)).toContainText("NEWEND");
    await expect(cards.nth(2).locator(".reply-more")).toHaveCount(0);
    await expect(page.locator(".timeline")).not.toContainText("A preview of");

    // 1,500 characters arrive whole and fold to eight lines; "Show all" opens them where
    // they are, the bubble's top staying put.
    const log = bubbles.nth(2);
    const logWords = log.locator(".prompt-words");
    await expect(log).toContainText("LOGEND");
    await expect(logWords).toHaveClass(/is-clamped/);
    expect(await shows(logWords, "LOGEND")).toBe(false);
    const all = log.getByRole("button", { name: "Show all" });
    await expect(all).toHaveAttribute("aria-expanded", "false");
    await all.scrollIntoViewIfNeeded();
    const top = (await log.boundingBox())!.y;
    await all.click();
    await expect(log.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    expect(await shows(logWords, "LOGEND")).toBe(true);
    expect(Math.abs((await log.boundingBox())!.y - top)).toBeLessThan(2);

    // Folded again from its end, with its top long gone off screen: "Show all" stays under
    // the finger with the eight lines above it, the bubble in sight.
    // A row held in place is put back in the frame after it changed (SessionBody's
    // ResizeObserver): measured only once that frame is drawn.
    const settled = () =>
      page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const less = log.getByRole("button", { name: "Show less" });
    await settled();
    await less.evaluate((el) => el.scrollIntoView({ block: "center" }));
    expect((await log.boundingBox())!.y).toBeLessThan(0);
    const at = (await less.boundingBox())!;
    await page.touchscreen.tap(at.x + 10, at.y + at.height / 2);
    await expect(all).toHaveAttribute("aria-expanded", "false");
    await settled();
    await expect(logWords).toHaveClass(/is-clamped/);
    expect(Math.abs((await all.boundingBox())!.y - at.y)).toBeLessThan(2);
    await expect(log).toBeInViewport({ ratio: 1 });

    // 3,000 characters come cut: "Show all" reads the turn whole first. The same read
    // brings its reply whole, so that one's "Show more" goes.
    const plan = bubbles.nth(1);
    await expect(plan).not.toContainText("PLANEND");
    await expect(cards.nth(1).locator(".reply-more")).toHaveText("Show more");
    await plan.getByRole("button", { name: "Show all" }).click();
    await expect(plan.getByRole("button", { name: "Show less" })).toBeVisible();
    expect(await shows(plan.locator(".prompt-words"), "PLANEND")).toBe(true);
    await expect(cards.nth(1)).toContainText("OLDEND");
    await expect(cards.nth(1).locator(".reply-more")).toHaveCount(0);

    // A read that fails says so on the button.
    const ask = bubbles.nth(0);
    await page.route(/\/api\/ui\/sessions\/.*[?&]limit=1(&|$)/, (r) => r.abort(), { times: 1 });
    await ask.getByRole("button", { name: "Show all" }).click();
    await expect(ask.locator(".prompt-more")).toHaveText("Couldn't load. Try again");

    // An older reply the receiver cut ends cleanly in "…"; "Show more" reads it and goes.
    // That read makes its turn's message whole too: the failed read is over, and the
    // message's button says "Show all" again.
    const first = cards.nth(0);
    await expect(first).not.toContainText("FIRSTEND");
    expect((await first.locator(".md").innerText()).trimEnd()).toMatch(/…$/);
    await first.getByRole("button", { name: "Show more" }).click();
    await expect(first).toContainText("FIRSTEND closes the first reply.");
    await expect(first.locator(".reply-more")).toHaveCount(0);
    await expect(ask).toContainText("ASKEND");
    await expect(ask.locator(".prompt-more")).toHaveText("Show all");
    await noSidewaysScroll(page);
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
