// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// What the iPhone app keeps as an iPhone Duo is unfolded, turned, put in Split View and
// folded again: each is a live resize of the one page, between the shapes of duo.ts. Run
// in Chromium (the `duo` project) and in WebKit (`duo-webkit`), WKWebView's engine, since
// what a page holds on to through a resize is the engine's doing as much as the app's.
// A message being written; the reply being read and the board's row, where they were under
// the bar (lib/resizeAnchor.ts), also where the page changed since it was last scrolled;
// the end of a session that is followed; an open list.
// So is what duo.ts itself promises a test, which is held here too: the system's bands in
// a page from its first script, and a measure that tells a control held under a band from
// one passing.
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { Session } from "../events.js";
import {
  bandOffenders,
  coarsePointer,
  DUO,
  DUO_SESSIONS,
  type DuoBed,
  duoBed,
  insetsInit,
  pose,
  shapeOf,
} from "./duo.js";

const composer = (page: Page) => page.locator("textarea").first();

/** The Duo's poses as a hand goes through them and back: unfolded, turned, upright again,
 *  folded. */
const ROUND = [
  [669, 951],
  [951, 669],
  [669, 951],
  [466, 678],
] as const;

const on = (title: string) => ({
  session: { machine: "studio-mac", cwd: "/Users/me/code/billing", title, title_source: "custom" as const },
});
const LONG = on("Resume the invoice export");
const PARAGRAPHS = [
  "Batch 7 resets because the connection pooler drops connections that sit idle for more than 30 seconds, and batch 7 is the first one large enough to spend that long building its CSV before it writes.",
  "I changed the export to take a fresh connection for each batch and to write the batch in pages of 100 invoices, so no connection is idle long enough to be dropped.",
  "The export now records the last batch that finished in export_state. A run that starts again reads it and goes on from the next batch, so a failure at batch 7 no longer repeats batches 1 to 6.",
  "The new test starts an export, closes the connection halfway through batch 7 and runs the export again. It checks that batches 1 to 6 are written once and that batch 7 is written whole.",
];
/** A session longer than any of the Duo's screens (/s/claude-code/s-long): five turns, each
 *  a question of one line and a reply of ten paragraphs, "Turn 3, paragraph 4." and so on. */
function longSession(): { s: Session; events: unknown[] } {
  const s = new Session("s-long", "claude-code", Date.now() - 50 * 60_000);
  const events: unknown[] = [s.ev("session.started", { source: "startup" }, LONG)];
  for (let t = 1; t <= 5; t++) {
    const assistant = Array.from(
      { length: 10 },
      (_, i) => `Turn ${t}, paragraph ${i + 1}. ${PARAGRAPHS[i % PARAGRAPHS.length]}`,
    ).join("\n\n");
    events.push(
      s.ev("turn.started", { turn_id: `t${t}` }, LONG),
      s.ev("turn.transcript", { turn: t, user: `Turn ${t}: what changed?`, assistant }, LONG),
      s.ev("turn.ended", { turn_id: `t${t}` }, LONG),
    );
  }
  return { s, events };
}
const LAST = "Turn 5, paragraph 10.";

/** A board longer than any screen: `n` sessions that ended hours ago, "Row 01: …" on. */
function manyRows(n: number): unknown[] {
  const events: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const s = new Session(`s-row-${i}`, "claude-code", Date.now() - (5 + i) * 60 * 60_000);
    const row = on(`Row ${String(i + 1).padStart(2, "0")}: tidy the billing module`);
    events.push(
      s.ev("session.started", { source: "startup" }, row),
      s.ev("turn.started", { turn_id: "t1" }, row),
      s.ev(
        "turn.transcript",
        { turn: 1, user: "Tidy the billing module.", assistant: "Tidied: two dead exports gone." },
        row,
      ),
      s.ev("turn.ended", { turn_id: "t1" }, row),
    );
  }
  return events;
}

/** A session that starts now, "`name`: …": its card arrives at the top of the board. */
function starts(b: DuoBed, name: string): void {
  const s = new Session(`s-${name.toLowerCase()}`, "claude-code", Date.now() - 30_000);
  const fresh = on(`${name}: a session that just started`);
  b.ss.push([
    s.ev("session.started", { source: "startup" }, fresh),
    s.ev("turn.started", { turn_id: "t1" }, fresh),
    s.ev("turn.progress", { turn_id: "t1", user: "Start.", assistant: "Starting." }, fresh),
  ]);
}

const PLAN = { first: "Here is the plan the team agreed on", last: "Ship it behind the export_resume flag first." };
const PLAN_REPLY_LAST = "Everything is on fix/export-resume, ready for review.";
/** A session (/s/claude-code/s-plan) whose second message is some forty lines, so it shows
 *  its first eight and "Show all", with a reply longer than a screen on each side of it. */
