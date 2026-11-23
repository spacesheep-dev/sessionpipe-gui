// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The iPhone app at the iPhone Duo's shapes (the `duo` project: a touch screen, 3x): the
// outer display 466×678, the inner one upright 669×951 and turned 951×669, a Split View
// half 470×669, each with the bands the system keeps (duo.ts). What holds at a shape is
// said here: the first run, the keyboard, a reply's lines, what a finger can copy, that
// the inner display turned (wider than the width at which a window with a mouse takes the
// Mac's layout) is still the touch app, with its own sidebar where the window has room and
// the tab bar where it has not, and that nothing a finger lands on is under a band,
// with the band at either side: those tests are tagged @webkit, and the `duo-webkit`
// project runs them in the iPhone's engine as well. What a page keeps as it moves from one
// shape to another is in duo-continuity.spec.ts, which runs in WebKit whole.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { Session } from "../events.js";
import {
  bandOffenders,
  coarsePointer,
  DUO,
  DUO_REPLY,
  DUO_SESSIONS,
  type DuoBed,
  duoBed,
  duoPlanSession,
  duoSession,
  fakeKeyboard,
  firstLineChars,
  hitSize,
  type Insets,
  insetsInit,
  pose,
  shapeOf,
} from "./duo.js";
import { png } from "./pictures.js";

const composer = (page: Page) => page.locator("textarea").first();
/** The inner display turned on its side, as the simulator gives it and as first estimated:
 *  both wider than the width a mouse window's layout changes at (lib/device.ts). */
const TURNED = ["951x669", "890x626"] as const;
/** A session whose reply has every kind of block: prose, a list, code and a table. */
const EXPORT = {
  title: "Resume the invoice export",
  user: "The nightly invoice export stops at batch 7 with a connection reset and then starts over from the first batch. Find out why, and make it go on from the batch that failed.",
  assistant: [
    "Batch 7 resets because the pooler drops a connection that sits idle for more than 30 seconds, and batch 7 is the first one large enough to spend that long building its file before it writes.",
    "- Each batch now takes a fresh connection and writes in pages of 100 invoices, so none sits idle long enough to be dropped.\n- A run that starts again goes on from the batch after the last one that finished.",
    "```ts\nfor (const batch of batches.slice(done + 1)) await withConnection((db) => writeBatch(db, batch));\n```",
    "| Batch | Invoices | Seconds building |\n| --- | --- | --- |\n| 6 | 500 | 12 |\n| 7 | 2400 | 41 |",
  ].join("\n\n"),
};

test.beforeAll(async ({ browser }) => {
  // A finger, at every width: what makes the inner display the touch app's and not a Mac's.
  expect(await coarsePointer(browser)).toBe(true);
});

test("insets given for one size are that size's alone: a page walked to another width leaves them behind, and has them back", async ({
  browser,
}) => {
  // account-screens.spec.ts is given the Duo's band for its own size and walks from 320 to
  // 1180 wide inside one test: a smaller iPhone has no such band.
  const outer = { width: 466, height: 678 };
  const band = DUO["466x678"]!.insets;
  const context = await browser.newContext({ viewport: outer });
  try {
    await insetsInit(context, band, outer);
    const page = await context.newPage();
    await page.goto("/");
    await expect.poll(() => shapeOf(page)).toEqual({ size: "466x678", insets: band });
    await page.setViewportSize({ width: 320, height: 568 });
    await expect.poll(() => shapeOf(page)).toEqual({ size: "320x568", insets: [0, 0, 0, 0] });
    await page.reload();
    await expect.poll(() => shapeOf(page)).toEqual({ size: "320x568", insets: [0, 0, 0, 0] });
    await page.setViewportSize(outer);
    await expect.poll(() => shapeOf(page)).toEqual({ size: "466x678", insets: band });
  } finally {
    await context.close();
  }
});

test("the first run keeps every control out from under the system's bands, on the outer display and on the inner one turned", async ({
  browser,
}) => {
  const step = (page: Page, name: string) => page.locator(`.onb[data-step='${name}']`);
  const button = (page: Page, name: string) => page.getByRole("button", { name });
  for (const [size, insets] of [
    ["466x678", DUO["466x678"]!.insets],
    // The outer display held the other way up: the band is on the left.
    ["466x678", [0, 0, 20, 84]],
    ["951x669", DUO["951x669"]!.insets],
  ] as [string, Insets][]) {
    const at = `${size} ${insets}`;
    const b = await duoBed(browser, size, { fresh: true, insets });
    const { page } = b;
    try {
      await page.goto(b.server.url);
      await expect(step(page, "welcome")).toBeVisible();
      expect(await shapeOf(page), at).toEqual({ size, insets });
      expect(await bandOffenders(page), `welcome ${at}`).toEqual([]);
      // Its disclosure, open: the welcome is then longer than the screen. What passes under
      // the home indicator on the way down is not held there, and the end stops above it.
      await button(page, "No sessionpipe on your computer yet?").click();
      const end = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      for (let y = 0; y < end + 12; y += 12) {
        await page.evaluate((top) => scrollTo(0, top), Math.min(y, end));
        expect(await bandOffenders(page), `welcome, opened and scrolled to ${Math.min(y, end)}, ${at}`).toEqual([]);
      }
      // An address to type, with Back in the bar.
      await button(page, "Enter an address").click();
      await expect(step(page, "address")).toBeVisible();
      expect(await bandOffenders(page), `address ${at}`).toEqual([]);
      await button(page, "Back").click();
      // The account's way in: what it is, then the number with Cancel in the bar.
      await button(page, "Use a spacesheep account").click();
      await expect(step(page, "account-intro")).toBeVisible();
      expect(await bandOffenders(page), `account-intro ${at}`).toEqual([]);
      await button(page, "Continue").click();
      await expect(step(page, "account-number")).toBeVisible();
      expect(await bandOffenders(page), `account-number ${at}`).toEqual([]);
      await button(page, "Cancel").click();
      await expect(step(page, "welcome")).toBeVisible();
      if (size === "466x678") {
        // The measure sees a control under a band when one is there: with the step's own
        // padding taken away, the welcome's buttons reach under the side band.
        await page.addStyleTag({ content: ".onb { padding: 0 !important; }" });
        expect(await bandOffenders(page), `unpadded ${at}`).toContain("Scan the code on your computer");
      }
    } finally {
      await b.close();
    }
  }
});

test("the keyboard up on the outer display: the page hears of it as WKWebView tells it, and the message field rides on the keys", async ({
  browser,
}) => {
  const b = await duoBed(browser, "466x678");
  const { page } = b;
  const kb = DUO["466x678"]!.kb;
  const said = () => page.evaluate(() => document.documentElement.style.getPropertyValue("--kb"));
  /** The docked strip's bottom edge, in the window. */
  const dock = () => page.locator(".sess-ctl").evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
    await expect(composer(page)).toBeEnabled();
    expect(await said()).toBe("");
    const down = await dock();
    await composer(page).focus();
    await fakeKeyboard(page, kb);
    // The window is as tall as it was; only what is left above the keys got shorter.
    expect(await page.evaluate(() => [innerHeight, Math.round(visualViewport!.height)])).toEqual([678, 678 - kb]);
    await expect.poll(said).toBe(`${kb}px`);
    await expect.poll(dock).toBe(678 - kb);
    await fakeKeyboard(page, 0);
    await expect.poll(said).toBe("");
    await expect.poll(dock).toBe(down);
    // A page not opened yet has nothing to raise it over: that is said, not let pass.
    await expect(fakeKeyboard(await b.context.newPage(), kb)).rejects.toThrow("no keyboard to move");
  } finally {
    await b.close();
  }
});

test("the message field keeps every key of a run typed faster than the page draws between them", {
  tag: "@webkit",
}, async ({ browser }) => {
  const b = await duoBed(browser, "466x678");
  const { page } = b;
  const typed = "Open a PR for the fix. Ask Sam to review it. Then deploy to production. ".repeat(3).trim();
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
    await expect(composer(page)).toBeEnabled();
    await composer(page).focus();
    // Each key as the engine gives it to the page (the field's text one letter longer, then
    // "input"), all of them in one task: no frame and no task of the page's comes between
    // two of them, as when keys come faster than the page gets a turn (a key held down, a
    // hardware keyboard, a run of input from a test). The state to read is the end of it.
    const said = await composer(page).evaluate((field: HTMLTextAreaElement, text) => {
      const errors: string[] = [];
      const heard = (e: ErrorEvent) => errors.push(e.message);
      addEventListener("error", heard);
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      try {
        for (const ch of text) {
          set.call(field, field.value + ch);
          field.setSelectionRange(field.value.length, field.value.length);
          field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
        }
      } finally {
        removeEventListener("error", heard);
      }
      return { value: field.value, errors };
    }, typed);
    expect(said).toEqual({ value: typed, errors: [] });
    // And the page has every one of them: drawn again, the field is still what was typed.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await expect(composer(page)).toHaveValue(typed);
  } finally {
    await b.close();
  }
});

test("a reply on the outer display and in Split View reads in lines of at most 75 characters", async ({ browser }) => {
  const b = await duoBed(browser, "466x678");
  const { page } = b;
  try {
    await page.goto(`${b.server.url}${DUO_SESSIONS.prompt}`);
    const reply = page.getByText(DUO_REPLY, { exact: true });
    await expect(reply).toBeVisible();
    for (const [width, height] of [
      [466, 678],
      [470, 669],
    ] as const) {
      await pose(page, width, height);
      const chars = await firstLineChars(reply);
      // It wraps (the reply is some 190 characters), into lines the eye can follow back.
      expect(chars, `${width}x${height}`).toBeGreaterThan(20);
      expect(chars, `${width}x${height}`).toBeLessThanOrEqual(75);
    }
  } finally {
    await b.close();
  }
});

