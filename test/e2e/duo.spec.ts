// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The iPhone app at the iPhone Duo's shapes (the `duo` project: a touch screen, 3x): the
// outer display 466×678, the inner one upright 669×951 and turned 951×669, a Split View
// half 470×669, each with the bands the system keeps (duo.ts). What holds at a shape is
// said here: the first run, the keyboard, a reply's lines, and that the inner display
// turned (wider than the width at which a window with a mouse takes the Mac's layout) is
// still the touch app. What a page keeps as it moves from one to another is in
// duo-continuity.spec.ts, which runs in WebKit too.
import { expect, type Page, test } from "@playwright/test";
import {
  bandOffenders,
  coarsePointer,
  DUO,
  DUO_REPLY,
  DUO_SESSIONS,
  duoBed,
  fakeKeyboard,
  firstLineChars,
  type Insets,
  insetsInit,
  pose,
  shapeOf,
} from "./duo.js";

const composer = (page: Page) => page.locator("textarea").first();
/** The inner display turned on its side, as the simulator gives it and as first estimated:
 *  both wider than the width a mouse window's layout changes at (lib/device.ts). */
const TURNED = ["951x669", "890x626"] as const;

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
