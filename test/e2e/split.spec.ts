// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The side panel: a session open beside the page. Shift-click on a board card opens it
// (URL `?s=`, the page shrinks), reload keeps it, Esc closes it, the divider resizes it,
// a theme opens it through api.openSession({ split: true }); on a phone it is a sheet.
// Pages that list no sessions (Setup, Connect, a missing page) don't show it, and it is
// back, tabs and all, on the board. It stays until it is closed: a session opened as a
// page has the other tabs beside it and takes only its own out of the strip, and the next
// launch lands on the page Settings › General › Open on names with the tabs put back.
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { SETTINGS_KEY } from "../../playwright.config.js";
import {
  EVENTS,
  holdBoard,
  INFO,
  openBoard,
  openPage,
  openPrompt,
  openSessionsUnchosen,
  sessionUrl,
  tier1Batch,
  ulid,
} from "./helpers.js";

const panel = (page: Page) => page.locator("aside.panel");
const mainWidth = (page: Page) => page.locator("main.main").evaluate((el) => el.getBoundingClientRect().width);
const live = (page: Page) => expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
const tabs = (page: Page) => panel(page).locator("[role='tablist'] [role='tab']");
/** The tab a session's address opens as: `/s/<harness>/<id>` is `<harness>:<id>`. */
const keyOf = (href: string): string => {
  const [, h, id] = /^\/s\/([^/]+)\/(.+)$/.exec(href)!.map(decodeURIComponent) as [string, string, string];
  return `${h}:${id}`;
};
type Modifier = "Shift" | "Alt" | "Meta" | "Control";
/** A modified click on a card's link, dispatched on the element: what these tests check
 *  is the tabs and the URL, and a live card's height changes (its counts) and the panel's
 *  reflow can keep a pointer click chasing it, or put it under the sticky bar. */
const clickOn = (link: Locator, modifiers: Modifier[]) =>
  link.dispatchEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    shiftKey: modifiers.includes("Shift"),
    altKey: modifiers.includes("Alt"),
    metaKey: modifiers.includes("Meta"),
    ctrlKey: modifiers.includes("Control"),
  });
const click = (page: Page, href: string, modifiers: Modifier[]) =>
  clickOn(page.locator(`a.card-link[href="${href}"]`), modifiers);
/** A card on the board now that is none of `hrefs`, by exclusion and not by its place:
 *  cards re-sort live, and one read ahead may be Done, off the board, when its click comes. */
const another = (page: Page, hrefs: string[]) =>
  page.locator(`article.card a.card-link${hrefs.map((h) => `:not([href="${h}"])`).join("")}`).first();

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

/** The prompts this file's tests left open, each as the events that end it. An open prompt
 *  counts in every page's title ("(1) Feed · …") and stands in the Inbox, which other specs
 *  read off this same server, so each ends with the test that raised it. */
const openPrompts: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  for (const end of openPrompts.splice(0)) await end();
});

/** One tier-3 session whose Bash call waits on the person's Allow, under the message that
 *  asked for it: in Simple mode its tools line is the needs-you dot and "Asking to run Bash". */
async function postAskingSession(request: APIRequestContext): Promise<{ key: string; url: string }> {
  const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
  const send = async (batch: Record<string, unknown>[]) => {
    const res = await request.post(EVENTS, {
      headers: { authorization: `Bearer ${sinkToken}` },
      data: { events: batch },
    });
    expect(res.status()).toBe(202);
  };
  const b = tier1Batch({ title: "A prompt in the narrow gutter" });
  // The session's start and its turn; the tool that follows gets no end.
  const events = b.events.slice(0, 2);
  for (const e of events) e.tier = 3;
  const turnId = (events[1]!.data as Record<string, unknown>).turn_id;
  const next = (type: string, hook: string, data: Record<string, unknown>) => {
    const last = events[events.length - 1]!;
    const time = Date.parse(last.time as string) + 1000;
    events.push({
      ...last,
      id: ulid(time),
      type,
      time: new Date(time).toISOString(),
      harness: { ...(last.harness as Record<string, unknown>), event: hook },
      session: { ...(last.session as Record<string, unknown>), seq: events.length },
      data,
    });
  };
  const call = { tool: "Bash", call_id: "toolu_deploy", turn_id: turnId };
  const attention = `att_${b.sessionId.slice(0, 8)}`;
  next("turn.progress", "UserPromptSubmit", { turn: 0, user: "Run the tests, then deploy.", assistant: "" });
  next("tool.started", "PreToolUse", { ...call, input: { command: "npm run deploy" } });
  next("attention.needed", "PermissionRequest", {
    attention_id: attention,
    kind: "permission",
    tool: "Bash",
    message: "npm run deploy",
  });
  await send(events);
  // Its end, sent after the test: the prompt answered, the call run, the turn over.
  const asked = events.length;
  next("attention.cleared", "PreToolUse", { attention_id: attention, how: "answered" });
  next("tool.ended", "PostToolUse", { ...call, ok: true, ms: 900 });
  next("turn.ended", "Stop", { turn_id: turnId, reason: "stop", ms: 3000 });
  openPrompts.push(() => send(events.slice(asked)));
  return { key: `${b.harness}:${b.sessionId}`, url: sessionUrl(b.harness, b.sessionId) };
}