test("a reply on the inner display, upright and turned, and on a tablet reads in lines of at most 75 characters", async ({
  browser,
}) => {
  // The widest of them, a tablet on its side, has room for any line: there it is 65 to 75.
  for (const [size, least] of [
    ["669x951", 20],
    ["951x669", 20],
    ["1180x820", 65],
  ] as const) {
    const b = await duoBed(browser, size);
    const { page } = b;
    try {
      await page.goto(`${b.server.url}${DUO_SESSIONS.prompt}`);
      const reply = page.getByText(DUO_REPLY, { exact: true });
      await expect(reply).toBeVisible();
      // In the page's own face: the one it stands in for until then is as wide only on the whole.
      await page.evaluate(() => document.fonts.ready);
      const chars = await firstLineChars(reply);
      expect(chars, size).toBeGreaterThanOrEqual(least);
      expect(chars, size).toBeLessThanOrEqual(75);
    } finally {
      await b.close();
    }
  }
});

test("on a wide touch screen a reply's prose stops at its measure from the column's leading edge, its code and its table keep the column, and the bubble stops at the same measure", async ({
  browser,
}) => {
  for (const size of ["951x669", "1180x820"]) {
    const b = await duoBed(browser, size);
    const { page } = b;
    try {
      await page.goto(`${b.server.url}${duoSession(b, "s-export", EXPORT)}`);
      const card = page.locator(".chat-card");
      await expect(card.locator(".md-table")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      /** A box's two sides, and how many of its own em it is wide. */
      const box = (sel: string) =>
        page.locator(sel).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, em: r.width / Number.parseFloat(getComputedStyle(el).fontSize) };
        });
      const column = await box(".chat-card");
      const para = await box(".chat-card .md > p");
      const list = await box(".chat-card .md > ul");
      // Prose: from where the column starts, to a measure that is narrower than the column.
      expect(para.left, size).toBe(column.left);
      expect(list.left, size).toBe(column.left);
      expect(para.right, size).toBeLessThan(column.right - 100);
      expect(list.right, size).toBe(para.right);
      const chars = await firstLineChars(page.locator(".chat-card .md > p"));
      expect(chars, size).toBeGreaterThanOrEqual(60);
      expect(chars, size).toBeLessThanOrEqual(75);
      // Code and a table are read across, not down: they keep the column.
      for (const wide of [".chat-card .md-pre", ".chat-card .md-table"]) {
        const got = await box(wide);
        expect([got.left, got.right], `${wide} at ${size}`).toEqual([column.left, column.right]);
      }
      // What the person wrote: on the column's far edge, no wider than the prose.
      const bubble = await box(".chat-bubble");
      expect(bubble.right, size).toBe(column.right);
      expect(bubble.em, size).toBeCloseTo(para.em, 1);
    } finally {
      await b.close();
    }
  }
});