function planSession(): unknown[] {
  const s = new Session("s-plan", "claude-code", Date.now() - 50 * 60_000);
  const steps = [
    "Record the last batch that finished in the export_state table, keyed by run id.",
    "On start, read it and skip every batch up to and including that one.",
    "Retry a failed batch three times with backoff, then stop and keep the state.",
    "Open a new connection for each batch instead of holding one for the whole run.",
  ];
  const plan = Array.from({ length: 36 }, (_, i) => `${i + 1}. ${steps[i % steps.length]}`).join("\n");
  const reply = (n: number) => Array.from({ length: n }, (_, i) => PARAGRAPHS[i % PARAGRAPHS.length]).join("\n\n");
  return [
    s.ev("session.started", { source: "startup" }, LONG),
    s.ev("turn.started", { turn_id: "t1" }, LONG),
    s.ev("turn.transcript", { turn: 1, user: "What changed?", assistant: reply(8) }, LONG),
    s.ev("turn.ended", { turn_id: "t1" }, LONG),
    s.ev("turn.started", { turn_id: "t2" }, LONG),
    s.ev(
      "turn.transcript",
      {
        turn: 2,
        user: `${PLAN.first} for the export:\n\n${plan}\n\n${PLAN.last}`,
        assistant: `${reply(16)}\n\n${PLAN_REPLY_LAST}`,
      },
      LONG,
    ),
    s.ev("turn.ended", { turn_id: "t2" }, LONG),
  ];
}

/** `n` sessions that each wait for an answer, "Ask 01: …" on: an Inbox longer than a screen. */
function manyPrompts(n: number): unknown[] {
  const events: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const asked = Date.now() - (2 + i) * 60_000;
    const s = new Session(`s-ask-${i}`, "claude-code", asked - 60_000);
    const row = (at?: number) => ({
      ...on(`Ask ${String(i + 1).padStart(2, "0")}: ship the billing module`),
      ...(at ? { time: new Date(at).toISOString() } : {}),
    });
    const command = `npm run deploy -- --target staging-${i + 1}`;
    events.push(
      s.ev("session.started", { source: "startup" }, row()),
      s.ev("turn.started", { turn_id: "t1" }, row()),
      s.ev("turn.progress", { turn_id: "t1", user: "Ship it to staging.", assistant: "Built. Deploying next." }, row()),
      s.ev("tool.started", { tool: "Bash", call_id: "c1", turn_id: "t1", input: { command } }, row(asked - 1_000)),
      s.ev(
        "attention.needed",
        { attention_id: `att_${i}`, kind: "permission", tool: "Bash", message: command },
        row(asked),
      ),
    );
  }
  return events;
}

/** The iPhone app at `size`, approved, with `events` more on its account, on its board. */
async function bedWith(browser: Browser, size: string, events: unknown[]): Promise<DuoBed> {
  const b = await duoBed(browser, size);
  b.ss.push(events);
  await b.page.goto(b.server.url);
  await expect(b.page.getByText("Release notes for 0.8.3").first()).toBeVisible();
  await b.approve();
  return b;
}

/** `n` frames drawn: what a scroll set off (the page hears it, then writes its place
 *  down in the next frame) is done. A state to wait for, not a time. */
const frames = (page: Page, n = 2) =>
  page.evaluate(
    (left) =>
      new Promise<void>((done) => {
        const tick = (k: number) => (k ? requestAnimationFrame(() => tick(k - 1)) : done());
        tick(left);
      }),
    n,
  );
/** How far the top of `el` is under the bar at the top of the page, in pt. */
const underBar = (el: Locator) =>
  el.evaluate((node) => {
    const bar = Array.from(document.querySelectorAll(".bar")).find((b) => b.getClientRects().length);
    return Math.round(node.getBoundingClientRect().top - (bar?.getBoundingClientRect().bottom ?? 0));
  });
/** Scrolls the page until `el` is `pt` under the bar, as a finger leaves it there: the page
 *  hears each scroll, and a list still taking its rows is waited for. */
async function putUnderBar(page: Page, el: Locator, pt: number): Promise<void> {
  await expect(async () => {
    await el.evaluate((node, want) => {
      const bar = Array.from(document.querySelectorAll(".bar")).find((b) => b.getClientRects().length);
      window.scrollBy(0, node.getBoundingClientRect().top - (bar?.getBoundingClientRect().bottom ?? 0) - want);
    }, pt);
    await frames(page);
    expect(Math.abs((await underBar(el)) - pt)).toBeLessThanOrEqual(1);
  }, "the page is long enough to put it there, and has stopped moving").toPass({ timeout: 10_000 });
}
/** `el` is within `slack` pt of `pt` under the bar (asked until a moving list has stopped). */
const staysUnderBar = (el: Locator, pt: number, slack: number, at: string) =>
  expect
    .poll(async () => Math.abs((await underBar(el)) - pt), { message: `${at}: pt from its place` })
    .toBeLessThanOrEqual(slack);
/** How far `el` is under the bar once the page has stopped moving: no row of a list is on
 *  its way to a new place, and two looks fifteen frames apart agree. */
async function atRest(page: Page, el: Locator): Promise<number> {
  await expect(page.locator("[data-flip-moving]")).toHaveCount(0);
  let at = await underBar(el);
  await expect(async () => {
    const was = at;
    await frames(page, 15);
    at = await underBar(el);
    expect(at).toBe(was);
  }, "the page has stopped moving").toPass({ timeout: 10_000 });
  return at;
}
/** What is left of the page under the screen, in pt: 0 at its end. */
const gapToEnd = (page: Page) =>
  page.evaluate(() => Math.round(document.documentElement.scrollHeight - (scrollY + innerHeight)));

