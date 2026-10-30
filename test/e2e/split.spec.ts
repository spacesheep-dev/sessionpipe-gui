// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The side panel: a session open beside the page. Shift-click on a board card opens it
// (URL `?s=`, the page shrinks), reload keeps it, Esc closes it, the divider resizes it,
// a theme opens it through api.openSession({ split: true }); on a phone it is a sheet.
// Pages that list no sessions (Setup, Connect, a missing page) don't show it, and it is
// back, tabs and all, on the board.
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { EVENTS, holdBoard, INFO, openBoard, tier1Batch } from "./helpers.js";

const panel = (page: Page) => page.locator("aside.panel");
const mainWidth = (page: Page) => page.locator("main.main").evaluate((el) => el.getBoundingClientRect().width);
const live = (page: Page) => expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
const rx = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the panel's title must read for a card: the card shortens a long title with "…",
 *  the panel shows it whole, so a shortened one is matched as a prefix. */
const titleOf = (card: string): string | RegExp =>
  card.endsWith("…") ? new RegExp(`^${rx(card.slice(0, -1))}`) : card;

/** Shift-clicks the first board card; returns the title the panel shows for it. The
 *  panel is the source of truth: a demo session may learn a better title mid-turn, so the
 *  card's text at click time is matched by the session key in the URL, not by its words. */
async function openBeside(page: Page): Promise<string> {
  await openBoard(page);
  // The pointer rests on the list first, so the board holds still (Board.tsx) and the
  // row read is the row clicked.
  await holdBoard(page);
  const card = page.locator("article.card").first();
  const href = (await card.locator("a.card-link").getAttribute("href"))!;
  const key = href
    .replace(/^\/s\//, "")
    .split("/")
    .slice(0, 2)
    .map(decodeURIComponent)
    .join(":");
  // By its href: the live demo may put another session first between the read and the click.
  await page.locator(`article.card a.card-link[href="${href}"]`).click({ modifiers: ["Shift"] });
  await expect(panel(page)).toHaveClass(/panel--open/);
  await expect(page).toHaveURL(/[?&]s=[^&]+(:|%3A)/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("s") ?? "")).toBe(key);
  await expect(panel(page).locator(".panel-title")).not.toHaveText("");
  return (await panel(page).locator(".panel-title").textContent())!;
}

/** One tier-3 session with everything that once widened the panel: a long machine, repo,
 *  branch and model, a long tool error, a reply with a wide code block and a table. */
async function postLongSession(request: APIRequestContext): Promise<string> {
  const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
  const b = tier1Batch({ title: "A long session for the narrow panel", machine: "e2e-box-with-a-long-name" });
  const wide = "x".repeat(60);
  for (const e of b.events) {
    e.tier = 3;
    Object.assign(e.session as Record<string, unknown>, {
      repo: `github.com/e2e/${wide}`,
      branch: `feature/${wide}`,
      model: `model-${wide}`,
    });
    const d = e.data as Record<string, unknown>;
    if (e.type === "tool.ended") Object.assign(d, { ok: false, error: `Exit code 1 ${wide} ${wide} ${wide}` });
  }
  const end = b.events[b.events.length - 1]!;
  const turnId = (end.data as Record<string, unknown>).turn_id;
  const session = { ...(end.session as Record<string, unknown>), seq: 5 };
  b.events.splice(4, 0, {
    ...end,
    id: `${(end.id as string).slice(0, 10)}ZZZZZZZZZZZZZZZZ`,
    type: "turn.transcript",
    session,
    data: {
      turn: 1,
      turn_id: turnId,
      user: `A prompt ${wide}`,
      assistant: `Reply.\n\n\`\`\`ts\nconst a = "${wide}${wide}";\n\`\`\`\n\n| a | b |\n|---|---|\n| https://example.com/${wide}/${wide} | c |`,
    },
  });
  (end.session as Record<string, unknown>).seq = 6;
  const res = await request.post(EVENTS, {
    headers: { authorization: `Bearer ${sinkToken}` },
    data: { events: b.events },
  });
  expect(res.status()).toBe(202);
  return `${b.harness}:${b.sessionId}`;
}