test("on the inner display turned and on a tablet a plan waiting for its answer reads across its whole card: the reply's measure is not the plan's", async ({
  browser,
}) => {
  const plan = [
    "### Resume the export from the batch that failed",
    "Each batch takes a fresh connection and writes in pages of 100 invoices, so none of them sits idle long enough for the pooler to drop it, and a run that starts again goes on from the batch after the last one that finished.",
    "1. Keep the last finished batch in the export's own table.\n2. Start a run from the batch after it.",
  ].join("\n\n");
  // Where the card is wider than a reply's measure. Upright, the inner display's page is
  // narrower than that beside the sidebar, so there is nothing to tell apart.
  for (const size of ["951x669", "1180x820"]) {
    const b = await duoBed(browser, size);
    const { page } = b;
    try {
      await page.goto(`${b.server.url}${duoPlanSession(b, "s-plan-measure", plan)}`);
      const text = page.locator(".ctl-plan-text");
      await expect(text.locator("p").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const widths = await text.evaluate((md) => {
        const s = getComputedStyle(md);
        const inner = md.clientWidth - Number.parseFloat(s.paddingLeft) - Number.parseFloat(s.paddingRight);
        return {
          em: inner / Number.parseFloat(s.fontSize),
          blocks: Array.from(md.children).map((el) => Math.round(el.getBoundingClientRect().width - inner)),
        };
      });
      // A card wider than a reply's measure, and every block of the plan across all of it.
      expect(widths.em, size).toBeGreaterThan(34);
      expect(widths.blocks, size).toEqual(widths.blocks.map(() => 0));
    } finally {
      await b.close();
    }
  }
});

test("Copy beside a tool's input and on a block of code takes a finger on the outer display: 44 pt round a 24 pt glyph", async ({
  browser,
}) => {
  const b = await duoBed(browser, "466x678");
  const { page } = b;
  /** The room a finger has round the glyph, and a tap in it that is not on the glyph: `dx`
   *  pt out from its left edge, `dy` under its bottom one. */
  const tapBeside = async (name: string, dx: number, dy: number) => {
    const copy = page.getByRole("button", { name });
    await expect(copy, name).toBeVisible();
    const hit = await hitSize(copy);
    expect(hit.width, `${name}: ${JSON.stringify(hit)}`).toBeGreaterThanOrEqual(44);
    expect(hit.height, `${name}: ${JSON.stringify(hit)}`).toBeGreaterThanOrEqual(44);
    const glyph = (await copy.boundingBox())!;
    expect([glyph.width, glyph.height], name).toEqual([24, 24]);
    await expect(copy, name).not.toHaveClass(/icon-btn--done/);
    // A session keeps its end in sight while its page settles, so the button can move from
    // under a tap: one is tried until it lands where the button is.
    await expect(async () => {
      const at = (await copy.boundingBox())!;
      await page.touchscreen.tap(at.x - dx, at.y + at.height + dy);
      // The check it shows for a moment: the tap was its own.
      await expect(copy).toHaveClass(/icon-btn--done/, { timeout: 1_000 });
    }, name).toPass({ timeout: 15_000 });
  };
  try {
    const exported = duoSession(b, "s-export", EXPORT);
    // A tool's input: the turn's tools opened, then the tool.
    await page.goto(`${b.server.url}${DUO_SESSIONS.prompt}`);
    await page.locator(".chat-tools-sum").first().click();
    await page.locator(".tool--x > details > summary").first().click();
    await tapBeside("Copy input", 6, 6);
    // A block of code in a reply: its well cuts off what leaves it, so the room is inside.
    await page.goto(`${b.server.url}${exported}`);
    await tapBeside("Copy code", 12, 12);
  } finally {
    await b.close();
  }
});

test("the inner display turned is the touch app still: its own sidebar, one sentence on a prompt it cannot answer yet, and none of a Mac's words in New session or a row's menu", async ({
  browser,
}) => {
  for (const size of TURNED) {
    const b = await duoBed(browser, size);
    const { page } = b;
    try {
      await page.goto(b.server.url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
      // The touch app's sidebar (its rows a finger's, named), not a Mac's icon rail.
      await expect(page.locator("nav.rail"), size).toBeVisible();
      await expect(page.locator("nav.tabbar"), size).toBeHidden();
      await expect(page.locator(".shell--side"), size).toHaveCount(0);
      await expect(page.locator("nav.rail").getByRole("link", { name: "Board" }), size).toBeVisible();
      // Not approved yet. The prompt's card says so in one sentence with the one way on: no
      // message field that would only refuse, and no second "Approve this iPhone" under it.
      await page.goto(`${b.server.url}${DUO_SESSIONS.prompt}`);
      await expect(page.locator(".ctl-answer").getByText("This iPhone can't answer yet."), size).toBeVisible();
      await expect(page.getByRole("link", { name: "Approve this iPhone" }), size).toHaveCount(1);
      await expect(page.getByText("Approve this iPhone"), size).toHaveCount(1);
      await expect(page.locator("textarea"), size).toHaveCount(0);
      // Approved: New session is the phone's form. Nothing is said while all is well, and
      // Start is a word, with no key beside it.
      await b.approve();
      await page.goto(b.server.url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
      await page.getByRole("button", { name: "New session" }).click();
      const sheet = page.getByRole("dialog", { name: "New session" });
      await sheet.locator("[data-ns-text]").fill("Look around.");
      await expect(sheet.locator("[data-ns-start]"), size).toBeEnabled();
      await expect(sheet.locator("[data-ns-start]"), size).toHaveText("Start");
      await expect(sheet.locator(".ns-status"), size).toHaveText("");
      await expect(sheet, size).not.toContainText("⌘");
      await expect(sheet, size).not.toContainText("is listening.");
      await sheet.getByRole("button", { name: "Discard draft" }).click();
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(sheet).toHaveCount(0);
      // A row held down: a preview, and nothing that needs a second window or a panel beside.
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
      await expect(page.getByRole("menuitem", { name: "Preview", exact: true }), size).toBeVisible();
      const items = await page.getByRole("menuitem").allInnerTexts();
      for (const mac of ["Open in new window", "Open in background tab", "Open beside"])
        expect(items, `${size}: ${mac}`).not.toContain(mac);
    } finally {
      await b.close();
    }
  }
});

test("the inner display turned: the message field rides on the keyboard, as on the outer display", async ({
  browser,
}) => {
  for (const size of TURNED) {
    const b = await duoBed(browser, size);
    const { page } = b;
    const [, height] = size.split("x").map(Number) as [number, number];
    const kb = DUO[size]!.kb;
    /** The docked strip's bottom edge, and the field's, in the window. */
    const edges = () =>
      page.evaluate(() =>
        [".sess-ctl", ".sess-ctl textarea"].map((sel) =>
          Math.round(document.querySelector(sel)!.getBoundingClientRect().bottom),
        ),
      );
    try {
      await page.goto(b.server.url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
      await b.approve();
      await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
      await expect(composer(page)).toBeEnabled();
      const [down] = await edges();
      await composer(page).focus();
      await fakeKeyboard(page, kb);
      // The strip stands on the keys, and the field in it is above them.
      await expect.poll(async () => (await edges())[0], size).toBe(height - kb);
      expect((await edges())[1], size).toBeLessThanOrEqual(height - kb);
      await fakeKeyboard(page, 0);
      await expect.poll(async () => (await edges())[0], size).toBe(down);
    } finally {
      await b.close();
    }
  }
});

/** The bottom of `el` in the window, and whether it is drawn. */
const bottomOf = (el: Locator) => el.evaluate((node) => Math.round(node.getBoundingClientRect().bottom));

/** The outer display's bed with Ask another agent… offered on its computer, and the
 *  keyboard down. */
async function outerBed(browser: Browser): Promise<DuoBed> {
  const b = await duoBed(browser, "466x678");
  Object.assign(b.ss.machines[0]!, { ask: true, handoff: true });
  return b;
}
const OUTER_ABOVE = 678 - DUO["466x678"]!.kb;

test("the keyboard up on the outer display: the composer and Send stay above it, and Ask another agent… folds away until it goes", {
  tag: "@webkit",
}, async ({ browser }) => {
  const b = await outerBed(browser);
  const { page } = b;
  const ask = page.getByRole("button", { name: "Ask another agent…" });
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
    await expect(composer(page)).toBeEnabled();
    await expect(ask).toBeVisible();
    await composer(page).focus();
    await fakeKeyboard(page, DUO["466x678"]!.kb);
    await expect(ask).toBeHidden();
    expect(await bottomOf(composer(page))).toBeLessThanOrEqual(OUTER_ABOVE);
    expect(await bottomOf(page.getByRole("button", { name: "Send" }))).toBeLessThanOrEqual(OUTER_ABOVE);
    await composer(page).blur();
    await fakeKeyboard(page, 0);
    await expect(ask).toBeVisible();
  } finally {
    await b.close();
  }
});

test("the keyboard up on the outer display: Search folds its large title and chips away, says Search in its bar, and shows three results whole above the keys", {
  tag: "@webkit",
}, async ({ browser }) => {
  const b = await outerBed(browser);
  const { page } = b;
  // Three sessions a search finds by a word of their own, and nothing else does.
  for (const n of [1, 2, 3])
    duoSession(b, `s-kumquat-${n}`, {
      title: `Kumquat import ${n}`,
      user: `Fix the kumquat import, part ${n}.`,
      assistant: `Done with part ${n}.`,
    });
  const rows = page.locator(".sx-list .sx-item");
  const large = page.locator(".sx--phone .bar-large");
  const chips = page.locator(".sx--phone .sx-filters");
  try {
    await page.goto(`${b.server.url}/search`);
    await page.getByRole("combobox", { name: /^Search prompts/ }).fill("kumquat");
    await expect(rows).toHaveCount(3);
    await fakeKeyboard(page, DUO["466x678"]!.kb);
    await expect(large).toBeHidden();
    await expect(chips).toBeHidden();
    await expect(page.locator(".sx--phone .bar-title")).toHaveCSS("opacity", "1");
    await expect
      .poll(() =>
        rows.evaluateAll((all, at) => all.filter((r) => r.getBoundingClientRect().bottom <= at).length, OUTER_ABOVE),
      )
      .toBeGreaterThanOrEqual(3);
    await fakeKeyboard(page, 0);
    await expect(large).toBeVisible();
    await expect(chips).toBeVisible();
  } finally {
    await b.close();
  }
});

test("the keyboard up on the outer display: New session's message and the sentence its status line says come up above the keys, under the sheet's bar", {
  tag: "@webkit",
}, async ({ browser }) => {
  const b = await outerBed(browser);
  const { page } = b;
  const ns = page.locator("[data-new-session]");
  const text = ns.locator("[data-ns-text]");
  const status = ns.locator(".ns-status");
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    // Its computer is away: the status line has a sentence to keep in sight.
    b.ss.machines[0]!.online = false;
    await page.reload();
    await page.getByRole("button", { name: "New session" }).click();
    await expect(status).toContainText("is offline");
    await settled(page);
    expect(await bottomOf(status)).toBeGreaterThan(OUTER_ABOVE);
    await text.click();
    await fakeKeyboard(page, DUO["466x678"]!.kb);
    await expect.poll(() => bottomOf(status)).toBeLessThanOrEqual(OUTER_ABOVE);
    expect(await bottomOf(text)).toBeLessThanOrEqual(OUTER_ABOVE);
    const bar = await bottomOf(ns.locator(".ns-bar"));
    expect(await text.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(bar);
  } finally {
    await b.close();
  }
});

test("the keyboard up on the inner display turned: the strip stands on the keys, and New session's form sheet ends above them with Start in sight", {
  tag: "@webkit",
}, async ({ browser }) => {
  const b = await duoBed(browser, "951x669");
  const { page } = b;
  const kb = DUO["951x669"]!.kb;
  const above = 669 - kb;
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
    await expect(composer(page)).toBeEnabled();
    await composer(page).focus();
    await fakeKeyboard(page, kb);
    await expect.poll(() => bottomOf(page.locator(".sess-ctl"))).toBe(above);
    await composer(page).blur();
    await fakeKeyboard(page, 0);

    // From the Board, with no session page under it.
    await page.goto(b.server.url);
    await page.locator("nav.rail .rail-compose").click();
    const ns = page.locator("[data-new-session]");
    await settled(page);
    await ns.locator("[data-ns-text]").click();
    await fakeKeyboard(page, kb);
    await expect.poll(() => bottomOf(ns)).toBeLessThanOrEqual(above);
    const start = ns.getByRole("button", { name: "Start" });
    await expect(start).toBeVisible();
    expect(await bottomOf(start)).toBeLessThanOrEqual(above);
    await fakeKeyboard(page, 0);
  } finally {
    await b.close();
  }
});

test("on a taller phone the keyboard folds nothing away: Ask another agent… stays under the composer", {
  tag: "@webkit",
}, async ({ browser }) => {
  const b = await duoBed(browser, "393x852");
  const { page } = b;
  const ask = page.getByRole("button", { name: "Ask another agent…" });
  try {
    Object.assign(b.ss.machines[0]!, { ask: true, handoff: true });
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
    await expect(composer(page)).toBeEnabled();
    await composer(page).focus();
    await fakeKeyboard(page, 336);
    await expect(page.locator("html")).toHaveAttribute("data-kb", "");
    await expect(ask).toBeVisible();
    expect(await bottomOf(ask)).toBeLessThanOrEqual(852 - 336);
  } finally {
    await b.close();
  }
});

test("Ask another agent dims the whole window on the inner display turned and on a tablet on its side: no session takes a tap beside it", async ({
  browser,
}) => {
  // Wider than the docked strip's measure (760 px): the sheet is not held to the strip it
  // is opened from. With room it is a form sheet over a dim from one edge of the window to
  // the other.
  for (const size of ["951x669", "1180x820"]) {
    const b = await duoBed(browser, size);
    const { page } = b;
    const [width] = size.split("x").map(Number) as [number, number];
    try {
      Object.assign(b.ss.machines[0]!, { ask: true, handoff: true });
      await page.goto(b.server.url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
      await b.approve();
      await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
      await page.getByRole("button", { name: "Ask another agent…" }).click();
      const sheet = page.locator("[data-handoff]");
      await expect(sheet.locator("[data-hs-text]")).toBeVisible();
      const dim = await page.locator(".ns-scrim--form").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return [r.left, r.right];
      });
      expect(dim, size).toEqual([0, width]);
    } finally {
      await b.close();
    }
  }
});

/** The windows with room (lib/device.ts sizeClass "regular"): the inner display upright,
 *  turned with the band on the right and on the left, and an iPad on its side (its status
 *  bar and home indicator, as estimated). */
const REGULAR: [size: string, insets: Insets][] = [
  ["669x951", DUO["669x951"]!.insets],
  ["951x669", DUO["951x669"]!.insets],
  ["951x669", [0, 0, 20, 84]],
  ["1180x820", [24, 0, 20, 0]],
];

/** The sidebar's rows as they show, top to bottom: each one's name, height and top. */
const sidebarRows = (page: Page) =>
  page.locator("nav.rail .nav-link").evaluateAll((els) =>
    els
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.querySelector(".nav-label")?.textContent ?? "", height: r.height, top: r.top };
      }),
  );