/** The long session open at `size` and followed at its end. A session opens on its end,
 *  and now and then stops a line short of it (0.8.4 does, more often in WebKit: a scroll
 *  of the browser's own is heard before the page has followed a reply read whole). That is
 *  not what is tried here: a flick to the end, as a person's, and it is followed. */
async function longOpen(browser: Browser, size: string): Promise<DuoBed & { s: Session }> {
  const { s, events } = longSession();
  const b = await bedWith(browser, size, events);
  await b.page.goto(`${b.server.url}/s/claude-code/s-long`);
  await expect(b.page.getByText(LAST).first()).toBeVisible();
  await expect(async () => {
    await b.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await frames(b.page);
    expect(await gapToEnd(b.page)).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 10_000 });
  return { ...b, s };
}
const paragraph = (page: Page, turn: number, n: number) =>
  page.locator(".md p").filter({ hasText: `Turn ${turn}, paragraph ${n}.` });

/** A page of this file's own, to try duo.ts on with no app in the way. Its first script
 *  writes down the bands it can read. Its buttons are named for where they stand, on a
 *  page three screens long: two fixed under a band and three that only look it (one clear,
 *  one that takes no tap, one under a scrim); a row and a sticky head that start under the
 *  home indicator and scroll up from it; a sticky foot that the window's bottom holds
 *  until the page's end; and the last row, which ends there. */
const MADE_UP = `<!doctype html>
<html>
  <head>
    <script>
      window.atFirstScript = ["top", "right", "bottom", "left"].map(function (side) {
        return getComputedStyle(document.documentElement).getPropertyValue("--safe-" + side);
      });
    </script>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin: 0; }
      button { display: block; width: 80px; height: 30px; margin: 0; padding: 0; border: 0; font-size: 10px; }
      .fixed { position: fixed; }
      .head, .foot { position: sticky; width: 80px; }
      .head { top: 0; }
      .foot { bottom: 0; }
    </style>
  </head>
  <body>
    <button class="fixed" style="right: 0; top: 100px">fixed at the side</button>
    <button class="fixed" style="left: 180px; bottom: 0">fixed at the bottom</button>
    <button class="fixed" style="left: 180px; top: 100px">clear</button>
    <button class="fixed" style="right: 0; top: 200px; pointer-events: none">takes no tap</button>
    <button class="fixed" style="right: 0; top: 300px">under a scrim</button>
    <div class="fixed" style="right: 0; top: 300px; width: 80px; height: 30px"></div>
    <button style="position: absolute; left: 270px; top: calc(100vh - 10px)">a row</button>
    <div style="height: calc(100vh - 10px)"></div>
    <div class="head"><button>a head</button></div>
    <div style="height: 200vh"></div>
    <div class="foot" style="margin-left: 90px"><button>a foot</button></div>
    <button>the last row</button>
  </body>
</html>`;

test.beforeAll(async ({ browser }) => {
  // A finger, at every width: what makes the inner display the touch app's and not a Mac's.
  expect(await coarsePointer(browser)).toBe(true);
});

test("a message being written is kept as the phone is unfolded, turned, put in Split View and folded again", async ({
  browser,
}) => {
  const b = await duoBed(browser, "466x678");
  const { page } = b;
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
    await expect(page.getByText("Drafted CHANGELOG.md").first()).toBeVisible();
    expect(await shapeOf(page)).toEqual({ size: "466x678", insets: DUO["466x678"]!.insets });
    const draft = "Add the fold fix to the notes, under Fixes.";
    await composer(page).fill(draft);
    for (const [width, height] of [
      [669, 951],
      [951, 669],
      [470, 669],
      [466, 678],
    ] as const) {
      const at = `${width}x${height}`;
      await pose(page, width, height);
      // The window and its bands moved together, and the words are where they were left.
      expect(await shapeOf(page), at).toEqual({ size: at, insets: DUO[at]!.insets });
      await expect(composer(page), at).toHaveValue(draft);
      await expect(composer(page), at).toBeVisible();
    }
    // A page opened in a pose has that pose's bands, not the ones the app started with.
    await pose(page, 669, 951);
    await page.reload();
    await expect(page.getByText("Drafted CHANGELOG.md").first()).toBeVisible();
    expect(await shapeOf(page)).toEqual({ size: "669x951", insets: DUO["669x951"]!.insets });
  } finally {
    await b.close();
  }
});

/** The inner display opened, turned on its side, upright again, then half of it in Split
 *  View: every pose from the outer display on. Turned, it is wider than the width at which
 *  a window with a mouse changes its layout; a touch screen keeps the one it has. */
const WALK = [
  [669, 951],
  [951, 669],
  [669, 951],
  [470, 669],
] as const;

