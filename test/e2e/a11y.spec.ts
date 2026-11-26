// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Accessibility: axe on every page (zero serious or critical violations), then a
// keyboard-only walk: Tab from the top reaches the skip link, the main region, the rail
// and a card (New session between the brand and the pages); `g f` navigates; `?` opens the help; a rebinding on /shortcuts takes
// effect (and the old key stops); a conflict is refused; Esc gives focus back. And focus is
// ink, never the needs-you orange: the ring, a focused field's edge, the composer (which
// never glows) and the j/k cursor's edge on its row, 2 px under Increase contrast; text
// selection is the system's own.
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { CONTROL_BASE, fakeDaemon, passkeyPage, postSession, seenSetupHere, sinkToken } from "./control-helpers.js";
import {
  composer,
  dropStream,
  EVENTS,
  INFO,
  openBoard,
  openPage,
  sessionUrl,
  tapStream,
  tier1Batch,
  ulid,
} from "./helpers.js";

const SHORTCUTS_KEY = "sessionpipe-gui.shortcuts";

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = results.violations.map((v) => `${v.impact}:${v.id}×${v.nodes.length}`).join(" ");
  console.log(`[axe] ${label}: ${results.violations.length} violations (${bad.length} serious/critical) ${summary}`);
  if (process.env.AXE_VERBOSE)
    for (const v of bad)
      for (const n of v.nodes) console.log(`  ${v.id} ${n.target.join(" ")} :: ${n.any[0]?.message ?? ""}`);
  expect
    .soft(
      bad.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })),
      `${label}: serious/critical axe violations`,
    )
    .toEqual([]);
}

/** The first board card's session path. */
async function firstSessionPath(page: Page): Promise<string> {
  await openBoard(page);
  const href = (await page.locator("article.card a.card-link").first().getAttribute("href"))!;
  return href.split("?")[0]!;
}