for (const [size, insets] of REGULAR) {
  const where = `${size} [${insets}]`;
  test(`with room, at ${where}, the pages are a labelled sidebar: the tab bar's and More's, rows a finger takes, New session at its head`, async ({
    browser,
  }) => {
    const b = await duoBed(browser, size, { insets });
    const { page } = b;
    try {
      await page.goto(b.server.url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
      await expect(page.locator("html"), where).toHaveAttribute("data-size-class", "regular");
      await expect(page.locator("nav.rail"), where).toBeVisible();
      await expect(page.locator("nav.tabbar"), where).toBeHidden();
      // What the tab bar and then More list, in their order, Display and Settings last
      // (an account has no Workflows).
      const rows = await sidebarRows(page);
      expect(
        rows.map((r) => r.name),
        where,
      ).toEqual(["Board", "Inbox", "Search", "Machines", "Usage", "Display", "Settings"]);
      for (const r of rows) expect(r.height, `${r.name}, ${where}`).toBeGreaterThanOrEqual(44);
      expect(rows.map((r) => r.top)).toEqual([...rows.map((r) => r.top)].sort((x, y) => x - y));
      // The Inbox's count: the sample's one prompt, as the tab bar says it.
      const inbox = page.locator("nav.rail [data-nav='inbox']");
      await expect(inbox.locator(".nav-badge"), where).toHaveText("1");
      await expect(inbox, where).toHaveAccessibleName(/1 needs you/);
      // No tooltip on a row, and none of a Mac's small buttons at its foot.
      await expect(page.locator("nav.rail .nav-link[data-tip]"), where).toHaveCount(0);
      await expect(page.locator("nav.rail .rail-foot .theme-btn:visible"), where).toHaveCount(0);
      // The head starts under the status bar, as tall as the page's bar; the page's bar has
      // no New session of its own.
      const [top, right, , left] = insets;
      const head = await page.locator("nav.rail .rail-head").evaluate((el) => ({
        top: el.getBoundingClientRect().top,
        pad: Number.parseFloat(getComputedStyle(el).paddingTop),
      }));
      expect(head, where).toEqual({ top: 0, pad: top });
      const compose = page.locator("nav.rail .rail-compose");
      expect((await compose.boundingBox())!.y, where).toBeGreaterThanOrEqual(top);
      expect(await hitSize(compose), where).toEqual({ width: 44, height: 44 });
      // The mark is a link to the Board, and a finger's too.
      const brand = await hitSize(page.locator("nav.rail .rail-brand"));
      expect(brand.width, where).toBeGreaterThanOrEqual(44);
      expect(brand.height, where).toBeGreaterThanOrEqual(44);
      await expect(page.locator(".compose-btn--phone"), where).toBeHidden();
      // The sidebar keeps clear of the band at the left, and the page beside it has its gutter.
      // The head's mark stands over the rows' glyphs.
      const sides = await page.evaluate(() => {
        const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        return {
          rail: box("nav.rail").right,
          glyph: box("nav.rail .nav-glyph").left,
          mark: box("nav.rail .rail-brand .mark").left,
          title: box(".bar-large").left,
        };
      });
      expect(sides.glyph, where).toBeGreaterThanOrEqual(left + 8);
      expect(sides.mark, where).toBe(sides.glyph);
      expect(sides.rail, where).toBe(220 + left);
      // The page's column (styles/regular.css): 672 pt at most, in the middle of what is
      // beside the sidebar.
      const room = Number(size.split("x")[0]) - sides.rail - 16 - (16 + right);
      expect(sides.title, where).toBe(sides.rail + 16 + Math.max(0, (room - 672) / 2));
      if (top || right || left) expect(await underBands(page), where).toEqual([]);
      // New session opens from the head, Display from the foot, Settings beside it.
      await compose.click();
      const sheet = page.getByRole("dialog", { name: "New session" });
      await expect(sheet, where).toBeVisible();
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(sheet).toHaveCount(0);
      await page.locator("nav.rail").getByRole("button", { name: "Display" }).click();
      await expect(page.getByRole("dialog", { name: "Quick settings" }), where).toBeVisible();
      if (top || right || left) expect(await underBands(page), `Display, ${where}`).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Quick settings" })).toHaveCount(0);
      const settings = page.locator("nav.rail").getByRole("link", { name: "Settings" });
      await settings.click();
      await expect(page.getByRole("dialog", { name: "Settings" }), where).toBeVisible();
      await expect(settings).toHaveAttribute("aria-expanded", "true");
    } finally {
      await b.close();
    }
  });
}

test("the outer display and a Split View half keep the tab bar; More or Display left open there is closed by an unfold, and stays closed when folded again", async ({
  browser,
}) => {
  const b = await duoBed(browser, "466x678");
  const { page } = b;
  const tabbar = page.locator("nav.tabbar");
  const more = tabbar.getByRole("button", { name: "More", exact: true });
  const sheet = page.getByRole("dialog", { name: "More" });
  const display = page.getByRole("dialog", { name: "Quick settings" });
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    for (const [w, h] of [
      [470, 669],
      [466, 678],
    ] as const) {
      await pose(page, w, h);
      await expect(page.locator("html"), `${w}x${h}`).toHaveAttribute("data-size-class", "compact");
      await expect(tabbar, `${w}x${h}`).toBeVisible();
      await expect(page.locator("nav.rail"), `${w}x${h}`).toBeHidden();
    }
    // What the tab bar and More list folded is what the sidebar lists unfolded.
    const tabs = await tabbar.locator("a.nav-link .nav-label").allInnerTexts();
    await more.click();
    await expect(sheet).toBeVisible();
    const inMore = await sheet.locator(".more-row-name").allInnerTexts();
    await pose(page, 669, 951);
    await expect(page.locator("nav.rail")).toBeVisible();
    await expect(sheet).toHaveCount(0);
    expect((await sidebarRows(page)).map((r) => r.name)).toEqual([...tabs, ...inMore]);
    await pose(page, 466, 678);
    await expect(tabbar).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(sheet).toHaveCount(0);
    // Display, opened from More, the same.
    await more.click();
    await sheet.getByRole("button", { name: "Display" }).click();
    await expect(display).toBeVisible();
    // Folded, it is the phone's sheet: from one side of the window to the other.
    await settled(page);
    const folded = await boxOf(display);
    expect([folded.left, folded.right]).toEqual([0, 466]);
    await pose(page, 669, 951);
    await expect(display).toHaveCount(0);
    await pose(page, 466, 678);
    await expect(tabbar).toBeVisible();
    await expect(display).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
  } finally {
    await b.close();
  }
});

test("with room, the palette's Display settings opens Display from the sidebar: no More sheet opens out of sight, to come back on a fold", async ({
  browser,
}) => {
  const b = await duoBed(browser, "1180x820", { insets: [24, 0, 20, 0] });
  const { page } = b;
  const more = page.locator("nav.tabbar [data-nav='more']");
  const sheet = page.getByRole("dialog", { name: "More" });
  const display = page.getByRole("dialog", { name: "Quick settings" });
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-size-class", "regular");
    // A tablet's hardware keyboard.
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.keyboard.type("Display settings");
    await palette.locator(".pal-row").filter({ hasText: "Display settings" }).first().click();
    await expect(display).toBeVisible();
    await expect(page.locator("nav.rail [data-nav='display']")).toHaveAttribute("aria-expanded", "true");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(sheet).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(display).toHaveCount(0);
    // Folded: the tab bar is back, and nothing opens with it.
    await pose(page, 466, 678);
    await expect(page.locator("nav.tabbar")).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(sheet).toHaveCount(0);
    await expect(display).toHaveCount(0);
  } finally {
    await b.close();
  }
});

/** Once every animation that ends has ended: a sheet on its way up is not yet where it stays. */
const settled = (page: Page) =>
  page.evaluate(async () => {
    const moving = document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.allSettled(moving.map((a) => a.finished));
  });
/** A box as the page has it: its left, right, top and bottom, and its width. */
const boxOf = (l: Locator) =>
  l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  });
/** Whether any of these is drawn: a grabber hidden by its stylesheet is in the page still. */
const grabbers = (page: Page) =>
  page
    .locator(".ns-grab, .menu-grab, .qs-grab")
    .evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).length);