interface Held {
  __held?: Record<string, Element | null>;
}
/** The page keeps hold of the nodes that match now, each by a name. */
const hold = (page: Page, nodes: Record<string, string>) =>
  page.evaluate((sel) => {
    const held: Record<string, Element | null> = {};
    for (const [name, selector] of Object.entries(sel)) held[name] = document.querySelector(selector);
    (window as unknown as Held).__held = held;
  }, nodes);
/** Which of them are still the nodes on the page: the same element, not one drawn anew in
 *  its place (that one would have lost the focus, the caret and an open list). */
const same = (page: Page, nodes: Record<string, string>) =>
  page.evaluate((sel) => {
    const held = (window as unknown as Held).__held ?? {};
    const kept: Record<string, boolean> = {};
    for (const [name, selector] of Object.entries(sel)) {
      const now = document.querySelector(selector);
      kept[name] = !!now && now === held[name] && now.isConnected;
    }
    return kept;
  }, nodes);
/** The field with the focus, as a person left it: its words and where the caret is. */
const typing = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const field = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(sel);
    return {
      focused: !!field && document.activeElement === field,
      caret: field ? [field.selectionStart, field.selectionEnd] : null,
      text: field?.value ?? null,
    };
  }, selector);

test.describe("no pose swaps the app: through an unfold, a turn and Split View", () => {
  /** The app on the outer display, approved, at the board. */
  const approved = async (b: Awaited<ReturnType<typeof duoBed>>) => {
    await b.page.goto(b.server.url);
    await expect(b.page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    await b.page.goto(b.server.url);
    await expect(b.page.getByText("Release notes for 0.8.3").first()).toBeVisible();
  };

  test("New session being written is the same sheet: its field keeps the focus, the caret and the words", async ({
    browser,
  }) => {
    const b = await duoBed(browser, "466x678");
    const { page } = b;
    const NODES = { sheet: "[data-new-session]", field: "[data-ns-text]" };
    const draft = "Started on the outer screen.";
    try {
      await approved(b);
      await page.getByRole("button", { name: "New session" }).click();
      const field = page.locator(NODES.field);
      await field.click();
      await field.fill(draft);
      await field.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(6, 6));
      expect(await typing(page, NODES.field)).toEqual({ focused: true, caret: [6, 6], text: draft });
      await hold(page, NODES);
      for (const [width, height] of WALK) {
        const at = `${width}x${height}`;
        await pose(page, width, height);
        expect(await same(page, NODES), at).toEqual({ sheet: true, field: true });
        expect(await typing(page, NODES.field), at).toEqual({ focused: true, caret: [6, 6], text: draft });
        // The phone's sheet at every one of them: Start in its bar, a word with no key beside it.
        await expect(page.locator("[data-ns-start]"), at).toHaveText("Start");
      }
    } finally {
      await b.close();
    }
  });

  test("New session with the machine picker open keeps the sheet and the open list", async ({ browser }) => {
    const b = await duoBed(browser, "466x678");
    const { page } = b;
    const NODES = { sheet: "[data-new-session]", picker: "[data-ns-row=machine] button" };
    try {
      await approved(b);
      await page.getByRole("button", { name: "New session" }).click();
      await page.locator(NODES.picker).click();
      const list = page.getByRole("listbox");
      await expect(list).toBeVisible();
      await expect(list.getByRole("option", { name: "studio-mac" })).toBeVisible();
      await hold(page, NODES);
      for (const [width, height] of WALK) {
        const at = `${width}x${height}`;
        await pose(page, width, height);
        expect(await same(page, NODES), at).toEqual({ sheet: true, picker: true });
        await expect(list, at).toHaveCount(1);
        await expect(list.getByRole("option", { name: "studio-mac" }), at).toBeVisible();
        await expect(page.locator(NODES.picker), at).toHaveAttribute("aria-expanded", "true");
      }
    } finally {
      await b.close();
    }
  });

  test("Ask another agent, Search's field and a choice pushed in Settings are each as they were left", async ({
    browser,
  }) => {
    const b = await duoBed(browser, "466x678");
    const { page } = b;
    const walk = async (what: string, check: (at: string) => Promise<void>) => {
      for (const [width, height] of [...WALK, [466, 678] as const]) {
        const at = `${what} at ${width}x${height}`;
        await pose(page, width, height);
        await check(at);
      }
    };
    try {
      // The computer's agents can be asked by one another, so the session offers it.
      Object.assign(b.ss.machines[0]!, { ask: true, handoff: true });
      await approved(b);
      // Ask another agent, with what to ask half written.
      const HANDOFF = { sheet: "[data-handoff]", field: "[data-hs-text]" };
      const ask = "Check the notes against the merged PRs.";
      await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
      await page.getByRole("button", { name: "Ask another agent…" }).click();
      const field = page.locator(HANDOFF.field);
      await field.click();
      await field.fill(ask);
      await field.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(5, 5));
      await hold(page, HANDOFF);
      await walk("Ask another agent", async (at) => {
        expect(await same(page, HANDOFF), at).toEqual({ sheet: true, field: true });
        expect(await typing(page, HANDOFF.field), at).toEqual({ focused: true, caret: [5, 5], text: ask });
      });
      // Search, with a word in its field.
      const SEARCH = { field: ".sx-search input" };
      await page.goto(`${b.server.url}/search`);
      const search = page.locator(SEARCH.field);
      await search.click();
      await search.fill("webhook");
      await search.evaluate((t: HTMLInputElement) => t.setSelectionRange(3, 3));
      await hold(page, SEARCH);
      await walk("Search", async (at) => {
        expect(await same(page, SEARCH), at).toEqual({ field: true });
        expect(await typing(page, SEARCH.field), at).toEqual({ focused: true, caret: [3, 3], text: "webhook" });
      });
      // Settings › General › Mode: a choice pushed, as a phone pushes it.
      const SETTINGS = { settings: ".settings", picks: ".settings-picks" };
      await page.goto(`${b.server.url}/settings`);
      const settings = page.getByRole("dialog", { name: "Settings" });
      await settings.getByRole("tab", { name: "General" }).click();
      await settings.getByRole("button", { name: /^Mode:/ }).click();
      await expect(settings.locator(".settings-bar-title")).toHaveText("Mode");
      await hold(page, SETTINGS);
      await walk("Settings", async (at) => {
        expect(await same(page, SETTINGS), at).toEqual({ settings: true, picks: true });
        await expect(settings.locator(".settings-bar-title"), at).toHaveText("Mode");
        await expect(settings.getByRole("radio", { name: "Simple" }), at).toBeChecked();
      });
    } finally {
      await b.close();
    }
  });
});