/** Simple mode for the page's next load (the suite starts every device in Advanced): the
 *  session as a chat, whose tools are one line under the agent's name. */
const simpleMode = (page: Page) =>
  page.addInitScript(() => localStorage.setItem("sessionpipe-gui.settings", JSON.stringify({ mode: "simple" })));

test.describe("split panel", () => {
  test.describe("desktop", () => {
    test.skip(({ isMobile }) => !!isMobile, "desktop project only");

    test("a title is plain words on its row, beside and on its page: no Markdown ticks", async ({ page, request }) => {
      const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
      const b = tier1Batch({ title: "Which docs still say the old `--sink` flag? **Fix** them" });
      const res = await request.post(EVENTS, {
        headers: { authorization: `Bearer ${sinkToken}` },
        data: { events: b.events },
      });
      expect(res.status()).toBe(202);
      const words = "Which docs still say the old --sink flag? Fix them";
      const href = sessionUrl(b.harness, b.sessionId);
      await openBoard(page);
      const link = page.locator(`a.card-link[href="${href}"]`);
      await expect(link.locator(".card-title")).toHaveText(words);
      await clickOn(link, ["Shift"]);
      await expect(panel(page).locator(".panel-title")).toHaveText(words);
      await openPage(page, href);
      await expect(page.locator(".sess-title-text")).toHaveText(words);
    });

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
      const first = (await panel(page).getAttribute("data-split"))!;
      const open = panel(page).getByRole("link", { name: "Open as page" });
      const href1 = (await open.getAttribute("href"))!;
      expect(keyOf(href1)).toBe(first);
      // Any card but the one open beside, not "the second": the second may by now be that
      // one, whose click would add no tab. Clicked where it is found, with no address read
      // ahead: a card can leave the board (its session done) between a read and a click.
      await clickOn(another(page, [href1]), ["Alt"]);
      await expect(tabs(page)).toHaveCount(2);
      const second = (await tabs(page).nth(1).getAttribute("data-tab-key"))!;
      expect(second).not.toBe(first);
      // By its key, not its words: a demo session may learn a better title mid-turn.
      await expect(panel(page)).toHaveAttribute("data-split", second);
      await expect(panel(page).locator(".panel-title")).not.toHaveText("");
      expect(new URL(page.url()).searchParams.get("s")).toBe(`${first},${second}`);
      // The link's address is the session's alone, whatever is open beside.
      const href2 = (await open.getAttribute("href"))!;
      expect(href2).not.toContain("?");
      expect(keyOf(href2)).toBe(second);
      await open.click();
      await expect(page).toHaveURL((u) => u.pathname === href2);
      await expect(page.locator("h1.sess-title")).toBeVisible();
      // Its tab went with it; the other one stays, beside the page.
      await expect(panel(page)).toHaveClass(/panel--open/);
      await expect(panel(page)).toHaveAttribute("data-split", first);
      expect(new URL(page.url()).searchParams.get("s")).toBe(first);
      // The last tab opened as a page closes the panel.
      await expect(open).toHaveAttribute("href", href1);
      await open.click();
      await expect(page).toHaveURL((u) => u.pathname + u.search === href1);
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

    // The panel's gutter is 16 px, the page's 24: the tools line's glyph hangs in the page's
    // and has no room to in the panel's, whose edge would cut it.
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
    ]) {
      test(`at ${size.width} wide the tools line's dot is whole, on the reply's edge, and the first turn starts 8 px under the tabs`, async ({
        page,
        request,
      }) => {
        await page.setViewportSize(size);
        await simpleMode(page);
        const asking = await postAskingSession(request);
        const other = await postLongSession(request);
        await page.goto(`/?s=${encodeURIComponent(`${asking.key},${other}`)}&t=0`);
        await live(page);
        const body = panel(page).locator(".panel-body:not(.panel-body--off)");
        const line = body.locator(".chat-tools-sum");
        await expect(line).toHaveText("Asking to run Bash");
        const [edge, dot, mark] = await Promise.all([
          panel(page).boundingBox(),
          line.locator(".dot--needs_you").boundingBox(),
          body.locator(".chat-meta").boundingBox(),
        ]);
        expect(dot!.x, "the dot is inside the panel, a gutter from its edge").toBeGreaterThanOrEqual(edge!.x + 16);
        expect(Math.abs(dot!.x - mark!.x), "the dot is level with the agent's mark").toBeLessThanOrEqual(1);
        // Under the tab strip, the room the full page leaves under its bar.
        const under = async (bar: string) => {
          const [above, turn] = await Promise.all([
            panel(page).locator(bar).boundingBox(),
            body.locator(".turn").first().boundingBox(),
          ]);
          return turn!.y - (above!.y + above!.height);
        };
        expect(Math.abs((await under("[role='tablist']")) - 8), "8 px under the tabs").toBeLessThanOrEqual(1);
        // One tab: the strip folds into the head, and the turn keeps the same room under it.
        await page.goto(`/?s=${encodeURIComponent(asking.key)}`);
        await live(page);
        await expect(line).toHaveText("Asking to run Bash");
        await expect(panel(page).locator("[role='tablist']")).toBeHidden();
        expect(Math.abs((await under(".panel-head")) - 8), "8 px under the head").toBeLessThanOrEqual(1);
      });
    }

    test("the session's own page keeps the glyph hung in its wider gutter", async ({ page, request }) => {
      await simpleMode(page);
      const asking = await postAskingSession(request);
      await page.goto(asking.url);
      await live(page);
      const view = page.locator(".page.session");
      const line = view.locator(".chat-tools-sum");
      await expect(line).toHaveText("Asking to run Bash");
      await expect(line).toHaveCSS("margin-left", "-22px");
      const [dot, mark] = await Promise.all([
        line.locator(".dot--needs_you").boundingBox(),
        view.locator(".chat-meta").boundingBox(),
      ]);
      expect(Math.abs(dot!.x - (mark!.x - 18)), "the dot hangs 18 px left of the reply").toBeLessThanOrEqual(1);
    });
  });

  // A window with a mouse under 840 px wide (half a 13-inch screen) keeps the desktop's
  // layout, with no room for a session beside its page: the panel covers the page.
  test.describe("a narrow window (desktop)", () => {
    test.skip(({ isMobile }) => !!isMobile, "desktop project only");
    test.use({ viewport: { width: 760, height: 800 } });

    const rail = (page: Page) => page.locator("nav.rail");
    const covered = (page: Page) => page.locator("main.main > .page[inert]");
    /** The panel from the rail's edge to the window's, once it has slid in. */
    const covers = async (page: Page) => {
      const span = async () => {
        const [r, p] = await Promise.all([rail(page).boundingBox(), panel(page).boundingBox()]);
        return { rail: Math.round(r!.width), from: Math.round(p!.x), to: Math.round(p!.x + p!.width) };
      };
      const edge = (await span()).rail;
      await expect.poll(span).toEqual({ rail: edge, from: edge, to: page.viewportSize()!.width });
    };

    test("the panel covers the page from the rail; Esc gives the list back, the focus on its row", async ({
      page,
      request,
    }) => {
      // A session of the test's own: its row stays where it is while the panel is over it.
      const key = await postLongSession(request);
      const row = `/s/${key.replace(":", "/")}`;
      await openBoard(page);
      // By the keys: the cursor on that row, then beside.
      const link = page.locator(`article.card a.card-link[href="${row}"]`);
      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press("Shift+Enter");
      await expect(panel(page)).toHaveClass(/panel--open/);
      await expect(panel(page)).not.toHaveClass(/panel--sheet/);
      await covers(page);
      await expect(rail(page)).toBeVisible();
      await expect(page.locator("nav.tabbar")).toBeHidden();
      // Nothing to resize, and nothing kept clear for it: the page under it has the column.
      await expect(page.locator(".panel-grip")).toBeHidden();
      expect(await page.locator(".shell").evaluate((el) => getComputedStyle(el).paddingRight)).toBe("0px");
      // The page under it is out of the tab order and the accessibility tree; the palette
      // and the toasts, which are in <main> too, are not.
      await expect(covered(page)).toHaveCount(1);
      // The focus the page gave up is in the panel, and the list's keys are off: nothing
      // moves a cursor nobody sees, and Enter opens no row from under the panel.
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("aside.panel"))).toBe(true);
      const here = page.url();
      await page.keyboard.press("j");
      await page.keyboard.press("Enter");
      await page.keyboard.press("e");
      await page.waitForTimeout(300);
      expect(page.url()).toBe(here);
      await expect(panel(page)).toHaveClass(/panel--open/);
      await expect(page.locator(`article.card a.card-link[href="${row}"]`)).toHaveCount(1);
      await expect(page.locator("main.main")).not.toHaveAttribute("inert");
      const taken = await page.evaluate(() => {
        const link = document.querySelector<HTMLElement>("main.main > .page a.card-link")!;
        link.focus();
        return document.activeElement === link;
      });
      expect(taken, "a row under the panel takes the focus").toBe(false);
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await expect(palette).toBeVisible();
      await expect(palette.getByRole("combobox")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();
      await expect(panel(page)).toHaveClass(/panel--open/);
      // Its own controls are as ever: the session, its close button, Esc.
      await expect(panel(page).locator("ol.timeline li.turn").first()).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "Close panel" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(panel(page)).not.toHaveClass(/panel--open/);
      await expect(page).not.toHaveURL(/[?&]s=/);
      await expect(covered(page)).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
      // The list is where it was, the focus back on the row the session was opened from.
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("href") ?? "")).toBe(row);
    });

    test("a wider window has it beside the page again, at the width it had", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.splitWidth", "520"));
      await page.setViewportSize({ width: 1000, height: 800 });
      await openBeside(page);
      const beside = async () => {
        await expect.poll(async () => Math.round((await panel(page).boundingBox())!.width)).toBe(520);
        await expect.poll(async () => Math.round((await panel(page).boundingBox())!.x)).toBe(480);
        await expect(covered(page)).toHaveCount(0);
        await expect(page.locator(".panel-grip")).toBeVisible();
        expect(await page.locator(".shell").evaluate((el) => getComputedStyle(el).paddingRight)).toBe("520px");
      };
      await beside();
      // Narrowed (the window tiled to half the screen): the same panel, over the page.
      for (const width of [839, 720]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(panel(page)).toHaveClass(/panel--open/);
        await covers(page);
        await expect(covered(page)).toHaveCount(1);
      }
      await page.setViewportSize({ width: 1000, height: 800 });
      await beside();
      // One pixel past the narrow window's last, it is beside the page: as wide as it was
      // set, less what the page keeps (360 px of the window).
      await page.setViewportSize({ width: 840, height: 800 });
      await expect.poll(async () => Math.round((await panel(page).boundingBox())!.width)).toBe(480);
      await expect(covered(page)).toHaveCount(0);
      await expect(page.locator(".panel-grip")).toBeVisible();
    });

    test("a move to another page leaves the panel behind; the page's own entry brings the page back", async ({
      page,
    }) => {
      await openBeside(page);
      await covers(page);
      const s = new URL(page.url()).searchParams.get("s");
      // The sidebar is live beside the panel: the page asked for is shown, not kept under it.
      await rail(page).locator('[data-nav="inbox"]').click();
      await expect(page).toHaveURL(/\/inbox$/);
      await expect(panel(page)).not.toHaveClass(/panel--open/);
      await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
      await expect(covered(page)).toHaveCount(0);
      // One step in the history: Back is the board with its panel, as it was left.
      await page.goBack();
      await expect(page).toHaveURL(/\/\?s=/);
      expect(new URL(page.url()).searchParams.get("s")).toBe(s);
      await expect(panel(page)).toHaveClass(/panel--open/);
      await covers(page);
      // The entry of the page under the panel is lit: pressed, it shows that page.
      await expect(rail(page).locator('[data-nav="board"]')).toHaveAttribute("aria-current", "page");
      await rail(page).locator('[data-nav="board"]').click();
      await expect(panel(page)).not.toHaveClass(/panel--open/);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
      // Settings is a window over the page: opening and closing it moves nothing.
      await page.goBack();
      await expect(panel(page)).toHaveClass(/panel--open/);
      await rail(page).locator('[data-nav="settings"]').click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings).toBeVisible();
      await expect(panel(page)).toHaveClass(/panel--open/);
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await expect(panel(page)).toHaveClass(/panel--open/);
      expect(new URL(page.url()).searchParams.get("s")).toBe(s);
    });
  });

  test.describe("tabs (desktop)", () => {
    test.skip(({ isMobile }) => !!isMobile, "desktop project only");

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
        out.push({ href, key: keyOf(href) });
      }
      return out;
    };
    /** Opens n sessions as tabs beside the Board, a shift-click each, and gives them in
     *  the strip's order. Each click goes to a card on the board at that moment. */
    const beside = async (page: Page, n: number) => {
      await openBoard(page);
      await holdBoard(page);
      const open = panel(page).getByRole("link", { name: "Open as page" });
      const out: { href: string; key: string }[] = [];
      for (let i = 0; i < n; i++) {
        const opened = out.map((t) => t.href);
        await clickOn(another(page, opened), ["Shift"]);
        await expect(tabs(page)).toHaveCount(i + 1);
        // The new tab is the active one: the head's link is its address.
        const href = (await open.getAttribute("href"))!;
        out.push({ href, key: keyOf(href) });
      }
      expect(await tabKeys(page)).toEqual(out.map((t) => t.key));
      return out;
    };
    /** The tabs this device keeps for its next launch. */
    const mirror = (page: Page) =>
      page.evaluate(() => JSON.parse(localStorage.getItem("sessionpipe-gui.splitTabs") ?? "null") as unknown);
    const where = (page: Page) => {
      const u = new URL(page.url());
      return { path: u.pathname, ...splitParams(page) };
    };

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

    test("a session opened as a page keeps the tabs beside it, and the Board still has them", async ({ page }) => {
      const [a, b, c] = await beside(page, 3);
      const strip = `${a!.key},${b!.key},${c!.key}`;
      // A plain click opens a fourth as a page (Open sessions: As a page, the default).
      const three = [a!.href, b!.href, c!.href];
      await clickOn(another(page, three), []);
      await expect(page.locator("h1.sess-title")).toBeVisible();
      const d = new URL(page.url()).pathname;
      expect(d).toMatch(/^\/s\//);
      expect(three).not.toContain(d);
      expect(splitParams(page)).toEqual({ s: strip, t: "2" });
      await expect(tabs(page)).toHaveCount(3);
      expect(await tabKeys(page)).toEqual([a!.key, b!.key, c!.key]);
      expect(await activeKey(page)).toBe(c!.key);
      // The sidebar's Board: the same three, the same one active.
      await page.locator("nav.rail a[data-nav='board']").click();
      await expect(page.locator("section.group").first()).toBeVisible();
      expect(where(page)).toEqual({ path: "/", s: strip, t: "2" });
      await expect(tabs(page)).toHaveCount(3);
      expect(await tabKeys(page)).toEqual([a!.key, b!.key, c!.key]);
      expect(await activeKey(page)).toBe(c!.key);
    });

    test("the app opened on a session's own address has the last visit's other tab beside it", async ({ page }) => {
      const [a, b] = await beside(page, 2);
      // A notification clicked with the window closed opens the app on the session's page:
      // the other tab beside it, and that session once.
      await page.goto(b!.href);
      await live(page);
      await expect(page.locator("h1.sess-title")).toBeVisible();
      await expect(panel(page)).toHaveClass(/panel--open/);
      await expect(tabs(page)).toHaveCount(1);
      expect(await activeKey(page)).toBe(a!.key);
      expect(where(page)).toEqual({ path: b!.href, s: a!.key, t: null });
      // What is on screen is what the launch after this one puts back.
      expect(await mirror(page)).toEqual({ tabs: [a!.key], active: 0 });
    });

    test("Open as page moves that one tab out, in one step that Back undoes", async ({ page }) => {
      const [a, b, c] = await beside(page, 3);
      const strip = `${a!.key},${b!.key},${c!.key}`;
      await page.keyboard.press(process.platform === "darwin" ? "Meta+2" : "Control+2");
      await expect.poll(() => where(page)).toEqual({ path: "/", s: strip, t: "1" });

      // The active tab, from the panel's head: b's page, with its right neighbour active.
      await panel(page).getByRole("link", { name: "Open as page" }).click();
      await expect(page.locator("h1.sess-title")).toBeVisible();
      expect(where(page)).toEqual({ path: b!.href, s: `${a!.key},${c!.key}`, t: "1" });
      expect(await tabKeys(page)).toEqual([a!.key, c!.key]);
      expect(await activeKey(page)).toBe(c!.key);
      // What the next launch puts back is what is on screen.
      expect(await mirror(page)).toEqual({ tabs: [a!.key, c!.key], active: 1 });

      // Back: the board and the strip exactly as they were.
      await page.goBack();
      await expect(page.locator("section.group").first()).toBeVisible();
      await expect(tabs(page)).toHaveCount(3);
      expect(where(page)).toEqual({ path: "/", s: strip, t: "1" });
      expect(await tabKeys(page)).toEqual([a!.key, b!.key, c!.key]);
      expect(await activeKey(page)).toBe(b!.key);
      expect(await mirror(page)).toEqual({ tabs: [a!.key, b!.key, c!.key], active: 1 });

      // A tab that is not the active one, from its own menu: the active tab stays active.
      await tabs(page).nth(0).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Open as page" }).click();
      await expect(page.locator("h1.sess-title")).toBeVisible();
      expect(where(page)).toEqual({ path: a!.href, s: `${b!.key},${c!.key}`, t: "0" });
      expect(await tabKeys(page)).toEqual([b!.key, c!.key]);
      expect(await activeKey(page)).toBe(b!.key);
    });

    test("a plain / lands on Open on with the last visit's tabs; an address that was asked for stays", async ({
      page,
    }) => {
      const [a] = await beside(page, 1);
      await expect(panel(page)).toHaveClass(/panel--open/);
      // This device opens on the Inbox (Settings › General › Open on).
      await page.evaluate(
        (key) => localStorage.setItem(key, JSON.stringify({ mode: "advanced", defaultPage: "/inbox" })),
        SETTINGS_KEY,
      );
      // The next launch: the Inbox, and the tab left open is put back beside it.
      await page.goto("/");
      await live(page);
      await expect(page).toHaveURL((u) => u.pathname === "/inbox");
      await expect(panel(page)).toHaveClass(/panel--open/);
      expect(where(page)).toEqual({ path: "/inbox", s: a!.key, t: null });
      expect(await activeKey(page)).toBe(a!.key);
      // The installed app's "New session" shortcut names a sheet, not a page: the Inbox
      // again, the tab beside it, the sheet over both.
      await page.goto("/?new=1");
      await expect(page.locator("[data-new-session]")).toBeVisible();
      await expect.poll(() => where(page)).toEqual({ path: "/inbox", s: a!.key, t: null });
      // An address that names its tabs (a reload, a bookmark of the Board) keeps the Board.
      await page.goto(`/?s=${encodeURIComponent(a!.key)}`);
      await live(page);
      await expect(panel(page)).toHaveClass(/panel--open/);
      expect(where(page).path).toBe("/");
      // The desktop app's Go › Board with the window closed (its init script marks the
      // page as asked for): the Board, with the tabs put back.
      await page.addInitScript(() => history.replaceState({ asked: 1 }, "", location.href));
      await page.goto("/");
      await live(page);
      await expect(panel(page)).toHaveClass(/panel--open/);
      expect(where(page)).toEqual({ path: "/", s: a!.key, t: null });
    });

    test.describe("with Open sessions: Beside", () => {
      test.beforeEach(async ({ page }) => {
        await page.addInitScript(
          (key) => localStorage.setItem(key, JSON.stringify({ mode: "advanced", openSessions: "beside" })),
          SETTINGS_KEY,
        );
      });
      /** Opens the menu of the row under the cursor with `.`: its first Open item is
       *  "Open beside ↵" and the next "Open as page ⇧↵"; then ↵ on that row opens it beside
       *  `path`, and the panel's tab is the row's session. */
      const enterFollowsTheMenu = async (page: Page, path: string, href: string) => {
        await page.keyboard.press(".");
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();
        const opens = menu.getByRole("menuitem", { name: /^Open (beside|as page)/ });
        await expect(opens.nth(0)).toHaveAccessibleName("Open beside");
        await expect(opens.nth(0).locator(".menu-keys")).toHaveText(/^(↵|Enter)$/);
        await expect(opens.nth(1)).toHaveAccessibleName("Open as page");
        await expect(opens.nth(1).locator(".menu-keys")).toHaveText(/^(⇧↵|Shift\+?\s?Enter)$/);
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        await page.keyboard.press("Enter");
        await expect(panel(page)).toHaveClass(/panel--open/);
        expect(where(page)).toEqual({ path, s: keyOf(href), t: null });
      };

      test("on the Board the menu leads with Open beside ↵, and ↵ opens the row beside", async ({ page }) => {
        await openBoard(page);
        await holdBoard(page);
        const link = page.locator("article.card a.card-link").first();
        const href = (await link.getAttribute("href"))!;
        await link.focus();
        await expect(page.locator("article.card[aria-current='true'] a.card-link")).toHaveAttribute("href", href);
        await enterFollowsTheMenu(page, "/", href);
      });

      test("on the Inbox the menu leads with Open beside ↵, and ↵ opens the row beside", async ({ page, request }) => {
        const p = await openPrompt(request, { machine: "e2e-enter-box", title: "E2E enter follows the menu" });
        try {
          await openPage(page, "/inbox");
          const row = page.locator(`.inbox-row[data-session="${p.key}"]`);
          await row.locator(".inbox-main").focus();
          await expect(row).toHaveAttribute("aria-current", "true");
          await enterFollowsTheMenu(page, "/inbox", sessionUrl(p.harness, p.sessionId));
        } finally {
          await p.clear();
        }
      });

      test("on the Feed the menu leads with Open beside ↵, and ↵ opens the row beside", async ({ page }) => {
        await openPage(page, "/feed");
        await expect(page.locator("ol.rows")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("li.ev a.ev-session").first()).toBeVisible({ timeout: 20_000 });
        await page.keyboard.press("j");
        // The row the cursor is on, read after it is there: new events land above it.
        const href = (await page.locator("li.ev[aria-current='true'] a.ev-session").getAttribute("href"))!;
        await enterFollowsTheMenu(page, "/feed", href);
      });

      test("a plain click opens beside, ⇧-click the other way (the page), ⌘-click a background tab", async ({
        page,
      }) => {
        const [a, b, c] = await cards(page, 3);
        await click(page, a!.href, []);
        await expect(tabs(page)).toHaveCount(1);
        expect(where(page)).toEqual({ path: "/", s: a!.key, t: null });
        await click(page, c!.href, [process.platform === "darwin" ? "Meta" : "Control"]);
        await expect(tabs(page)).toHaveCount(2);
        expect(await activeKey(page)).toBe(a!.key);
        await click(page, b!.href, ["Shift"]);
        await expect(page).toHaveURL((u) => u.pathname === b!.href);
        await expect(page.locator("h1.sess-title")).toBeVisible();
      });

      test("plain clicks reuse one italic preview tab; ⌘-click and a double-click keep theirs; ⌘2 and a close keep the rule", async ({
        page,
      }) => {
        await openBoard(page);
        await holdBoard(page);
        const meta: Modifier = process.platform === "darwin" ? "Meta" : "Control";
        const seen: string[] = [];
        /** Clicks a card on the board now that no click here has opened yet; its key. */
        const open = async (modifiers: Modifier[] = []) => {
          const href = (await another(page, seen).getAttribute("href"))!;
          seen.push(href);
          await click(page, href, modifiers);
          return keyOf(href);
        };
        const preview = panel(page).locator(".tab--preview");
        await open();
        const b = await open();
        await expect.poll(() => where(page)).toEqual({ path: "/", s: b, t: null });
        await expect(tabs(page)).toHaveCount(1);
        await expect(preview).toHaveCount(1);
        await expect(panel(page).locator(".panel-title")).toHaveCSS("font-style", "italic");
        // ⌘-click: a kept tab in the background; the preview stays the active one.
        const c = await open([meta]);
        await expect.poll(() => tabKeys(page)).toEqual([b, c]);
        await expect.poll(() => activeKey(page)).toBe(b);
        await expect(tabs(page).nth(0)).toHaveClass(/tab--preview/);
        await expect(tabs(page).nth(0).locator(".tab-title")).toHaveCSS("font-style", "italic");
        await expect(tabs(page).nth(1).locator(".tab-title")).toHaveCSS("font-style", "normal");
        // ⌘2 goes to the kept tab; the next plain open still takes the preview's place.
        await page.keyboard.press(`${meta}+2`);
        await expect.poll(() => activeKey(page)).toBe(c);
        const d = await open();
        await expect.poll(() => tabKeys(page)).toEqual([d, c]);
        await expect.poll(() => activeKey(page)).toBe(d);
        // A double-click keeps it; the next plain open adds a preview at the end.
        await tabs(page).nth(0).dblclick();
        await expect(preview).toHaveCount(0);
        const e = await open();
        await expect.poll(() => tabKeys(page)).toEqual([d, c, e]);
        await expect(tabs(page).nth(2)).toHaveClass(/tab--preview/);
        // Closed, the preview is gone: the next plain open adds a tab of its own.
        await tabs(page).nth(2).locator(".tab-close").click();
        await expect(tabs(page)).toHaveCount(2);
        const f = await open();
        await expect.poll(() => tabKeys(page)).toEqual([d, c, f]);
        // A reload keeps every tab and drops the mark.
        await page.reload();
        await live(page);
        await expect(tabs(page)).toHaveCount(3);
        await expect(preview).toHaveCount(0);
      });

      test("what ⇧ does is said as the other way, in Settings and on the row's button", async ({ page }) => {
        await openBoard(page);
        await holdBoard(page);
        // The row's button names one thing; ⇧-click's way follows the setting, so it is not in it.
        await expect(page.locator("article.card .icon-btn[aria-label='Open beside']").first()).toHaveAttribute(
          "title",
          "Open beside",
        );
        await page.locator("nav.rail a[aria-label='Settings']").click();
        const settings = page.getByRole("dialog", { name: "Settings", exact: true });
        const row = settings.locator(".settings-row").filter({ hasText: "Open sessions" });
        await expect(row.locator(".settings-hint")).toHaveText(
          /^(Click or ↵\. Hold ⇧ for the other way\.|Click or Enter\. Hold Shift for the other way\.)$/,
        );
      });
    });

    test.describe("with nothing chosen", () => {
      test.beforeEach(({ page }) => openSessionsUnchosen(page));
      const openSettings = async (page: Page) => {
        await page.locator("nav.rail a[aria-label='Settings']").click();
        const settings = page.getByRole("dialog", { name: "Settings", exact: true });
        return settings.locator(".settings-row").filter({ hasText: "Open sessions" });
      };

      test("a plain click on a computer opens the session beside the Board, one preview tab, and Settings says Beside", async ({
        page,
      }) => {
        const [a, b] = await cards(page, 2);
        await click(page, a!.href, []);
        await expect(panel(page)).toHaveClass(/panel--open/);
        expect(where(page)).toEqual({ path: "/", s: a!.key, t: null });
        await click(page, b!.href, []);
        await expect.poll(() => where(page)).toEqual({ path: "/", s: b!.key, t: null });
        await expect(panel(page).locator(".tab--preview")).toHaveCount(1);
        const row = await openSettings(page);
        await expect(row.getByRole("radio", { name: "Beside" })).toBeChecked();
        await expect(row.locator(".seg-opt")).toHaveText(["Beside", "As a page"]);
      });

      test("the As a page every save used to store gives way to Beside once; As a page chosen again sticks, and ↵ does what the menu says", async ({
        page,
      }) => {
        // What 0.8.5 kept after any change in Settings: every field, openSessions "page" with them.
        await page.addInitScript((key) => {
          if (sessionStorage.getItem("e2e-seeded")) return;
          sessionStorage.setItem("e2e-seeded", "1");
          localStorage.setItem(key, JSON.stringify({ mode: "advanced", defaultPage: "/", openSessions: "page" }));
        }, SETTINGS_KEY);
        const [a] = await cards(page, 1);
        await click(page, a!.href, []);
        await expect(panel(page)).toHaveClass(/panel--open/);
        expect(where(page)).toEqual({ path: "/", s: a!.key, t: null });
        const row = await openSettings(page);
        await row.locator(".seg-opt").filter({ hasText: "As a page" }).click();
        await expect(row.getByRole("radio", { name: "As a page" })).toBeChecked();
        await page.keyboard.press("Escape");
        await expect(page).toHaveURL((u) => !u.searchParams.has("settings"));
        await page.goto("/");
        await live(page);
        await holdBoard(page);
        // Not the row whose tab is open beside (its menu has no Open beside).
        const link = another(page, [a!.href]);
        const href = (await link.getAttribute("href"))!;
        await page.locator(`article.card a.card-link[href="${href}"]`).focus();
        await expect(page.locator("article.card[aria-current='true'] a.card-link")).toHaveAttribute("href", href);
        await page.keyboard.press(".");
        const menu = page.getByRole("menu");
        const opens = menu.getByRole("menuitem", { name: /^Open (beside|as page)/ });
        await expect(opens.nth(0)).toHaveAccessibleName("Open as page");
        await expect(opens.nth(0).locator(".menu-keys")).toHaveText(/^(↵|Enter)$/);
        await expect(opens.nth(1)).toHaveAccessibleName("Open beside");
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL((u) => u.pathname === href);
      });
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
      // The bar's own Back (by name a subagent's "…a background agent" notice matches too).
      await page.locator(".bar .bar-back").click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator("section.group").first()).toBeVisible();
    });

    test("the tools line's glyph sits on the reply's edge, as it did", async ({ page, request }) => {
      await simpleMode(page);
      const asking = await postAskingSession(request);
      await page.goto(asking.url);
      await live(page);
      const line = page.locator(".page.session .chat-tools-sum");
      await expect(line).toHaveText("Asking to run Bash");
      await expect(line).toHaveCSS("margin-left", "-4px");
    });
  });

  // Both projects: the installed app's "New session" shortcut (manifest.webmanifest) is
  // `/?new=1` on a phone and on a computer.
  test("the New session shortcut lands on Open on, its sheet over that page", async ({ page }) => {
    await page.addInitScript(
      (key) => localStorage.setItem(key, JSON.stringify({ mode: "advanced", defaultPage: "/inbox" })),
      SETTINGS_KEY,
    );
    await page.goto("/?new=1");
    await expect(page.locator("[data-new-session]")).toBeVisible();
    // The sheet's parameters ask for no page, and leave the address.
    await expect(page).toHaveURL((u) => u.pathname === "/inbox" && u.search === "");
  });
});