const ROOM: [size: string, insets: Insets][] = [...REGULAR, ["820x1180", [24, 0, 20, 0]]];
for (const [size, insets] of ROOM) {
  const where = `${size} [${insets}]`;
  test(`with room, at ${where}, New session and Ask another agent are a centred form sheet, a row's menu, Display and the Feed's Filter float as cards beside the sidebar, and a Select is a pop-up`, {
    tag: "@webkit",
  }, async ({ browser }) => {
    test.setTimeout(90_000);
    const b = await duoBed(browser, size, { insets });
    const { page } = b;
    const [width, height] = size.split("x").map(Number) as [number, number];
    const [top, right, bottom, left] = insets;
    /** The middle of what the system leaves of the width. */
    const middle = (left + width - right) / 2;
    const formSheet = async (sheet: Locator, what: string) => {
      await settled(page);
      const box = await boxOf(sheet);
      expect(box.width, what).toBeLessThanOrEqual(540);
      expect(Math.abs((box.left + box.right) / 2 - middle), what).toBeLessThanOrEqual(1);
      expect(box.top, what).toBeGreaterThanOrEqual(top + 40);
      // Over a dim from one side of the window to the other, which takes a tap off the page.
      const dim = await boxOf(page.locator(".ns-scrim--form"));
      expect([dim.left, dim.right, dim.top, dim.bottom], what).toEqual([0, width, 0, height]);
      expect(await grabbers(page), what).toBe(0);
      if (top || right || left) expect(await underBands(page), what).toEqual([]);
      // The card ends 16 pt under the last thing it shows: no empty band under it.
      const foot = await sheet.evaluate((el) => {
        const shown = Array.from(el.querySelectorAll(".ns-scroll > .ns-group, .ns-group-foot > *")).filter(
          (c) => c.getBoundingClientRect().height > 0,
        );
        return el.getBoundingClientRect().bottom - shown.at(-1)!.getBoundingClientRect().bottom;
      });
      expect(foot, what).toBe(16);
    };
    /** A floating card: in the middle of the page beside the sidebar (never over the
     *  sidebar, 24 pt clear of it at least), over a dim of the whole window, sidebar
     *  included. `dim` is its dim. */
    const card = async (el: Locator, dim: Locator, what: string) => {
      await settled(page);
      const box = await boxOf(el);
      const side = await boxOf(page.locator("nav.rail"));
      expect(box.width, what).toBeLessThanOrEqual(400);
      expect(Math.abs((box.left + box.right) / 2 - (side.right + width - right) / 2), what).toBeLessThanOrEqual(1);
      expect(box.left, what).toBeGreaterThanOrEqual(side.right + 24 - 1);
      expect(box.right, what).toBeLessThanOrEqual(width - right - 24 + 1);
      expect(box.bottom, what).toBeLessThanOrEqual(height - bottom - 16);
      const d = await boxOf(dim);
      expect([d.left, d.right, d.top, d.bottom], what).toEqual([0, width, 0, height]);
      expect(await grabbers(page), what).toBe(0);
      if (top || right || left) expect(await underBands(page), what).toEqual([]);
      return side;
    };
    try {
      Object.assign(b.ss.machines[0]!, { ask: true, handoff: true });
      await page.goto(b.server.url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeAttached();
      // Not approved yet: New session is its sentence and its one button at the top of the
      // card, and the card ends under the button.
      await page.locator("nav.rail .rail-compose").click();
      const unapproved = page.locator("[data-new-session]");
      await expect(unapproved.locator(".ns-empty [data-ns-approve]")).toBeVisible();
      await settled(page);
      const gaps = await unapproved.evaluate((el) => {
        const r = (sel: string) => el.querySelector(sel)!.getBoundingClientRect();
        return {
          above: r(".ns-empty .state-title").top - r(".ns-bar").bottom,
          below: el.getBoundingClientRect().bottom - r(".ns-empty [data-ns-approve]").bottom,
        };
      });
      expect(gaps.above, `unapproved, ${where}`).toBeLessThanOrEqual(48);
      expect(gaps.below, `unapproved, ${where}`).toBeLessThanOrEqual(48);
      await unapproved.locator("[data-ns-cancel]").click();
      await expect(unapproved).toHaveCount(0);
      await b.approve();
      await page.reload();
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeAttached();
      await expect(page.locator("html"), where).toHaveAttribute("data-size-class", "regular");

      // New session: its machine's list is a pop-up under its button, over the sheet.
      await page.locator("nav.rail .rail-compose").click();
      const ns = page.locator("[data-new-session]");
      await expect(ns.locator("[data-ns-text]")).toBeVisible();
      await formSheet(ns, `New session, ${where}`);
      await ns.locator("[data-ns-row=machine] button").click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await expect(page.locator(".sel-pop"), where).toBeVisible();
      await expect(page.locator(".sel-sheet, .sel-scrim"), where).toHaveCount(0);
      // Its own machine, picked again, closes it (a tap: WebKit gives a tapped button no
      // focus, so a key would go to the sheet).
      await page
        .getByRole("listbox")
        .getByRole("option", { name: /studio-mac/ })
        .click();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(ns).toBeVisible();
      await ns.getByRole("button", { name: "Cancel" }).click();
      await expect(ns).toHaveCount(0);

      // Display, from the sidebar's foot.
      await page.locator("nav.rail").getByRole("button", { name: "Display" }).click();
      const display = page.getByRole("dialog", { name: "Quick settings" });
      await expect(display).toBeVisible();
      const side = await card(display, page.locator(".qs-scrim"), `Display, ${where}`);
      // A tap on the dim over the sidebar puts it away, and opens no page under it.
      const before = page.url();
      await page.mouse.click((side.left + side.right) / 2, side.top + (side.bottom - side.top) / 3);
      await expect(display).toHaveCount(0);
      expect(page.url(), where).toBe(before);

      // A row held down: its menu is a card. (Last on the board: the finger's lift that
      // the menu swallows never comes from a test.)
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
      await expect(page.getByRole("menuitem", { name: "Preview", exact: true })).toBeVisible();
      await card(page.locator(".menu-sheet"), page.locator(".menu-scrim"), `a row's menu, ${where}`);
      await page.keyboard.press("Escape");
      await expect(page.locator(".menu-sheet")).toHaveCount(0);

      // A picker: the Feed's Filter, its machines and agents (in Pro, where the Feed is).
      await page.evaluate(() => {
        const key = "sessionpipe-gui.settings";
        localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), mode: "pro" }));
      });
      await page.goto(`${b.server.url}/feed`);
      await page.locator(".filter-btn").click();
      await expect(page.getByRole("menuitemradio", { name: "All machines" })).toBeVisible();
      await card(page.locator(".menu-sheet"), page.locator(".menu-scrim"), `the Feed's Filter, ${where}`);
      await page.mouse.click((side.left + side.right) / 2, side.top + (side.bottom - side.top) / 3);
      await expect(page.locator(".menu-sheet")).toHaveCount(0);
      expect(new URL(page.url()).pathname, where).toBe("/feed");

      // Settings covers the sidebar: a card over it (a confirm from one of its sections)
      // stands in the middle of what the system leaves, as the form sheet does. Measured
      // on a card put there by hand: no section here asks before it acts.
      await page.locator("nav.rail").getByRole("link", { name: "Settings" }).click();
      await expect(page.locator(".settings-wrap")).toBeVisible();
      const over = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "menu-sheet";
        probe.style.cssText = "height:100px;animation:none";
        document.body.append(probe);
        const r = probe.getBoundingClientRect();
        probe.remove();
        return { left: r.left, right: r.right };
      });
      expect(over.right - over.left, where).toBeLessThanOrEqual(400);
      expect(Math.abs((over.left + over.right) / 2 - middle), where).toBeLessThanOrEqual(1);
      await page.keyboard.press("Escape");
      await expect(page.locator(".settings-wrap")).toHaveCount(0);

      // Ask another agent, from a session.
      await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
      await page.getByRole("button", { name: "Ask another agent…" }).click();
      const hs = page.locator("[data-handoff]");
      await expect(hs.locator("[data-hs-text]")).toBeVisible();
      await formSheet(hs, `Ask another agent, ${where}`);
      // With the keys up, it ends above them.
      await hs.locator("[data-hs-text]").click();
      await fakeKeyboard(page, 300);
      await expect.poll(async () => (await boxOf(hs)).bottom, where).toBeLessThanOrEqual(height - 300);
      await fakeKeyboard(page, 0);
      // A tap on the dim puts it away.
      await page.mouse.click(left + 8, height - bottom - 8);
      await expect(hs).toHaveCount(0);
    } finally {
      await b.close();
    }

    // "You're in": a card of at most 440 pt in the middle of what the system leaves of the
    // width, as the form sheet is.
    const fresh = await duoBed(browser, size, { fresh: true, insets });
    try {
      fresh.hub.add("me@example.com", fresh.ss.key, Date.parse("2026-11-03T09:00:00Z"));
      await fresh.page.goto(fresh.server.url);
      const sheet = fresh.page.locator("[data-first-run='phone']");
      await expect(sheet.getByRole("button", { name: "Approve this iPhone" })).toBeVisible();
      await expect
        .poll(async () => {
          const box = await boxOf(sheet);
          return box.width <= 440 && Math.abs((box.left + box.right) / 2 - middle) <= 1;
        }, `You're in, ${where}`)
        .toBe(true);
      expect(await grabbers(fresh.page), where).toBe(0);
    } finally {
      await fresh.close();
    }
  });
}

/** The entrance of the sheet `sheet` held still `part` of the way up (its animation running
 *  at no speed): a tap in its first moment, made a state to wait in. */
const holdRise = (sheet: Locator, part: number) =>
  sheet.evaluate((el, at) => {
    const rise = el.getAnimations().find((a) => a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY);
    if (!rise) throw new Error("the sheet has no entrance");
    rise.playbackRate = 0;
    rise.currentTime = Number(rise.effect!.getComputedTiming().endTime) * at;
    return el.getBoundingClientRect().top;
  }, part);
/** The entrance of `sheet` goes on at its own speed. */
const letRise = (sheet: Locator) =>
  sheet.evaluate((el) => {
    for (const a of el.getAnimations()) a.playbackRate = 1;
  });
/** How far under its button the open pop-up list stands, in pt (6: where it opens). */
const listUnder = (button: Locator) =>
  button.evaluate((b) => {
    const pop = document.querySelector(".sel-pop:not(.sel-pop--above)");
    return pop ? Math.round(pop.getBoundingClientRect().top - b.getBoundingClientRect().bottom) : null;
  });

