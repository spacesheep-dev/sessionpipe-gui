// SPDX-License-Identifier: Apache-2.0
// What the iPhone app keeps as an iPhone Duo is unfolded, turned, put in Split View and
// folded again: each is a live resize of the one page, between the shapes of duo.ts. Run
// in Chromium (the `duo` project) and in WebKit (`duo-webkit`), WKWebView's engine, since
// what a page holds on to through a resize is the engine's doing as much as the app's.
import { expect, type Page, test } from "@playwright/test";
import { coarsePointer, DUO, DUO_SESSIONS, duoBed, pose, shapeOf } from "./duo.js";

const composer = (page: Page) => page.locator("textarea").first();

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