test.describe("accessibility", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project only");

  test("axe: board, inbox, feed, review, machines, connect, setup, views, shortcuts", async ({ page }) => {
    test.slow();
    // Dialogs fade in; axe must sample text at full opacity, not mid-animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openBoard(page);
    await axe(page, "board");
    for (const [path, marker] of [
      ["/inbox", ".inbox, .page-note"],
      ["/feed", "ol.rows li"],
      ["/review", ".rv-tabs"],
      ["/machines", "section.machine, .machines, .page"],
      ["/connect", ".connect"],
      ["/setup", ".setup, .page"],
      ["/themes", ".themes"],
      ["/shortcuts", ".sc-page"],
    ] as const) {
      await page.goto(path);
      await expect(page.locator(marker).first()).toBeVisible();
      await axe(page, path);
    }
  });

  test("axe: a session page, the palette open, and a view page", async ({ page }) => {
    test.slow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const path = await firstSessionPath(page);
    await page.goto(path);
    await expect(page.locator("h1.sess-title")).toBeVisible();
    await axe(page, "session");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await axe(page, "palette");
    await page.keyboard.press("Escape");
    await openPage(page, "/t/e2e-counter");
    await expect(page.locator(".e2e-counter")).toBeVisible();
    await axe(page, "view");
    // The help (a view page owns `?`, so from the feed).
    await openPage(page, "/feed");
    await page.locator("body").click({ position: { x: 700, y: 600 } });
    await page.keyboard.press("Shift+?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await axe(page, "help");
  });

  test("axe: a session that opens on its New line", async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // A session read up to its first turn, then a second turn with an answer: unread at
    // open, the line above that answer. (One never looked at gets no line: lib/newLine.ts.)
    const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
    const post = async (events: Record<string, unknown>[]) => {
      const res = await request.post(EVENTS, {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sinkToken}`,
          "sessionpipe-protocol": "1",
        },
        data: { events },
      });
      expect(res.ok()).toBeTruthy();
    };
    const batch = tier1Batch({ title: "New line" });
    for (const e of batch.events) e.tier = 3;
    await post(batch.events);
    const key = `${batch.harness}:${batch.sessionId}`;
    const snap = (await (await request.get("/api/ui/snapshot")).json()) as {
      sessions: { key: string; newsAt?: string }[];
    };
    const read = snap.sessions.find((s) => s.key === key)?.newsAt;
    expect(read).toBeTruthy();
    expect((await request.patch("/api/ui/marks", { data: { read: { [key]: read } } })).ok()).toBeTruthy();
    const last = batch.events[batch.events.length - 1]!;
    const turnId = randomUUID();
    let seq = batch.events.length;
    let clock = Date.now() - 30_000;
    const ev = (type: string, data: Record<string, unknown>, hook: string) => {
      clock += 1000;
      return {
        ...last,
        id: ulid(clock),
        type,
        time: new Date(clock).toISOString(),
        harness: { ...(last.harness as Record<string, unknown>), event: hook },
        session: { ...(last.session as Record<string, unknown>), seq: seq++ },
        data,
      };
    };
    await post([
      ev("turn.started", { turn_id: turnId, prompt_chars: 5 }, "UserPromptSubmit"),
      ev("turn.transcript", { turn: 2, turn_id: turnId, user: "More?", assistant: "The rest." }, "Stop"),
      ev("turn.ended", { turn_id: turnId, reason: "stop", ms: 2000 }, "Stop"),
    ]);
    await openPage(page, sessionUrl(batch.harness, batch.sessionId));
    const line = page.getByRole("separator", { name: "New since you looked" });
    await expect(line).toBeVisible();
    // Under the second turn's prompt, above its answer.
    const top = async (text: string) => (await page.getByText(text, { exact: true }).boundingBox())!.y;
    const at = (await line.boundingBox())!.y;
    expect(at).toBeGreaterThan(await top("More?"));
    expect(at).toBeLessThan(await top("The rest."));
    await axe(page, "session, New line");
  });

  test("keyboard-only: skip link, main, rail, a card; g f navigates; ? opens the help", async ({ page }) => {
    await openBoard(page);
    // Tab from the top: the skip link first, which lands on main.
    await page.keyboard.press("Tab");
    const skip = page.locator("a.skip");
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
    // From the skip link, Tab walks the rail: the brand, the sessions column's button, then
    // the pages (New session is the column's first row, after the rail).
    await skip.focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("nav.rail a.rail-brand")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("nav.rail [data-tree-toggle]")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("nav.rail a[data-nav='board']")).toBeFocused();
    // The board's cards are one tab stop: Tab goes into the list, arrows move inside it.
    const card = page.locator("article.card a.card-link[tabindex='0']");
    await card.focus();
    await expect(card).toBeFocused();
    // The demo board is live and moves its cards, and the cursor goes with its card: which
    // card it is on is checked, not where that card is.
    const first = await card.evaluate((el) => el.closest("article.card")?.getAttribute("data-flip"));
    await page.keyboard.press("ArrowDown");
    const current = page.locator("article.card[aria-current='true']");
    await expect(current.locator("a.card-link")).toBeFocused();
    await expect(current).not.toHaveAttribute("data-flip", first ?? "");

    // `g f` is the feed; the title is announced and main takes focus.
    await page.keyboard.press("g");
    await page.keyboard.press("f");
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.locator("main#main")).toBeFocused();
    await expect(page.locator("[data-announcer]")).toHaveText(/Feed/);

    // `?` opens the help, lists the bindings, Esc closes it and gives focus back.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    const search = page.locator("[data-search]");
    await search.focus();
    await page.keyboard.press("Escape"); // leaves the field, keeps the list
    await expect(search).not.toBeFocused();
    // Typing `?` in the field is text, not a shortcut; from the page it opens the help.
    await search.focus();
    await page.keyboard.press("Shift+?");
    await expect(search).toHaveValue("?");
    await search.fill("");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+?");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(help).toBeVisible();
    await expect(help.getByRole("searchbox")).toBeFocused();
    await expect(help.locator("kbd", { hasText: /^g$/ }).first()).toBeVisible();
    await help.getByRole("searchbox").fill("feed");
    await expect(help.locator(".sc-row", { hasText: "Feed" }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
  });

  test("/shortcuts: rebinding g f to g x works, g f stops, a conflict is refused, Esc restores focus", async ({
    page,
  }) => {
    await openPage(page, "/shortcuts");
    const row = page.locator(".sc-row[data-action='nav.feed']");
    await expect(row).toBeVisible();
    const chip = row.locator("button.sc-key").first();
    await chip.click();
    await expect(row.locator(".sc-recorder")).toBeVisible();
    await page.keyboard.press("g");
    await page.keyboard.press("x");
    await expect(row.locator("button.sc-key").first()).toHaveText(/g\s*x/);
    // Persisted as an override.
    const stored = await page.evaluate((k) => localStorage.getItem(k), SHORTCUTS_KEY);
    expect(JSON.parse(stored!)["nav.feed"]).toEqual(["g x"]);

    // A conflict is refused: `g x` on Board stays unbound and says why.
    const board = page.locator(".sc-row[data-action='nav.board']");
    await board.locator("button.sc-add").click();
    await page.keyboard.press("g");
    await page.keyboard.press("x");
    await expect(board.locator(".sc-conflict")).toHaveText(/Feed/);
    await page.keyboard.press("Escape");
    await expect(board.locator(".sc-recorder")).toHaveCount(0);
    await expect(board.locator("button.sc-add")).toBeFocused();
    await expect(board.locator("button.sc-key")).toHaveText([/g\s*b/]);

    // A browser essential is refused too.
    await board.locator("button.sc-add").click();
    await page.keyboard.press("ControlOrMeta+l");
    await expect(board.locator(".sc-conflict")).toHaveText(/browser/);
    await page.keyboard.press("Escape");

    // Now `g x` goes to the feed and `g f` does not.
    await page.goto("/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("g");
    await page.keyboard.press("f");
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press("g");
    await page.keyboard.press("x");
    await expect(page).toHaveURL(/\/feed$/);

    // Reset all puts `g f` back.
    await page.goto("/shortcuts");
    await page.locator("button", { hasText: "Reset all" }).click();
    await expect(row.locator("button.sc-key").first()).toHaveText(/g\s*f/);
    expect(await page.evaluate((k) => localStorage.getItem(k), SHORTCUTS_KEY)).toBeNull();
  });

  test("a view's own keys win on its page: ? is the view's legend there, not the host's help", async ({ page }) => {
    await openPage(page, "/t/e2e-counter");
    await expect(page.locator(".e2e-counter")).toBeVisible();
    const legend = page.locator("[data-legend]");
    await expect(legend).toBeHidden();
    await page.locator("body").click({ position: { x: 700, y: 600 } });
    await page.keyboard.press("Shift+?");
    await expect(legend).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    // The host's mod chords and its `g …` sequences still work from the view.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("g");
    await page.keyboard.press("f");
    await expect(page).toHaveURL(/\/feed$/);
    // Off the view, `?` is the help again.
    await page.locator("body").click({ position: { x: 700, y: 600 } });
    await page.keyboard.press("Shift+?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  });

  test("a long page keeps its scroll through stream events and a panel (?s=) change", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    await openPage(page, "/connect");
    // The groups arrive whole once the receiver's info and the setup status are in.
    await expect(page.locator(".connect .form-group").first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 600));
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(300);
    // A stream event re-renders the app; a `?s=` change re-renders the shell and the panel.
    const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
    const batch = tier1Batch({ title: "Scroll keeper" });
    const res = await request.post(EVENTS, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sinkToken}`,
        "sessionpipe-protocol": "1",
      },
      data: { events: batch.events },
    });
    expect(res.ok()).toBeTruthy();
    await page.evaluate((key) => {
      history.pushState(null, "", `${location.pathname}?s=${encodeURIComponent(key)}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `${batch.harness}:${batch.sessionId}`);
    await page.waitForTimeout(1500);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThanOrEqual(2);
  });

  test("dialogs trap focus and give it back: quick settings, the More sheet is phone-only", async ({ page }) => {
    await openBoard(page);
    const trigger = page.locator("nav.rail button[aria-label='Quick settings']");
    await trigger.focus();
    await page.keyboard.press("Enter");
    const pop = page.getByRole("dialog", { name: "Quick settings" });
    await expect(pop).toBeVisible();
    await expect(pop).toHaveAttribute("aria-modal", "true");
    // Focus is inside and stays inside through a full Tab cycle.
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".qs-pop"))).toBe(true);
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".qs-pop"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("a dropped stream is spoken once, never as a countdown, and Retry's focus goes to the page when it is back", async ({
    page,
  }) => {
    await tapStream(page);
    await openBoard(page);
    // A first connect says nothing.
    const spoken = page.locator("[data-conn-announcer]");
    await expect(spoken).toHaveAttribute("role", "status");
    await expect(spoken).toHaveText("");

    const back = await dropStream(page);
    await expect(spoken).toHaveText("Reconnecting.");
    // The words a person reads are in the bar, with the one Retry, and are no live region.
    const bar = page.locator(".bar-conn");
    await expect(bar).toContainText("Reconnecting…");
    await expect(bar.locator("xpath=ancestor-or-self::*[@aria-live or @role='status']")).toHaveCount(0);
    await axe(page, "board, reconnecting");
    // No live region says the stream's state with a number in it: every retry that fails
    // leaves what is spoken as it was, and nothing in the bar or the sidebar's foot counts down.
    const counting = async () =>
      (
        await page
          .locator("[aria-live], [role=status], [role=alert]")
          .evaluateAll((els) => els.map((el) => el.textContent ?? ""))
      ).filter((t) => /Reconnecting|Offline/.test(t) && /\d/.test(t));
    expect(await counting()).toEqual([]);
    await page.waitForTimeout(2500);
    await expect(spoken).toHaveText("Reconnecting.");
    expect(await counting()).toEqual([]);
    await expect(page.locator(".bar, .rail-foot").getByText(/\d s$/)).toHaveCount(0);

    // Back: said once, and the focus Retry held is the page's, not nowhere. (The transport's
    // own backoff may get there before the key does; the button is gone then, and the
    // focus has gone to the page the same way.)
    const retry = bar.getByRole("button", { name: "Retry", exact: true });
    await retry.focus();
    await expect(retry).toBeFocused();
    await back();
    await page.keyboard.press("Enter");
    await expect(spoken).toHaveText("Reconnected.");
    await expect(bar).toHaveCount(0);
    await expect(page.locator("main#main")).toBeFocused();
  });
});

/** A token's colour as getComputedStyle writes it (rgb(…)). */
const tokenColour = (page: Page, name: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.body.appendChild(document.createElement("i"));
    probe.style.color = `var(${name})`;
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

test.describe("focus is ink", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project only");

  for (const [scheme, ink] of [
    ["light", "rgb(20, 20, 20)"],
    ["dark", "rgb(245, 245, 243)"],
  ] as const) {
    test(`${scheme}: the ring, the board's search and the j/k cursor`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openBoard(page);
      const meta = await tokenColour(page, "--fg-3");
      expect(meta).not.toBe(ink);

      // Tab to the first button: the ring is the ink.
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        if (await page.evaluate(() => document.activeElement?.tagName === "BUTTON")) break;
      }
      const ring = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement!);
        return { tag: document.activeElement!.tagName, color: s.outlineColor, style: s.outlineStyle };
      });
      expect(ring).toEqual({ tag: "BUTTON", color: ink, style: "solid" });

      // The board's search: its edge steps to the meta ink.
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("/");
      await expect(page.locator("input[data-search]")).toBeFocused();
      await expect(page.locator(".search")).toHaveCSS("border-top-color", meta);
      await page.keyboard.press("Escape");

      // j twice: the cursor's edge is a 1 px inset in the meta ink, on the selection fill.
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("j");
      await page.keyboard.press("j");
      const row = page.locator("article.card[aria-current='true'] > .card-row");
      await expect(row.locator("> .card-link")).toBeFocused();
      await expect(row).toHaveCSS("box-shadow", `${meta} 0px 0px 0px 1px inset`);
      // Increase contrast: 2 px, in the tier the setting lifts the meta ink to.
      await page.emulateMedia({ contrast: "more" });
      const more = await tokenColour(page, "--fg-3");
      await expect(row).toHaveCSS("box-shadow", `${more} 0px 0px 0px 2px inset`);
    });

    test(`${scheme}: a field's edge steps to the meta ink`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openBoard(page);
      const meta = await tokenColour(page, "--fg-3");
      // Edit labels…: the meta ink, never the orange.
      await page.getByRole("button", { name: "View options" }).click();
      await page.getByRole("menuitem", { name: "Edit labels…" }).click();
      const red = page.getByRole("dialog", { name: "Labels" }).getByRole("textbox", { name: "Red label name" });
      await red.focus();
      await expect(red).toHaveCSS("border-top-color", meta);
    });
  }

  test("the composer's edge steps to the meta ink and it never glows", async ({ context, page }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const d = await fakeDaemon(key, {
      name: `ink-${Math.random().toString(36).slice(2, 8)}`,
      harnesses: ["claude-code"],
      folders: ["/Users/e2e/code"],
      mode: "auto",
    });
    try {
      const s = await postSession(await sinkToken(), { machine: d.name, cwd: "/Users/e2e/code", title: "Ink" });
      await page.goto(`${CONTROL_BASE}${sessionUrl(s.harness, s.id)}`);
      const box = composer(page);
      await expect(box).toBeEnabled();
      await box.focus();
      const field = page.locator(".ctl-field");
      await expect(field).toHaveCSS("border-top-color", await tokenColour(page, "--fg-3"));
      await expect(field).toHaveCSS("box-shadow", "none");
    } finally {
      await d.stop();
    }
  });

  test("a menu's item has the cursor edge when the keys put it there, the fill alone under the pointer", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openBoard(page);
    const edge = `${await tokenColour(page, "--fg-3")} 0px 0px 0px 1px inset`;
    const menu = page.locator(".menu[data-depth='0']");
    const active = menu.locator(".menu-item--active");
    // `.` on the j cursor: the menu opens on its first item, the keys'.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("j");
    await page.keyboard.press(".");
    await expect(menu).toBeVisible();
    await expect(active).toHaveCSS("box-shadow", edge);
    await page.keyboard.press("ArrowDown");
    await expect(active).toHaveCSS("box-shadow", edge);
    // The mouse onto an item (one with no submenu): the fill alone.
    const plain = menu.locator(".menu-item:not([aria-haspopup]):not([aria-disabled='true'])");
    await plain.nth(1).hover();
    await expect(plain.nth(1)).toHaveClass(/menu-item--active/);
    await expect(active).toHaveCSS("box-shadow", "none");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // Opened by a right-click and hovered: the fill alone; an arrow key brings the edge.
    await page.locator("article.card a.card-link").first().click({ button: "right" });
    await expect(menu).toBeVisible();
    await plain.first().hover();
    await expect(plain.first()).toHaveClass(/menu-item--active/);
    await expect(active).toHaveCSS("box-shadow", "none");
    await page.keyboard.press("ArrowDown");
    await expect(active).toHaveCSS("box-shadow", edge);
    await page.keyboard.press("Escape");
  });

  test("in the Mac app, text selection is the system's own", async ({ page }) => {
    await openBoard(page);
    await page.evaluate(() => {
      document.documentElement.dataset.shell = "macos";
    });
    // No rule of the app's styles ::selection on this page.
    const rules = await page.evaluate(() => {
      const out: string[] = [];
      const walk = (list: CSSRuleList) => {
        for (const r of Array.from(list)) {
          if (r instanceof CSSStyleRule && r.selectorText.includes("::selection")) {
            const host = r.selectorText.replace(/\s*::selection/g, "").trim() || "*";
            if (document.documentElement.matches(host) || document.body.matches(host)) out.push(r.selectorText);
          }
          if ("cssRules" in r) walk((r as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
      return out;
    });
    expect(rules).toEqual([]);
    // And the engine agrees: an author rule shows in the selection's computed colour, and
    // without one it is the engine's own.
    const read = () =>
      page.evaluate(() => getComputedStyle(document.querySelector("main")!, "::selection").backgroundColor);
    const own = await read();
    await page.addStyleTag({ content: "::selection { background: rgb(1, 2, 3); }" });
    expect(await read()).toBe("rgb(1, 2, 3)");
    expect(own).not.toBe("rgb(1, 2, 3)");
  });
});