test("a reply being read stays where it was under the bar as the phone is unfolded, turned and folded", async ({
  browser,
}) => {
  const b = await longOpen(browser, "466x678");
  const { page } = b;
  try {
    // The start of a reply, 260 pt under the bar: its message is the row at the reading
    // line, a third of the way down the view (lib/resizeAnchor.ts). Up from the end first,
    // so that the page knows the reader left it.
    const start = paragraph(page, 4, 1);
    await page.evaluate(() => window.scrollBy(0, -600));
    await putUnderBar(page, start, 260);
    for (const [width, height] of ROUND) {
      await pose(page, width, height);
      await staysUnderBar(start, 260, 24, `${width}x${height}`);
    }
    // The middle of a reply longer than the screen, with no message's start in sight: the
    // paragraph at the reading line holds the place.
    const middle = paragraph(page, 3, 4);
    await putUnderBar(page, middle, 180);
    for (const [width, height] of ROUND) {
      await pose(page, width, height);
      await staysUnderBar(middle, 180, 24, `${width}x${height}`);
    }
  } finally {
    await b.close();
  }
});

test("a session followed at its end is still followed after a turn and a fold, and the next reply shows", async ({
  browser,
}) => {
  const b = await longOpen(browser, "951x669");
  const { page } = b;
  try {
    for (const [width, height] of [
      [669, 951],
      [466, 678],
    ] as const) {
      await pose(page, width, height);
      await expect.poll(() => gapToEnd(page), { message: `${width}x${height}` }).toBeLessThanOrEqual(1);
    }
    const reply = "A reply that comes after the fold: the last line of it.";
    b.s.clock = Date.now();
    b.ss.push([
      b.s.ev("turn.started", { turn_id: "t9" }, LONG),
      b.s.ev(
        "turn.progress",
        { turn_id: "t9", user: "One more thing: is the dispute export covered?", assistant: reply },
        LONG,
      ),
    ]);
    // It is on screen, not under a pill that says there is something new below.
    await expect(page.getByText(reply).first()).toBeInViewport({ timeout: 30_000 });
    await expect.poll(() => gapToEnd(page)).toBeLessThanOrEqual(1);
    await expect(page.locator(".sess-new")).toHaveCount(0);
  } finally {
    await b.close();
  }
});

test("a session followed at its end and scrolled up a little stays where the reader put it when only the window's height changes", async ({
  browser,
}) => {
  // A browser's toolbar shows as a swipe up begins: the window is 56 pt shorter, as wide as
  // it was. Nothing rewraps, so nothing is the page's to put back: not even the end, which
  // the reader is still within reach of.
  const b = await longOpen(browser, "466x678");
  const { page } = b;
  const y = () => page.evaluate(() => Math.round(window.scrollY));
  const up = async (pt: number) => {
    await page.evaluate((d) => window.scrollBy(0, -d), pt);
    await frames(page, 4);
  };
  try {
    await up(30);
    const put = await y();
    await pose(page, 466, 678 - 56, DUO["466x678"]!.insets);
    expect(await y(), "after the window's height changed").toBe(put);
    await up(30);
    expect(await y(), "scrolled up again").toBe(put - 30);
    await frames(page, 10);
    expect(await y(), "ten frames later").toBe(put - 30);
  } finally {
    await b.close();
  }
});

test("a board scrolled to a row keeps that row in place as the phone is unfolded and turned", async ({ browser }) => {
  const b = await bedWith(browser, "466x678", manyRows(24));
  const { page } = b;
  try {
    // 231 pt from the top of the outer display, under its 45 pt bar. On the inner display
    // the bar is under the status bar, and a card's lines run further before they wrap.
    const row = page.locator("article.card").filter({ hasText: "Row 09:" });
    await expect(page.locator("article.card").filter({ hasText: "Row 20:" })).toBeAttached();
    await putUnderBar(page, row, 186);
    for (const [width, height] of ROUND) {
      await pose(page, width, height);
      await staysUnderBar(row, 186, 24, `${width}x${height}`);
    }
  } finally {
    await b.close();
  }
});

