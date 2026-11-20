// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The iPhone app at the iPhone Duo's shapes (the `duo` project: a touch screen, 3x): the
// outer display 466×678, the inner one upright 669×951 and turned 951×669, a Split View
// half 470×669, each with the bands the system keeps (duo.ts). What holds at a shape is
// said here: the first run, the keyboard, a reply's lines, what a finger can copy, and that
// the inner display turned (wider than the width at which a window with a mouse takes the
// Mac's layout) is still the touch app. What a page keeps as it moves from one to another
// is in duo-continuity.spec.ts, which runs in WebKit too.
import { expect, type Page, test } from "@playwright/test";
import {
  bandOffenders,
  coarsePointer,
  DUO,
  DUO_REPLY,
  DUO_SESSIONS,
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

test("on the inner display a plan waiting for its answer reads across its whole card: the reply's measure is not the plan's", async ({
  browser,
}) => {
  const plan = [
    "### Resume the export from the batch that failed",
    "Each batch takes a fresh connection and writes in pages of 100 invoices, so none of them sits idle long enough for the pooler to drop it, and a run that starts again goes on from the batch after the last one that finished.",
    "1. Keep the last finished batch in the export's own table.\n2. Start a run from the batch after it.",
  ].join("\n\n");
  for (const size of ["669x951", "951x669"]) {
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

test("the inner display turned is the touch app still: its tab bar, one sentence on a prompt it cannot answer yet, and none of a Mac's words in New session or a row's menu", async ({
  browser,
}) => {
  for (const size of TURNED) {
    const b = await duoBed(browser, size);
    const { page } = b;
    try {
      await page.goto(b.server.url);
      await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
      // The phone's tab bar under the page, and no rail beside it.
      await expect(page.locator("nav.tabbar"), size).toBeVisible();
      await expect(page.locator("nav.rail"), size).toBeHidden();
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

test("the inner display turned holds no control under its band that the outer display does not", async ({
  browser,
}) => {
  const b = await duoBed(browser, "466x678");
  const { page } = b;
  /** Each control by its first words: a row's name ends with its age, which moves. */
  const named = (names: string[]) => names.map((name) => name.split(" ").slice(0, 3).join(" ")).sort();
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
  try {
    await page.goto(b.server.url);
    await expect(page.getByText("Release notes for 0.8.3").first()).toBeVisible();
    await b.approve();
    // The phone's own layout, on the outer display: what it holds there is the measure.
    // Today that is its gutter's doing: a bar's last button is 44 wide round a glyph that
    // ends at the band (10 pt under it), and a board row's ground runs 8 pt past its words.
    // Turned, the same and nothing of a Mac's layout; none at either is the gutter's to fix.
    const outer = await under();
    for (const size of TURNED) {
      const [width, height] = size.split("x").map(Number) as [number, number];
      await pose(page, width, height);
      const turned = await under();
      expect(await shapeOf(page), size).toEqual({ size, insets: DUO[size]!.insets });
      for (const [name] of PAGES) {
        // What answers a prompt, sends, or turns something on is never one of them.
        for (const held of turned[name]!)
          expect(held, `${name} at ${size}`).not.toMatch(/^(Allow|Deny|Send|Stop|Ask another agent…|Turn on)\b/);
        expect(named(turned[name]!), `${name} at ${size}`).toEqual(named(outer[name]!));
      }
    }
  } finally {
    await b.close();
  }
});
