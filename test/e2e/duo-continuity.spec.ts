// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// What the iPhone app keeps as an iPhone Duo is unfolded, turned, put in Split View and
// folded again: each is a live resize of the one page, between the shapes of duo.ts. Run
// in Chromium (the `duo` project) and in WebKit (`duo-webkit`), WKWebView's engine, since
// what a page holds on to through a resize is the engine's doing as much as the app's.
// So is what duo.ts itself promises a test, which is held here too: the system's bands in
// a page from its first script, and a measure that tells a control held under a band from
// one passing.
import { expect, type Page, test } from "@playwright/test";
import { bandOffenders, coarsePointer, DUO, DUO_SESSIONS, duoBed, insetsInit, pose, shapeOf } from "./duo.js";

const composer = (page: Page) => page.locator("textarea").first();

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
        // page ends at 382.
        if (size === "669x951") expect(first.bar[3]).toBe(77);
        if (size === "466x678") expect(first.page[1]).toBe(382);
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
      // With no band at all there is nothing to measure: that is said, not passed.
      await pose(page, 669, 951, [0, 0, 0, 0]);
      await expect(bandOffenders(page)).rejects.toThrow("no inset band");
    } finally {
      await context.close();
    }
  });
});
