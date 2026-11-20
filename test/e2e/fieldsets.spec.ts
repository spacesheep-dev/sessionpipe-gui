// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// A fieldset groups controls for a screen reader and draws nothing of the browser's own
// (base.css): no groove, no padding and no least width, on Setup's folders, the Settings
// window's switches, tiles and picks, and a plugin's form. files.spec.ts holds the one that
// showed its groove, the Files drawer's versions.
import { expect, type Page, test } from "@playwright/test";
import { E2E_PORT } from "../../playwright.config.js";
import { openPage } from "./helpers.js";

/** What each fieldset in `scope` draws of its own: its borders, its padding, its margin and
 *  the least width it insists on, and its legend's padding. */
const fieldsets = (page: Page, scope: string) =>
  page.locator(`${scope} fieldset`).evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      const legend = el.querySelector(":scope > legend");
      return {
        class: el.className,
        border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].join(" "),
        padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" "),
        margin: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].join(" "),
        min: cs.minInlineSize,
        legend: legend ? getComputedStyle(legend).paddingLeft : "0px",
      };
    }),
  );

/** Nothing of the browser's own on any fieldset in `scope`, which holds each of `classes`;
 *  a segmented control alone keeps padding, its track's 2 px inset. */
async function drawNothing(page: Page, scope: string, classes: string[]) {
  const found = await fieldsets(page, scope);
  for (const c of classes) expect(found.map((f) => f.class).join(" "), `a .${c} fieldset is here`).toContain(c);
  for (const f of found) {
    const seg = f.class.split(" ").includes("seg");
    expect(f, `fieldset.${f.class}`).toMatchObject({
      border: "0px 0px 0px 0px",
      padding: seg ? "2px 2px 2px 2px" : "0px 0px 0px 0px",
      margin: "0px 0px 0px 0px",
      min: "0px",
      legend: "0px",
    });
  }
}

test.describe("a fieldset draws nothing of the browser's own", () => {
  test("the Settings window: the mode and the lens switches, the appearance tiles", async ({ page }) => {
    await openPage(page, "/settings?section=general");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(dialog.locator("fieldset.tiles").first()).toBeVisible();
    await drawNothing(page, "[role=dialog]", ["seg", "tiles"]);
    await dialog.getByRole("tab", { name: "Tier lens" }).click();
    await expect(dialog.locator("fieldset.seg")).toBeVisible();
    await drawNothing(page, "[role=dialog]", ["seg"]);
  });

  test("the phone's Settings: a pushed choice's rows", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await openPage(page, "/settings?section=general");
    await page.locator(".settings-choice").first().click();
    await expect(page.locator("fieldset.settings-picks")).toBeVisible();
    await drawNothing(page, "body", ["settings-picks"]);
  });

  test("a plugin's form on the Views page: its group of checkboxes", async ({ page }) => {
    await page.route("**/api/ui/plugins", (r) =>
      r.fulfill({
        json: {
          plugins: [
            {
              id: "e2e-notes",
              name: "e2e-notes",
              version: "1.0.0",
              kind: "plugin",
              api: 1,
              entry: "index.js",
              status: "active",
              settings: [
                { key: "events", label: "Send a message for", type: "multiselect", options: ["needs_you", "question"] },
              ],
              values: { events: ["needs_you"] },
            },
          ],
        },
      }),
    );
    await openPage(page, "/themes");
    const field = page.locator("fieldset.plug-field--multi");
    await expect(field).toBeVisible();
    await drawNothing(page, "[data-plugins]", ["plug-field--multi"]);
  });

  test.describe("Setup's folders", () => {
    // localhost: where passkeys work, so the pairing step is past "Finish step 2 first".
    test.use({ baseURL: `http://localhost:${E2E_PORT}` });

    test("the folders a pairing may use are a plain list under their legend", async ({ page }) => {
      await page.route("**/api/ui/setup/status", async (r) => {
        const real = await (await r.fetch()).json();
        await r.fulfill({
          json: {
            ...real,
            sessionpipe: { ...real.sessionpipe, installed: true },
            tls: { ...real.tls, on: true, caTrusted: true, rpId: "localhost" },
            daemon: { ...real.daemon, pairedHere: false, suggestedFolders: ["~/code/billing", "~/code/site"] },
          },
        });
      });
      await openPage(page, "/setup");
      const folders = page.locator("li.step[data-step=pair] fieldset.step-folders");
      await expect(folders).toBeVisible();
      await drawNothing(page, "li.step[data-step=pair]", ["step-folders"]);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });
  });
});