for (const [size, insets] of [
  ["669x951", DUO["669x951"]!.insets],
  ["820x1180", [24, 0, 20, 0]],
] as [string, Insets][]) {
  test(`with room, at ${size}, a Select opened while its sheet still rises stands under its button once the sheet is up`, {
    tag: "@webkit",
  }, async ({ browser }) => {
    test.setTimeout(60_000);
    const b = await duoBed(browser, size, { insets });
    const { page } = b;
    const opened = async (sheet: Locator, button: Locator, what: string) => {
      // Held a tenth of the way through its entrance, the sheet is half its height below
      // where it stays: the list opened now is placed under the button there, as a tap is.
      const held = await holdRise(sheet, 0.1);
      await button.click();
      await expect(page.getByRole("listbox"), what).toBeVisible();
      await expect.poll(() => listUnder(button), `${what}, the sheet held`).toBe(6);
      await letRise(sheet);
      await settled(page);
      expect((await boxOf(sheet)).top, `${what}: the sheet rose`).toBeLessThan(held - 200);
      // Up, the list stands under its button where the sheet came to rest, not where the
      // button was when it opened.
      await expect.poll(() => listUnder(button), `${what}, the sheet up`).toBe(6);
      await expect(page.getByRole("listbox").getByRole("option").first(), what).toBeInViewport();
    };
    try {
      Object.assign(b.ss.machines[0]!, { ask: true, handoff: true });
      await page.goto(b.server.url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeAttached();
      await b.approve();
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-size-class", "regular");

      await page.locator("nav.rail .rail-compose").click();
      const ns = page.locator("[data-new-session]");
      await opened(ns, ns.locator("[data-ns-row=machine] button"), `New session, ${size}`);

      await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
      await page.getByRole("button", { name: "Ask another agent…" }).click();
      const hs = page.locator("[data-handoff]");
      await opened(hs, hs.locator("[data-hs-row=agent] button"), `Ask another agent, ${size}`);
    } finally {
      await b.close();
    }
  });
}

test("with room, New session dragged down by its bar goes, its dim fading with it, and the next New session has its dim whole", {
  tag: "@webkit",
}, async ({ browser }) => {
  const b = await duoBed(browser, "951x669", { insets: [0, 84, 20, 0] });
  const { page } = b;
  const ns = page.locator("[data-new-session]");
  const dim = page.locator(".ns-scrim--form");
  const opacity = () => dim.evaluate((el) => Number(getComputedStyle(el).opacity));
  /** Every element that carries the drag's mark (lib/motion.ts useSheetDrag). */
  const marked = () =>
    page.evaluate(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
          (el) => el.style.getPropertyValue("--sheet-drag") !== "",
        ).length,
    );
  const open = async () => {
    await page.locator("nav.rail .rail-compose").click();
    await expect(ns.locator("[data-ns-text]")).toBeVisible();
    await settled(page);
  };
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeAttached();
    await b.approve();
    await page.reload();
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeAttached();
    await expect(page.locator("html")).toHaveAttribute("data-size-class", "regular");

    await open();
    expect(await opacity()).toBe(1);
    // By its title, past the two fifths of its height that let it go; the dim fades as
    // the sheet goes down.
    const bar = await boxOf(ns.locator(".ns-bar-title"));
    const from = { x: (bar.left + bar.right) / 2, y: (bar.top + bar.bottom) / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(from.x, from.y + 40 * i);
    const held = await opacity();
    expect(held).toBeLessThan(0.5);
    // From the lift until it is gone, the dim never comes back.
    await dim.evaluate((el) => {
      const seen: number[] = [];
      (window as unknown as { dimSeen: number[] }).dimSeen = seen;
      const look = () => {
        if (!el.isConnected) return;
        seen.push(Number(getComputedStyle(el).opacity));
        requestAnimationFrame(look);
      };
      look();
    });
    await page.mouse.up();
    await expect(ns).toHaveCount(0);
    await expect(dim).toHaveCount(0);
    const seen = await page.evaluate(() => (window as unknown as { dimSeen: number[] }).dimSeen);
    expect(Math.max(...seen)).toBeLessThanOrEqual(held + 0.01);
    expect(await marked()).toBe(0);

    // Open again: the dim is whole once it has come in; and Display's, after it.
    await open();
    expect(await opacity()).toBe(1);
    await ns.getByRole("button", { name: "Cancel" }).click();
    await expect(ns).toHaveCount(0);
    await page.locator("nav.rail").getByRole("button", { name: "Display" }).click();
    await expect(page.getByRole("dialog", { name: "Quick settings" })).toBeVisible();
    await settled(page);
    await expect(page.locator(".qs-scrim")).toHaveCSS("opacity", "1");
  } finally {
    await b.close();
  }
});

test("on a tablet on its side each page reads down one column: its title starts where its first row does, in the middle of what is beside the sidebar", async ({
  browser,
}) => {
  const b = await duoBed(browser, "1180x820", { insets: [24, 0, 20, 0] });
  const { page } = b;
  /** The column beside the sidebar: 1180 less the sidebar's 220 and a 16 pt gutter a side,
   *  then 672 in the middle of that. */
  const column = 220 + 16 + (1180 - 220 - 32 - 672) / 2;
  /** Where a box's content starts: inside its padding. */
  const startOf = (l: Locator) =>
    l.first().evaluate((el) => el.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(el).paddingLeft));
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeAttached();
    await b.approve();
    for (const [path, row] of [
      ["/", ".group-head"],
      ["/search?q=release", ".sx-row"],
      ["/machines", ".form-group"],
    ] as const) {
      await page.goto(`${b.server.url}${path}`);
      await expect(page.locator(row).first(), path).toBeVisible();
      const title = await startOf(page.locator(".bar-large"));
      expect(Math.abs(title - (await startOf(page.locator(row)))), path).toBeLessThanOrEqual(1);
      expect(Math.abs(title - column), path).toBeLessThanOrEqual(1);
      // The bar's ground runs on from the sidebar to the window's edge.
      const bar = await boxOf(page.locator(".main > .page > .bar"));
      expect([bar.left, bar.right], path).toEqual([220, 1180]);
    }
    // A session: its bar, the line under it (machine and folder) and its messages start at
    // one edge, the column's.
    await page.goto(`${b.server.url}${DUO_SESSIONS.done}`);
    const timeline = page.locator(".main > .session > .timeline");
    await expect(timeline).toBeVisible();
    const lead = (await boxOf(timeline)).left;
    expect(Math.abs(lead - column), "a session").toBeLessThanOrEqual(1);
    expect((await boxOf(page.locator(".main > .session > .bar .bar-lead"))).left, "a session's bar").toBe(lead);
    expect((await boxOf(page.locator(".main > .session > .bar-below .bar-sub"))).left, "its meta").toBe(lead);
    // Settings covers the window: its title and its list, and a section's groups, keep to
    // a column of the same width in the middle of it.
    await page.locator("nav.rail").getByRole("link", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    const middle = 16 + (1180 - 32 - 672) / 2;
    const title = await startOf(settings.locator(".settings-nav-large"));
    expect(Math.abs(title - (await startOf(settings.locator(".settings-tabs")))), "Settings").toBeLessThanOrEqual(1);
    expect(Math.abs(title - middle), "Settings").toBeLessThanOrEqual(1);
    await settings.getByRole("tab", { name: "General" }).click();
    const group = settings.locator(".settings-pane .settings-group").first();
    await expect(group).toBeVisible();
    expect(Math.abs((await startOf(group)) - middle), "Settings › General").toBeLessThanOrEqual(1);
  } finally {
    await b.close();
  }
});

