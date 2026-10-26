// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The command palette: ⌘K opens it on any page, a title fragment puts that session first
// and Enter opens it, shift+Enter opens it beside, `>` keeps only actions, `#<view>` jumps
// to an installed view, Esc closes it and gives focus back.
import { expect, type Page, test } from "@playwright/test";
import { openBoard, openPage } from "./helpers.js";

/** The card shows a long title up to its first sentence or an ellipsis; the palette and the
 *  session page may show more, so a title is matched as the start. */
const startsWith = (t: string) => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const dialog = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const rows = (page: Page) => dialog(page).locator(".pal-row");

async function open(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("combobox")).toBeFocused();
}

/** A settled board card (idle or stale: past its first turn, so its title won't be replaced
 *  by a better one mid-test) whose title is a phrase with a word worth typing (3+ words, one of
 *  7+ letters: a session, not a repo or machine name), else the first card; its title, and that word. */
async function firstCard(page: Page): Promise<{ title: string; href: string; fragment: string }> {
  const longest = (t: string) =>
    t
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
      .sort((a, b) => b.length - a.length)[0] ?? "";
  const settled = page.locator("section.group--idle, section.group--stale").locator("article.card a.card-link");
  let link = page.locator("article.card a.card-link").first();
  for (let i = 0, n = await settled.count(); i < n; i++) {
    const t = ((await settled.nth(i).locator(".card-title").textContent()) ?? "").trim();
    if (t.split(/\s+/).length >= 3 && longest(t).length >= 7) {
      link = settled.nth(i);
      break;
    }
  }
  const title = (await link.locator(".card-title").textContent())!.trim().replace(/…$/, "");
  const href = (await link.getAttribute("href"))!;
  return { title, href, fragment: longest(title) };
}

test.describe("command palette", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project only");

  test("⌘K opens it; a title fragment puts the session first; Enter opens it", async ({ page }) => {
    await openBoard(page);
    const { title, href, fragment } = await firstCard(page);
    await open(page);
    // The board's own search is a plain toolbar field; the palette is ⌘K (and in the rail's menu).
    await expect(page.locator("[data-search]")).toHaveAttribute("placeholder", "Search");
    await expect(dialog(page).locator(".pal-section").first()).toHaveText("Sessions");
    await page.keyboard.type(fragment);
    const first = rows(page).first();
    await expect(first).toHaveAttribute("data-section", "Sessions");
    await expect(first.locator(".pal-label")).toHaveText(startsWith(title));
    // The matched letters are marked (in the ink at 600), not blocked.
    await expect(first.locator("u").first()).toBeVisible();
    await expect(first).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL((u) => u.pathname === href.split("?")[0]);
    await expect(page.locator("h1.sess-title")).toHaveText(startsWith(title));
  });

  test("shift+Enter opens the session beside the page", async ({ page }) => {
    await openBoard(page);
    const { title, href, fragment } = await firstCard(page);
    await open(page);
    await page.keyboard.type(fragment);
    await expect(rows(page).first().locator(".pal-label")).toHaveText(startsWith(title));
    await page.keyboard.press("Shift+Enter");
    await expect(dialog(page)).toBeHidden();
    const panel = page.locator("aside.panel");
    await expect(panel).toHaveClass(/panel--open/);
    // By its key, not its words: a demo session may learn a better title mid-turn.
    const key = href
      .split("?")[0]!
      .replace(/^\/s\//, "")
      .split("/")
      .slice(0, 2)
      .map(decodeURIComponent)
      .join(":");
    await expect.poll(() => decodeURIComponent(new URL(page.url()).searchParams.get("s") ?? "")).toBe(key);
    await expect(panel.locator(".panel-title")).not.toHaveText("");
    // Inside the split, ⌘K still works.
    await open(page);
    await expect(dialog(page).locator(".pal-section", { hasText: "Actions" })).toBeVisible();
  });

  test("`>` lists only actions; arrows move the cursor", async ({ page }) => {
    await openBoard(page);
    await open(page);
    await page.keyboard.type(">");
    const sections = dialog(page).locator(".pal-section");
    await expect(sections).toHaveText(["Actions"]);
    await expect(rows(page).first()).toHaveAttribute("data-section", "Actions");
    await expect(rows(page).filter({ hasText: "Send a message…" }).first()).toBeVisible();
    await expect(rows(page).filter({ hasText: "Open beside" }).first()).toBeVisible();
    await expect(rows(page).filter({ hasText: "Open as page" }).first()).toBeVisible();
    await expect(rows(page).filter({ hasText: "Forget…" }).first()).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowUp");
    await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
    // `#` keeps only the places.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("#");
    await expect(sections).toHaveText(["Go to"]);
    await expect(rows(page).filter({ hasText: "Board" })).toBeVisible();
    await expect(rows(page).filter({ hasText: "Display settings" })).toBeVisible();
  });

  test("`#<view>` jumps to an installed view", async ({ page, request }) => {
    const { themes } = (await (await request.get("/api/ui/themes")).json()) as {
      themes: { id: string; name: string; error?: string }[];
    };
    const view = themes.find((t) => t.id === "canvas" && !t.error) ?? themes.find((t) => !t.error);
    test.skip(!view, "no view installed");
    await openPage(page, "/feed");
    await open(page);
    await page.keyboard.type(`#${view!.name}`);
    await expect(rows(page).first().locator(".pal-label")).toHaveText(view!.name);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/t/${view!.id}$`));
    // And from inside the view, ⌘K opens it again.
    await open(page);
    await page.keyboard.type("#feed");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/feed$/);
  });

  test("Esc closes it and focus goes back where it was", async ({ page }) => {
    await openBoard(page);
    const search = page.locator("[data-search]");
    await search.focus();
    await expect(search).toBeFocused();
    await open(page);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(search).toBeFocused();
    // Reopened and dismissed through the scrim, the same.
    await open(page);
    await page.locator(".pal-scrim").click({ position: { x: 10, y: 10 } });
    await expect(dialog(page)).toBeHidden();
  });
});