test("a board keeps the row being read where a card that came in above left it, as the phone is unfolded, turned and folded", async ({
  browser,
}) => {
  const b = await bedWith(browser, "466x678", manyRows(24));
  const { page } = b;
  try {
    const row = page.locator("article.card").filter({ hasText: "Row 09:" });
    await expect(page.locator("article.card").filter({ hasText: "Row 20:" })).toBeAttached();
    // A session starts, and its card comes in above. The list moves its rows down to make
    // room (lib/motion.ts useFlip); an engine may scroll the page to hold them still, at
    // once or as they move, and may not. So the place is tried as the engine leaves it,
    // then read while the rows are on their way (a scroll of the person's just then), then
    // with the page not scrolled at all.
    for (const [name, how] of [
      ["First", "as the engine has it"],
      ["Second", "scrolled as the rows move"],
      ["Third", "not scrolled"],
    ] as const) {
      await putUnderBar(page, row, 186);
      if (how === "scrolled as the rows move")
        await page.evaluate((title) => {
          const seen = new MutationObserver(() => {
            const cards = Array.from(document.querySelectorAll("article.card"));
            if (!cards.some((card) => card.textContent?.includes(title))) return;
            seen.disconnect();
            requestAnimationFrame(() => window.scrollBy(0, 1));
          });
          seen.observe(document.querySelector(".board-list")!, { childList: true, subtree: true });
        }, `${name}:`);
      if (how === "not scrolled") await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
      starts(b, name);
      await expect(page.locator("article.card").filter({ hasText: `${name}:` })).toBeAttached({ timeout: 30_000 });
      const left = await atRest(page, row);
      for (const [width, height] of ROUND) {
        await pose(page, width, height);
        await staysUnderBar(row, left, 24, `${how}, ${width}x${height}`);
      }
    }
  } finally {
    await b.close();
  }
});

test("a message opened in place and not scrolled since keeps its top as the phone is unfolded, turned and folded", async ({
  browser,
}) => {
  const b = await bedWith(browser, "466x678", planSession());
  const { page } = b;
  try {
    await page.goto(`${b.server.url}/s/claude-code/s-plan`);
    await expect(page.getByText(PLAN_REPLY_LAST).first()).toBeVisible();
    const message = page.locator(".chat-bubble").filter({ hasText: PLAN.first });
    const all = message.getByRole("button", { name: "Show all" });
    // Up from the end, to "Show all" 60 pt under the bar: the reply under the message is
    // what is at the reading line, and the place written down.
    await page.evaluate(() => window.scrollBy(0, -400));
    await putUnderBar(page, all, 60);
    await all.tap();
    await expect(message).toContainText(PLAN.last);
    // It opened downwards and fills the screen; that reply is a screen and more further
    // down, and nothing was scrolled.
    const top = await atRest(page, message);
    for (const [width, height] of ROUND) {
      await pose(page, width, height);
      await staysUnderBar(message, top, 24, `${width}x${height}`);
    }
  } finally {
    await b.close();
  }
});

test("the Inbox's prompt and Search's result stay in place as the phone is unfolded and turned", async ({
  browser,
}) => {
  const b = await bedWith(browser, "466x678", [...manyPrompts(14), ...manyRows(24)]);
  const { page } = b;
  try {
    await page.goto(`${b.server.url}/inbox`);
    const prompt = page.locator(".inbox-row").filter({ hasText: "Ask 06:" });
    await expect(page.locator(".inbox-row").filter({ hasText: "Ask 14:" })).toBeAttached();
    await putUnderBar(page, prompt, 186);
    for (const [width, height] of ROUND.slice(0, 3)) {
      await pose(page, width, height);
      await staysUnderBar(prompt, 186, 24, `Inbox, ${width}x${height}`);
    }
    await pose(page, 466, 678);
    await page.goto(`${b.server.url}/search`);
    await page.getByRole("combobox", { name: "Search" }).first().fill("tidy");
    const result = page.locator(".sx-row").filter({ hasText: "Row 09:" });
    await expect(page.locator(".sx-row").filter({ hasText: "Row 20:" })).toBeAttached();
    await putUnderBar(page, result, 186);
    for (const [width, height] of ROUND.slice(0, 3)) {
      await pose(page, width, height);
      await staysUnderBar(result, 186, 24, `Search, ${width}x${height}`);
    }
  } finally {
    await b.close();
  }
});