for (const [size, insets] of ROOM) {
  const where = `${size} [${insets}]`;
  test(`with room, at ${where}, a list that shows nothing says so in the middle of what is left under its bar, in the page's column`, async ({
    browser,
  }) => {
    const b = await duoBed(browser, size, { insets });
    const { page } = b;
    try {
      await page.goto(b.server.url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeAttached();
      await b.approve();
      await expect(page.locator("html"), where).toHaveAttribute("data-size-class", "regular");
      await page.getByRole("searchbox", { name: "Filter sessions" }).fill("zzzz-nothing");
      const state = page.locator(".main > .page.board > .board-nomatch");
      await expect(state.locator(".state-title")).toHaveText("No sessions match “zzzz-nothing”");
      const room = await state.evaluate((el) => {
        const s = getComputedStyle(el);
        const page = el.parentElement!.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return {
          above: Number.parseFloat(s.marginTop),
          below: Number.parseFloat(s.marginBottom),
          middle: (r.left + r.right) / 2,
          page: (page.left + page.right) / 2,
        };
      });
      // The room the page has under its last row is shared out above and below it, as on a
      // phone, and there is room to share: it does not sit under the filter.
      expect(room.above, where).toBeGreaterThan(48);
      expect(Math.abs(room.above - room.below), where).toBeLessThanOrEqual(1);
      expect(Math.abs(room.middle - room.page), where).toBeLessThanOrEqual(1);
    } finally {
      await b.close();
    }
  });
}

/** The windows with a band at one side: the outer display, a Split View half and the
 *  inner display turned; and with the phone held the other way up, the band on the left.
 *  The band is the 84 pt the system's own bars stand in beside the page (duo.ts). */
const BANDS: [size: string, insets: Insets][] = [
  ["466x678", DUO["466x678"]!.insets],
  ["466x678", [0, 0, 20, 84]],
  ["470x669", DUO["470x669"]!.insets],
  ["951x669", DUO["951x669"]!.insets],
  ["951x669", [0, 0, 20, 84]],
];

/** bandOffenders, once what moves has arrived: a sheet on its way up covers nothing yet.
 *  Every animation that ends is waited for; a spinner's never does. */
async function underBands(page: Page): Promise<string[]> {
  await page.evaluate(async () => {
    const moving = document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.allSettled(moving.map((a) => a.finished));
  });
  return bandOffenders(page);
}

for (const [size, insets] of BANDS) {
  const where = `${size}, the band on the ${insets[3] ? "left" : "right"}`;
  const title = `nothing a finger lands on is under the system's bands at ${where}: every page, a prompt, each sheet and menu`;
  test(title, { tag: "@webkit" }, async ({ browser }) => {
    test.setTimeout(120_000);
    const b = await duoBed(browser, size, { insets });
    const { page } = b;
    const url = b.server.url;
    /** What is held under a band, state by state: one failure names every one of them. */
    const held: Record<string, string[]> = {};
    const measure = async (state: string) => {
      held[state] = await underBands(page);
    };
    const board = async () => {
      await page.goto(url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    };
    const allow = page.getByRole("button", { name: "Allow", exact: true });
    try {
      // The computer's agents can be asked by one another, so a session offers it.
      Object.assign(b.ss.machines[0]!, { ask: true, handoff: true });
      // A session on a second computer, older than the sample's: the Board then has a
      // filter to offer.
      const other = new Session("s-other", "claude-code", Date.now() - 3 * 60 * 60_000);
      const elsewhere = {
        session: {
          machine: "build-box",
          cwd: "/srv/ci",
          title: "Warm the build cache",
          title_source: "custom" as const,
        },
      };
      b.ss.push([
        other.ev("session.started", { source: "startup" }, elsewhere),
        other.ev("turn.started", { turn_id: "t1" }, elsewhere),
        other.ev("turn.transcript", { turn: 1, user: "Warm the cache.", assistant: "Warmed." }, elsewhere),
        other.ev("turn.ended", { turn_id: "t1" }, elsewhere),
      ]);
      await board();
      await b.approve();
      expect(await shapeOf(page)).toEqual({ size, insets });
      await measure("Board");
      // The gutter is inside what the band leaves: the large title starts 16 pt from it and
      // a row's age ends 16 pt from it, where they are 16 pt from the window's edge without
      // one. (With the larger of the two for a margin, the age stood flush against the band.)
      // Where the window has room (the inner display turned) the sidebar stands beside the
      // page and takes the band at the left: the page then begins where the sidebar ends.
      const [, right, , band] = insets;
      const regular = (await page.locator("html").getAttribute("data-size-class")) === "regular";
      const left = regular ? await page.locator("nav.rail").evaluate((el) => el.getBoundingClientRect().right) : band;
      const edges = await page.evaluate(() => {
        const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        return { title: box(".bar-large").left, age: box("article.card .card-time").right, width: innerWidth };
      });
      expect(edges.title, where).toBe(left + 16);
      expect(edges.age, where).toBeLessThanOrEqual(edges.width - right - 16);
      expect(edges.age, where).toBeGreaterThan(edges.width - right - 20);
      // Where the pull-to-refresh ring turns: across what the band leaves, so in its middle.
      const pull = await page.locator(".pull").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return [r.left, r.right];
      });
      expect(pull, where).toEqual([left, edges.width - right]);

      // A row held down: the phone's action sheet.
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
      await expect(page.getByRole("menuitem", { name: "Preview", exact: true })).toBeVisible();
      await measure("a row's menu");

      // The board's own menu, and Labels from it.
      await board();
      await page.getByRole("button", { name: "View options", exact: true }).click();
      await page.getByRole("menuitem", { name: "Edit labels…" }).click();
      await expect(page.getByRole("dialog", { name: "Labels" })).toBeVisible();
      await measure("Labels");

      // The board's filters: on a touch screen a chip for each, here the computers', with
      // its list open (a sheet on a narrow window, a pop-up from 600 pt).
      await board();
      await page.getByRole("combobox", { name: "Machine", exact: true }).click();
      await expect(page.getByRole("option", { name: "build-box" })).toBeVisible();
      await measure("Board, a filter's list");

      // The Feed's Filter: its menu, the phone's action sheet.
      await page.goto(`${url}/feed`);
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      await expect(page.getByRole("menuitemradio", { name: "All machines" })).toBeVisible();
      await measure("Feed, its Filter");

      // More, and Display from it; or, with room, the sidebar and Display from its foot.
      await board();
      if (regular) {
        await measure("the sidebar");
        await page.locator("nav.rail").getByRole("button", { name: "Display" }).click();
      } else {
        const more = page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "More", exact: true });
        await more.click();
        await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
        await measure("More");
        await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Display" }).click();
      }
      await expect(page.getByRole("dialog", { name: "Quick settings" })).toBeVisible();
      await measure("Display");

      // New session, then with the list of computers open over it.
      await board();
      await page.getByRole("button", { name: "New session" }).click();
      const sheet = page.getByRole("dialog", { name: "New session" });
      await expect(sheet.locator("[data-ns-start]")).toBeVisible();
      await measure("New session");
      await sheet.locator("[data-ns-row=machine] button").click();
      await expect(page.getByRole("listbox").getByRole("option", { name: "studio-mac" })).toBeVisible();
      await measure("New session, a list open");

      await page.goto(`${url}/inbox`);
      await expect(allow).toBeEnabled();
      await measure("Inbox");

      await page.goto(`${url}/search`);
      await page.locator(".sx-search input").fill("webhook");
      await expect(page.locator(".sx-hit").first()).toBeVisible();
      await measure("Search");
      // Its two pop-ups: a range of days, and what the index holds.
      await page.locator(".sx-chips button", { hasText: "Any time" }).click();
      await page.getByRole("option", { name: "Custom range…" }).click();
      await expect(page.getByRole("dialog", { name: "Custom range" })).toBeVisible();
      await measure("Search, a range of days");
      await page.goto(`${url}/search`);
      await page.locator(".sx-status-btn").click();
      await expect(page.getByRole("dialog", { name: "Search index" })).toBeVisible();
      await measure("Search, its index");

      await page.goto(`${url}/machines`);
      await expect(page.getByText("studio-mac").first()).toBeVisible();
      await measure("Machines");

      await page.goto(`${url}/settings`);
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings.getByRole("tab", { name: "General" })).toBeVisible();
      await measure("Settings");
      await settings.getByRole("tab", { name: "General" }).click();
      await expect(settings.getByRole("button", { name: /^Mode:/ })).toBeVisible();
      await measure("Settings, General");

      await page.goto(`${url}${DUO_SESSIONS.prompt}`);
      await expect(allow).toBeEnabled();
      await measure("a session with a prompt");
      // Its bars are grounds from one edge of the window (or the sidebar) to the other, under
      // the band: the page's bar, the strip the prompt and the message field stand in, the
      // tab bar. And
      // its title, too long to show whole, is in the middle of what the band leaves, cut
      // short of the way back before it and of the buttons after it.
      const sides = (sel: string) =>
        page.locator(sel).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return [r.left, r.right] as [number, number];
        });
      const width = Number(size.split("x")[0]);
      for (const bar of [".main > .page > .bar", ".sess-ctl", ...(regular ? [] : [".tabbar"])])
        expect(await sides(bar), `${bar}, ${where}`).toEqual([regular ? left : 0, width]);
      const [from, to] = await sides(".bar-title");
      expect((from + to) / 2, where).toBeCloseTo((left + width - right) / 2, 0);
      expect(from, where).toBeGreaterThanOrEqual((await sides(".bar-back"))[1]);
      expect(to, where).toBeLessThanOrEqual((await sides(".bar-actions"))[0]);
      await page.getByRole("button", { name: "Files", exact: true }).click();
      await expect(page.getByRole("button", { name: "Close files" })).toBeVisible();
      await measure("a session's files");

      await page.goto(`${url}${DUO_SESSIONS.done}`);
      await page.getByRole("button", { name: "Ask another agent…" }).click();
      await expect(page.locator("[data-handoff] [data-hs-text]")).toBeVisible();
      await measure("Ask another agent");

      // On a session's page, a prompt in another session: its banner comes down 8 pt inside
      // what the band leaves.
      await page.goto(`${url}${DUO_SESSIONS.done}`);
      await expect(composer(page)).toBeVisible();
      const site = new Session("s-site", "claude-code", Date.now() - 30_000);
      const build = "npm run build -- --mode production --outDir dist/site";
      const asking = () => ({
        session: {
          machine: "studio-mac",
          cwd: "/Users/me/code/site",
          title: "Build the site",
          title_source: "custom" as const,
        },
        time: new Date().toISOString(),
      });
      b.ss.push([
        site.ev("session.started", { source: "startup" }, asking()),
        site.ev("turn.started", { turn_id: "t1" }, asking()),
        site.ev("tool.started", { tool: "Bash", call_id: "c1", turn_id: "t1", input: { command: build } }, asking()),
        site.ev(
          "attention.needed",
          { attention_id: "att_build", kind: "permission", tool: "Bash", message: build },
          asking(),
        ),
      ]);
      await expect(page.locator(".toasts--phone .toast")).toBeVisible({ timeout: 15_000 });
      await measure("a banner");
      expect(await sides(".toasts--phone .toast"), where).toEqual([left + 8, width - right - 8]);

      // A long session read from its top while another turn lands at its end: "N new" stands
      // over the message field, the middle of what the band leaves, and not of the strip's
      // ground, which runs on under the band.
      const long = new Session("s-export", "claude-code", Date.now() - 20 * 60_000);
      const exporting = {
        session: {
          machine: "studio-mac",
          cwd: "/Users/me/code/billing",
          title: EXPORT.title,
          title_source: "custom" as const,
        },
      };
      b.ss.push([
        long.ev("session.started", { source: "startup" }, exporting),
        long.ev("turn.started", { turn_id: "t1" }, exporting),
        long.ev(
          "turn.transcript",
          { turn: 1, user: EXPORT.user, assistant: Array(6).fill(EXPORT.assistant).join("\n\n") },
          exporting,
        ),
        long.ev("turn.ended", { turn_id: "t1" }, exporting),
      ]);
      await page.goto(`${url}/s/claude-code/s-export`);
      await expect(composer(page)).toBeVisible();
      // It opens at its end. The person goes to its top, and the page has heard of it (its
      // scroll event comes with the next frame) before the turn lands.
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            scrollTo(0, 0);
            await new Promise((seen) => requestAnimationFrame(() => requestAnimationFrame(seen)));
            return scrollY;
          }),
        )
        .toBe(0);
      b.ss.push([
        long.ev("turn.started", { turn_id: "t2" }, exporting),
        long.ev("turn.transcript", { turn: 2, user: "And batch 8?", assistant: "It goes on from batch 8." }, exporting),
        long.ev("turn.ended", { turn_id: "t2" }, exporting),
      ]);
      await expect(page.locator(".sess-new")).toBeVisible({ timeout: 20_000 });
      await measure("a session read from its top, more below");
      const middle = (of: Locator) =>
        of.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (r.left + r.right) / 2;
        });
      const column = await middle(page.locator(".sess-ctl > :not(.sess-new)").filter({ has: composer(page) }));
      expect(column, where).toBeCloseTo((left + width - right) / 2, 0);
      expect(await middle(page.locator(".sess-new")), where).toBeCloseTo(column, 0);

      // spacesheep out of reach: the pill that says so, and retries, floats in the middle
      // of what the band leaves.
      await page.goto(`${url}${DUO_SESSIONS.done}`);
      await expect(composer(page)).toBeVisible();
      b.hub.down = true;
      const pill = page.locator(".phone-conn");
      await expect(pill).toBeVisible({ timeout: 30_000 });
      await measure("the pill");
      const at = await pill.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (r.left + r.right) / 2;
      });
      expect(at, where).toBeCloseTo((left + width - right) / 2, 0);
      b.hub.down = false;

      expect(held, where).toEqual(Object.fromEntries(Object.keys(held).map((state) => [state, []])));
      expect(Object.keys(held), where).toHaveLength(22);
    } finally {
      await b.close();
    }

    // A new install's last screen, over the board: "You're in", with its two ways on.
    const fresh = await duoBed(browser, size, { fresh: true, insets });
    try {
      fresh.hub.add("me@example.com", fresh.ss.key, Date.parse("2026-11-03T09:00:00Z"));
      await fresh.page.goto(fresh.server.url);
      const sheet = fresh.page.locator("[data-first-run='phone']");
      await expect(sheet.getByRole("button", { name: "Approve this iPhone" })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Later" })).toBeVisible();
      // Asked until it holds: the sheet's stylesheet (native.css) can land after the sheet
      // itself on a slow start, and until then it is the centred card any dialog is, with
      // Approve at its right.
      await expect.poll(() => underBands(fresh.page), `You're in, ${where}`).toEqual([]);
    } finally {
      await fresh.close();
    }
  });
}