test.describe("split panel", () => {
  test.describe("desktop", () => {
    test.skip(({ isMobile }) => !!isMobile, "desktop project only");

    test("steps aside on pages that list no sessions, and comes back on the board", async ({ page }) => {
      await openBeside(page);
      const open = await mainWidth(page);
      const s = new URL(page.url()).searchParams.get("s");
      for (const path of ["/setup", "/connect", "/no-such-page"]) {
        await page.evaluate((p) => {
          history.pushState(null, "", `${p}${location.search}`);
          dispatchEvent(new PopStateEvent("popstate"));
        }, path);
        await expect(panel(page)).not.toHaveClass(/panel--open/);
        // The page takes the room back over the split's slide (split.css).
        await expect.poll(() => mainWidth(page), { message: `${path} has the full width` }).toBeGreaterThan(open + 100);
      }
      await page.goBack();
      await page.goBack();
      await page.goBack();
      await expect(panel(page)).toHaveClass(/panel--open/);
      expect(new URL(page.url()).searchParams.get("s")).toBe(s);
    });

    test("shift-click opens beside, the page shrinks, reload keeps it, Esc closes it", async ({ page }) => {
      await openBoard(page);
      const before = await mainWidth(page);
      await openBeside(page);
      // The session view inside opens with its own scrolling and its latest events.
      await expect(panel(page).locator("ol.timeline li.turn").first()).toBeVisible();
      await expect.poll(() => mainWidth(page)).toBeLessThan(before - 300);
      const url = page.url();
      // The same session after the reload: by its key, in the URL and on the panel. Not by
      // title: a demo session may learn a better one at any moment, reload included.
      const key = await panel(page).getAttribute("data-split");
      expect(key).toBeTruthy();

      await page.reload();
      await live(page);
      await expect(panel(page)).toHaveClass(/panel--open/);
      expect(page.url()).toBe(url);
      await expect(panel(page)).toHaveAttribute("data-split", key ?? "");
      await expect(panel(page).locator(".panel-title")).not.toBeEmpty();

      await page.keyboard.press("Escape");
      await expect(panel(page)).not.toHaveClass(/panel--open/);
      await expect(page).not.toHaveURL(/[?&]s=/);
      await expect.poll(() => mainWidth(page)).toBeGreaterThan(before - 2);
      // Back brings it back, forward closes it again.
      await page.goBack();
      await expect(panel(page)).toHaveClass(/panel--open/);
      await page.goForward();
      await expect(panel(page)).not.toHaveClass(/panel--open/);
    });

    test("the divider resizes the panel and the width is remembered", async ({ page }) => {
      await openBeside(page);
      // Let the slide-in finish: the grip's position is only right once the panel is still.
      const box = (await panel(page).boundingBox())!;
      await expect
        .poll(async () => Math.round((await panel(page).boundingBox())!.x))
        .toBe(Math.round(page.viewportSize()!.width - box.width));
      const g = (await page.locator(".panel-grip").boundingBox())!;
      const x = g.x + g.width / 2;
      await page.mouse.move(x, g.y + 300);
      await page.mouse.down();
      await page.mouse.move(x - 60, g.y + 300, { steps: 4 });
      await page.mouse.move(x - 120, g.y + 300, { steps: 4 });
      await page.mouse.up();
      await expect.poll(async () => (await panel(page).boundingBox())!.width).toBeGreaterThan(box.width + 100);
      const wider = (await panel(page).boundingBox())!;
      expect(wider.width).toBeLessThan(box.width + 140);
      await page.reload();
      await live(page);
      const kept = (await panel(page).boundingBox())!;
      expect(Math.abs(kept.width - wider.width)).toBeLessThanOrEqual(1);
    });

    test("another session swaps the content; the header opens the session as a page", async ({ page }) => {
      await openBeside(page);
      const second = page.locator("article.card").nth(1);
      if ((await second.count()) > 0) {
        // Cards re-sort live, so alt-click the one whose href was read, not "the second".
        const href2 = (await second.locator("a.card-link").getAttribute("href"))!;
        const link2 = page.locator(`a.card-link[href="${href2}"]`);
        const title2 = (await link2.locator(".card-title").textContent())!;
        await link2.click({ modifiers: ["Alt"] });
        await expect(panel(page).locator(".panel-title")).toHaveText(titleOf(title2));
        await expect(page).toHaveURL(/[?&]s=/);
      }
      const open = panel(page).getByRole("link", { name: "Open as page" });
      const href = (await open.getAttribute("href"))!;
      await open.click();
      await expect(page).toHaveURL((u) => u.pathname + u.search === href);
      await expect(page.locator("h1.sess-title")).toBeVisible();
      await expect(panel(page)).not.toHaveClass(/panel--open/);
    });

    test("nothing scrolls sideways in the panel at 420, 520 and 640, nor the page at 768", async ({
      page,
      request,
    }) => {
      const key = await postLongSession(request);
      for (const width of [420, 520, 640]) {
        await page.addInitScript((w) => localStorage.setItem("sessionpipe-gui.splitWidth", String(w)), width);
        await page.goto(`/?s=${encodeURIComponent(key)}`);
        await live(page);
        const body = panel(page).locator(".panel-body:not(.panel-body--off)");
        await expect(body.locator("ol.timeline li.turn").first()).toBeVisible();
        await body.locator(".tool--x summary").first().click();
        expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
        expect(await page.locator("main.main").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(
          0,
        );
      }
      await page.setViewportSize({ width: 768, height: 900 });
      await page.goto(`/s/${key.replace(":", "/")}`);
      await live(page);
      await expect(page.locator("ol.timeline li.turn").first()).toBeVisible();
      await page.locator(".tool--x summary").first().click();
      expect(await page.locator("main.main").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      ).toBe(0);
    });

    test("a theme opens the panel through api.openSession({ split: true, from })", async ({ page }) => {
      await page.goto("/t/e2e-counter");
      await live(page);
      await expect(page.locator("[data-open-split]")).toBeVisible();
      await page.locator("[data-open-split]").click();
      await expect(panel(page)).toHaveClass(/panel--open/);
      await expect(page).toHaveURL(/\/t\/e2e-counter\?s=/);
      await expect(panel(page).locator("ol.timeline")).toBeVisible();
      // The theme's own container made room (after the 240 ms slide).
      const viewport = page.viewportSize()!.width;
      await expect.poll(() => mainWidth(page)).toBeLessThan(viewport - 400);
    });
  });

  test.describe("tabs (desktop)", () => {
    test.skip(({ isMobile }) => !!isMobile, "desktop project only");

    const tabs = (page: Page) => panel(page).locator("[role='tablist'] [role='tab']");
    const tabKeys = (page: Page) => tabs(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-key")));
    const activeKey = (page: Page) => panel(page).getAttribute("data-split");
    const splitParams = (page: Page) => {
      const u = new URL(page.url());
      return { s: u.searchParams.get("s"), t: u.searchParams.get("t") };
    };
    /** The first three distinct board cards: href and key, read once (cards re-sort live). */
    const cards = async (page: Page, n: number) => {
      await openBoard(page);
      const links = page.locator("article.card a.card-link");
      await expect.poll(() => links.count()).toBeGreaterThanOrEqual(n);
      // Held before the read and through the clicks: the pointer stays on the list.
      await holdBoard(page);
      const out: { href: string; key: string }[] = [];
      for (let i = 0; i < n; i++) {
        const href = (await links.nth(i).getAttribute("href"))!;
        const [, h, id] = /^\/s\/([^/]+)\/(.+)$/.exec(href)!.map(decodeURIComponent) as [string, string, string];
        out.push({ href, key: `${h}:${id}` });
      }
      return out;
    };
    /** A modified click on the card's link, dispatched on the element: what these tests check
     *  is the tabs and the URL, and a live card's height changes (its counts) and the panel's
     *  reflow can keep a pointer click chasing it, or put it under the sticky bar. */
    const click = (page: Page, href: string, modifiers: ("Shift" | "Meta" | "Control")[]) =>
      page.locator(`a.card-link[href="${href}"]`).dispatchEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        shiftKey: modifiers.includes("Shift"),
        metaKey: modifiers.includes("Meta"),
        ctrlKey: modifiers.includes("Control"),
      });

    test("shift-clicks add tabs, ⌘-click adds one in the background; the URL round-trips", async ({ page }) => {
      const [a, b, c] = await cards(page, 3);
      await click(page, a!.href, ["Shift"]);
      await click(page, b!.href, ["Shift"]);
      await expect(tabs(page)).toHaveCount(2);
      expect(await tabKeys(page)).toEqual([a!.key, b!.key]);
      await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
      // By its key, not its words: a demo session may learn a better title mid-turn.
      expect(await activeKey(page)).toBe(b!.key);
      await expect(panel(page).locator(".panel-title")).not.toHaveText("");
      expect(splitParams(page)).toEqual({ s: `${a!.key},${b!.key}`, t: "1" });

      await click(page, c!.href, [process.platform === "darwin" ? "Meta" : "Control"]);
      await expect(tabs(page)).toHaveCount(3);
      expect(await tabKeys(page)).toEqual([a!.key, b!.key, c!.key]);
      await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
      expect(splitParams(page)).toEqual({ s: `${a!.key},${b!.key},${c!.key}`, t: "1" });
      // Shift-click on an open one activates it instead of adding another.
      await click(page, c!.href, ["Shift"]);
      await expect(tabs(page)).toHaveCount(3);
      await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");

      // Reload keeps all three and the active one; ctrl+tab cycles.
      await page.reload();
      await live(page);
      await expect(tabs(page)).toHaveCount(3);
      expect(await activeKey(page)).toBe(c!.key);
      await page.keyboard.press("Control+Tab");
      expect(await activeKey(page)).toBe(a!.key);
      await page.keyboard.press("Control+Shift+Tab");
      expect(await activeKey(page)).toBe(c!.key);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+2" : "Control+2");
      expect(await activeKey(page)).toBe(b!.key);
      // Each tab's body stays mounted with its own scroller.
      await expect(panel(page).locator("[data-body]")).toHaveCount(3);
    });

    test("tabs reorder by drag; closing the middle one keeps the neighbours; the last close shuts the panel", async ({
      page,
    }) => {
      const [a, b, c] = await cards(page, 3);
      await click(page, a!.href, ["Shift"]);
      await click(page, b!.href, ["Shift"]);
      await click(page, c!.href, ["Shift"]);
      await expect(tabs(page)).toHaveCount(3);
      // Drag the third tab to the front, once the tabs have settled (hover waits for stable).
      await tabs(page).nth(0).hover();
      await tabs(page).nth(2).hover();
      const third = (await tabs(page).nth(2).boundingBox())!;
      const first = (await tabs(page).nth(0).boundingBox())!;
      await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2);
      await page.mouse.down();
      await page.mouse.move(third.x + third.width / 2 - 20, third.y + third.height / 2, { steps: 3 });
      await page.mouse.move(first.x + 4, first.y + first.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect.poll(() => tabKeys(page)).toEqual([c!.key, a!.key, b!.key]);
      expect(await activeKey(page)).toBe(c!.key);
      expect(splitParams(page).t).toBe("0");

      // Close the middle tab (a) through its ×; c stays active.
      await tabs(page).nth(1).hover();
      await tabs(page).nth(1).locator(".tab-close").click();
      await expect.poll(() => tabKeys(page)).toEqual([c!.key, b!.key]);
      expect(await activeKey(page)).toBe(c!.key);
      // Close the active one: its neighbour takes over.
      await tabs(page).nth(0).locator(".tab-close").click();
      await expect.poll(() => tabKeys(page)).toEqual([b!.key]);
      expect(await activeKey(page)).toBe(b!.key);
      expect(splitParams(page)).toEqual({ s: b!.key, t: null });
      // One tab left: the strip folds into the head (the tab stays in the DOM). Closing that
      // last tab (⌘W with focus in the panel) shuts the panel.
      await expect(panel(page).locator("[role='tablist']")).toBeHidden();
      await panel(page).getByRole("link", { name: "Open as page" }).focus();
      await page.keyboard.press("ControlOrMeta+w");
      await expect(panel(page)).not.toHaveClass(/panel--open/);
      await expect(page).not.toHaveURL(/[?&]s=/);
    });

    test("a plain reload of / without params restores the tabs from this device", async ({ page }) => {
      const [a, b] = await cards(page, 2);
      await click(page, a!.href, ["Shift"]);
      await click(page, b!.href, ["Shift"]);
      await expect(tabs(page)).toHaveCount(2);
      await page.goto("/");
      await live(page);
      await expect(tabs(page)).toHaveCount(2);
      expect(await tabKeys(page)).toEqual([a!.key, b!.key]);
      expect(await activeKey(page)).toBe(b!.key);
      expect(splitParams(page)).toEqual({ s: `${a!.key},${b!.key}`, t: "1" });
      // Closing clears the mirror: a later plain load stays closed.
      await page.keyboard.press("Escape");
      await expect(panel(page)).not.toHaveClass(/panel--open/);
      await page.goto("/");
      await live(page);
      await expect(panel(page)).not.toHaveClass(/panel--open/);
    });

    test("a theme opens a background tab through api.openSession({ split, background })", async ({ page }) => {
      await page.goto("/t/e2e-counter");
      await live(page);
      await page.locator("[data-open-split]").click();
      await expect(tabs(page)).toHaveCount(1);
      const first = await activeKey(page);
      await page.locator("[data-open-split-bg]").click();
      await expect(tabs(page)).toHaveCount(2);
      expect(await activeKey(page)).toBe(first);
      await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");
      expect(splitParams(page).t).toBe("0");
    });
  });

  test.describe("phone", () => {
    test.skip(({ isMobile }) => !isMobile, "phone project only");

    test("open beside pushes the session's own page; Back returns to the board", async ({ page }) => {
      await openBoard(page);
      // The pointer rests on the list first, so the board holds still (Board.tsx): the row
      // read is the row tapped, by its key, wherever the live demo would have moved it.
      const rest = (await page.locator("article.card").first().boundingBox())!;
      await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2);
      await expect(page.locator(".page.board")).toHaveAttribute("data-held", "");
      const key = await page.locator("article.card").first().getAttribute("data-flip");
      const card = page.locator(`article.card[data-flip="${key}"]`);
      // A phone has no panel: "beside" opens the session's page (lib/split.ts), pushed
      // over the board with Board behind its back button, and nothing in the URL's `s`.
      await card.locator("a.card-link").click({ modifiers: ["Shift"] });
      await expect(page).toHaveURL(/\/s\//);
      await expect(page).not.toHaveURL(/[?&]s=/);
      await expect(page.locator("h1.sess-title")).not.toHaveText("");
      await expect(page.locator("ol.timeline li.turn").first()).toBeVisible();
      await expect(panel(page)).not.toHaveClass(/panel--open/);
      await expect(page.locator(".bar-back-label")).toHaveText("Board");
      await page.getByRole("button", { name: "Back" }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator("section.group").first()).toBeVisible();
    });
  });
});