test("twelve folds and turns faster than the page settles keep the draft, the caret and the reading place", async ({
  browser,
}) => {
  const b = await longOpen(browser, "466x678");
  const { page } = b;
  try {
    const draft = "Check the refund export too.";
    await composer(page).click();
    await composer(page).fill(draft);
    await composer(page).evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(8, 8));
    const start = paragraph(page, 4, 1);
    await page.evaluate(() => window.scrollBy(0, -600));
    await putUnderBar(page, start, 260);
    const shapes = [
      [669, 951],
      [466, 678],
      [669, 951],
      [951, 669],
      [669, 951],
      [466, 678],
      [669, 951],
      [951, 669],
      [470, 669],
      [951, 669],
      [466, 678],
      [669, 951],
    ] as const;
    for (const [width, height] of shapes) await pose(page, width, height, undefined, false);
    // On the inner display, where the hand stopped, and folded once more.
    for (const [width, height] of [
      [669, 951],
      [466, 678],
    ] as const) {
      await pose(page, width, height);
      const at = `${width}x${height}`;
      await staysUnderBar(start, 260, 40, at);
      await expect(composer(page), at).toHaveValue(draft);
      await expect(composer(page), at).toBeFocused();
      expect(await composer(page).evaluate((t: HTMLTextAreaElement) => [t.selectionStart, t.selectionEnd]), at).toEqual(
        [8, 8],
      );
    }
  } finally {
    await b.close();
  }
});

test("New session's machine list stays open through an unfold, a turn and a fold, with its filter's text, the focus and the row it was on", async ({
  browser,
}) => {
  const b = await duoBed(browser, "466x678");
  const { page } = b;
  // Nine computers: enough for the list to have a filter, which is where the focus is.
  for (let i = 1; i <= 8; i++)
    b.ss.machines.push({ ...b.ss.machines[0]!, id: `m_build${i}0123456789abcde`, name: `build-0${i}` });
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    // A page opened after the approval knows of it.
    await page.reload();
    await page
      .getByRole("button", { name: /new session/i })
      .first()
      .click();
    const sheet = page.locator("[data-new-session]");
    await sheet.getByRole("combobox", { name: "Machine" }).click();
    const list = page.getByRole("listbox", { name: "Machine" });
    const filter = page.getByRole("textbox", { name: "Filter options" });
    const active = page.locator("[role=option].sel-opt--active");
    await expect(filter).toBeFocused();
    await filter.pressSequentially("build-0");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(active).toHaveText(/build-03/);
    // A sheet on the outer display, a pop-up under its button on the inner one, upright
    // and turned: one list.
    for (const [width, height, form] of [
      [669, 951, ".sel-pop"],
      [951, 669, ".sel-pop"],
      [466, 678, ".sel-sheet"],
    ] as const) {
      await pose(page, width, height);
      const at = `${width}x${height}`;
      await expect(page.locator(form), at).toBeVisible();
      await expect(list, at).toBeVisible();
      await expect(active, at).toHaveText(/build-03/);
      await expect(active, at).toBeInViewport();
      await expect(filter, at).toBeFocused();
      await expect(filter, at).toHaveValue("build-0");
      expect(await filter.getAttribute("aria-activedescendant"), at).toBe(await active.getAttribute("id"));
    }
    // The keys still move it, and Return picks.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(list).toHaveCount(0);
    await expect(sheet.getByRole("combobox", { name: "Machine" })).toHaveText(/build-04/);
  } finally {
    await b.close();
  }
});