for (const [size, insets] of BANDS) {
  const where = `${size}, the band on the ${insets[3] ? "left" : "right"}`;
  test(`pictures beside the band at ${where}: the message box's tray and a sent picture opened whole keep their buttons clear of it`, {
    tag: "@webkit",
  }, async ({ browser }) => {
    test.setTimeout(90_000);
    const b = await duoBed(browser, size, { insets });
    const { page } = b;
    const [, right, , left] = insets;
    const width = Number(size.split("x")[0]);
    /** Each control's two sides, by its name. */
    const sides = (sel: string) =>
      page.locator(sel).evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return [el.getAttribute("aria-label") ?? el.className, Math.round(r.left), Math.round(r.right)] as const;
        }),
      );
    const clear = async (sel: string, state: string) => {
      const found = await sides(sel);
      expect(found.length, `${state}, ${where}`).toBeGreaterThan(0);
      for (const [name, from, to] of found) {
        expect(from, `${name}, ${state}, ${where}`).toBeGreaterThanOrEqual(left);
        expect(to, `${name}, ${state}, ${where}`).toBeLessThanOrEqual(width - right);
      }
    };
    // The computer takes pictures with a message (sessionpipe 0.10 and later) and answers
    // each one, naming the files it saved as a computer does.
    Object.assign(b.ss.machines[0]!, { cli_version: "sessionpipe 0.17.0", files: true, prompt_files: true });
    const pics = new Session("s-pics", "claude-code", Date.now() - 30 * 60_000);
    const on = {
      session: {
        machine: "studio-mac",
        cwd: "/Users/me/code/site",
        title: "Match the hero colours",
        title_source: "custom" as const,
      },
    };
    b.ss.push([
      pics.ev("session.started", { source: "startup" }, on),
      pics.ev("turn.started", { turn_id: "t1" }, on),
      pics.ev("turn.transcript", { turn: 1, user: "Find the hero's colours.", assistant: "Found two." }, on),
      pics.ev("turn.ended", { turn_id: "t1" }, on),
    ]);
    let turn = 2;
    const answer = setInterval(() => {
      for (const job of b.ss.jobs) {
        if (job.status !== "queued") continue;
        const cmd = JSON.parse(String(job.sent.cmd)) as Record<string, unknown>;
        b.ss.settle(job.id, "running");
        const files = (cmd.files ?? []) as { name: string; type: string; size: number }[];
        const list = files
          .map((f) => `- .sessionpipe/files/s-pics/${String(cmd.nonce)}/${f.name} (${f.type}, ${f.size} B)`)
          .join("\n");
        const id = `t${turn}`;
        b.ss.push([
          pics.ev("turn.started", { turn_id: id }, on),
          pics.ev(
            "turn.transcript",
            {
              turn: turn++,
              user: `${cmd.text}\n\nAttached files (saved in this folder):\n${list}`,
              assistant: "Both red.",
            },
            on,
          ),
          pics.ev("turn.ended", { turn_id: id }, on),
        ]);
        b.ss.settle(job.id, "done");
      }
    }, 100);
    try {
      await page.goto(b.server.url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
      await b.approve();
      await page.goto(`${b.server.url}/s/claude-code/s-pics`);
      await expect(composer(page)).toBeEnabled();
      // Two pictures in the message box: the tray, each with its ×.
      await page.locator("input[data-attach-input]").setInputFiles([
        { name: "brick.png", mimeType: "image/png", buffer: png(64, 48, [0xb0, 0x3a, 0x2e]) },
        { name: "coral.png", mimeType: "image/png", buffer: png(80, 60, [0xf0, 0x80, 0x70]) },
      ]);
      await expect(page.locator(".att-item[data-state=ready]")).toHaveCount(2);
      expect(await underBands(page), `the tray, ${where}`).toEqual([]);
      await clear(".att-x", "the tray");
      // Sent, and the second one opened whole: ×, and a chevron at each side.
      await composer(page).fill("Are these the same red?");
      await page.locator(".ctl-send").click();
      await expect(page.locator("[data-sent-picture] img")).toHaveCount(2, { timeout: 20_000 });
      await page.locator("[data-sent-picture='coral.png']").last().click();
      await expect(page.locator("[data-lightbox]")).toBeVisible();
      expect(await underBands(page), `the lightbox, ${where}`).toEqual([]);
      await clear(".lb-btn", "the lightbox");
      await expect(page.locator(".lb-btn")).toHaveCount(3);
    } finally {
      clearInterval(answer);
      await b.close();
    }
  });
}

const UNFOLDED =
  "a page open on the outer display, unfolded and turned: nothing is under the band there either, at the simulator's size or at the earlier estimate's";
test(UNFOLDED, { tag: "@webkit" }, async ({ browser }) => {
  const b = await duoBed(browser, "466x678");
  const { page } = b;
  /** The pages, each with what shows once it is whole (`answers`: Allow, ready to be tapped). */
  const PAGES: [name: string, path: string, shown: string, answers: boolean][] = [
    ["Board", "/", "Release notes for 0.8.3", false],
    ["a session with a prompt", DUO_SESSIONS.prompt, "Allow Bash to run:", true],
    ["Inbox", "/inbox", "Fix the invoice webhook retries", true],
    ["Machines", "/machines", "studio-mac", false],
  ];
  /** What a finger would land on under a band, page by page, in the pose the phone is in. */
  const under = async () => {
    const found: Record<string, string[]> = {};
    for (const [name, path, shown, answers] of PAGES) {
      await page.goto(`${b.server.url}${path}`);
      await expect(page.getByText(shown).first(), name).toBeVisible();
      if (answers) await expect(page.getByRole("button", { name: "Allow", exact: true }), name).toBeEnabled();
      found[name] = await bandOffenders(page);
    }
    return found;
  };
  const none = Object.fromEntries(PAGES.map(([name]) => [name, []]));
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    // The gutter is inside what the band leaves, so a bar's last button (44 wide round its
    // glyph) and a row's ground (8 pt past its words) end short of it. The same page, moved
    // to the inner display turned: its band is another width at the earlier estimate (56 pt).
    expect(await under(), "466x678").toEqual(none);
    for (const size of TURNED) {
      const [width, height] = size.split("x").map(Number) as [number, number];
      await pose(page, width, height);
      expect(await shapeOf(page), size).toEqual({ size, insets: DUO[size]!.insets });
      expect(await under(), size).toEqual(none);
    }
  } finally {
    await b.close();
  }
});

/** What the iOS app's probe (apps/mobile/src-tauri/src/probe.js) says of the page, run as
 *  the shell runs it on a probe launch: mobile.yml's iPhone Duo step prints it from the
 *  simulator, and the real insets come from there. */
const PROBE = readFileSync(fileURLToPath(new URL("../../apps/mobile/src-tauri/src/probe.js", import.meta.url)), "utf8");
async function probe(page: Page): Promise<Record<string, unknown>> {
  await page.evaluate(() => history.replaceState(history.state, "", location.pathname + location.search));
  await page.evaluate(PROBE);
  // A state, not a time: the probe has put what it saw in the address.
  await page.waitForFunction(() => location.hash.startsWith("#probe="));
  return page.evaluate(() => JSON.parse(decodeURIComponent(location.hash.slice("#probe=".length))));
}

test("the iOS app's probe says the window's size, the system's insets, the size class, the pointer and the screen, folded and unfolded", {
  tag: "@webkit",
}, async ({ browser }) => {
  const b = await duoBed(browser, "466x678");
  const { page } = b;
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    for (const [width, height, sizeClass] of [
      [466, 678, "compact"],
      [669, 951, "regular"],
    ] as const) {
      await pose(page, width, height);
      const seen = await probe(page);
      const size = `${width}x${height}`;
      expect(seen, size).toMatchObject({ w: width, h: height, sizeClass, coarse: true, vv: [width, height], dpr: 3 });
      // env(safe-area-inset-*), not the --safe-* this bed stands in for them with: a browser
      // has no band of its own, the simulator has.
      expect(await shapeOf(page), size).toEqual({ size, insets: DUO[size]!.insets });
      expect(seen.insets, size).toEqual([0, 0, 0, 0]);
      expect(seen.screen, size).toEqual([expect.any(Number), expect.any(Number)]);
      expect(seen.errors, size).toEqual([]);
    }
  } finally {
    await b.close();
  }
});