test.describe("what duo.ts promises a test, in both engines", () => {
  /** A page of the made-up document at the outer display, with its bands. */
  const madeUp = async (browser: Parameters<typeof duoBed>[0]) => {
    const context = await browser.newContext({ viewport: { width: 466, height: 678 } });
    await insetsInit(context, DUO["466x678"]!.insets);
    const page = await context.newPage();
    await page.route("http://duo.test/", (route) => route.fulfill({ contentType: "text/html", body: MADE_UP }));
    await page.goto("http://duo.test/");
    return { context, page };
  };
  const atFirstScript = (page: Page) =>
    page.evaluate(() => (window as unknown as { atFirstScript: string[] }).atFirstScript);
  const px = (size: string) => DUO[size]!.insets.map((pt) => `${pt}px`);

  test("a page's first script reads the system's bands, and after a fold and a reload the new ones", async ({
    browser,
  }) => {
    const { context, page } = await madeUp(browser);
    try {
      expect(await atFirstScript(page)).toEqual(px("466x678"));
      await pose(page, 669, 951);
      await page.reload();
      expect(await atFirstScript(page)).toEqual(px("669x951"));
      // A document written into the open page has them once it is written. Its own first
      // script is not promised them: Chromium runs it before they are put on.
      await page.setContent(MADE_UP);
      expect(await shapeOf(page)).toEqual({ size: "669x951", insets: DUO["669x951"]!.insets });
    } finally {
      await context.close();
    }
  });

  test("the app's first frame is drawn inside the bands, where the app then stands", async ({ browser }) => {
    for (const size of ["669x951", "466x678"]) {
      const b = await duoBed(browser, size);
      const { page } = b;
      // index.html draws the first frame itself. The app's script is held back, so that
      // frame stays to be measured: the document is not read to its end while it waits.
      let letGo = () => {};
      const held = new Promise<void>((go) => {
        letGo = go;
      });
      await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
        await held;
        await route.continue().catch(() => {});
      });
      /** The bar and the tab bar, and the page's two sides: left, top, right, bottom. */
      const chrome = () =>
        page.evaluate(() => {
          const box = (sel: string) => {
            const r = document.querySelector(`.shell ${sel}`)!.getBoundingClientRect();
            return [r.left, r.top, r.right, r.bottom].map(Math.round);
          };
          const [left, , right] = box(".page");
          return { bar: box(".bar"), tabbar: box(".tabbar"), page: [left, right] };
        });
      try {
        await page.goto(b.server.url, { waitUntil: "commit" });
        await expect(page.locator(".boot")).toBeVisible();
        expect(await shapeOf(page), size).toEqual({ size, insets: DUO[size]!.insets });
        const first = await chrome();
        // Under the 32 pt on top the 45 pt bar ends at 77; beside the 84 pt at the side the
        // page ends a 16 pt gutter short of the band, at 366.
        if (size === "669x951") expect(first.bar[3]).toBe(77);
        if (size === "466x678") expect(first.page[1]).toBe(366);
        letGo();
        await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
        await expect(page.locator(".boot")).toHaveCount(0);
        expect(await chrome(), size).toEqual(first);
      } finally {
        letGo();
        await b.close();
      }
    }
  });

  test("a wide touch screen's first frame is the touch app's: the tab bar, and no sidebar the app would then take away", async ({
    browser,
  }) => {
    // The inner display turned, and a tablet on its side at the width a mouse window's
    // sidebar gets its labels (index.html draws that frame before the app's script runs).
    for (const size of ["951x669", "1280x800"]) {
      const b = await duoBed(browser, size);
      const { page } = b;
      let letGo = () => {};
      const held = new Promise<void>((go) => {
        letGo = go;
      });
      await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
        await held;
        await route.continue().catch(() => {});
      });
      /** The shell as drawn: which of the tab bar and the rail shows, whether it is marked
       *  as the labelled sidebar's, and where the page's bar and the tab bar stand. */
      const chrome = () =>
        page.evaluate(() => {
          const shell = document.querySelector(".shell")!;
          const shows = (sel: string) => (shell.querySelector(sel)?.getClientRects().length ?? 0) > 0;
          const box = (sel: string) => {
            const r = shell.querySelector(sel)!.getBoundingClientRect();
            return [r.left, r.top, r.right, r.bottom].map(Math.round);
          };
          return {
            tabbar: shows(".tabbar"),
            rail: shows(".rail"),
            side: shell.classList.contains("shell--side"),
            at: { bar: box(".bar"), tabbar: box(".tabbar") },
          };
        });
      try {
        await page.goto(b.server.url, { waitUntil: "commit" });
        await expect(page.locator(".boot")).toBeVisible();
        const first = await chrome();
        expect(first, size).toMatchObject({ tabbar: true, rail: false, side: false });
        letGo();
        await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
        await expect(page.locator(".boot")).toHaveCount(0);
        expect(await chrome(), size).toEqual(first);
      } finally {
        letGo();
        await b.close();
      }
    }
  });

  test("the measure tells a control held under a band from one that is clear, covered or passing", async ({
    browser,
  }) => {
    const { context, page } = await madeUp(browser);
    const html = () => page.evaluate(() => document.documentElement.outerHTML);
    try {
      const before = await html();
      // The outer display: a band at the side and the home indicator's. The row and the
      // head are under the indicator and scroll up from it; the foot is held there.
      expect(await bandOffenders(page)).toEqual(["fixed at the side", "fixed at the bottom", "a foot"]);
      // A measure: the page is as it was.
      expect(await html()).toBe(before);
      // The inner display, upright and read on: the side band is gone, there is one on top,
      // and the head is stuck under it.
      await pose(page, 669, 951);
      await page.evaluate(() => scrollTo(0, innerHeight * 1.5));
      await expect.poll(() => bandOffenders(page)).toEqual(["fixed at the bottom", "a head", "a foot"]);
      // At the page's end the foot is where its flow puts it, above the indicator; the last
      // row is under it, and nothing is left to scroll.
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await expect.poll(() => bandOffenders(page)).toEqual(["fixed at the bottom", "a head", "the last row"]);
      // A scrim over it all, as a sheet has round it: an empty button across the window.
      // What it covers takes no tap, and the scrim itself is the ground, not a control
      // someone aims at under a band. With a word on it, it is a button like any other.
      await page.evaluate(() => {
        const scrim = document.createElement("button");
        scrim.id = "scrim";
        scrim.setAttribute("aria-label", "Close");
        scrim.style.cssText = "position:fixed;inset:0;width:auto;height:auto;z-index:1";
        document.body.append(scrim);
      });
      await expect.poll(() => bandOffenders(page)).toEqual([]);
      await page.evaluate(() => {
        document.getElementById("scrim")!.textContent = "Close";
      });
      await expect.poll(() => bandOffenders(page)).toEqual(["Close"]);
      // With no band at all there is nothing to measure: that is said, not passed.
      await pose(page, 669, 951, [0, 0, 0, 0]);
      await expect(bandOffenders(page)).rejects.toThrow("no inset band");
    } finally {
      await context.close();
    }
  });
});
