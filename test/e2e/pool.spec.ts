// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The Usage page's pooled section (UX-SPEC §3–§5, §9): drawn from the demo's hellos with
// the right status words and never twice; and, against the test-door instance with a fake
// daemon whose hello carries a pool, the signed commands it sends: the switch (optimistic,
// reverting on a refusal), Move down holding the order with "saving order…" until the
// hello confirms it, Remove asking first, and the Add account sheet's command and sign-in
// path (login.begin → the link → login.complete with the pasted code; the # check; the
// expired line). The phone project draws the section as one inset group with no
// horizontal scroll.
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { CONTROL_BASE, passkeyPage, seenSetupHere } from "./control-helpers.js";
import { openPage } from "./helpers.js";
import { poolDaemon } from "./pool-helpers.js";

const tag = () => randomUUID().slice(0, 6);
const section = (page: Page, machine: string) => page.locator(`section[data-pool="${machine}"]`);
const row = (page: Page, machine: string, name: string) =>
  section(page, machine).locator("li.pool-acct", { has: page.locator(".pool-title", { hasText: name }) });
/** Axe's serious and critical violations on the page right now, as one line each. */
async function axeBad(page: Page, label: string): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test.describe("the pooled section, from the demo", () => {
  test("lab-mac, mini-mac and desk-pc: the words, the order, nothing drawn twice", async ({ page, isMobile }) => {
    await openPage(page, "/usage");
    const lab = section(page, "lab-mac");
    await expect(lab.locator(".usage-title")).toHaveText("Claude accounts on lab-mac");
    await expect(lab.locator(isMobile ? ".pool-foot" : "[data-pool-meta]")).toHaveText("3 accounts, 2 with room");
    await expect(lab.getByRole("switch", { name: "Switch accounts when one runs out" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(lab.locator(".form-caption").first()).toHaveText(
      "Requests go to the first account in this order that has room; a session stays on its account while it has room. Claude Code on lab-mac sends through sessionpipe while this is on.",
    );
    await expect(lab.locator("li.pool-acct .pool-title")).toHaveText(["Misha", "Fiction", "Spacesheep"]);
    await expect(lab.locator("li.pool-acct .pool-word")).toHaveText(["In use", "Has room", "Used up"]);
    const sheep = row(page, "lab-mac", "Spacesheep");
    await expect(sheep.locator(".pool-status-after")).toHaveText(/^resets in 2 h \d{2} m$/);
    await expect(sheep.locator('[data-window="five_hour"] .usage-value')).toHaveText("<1% left");
    // Fiction has no numbers yet: no rows, and no "No numbers yet" either.
    await expect(row(page, "lab-mac", "Fiction").locator(".usage-win")).toHaveCount(0);
    await expect(lab).not.toContainText("No numbers yet");
    // The one accent in the section is "Used up".
    await expect(lab.locator(".pool-status--needs .pool-word")).toHaveText(["Used up"]);
    await expect(lab.locator("[data-pool-add]")).toHaveText("Add account…");
    if (!isMobile) {
      // Pooled sections come before the free-standing ones; a pooled account is never free-standing.
      const first = page.locator("#main section").first();
      await expect(first).toHaveAttribute("data-pool", /./);
      await expect(page.locator("section.usage-acct", { hasText: "dev@example.com" })).toHaveCount(0);
    }
    // mini-mac: an account in error is a quiet button, a disabled one says Off.
    const mini = section(page, "mini-mac");
    await expect(mini.getByRole("button", { name: "Sign in again…" })).toBeVisible();
    await expect(row(page, "mini-mac", "Old").locator(".pool-word")).toHaveText("Off");
    await expect(mini.locator(isMobile ? ".pool-foot" : "[data-pool-meta]")).toHaveText("3 accounts, 1 with room");
    // desk-pc: the switch off, never "In use", the hint's off sentence.
    const desk = section(page, "desk-pc");
    await expect(desk.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await expect(desk).not.toContainText("In use");
    await expect(desk.locator(".form-caption").first()).toHaveText(/Claude Code on desk-pc uses its own login\.$/);
    // "None left" is a window's word; no pooled account's status says it.
    await expect(page.locator("section[data-pool]").filter({ hasText: "None left" })).toHaveCount(0);
    // Never a "% used", never the account id.
    const html = await page.locator("#main").innerHTML();
    expect(html).not.toMatch(/% used/);
    expect(html).not.toMatch(/01K8[A-Z0-9]{20}/);
  });

  test("the geometry: one lead edge, inset window rules, the switch on its label, the trail beside the word", async ({
    page,
    isMobile,
  }) => {
    await openPage(page, "/usage");
    const lab = section(page, "lab-mac");
    await lab.scrollIntoViewIfNeeded();
    const box = async (l: ReturnType<Page["locator"]>) => (await l.boundingBox())!;
    const left = async (l: ReturnType<Page["locator"]>) => (await box(l)).x;
    const cy = async (l: ReturnType<Page["locator"]>) => {
      const b = await box(l);
      return b.y + b.height / 2;
    };
    const textRight = (l: ReturnType<Page["locator"]>) =>
      l.evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return r.getBoundingClientRect().right;
      });
    const sheep = row(page, "lab-mac", "Spacesheep");
    const win = sheep.locator(".pool-windows .usage-win").first();
    if (!isMobile) {
      // One lead edge: the title, the switch's label, the names and "Add account…".
      const edge = await left(lab.locator(".usage-title"));
      expect(await left(lab.locator(".pool-switch .form-label"))).toBe(edge);
      expect(await left(lab.locator(".pool-title").first())).toBe(edge);
      expect(
        await lab.locator(".pool-add").evaluate((el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return r.getBoundingClientRect().left;
        }),
      ).toBe(edge);
      // A window's rule starts under its label, one step in; the bar stays on the page's
      // bar line, the same in a free-standing section (whose rules start at its labels too).
      expect(await left(win)).toBe(edge + 24);
      expect(await left(win.locator(".usage-label"))).toBe(edge + 24);
      expect(await left(sheep.locator(".pool-row"))).toBe(edge - 24);
      const free = page.locator("section.usage-acct").first();
      expect(await left(win.locator(".usage-bar"))).toBe(await left(free.locator(".usage-bar").first()));
      expect(await left(free.locator(".usage-win").first())).toBe(await left(free.locator(".usage-label").first()));
      // The switch on the label's line, not on the paragraph.
      expect(
        Math.abs((await cy(lab.locator(".toggle"))) - (await cy(lab.locator(".pool-switch .form-label")))),
      ).toBeLessThanOrEqual(1);
      // The word and its trail on one baseline; "Sign in again…" ending where "Off" ends.
      const word = await box(sheep.locator(".pool-word"));
      const sub = await box(sheep.locator(".pool-status-sub"));
      expect(Math.abs(word.y + word.height - (sub.y + sub.height))).toBeLessThan(2);
      const mini = section(page, "mini-mac");
      expect(await textRight(mini.getByRole("button", { name: "Sign in again…" }))).toBe(
        await textRight(row(page, "mini-mac", "Old").locator(".pool-word")),
      );
      // "Sending works from…" sits 16 px above the first header.
      const note = await box(page.locator(".machines-note"));
      const first = await box(page.locator("#main section").first());
      expect(first.y - (note.y + note.height)).toBe(16);
      // A pointer landing beside the grip's mark still lands on the grip.
      const grip = sheep.locator(".pool-grip");
      const g = await box(grip);
      expect(
        await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [g.x - 6, g.y + g.height / 2] as [
          number,
          number,
        ]),
      ).toBe("pool-grip");
      // With its menu open the row is the selection pill; closed, it is the page again.
      const fiction = row(page, "lab-mac", "Fiction").locator(".pool-row");
      const bg = (l: ReturnType<Page["locator"]>) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
      const plain = await bg(fiction);
      await fiction.click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(fiction).toHaveAttribute("data-menu-open", "");
      await expect.poll(() => bg(fiction)).not.toBe(plain);
      expect(await fiction.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("6px");
      await page.keyboard.press("Escape");
      await expect(fiction).not.toHaveAttribute("data-menu-open", "");
      await expect.poll(() => bg(fiction)).toBe(plain);
    } else {
      // Spacesheep's cell: the name and the word, the email, then "resets in … · numbers
      // as of …" as one third line, nothing drawn over anything (the numbers' age is
      // there only once the demo's report is old enough to say so).
      const email = await box(sheep.locator(".pool-email"));
      const after = await box(sheep.locator(".pool-status-after"));
      expect(after.y).toBeGreaterThanOrEqual(email.y + email.height - 1);
      await expect(sheep.locator(".pool-status-sub")).toHaveText(/^resets in 2 h \d{2} m/);
      if (await sheep.locator(".pool-age").count()) {
        const age = await box(sheep.locator(".pool-age"));
        expect(Math.abs(after.y - age.y)).toBeLessThan(1);
        expect(after.x + after.width <= age.x || age.x + age.width <= after.x).toBe(true);
      }
      // The switch centred on the label's first line; the window row 16 px in from the name.
      expect(
        Math.abs((await cy(lab.locator(".toggle"))) - (await cy(lab.locator(".pool-switch .form-label")))),
      ).toBeLessThanOrEqual(1);
      expect(await left(win)).toBe((await left(sheep.locator(".pool-title"))) + 16);
      expect(await left(win.locator(".usage-label"))).toBe(await left(win));
    }
  });

  test("axe: the page with the section has no serious or critical violation", async ({ page, isMobile }) => {
    test.skip(!!isMobile, "the desktop project");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPage(page, "/usage");
    expect(await axeBad(page, "usage")).toEqual([]);
  });

  test("the section's ··· opens on the first click; a section taller than the window holds still", async ({
    page,
    isMobile,
  }) => {
    test.skip(!!isMobile, "the desktop project");
    await openPage(page, "/usage");
    // lab-mac's section starts mid-window and runs past its bottom (three accounts, two with
    // windows); the click's focus must not scroll it out from under the pointer.
    const lab = section(page, "lab-mac");
    const box = (await lab.boundingBox())!;
    expect(box.y).toBeGreaterThan(0);
    expect(box.y + box.height).toBeGreaterThan(900);
    const before = await page.evaluate(() => window.scrollY);
    await lab.locator(".usage-head .icon-btn").click();
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await expect(page.getByRole("menuitem")).toHaveText(["Add account…", "Refresh usage", "Copy setup command"]);
    await page.keyboard.press("Escape");
  });

  test("phone: one inset group, the grip at the trailing edge, no horizontal scroll", async ({ page, isMobile }) => {
    test.skip(!isMobile, "the phone project");
    await openPage(page, "/usage");
    const lab = section(page, "lab-mac");
    await lab.scrollIntoViewIfNeeded();
    const grip = row(page, "lab-mac", "Fiction").locator(".pool-grip");
    await expect(grip).toBeVisible();
    expect(await grip.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    const rowBox = (await row(page, "lab-mac", "Fiction").boundingBox())!;
    const gripBox = (await grip.boundingBox())!;
    expect(gripBox.x + gripBox.width).toBeGreaterThan(rowBox.x + rowBox.width - 60);
    expect(gripBox.height).toBeGreaterThanOrEqual(44);
    await expect(lab.locator(".pool-foot")).toHaveText("3 accounts, 2 with room");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The row's ··· is the long press's job here; the header's opens the section menu as a sheet.
    const sheet = page.getByRole("menu");
    await expect(async () => {
      await lab.locator(".usage-head .icon-btn").click();
      await expect(sheet).toBeVisible({ timeout: 1500 });
    }).toPass();
    await expect(sheet.getByRole("menuitem")).toHaveText(["Add account…", "Refresh usage", "Copy setup command"]);
    await page.keyboard.press("Escape");
  });
});

// ----- signed commands, against the test door with a fake daemon (pool-helpers.ts) -----

test.describe("signed pool commands", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project");
  test.describe.configure({ mode: "serial" });

  test("the switch sends off and on, flips at once, and reverts with the note when refused", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const name = `lab-${tag()}`;
    let refuse = false;
    const m = await poolDaemon(key, name, {
      refuse: (a) => (refuse && a === "on" ? { code: "pool_unsupported" } : null),
    });
    try {
      await page.goto(`${CONTROL_BASE}/usage`);
      const s = section(page, name);
      const sw = s.getByRole("switch", { name: "Switch accounts when one runs out" });
      await expect(sw).toHaveAttribute("aria-checked", "true");
      await expect(s.locator("li.pool-acct .pool-word").first()).toHaveText("In use");
      // The switch answers 10 px above its track: its reach, not just its 18 px.
      const t = (await sw.boundingBox())!;
      await page.mouse.click(t.x + t.width / 2, t.y - 10);
      // Optimistic: off before the machine answers, and "In use" goes with it.
      await expect(sw).toHaveAttribute("aria-checked", "false");
      await expect(s.locator("li.pool-acct .pool-word").first()).toHaveText("Has room");
      await expect.poll(() => m.seen.map((c) => c.pool_action)).toEqual(["off"]);
      expect(m.seen[0]!.session).toBe("sessionpipe:pool");
      // The hello confirms it: the hint's off sentence, and the switch stays.
      await expect(s.locator(".form-caption").first()).toHaveText(/uses its own login\.$/);
      await expect(sw).toHaveAttribute("aria-checked", "false");
      await expect(sw).toBeEnabled();

      refuse = true;
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "true");
      await expect(s.locator("[data-pool-note]")).toHaveText(/^lab-.* refused it: /);
      await expect(s.locator("[data-pool-note]")).toHaveClass(/is-err/);
      await expect(sw).toHaveAttribute("aria-checked", "false");
      await expect.poll(() => m.seen.map((c) => c.pool_action)).toEqual(["off", "on"]);
    } finally {
      await m.stop();
    }
  });

  test("Move down holds the new order with 'saving order…' until the hello; Remove asks first", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const name = `lab-${tag()}`;
    const m = await poolDaemon(key, name);
    try {
      await page.goto(`${CONTROL_BASE}/usage`);
      const s = section(page, name);
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Misha", "Fiction", "Spacesheep"]);
      await row(page, name, "Misha").locator(".pool-row").click({ button: "right" });
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem")).toHaveText([
        "Move up",
        "Move down",
        "Turn off",
        "Refresh usage",
        "Remove…",
      ]);
      await expect(menu.getByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
      await menu.getByRole("menuitem", { name: "Move down" }).click();
      // Held at once, named in the header, then confirmed by the hello.
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Fiction", "Misha", "Spacesheep"]);
      await expect(s.locator("[data-pool-meta]")).toHaveText("saving order…");
      await expect.poll(() => m.seen.map((c) => c.pool_action)).toEqual(["order"]);
      expect(m.seen[0]!.pool_order).toEqual(["a2", "a1", "a3"]);
      await expect(s.locator("[data-pool-meta]")).toHaveText("3 accounts, 3 with room");
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Fiction", "Misha", "Spacesheep"]);

      // Remove: the ask, Esc sends nothing; Remove sends it.
      await page.waitForTimeout(450);
      await row(page, name, "Spacesheep").locator(".icon-btn").last().click();
      await page.getByRole("menu").getByRole("menuitem", { name: "Remove…" }).click();
      const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
      await expect(dialog).toContainText(`Remove Spacesheep from ${name}?`);
      await expect(dialog).toContainText(
        `sessionpipe forgets its sign-in on ${name}. Sessions on it move to the next account with room. Claude Code's own login is not touched.`,
      );
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await page.waitForTimeout(300);
      expect(m.seen.map((c) => c.pool_action)).toEqual(["order"]);
      await row(page, name, "Spacesheep").locator(".icon-btn").last().click();
      await page.getByRole("menu").getByRole("menuitem", { name: "Remove…" }).click();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await expect.poll(() => m.seen.map((c) => c.pool_action)).toEqual(["order", "remove"]);
      expect(m.seen[1]!.pool_account).toBe("a3");
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Fiction", "Misha"]);
      await expect(s.locator("[data-pool-live]")).toHaveText(`Removed Spacesheep from ${name}`);
    } finally {
      await m.stop();
    }
  });

  test("the keyboard: Space picks a row up, the arrows move it, Space drops it and sends one order", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const name = `lab-${tag()}`;
    const m = await poolDaemon(key, name);
    try {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(`${CONTROL_BASE}/usage`);
      const s = section(page, name);
      const grip = row(page, name, "Spacesheep").locator(".pool-grip");
      const bg = () => row(page, name, "Spacesheep").evaluate((el) => getComputedStyle(el).backgroundColor);
      const pageBg = await bg();
      await grip.focus();
      await page.keyboard.press("Space");
      await expect(s.locator("[data-pool-live]")).toHaveText("Picked up Spacesheep");
      await expect(row(page, name, "Spacesheep")).toHaveAttribute("data-grabbed", "");
      // Lifted: on the raised ground (visible in dark, where a shadow is not), with corners.
      await expect.poll(bg).toBe("rgb(42, 42, 42)");
      expect(await row(page, name, "Spacesheep").evaluate((el) => getComputedStyle(el).borderRadius)).toBe("6px");
      await page.keyboard.press("ArrowUp");
      await expect(s.locator("[data-pool-live]")).toHaveText("Moved to position 2 of 3");
      await page.keyboard.press("ArrowUp");
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Spacesheep", "Misha", "Fiction"]);
      expect(m.seen).toHaveLength(0);
      await page.keyboard.press("Escape");
      await expect(s.locator("[data-pool-live]")).toHaveText("Cancelled, order unchanged");
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Misha", "Fiction", "Spacesheep"]);
      await expect.poll(bg).toBe(pageBg);
      await grip.focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Space");
      await expect(s.locator("[data-pool-live]")).toHaveText("Dropped");
      await expect.poll(() => m.seen.map((c) => c.pool_order)).toEqual([["a1", "a3", "a2"]]);
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Misha", "Spacesheep", "Fiction"]);
    } finally {
      await m.stop();
    }
  });

  test("the pointer: a row lifts past 6 px, crosses its neighbour, settles, and sends one order", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const name = `lab-${tag()}`;
    const m = await poolDaemon(key, name);
    try {
      // The rows' slide after a hello would move the second drag's target under the mouse.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${CONTROL_BASE}/usage`);
      const s = section(page, name);
      const fiction = row(page, name, "Fiction");
      const box = (await fiction.locator(".pool-row").boundingBox())!;
      const x = box.x + 160;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      // Under 6 px nothing lifts.
      await page.mouse.move(x, y + 3);
      await expect(fiction).not.toHaveAttribute("data-dragging", "");
      await page.mouse.move(x, y + 12, { steps: 2 });
      await expect(fiction).toHaveAttribute("data-dragging", "");
      await expect(s.locator("[data-pool-live]")).toHaveText("Picked up Fiction");
      // The lifted row rides under the pointer, inside the list, over its neighbour.
      await page.mouse.move(x, y + box.height * 1.5, { steps: 6 });
      const lifted = (await fiction.boundingBox())!;
      expect(Math.abs(lifted.y + lifted.height / 2 - (y + box.height * 1.5))).toBeLessThan(lifted.height);
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Misha", "Spacesheep", "Fiction"]);
      expect(m.seen).toHaveLength(0);
      await page.mouse.up();
      await expect(fiction).not.toHaveAttribute("data-dragging", "");
      await expect(s.locator("[data-pool-meta]")).toHaveText("saving order…");
      await expect.poll(() => m.seen.map((c) => c.pool_order)).toEqual([["a1", "a3", "a2"]]);
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Misha", "Spacesheep", "Fiction"]);
      await expect(s.locator("[data-pool-meta]")).toHaveText("3 accounts, 3 with room");
      // Esc mid-drag puts the row back and sends nothing.
      const sheep = row(page, name, "Spacesheep");
      const b2 = (await sheep.locator(".pool-row").boundingBox())!;
      await page.mouse.move(b2.x + 160, b2.y + b2.height / 2);
      await page.mouse.down();
      await page.mouse.move(b2.x + 160, b2.y + b2.height / 2 + b2.height * 1.5, { steps: 6 });
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Misha", "Fiction", "Spacesheep"]);
      await page.keyboard.press("Escape");
      await expect(s.locator("[data-pool-live]")).toHaveText("Cancelled, order unchanged");
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Misha", "Spacesheep", "Fiction"]);
      await page.mouse.up();
      await page.waitForTimeout(300);
      expect(m.seen).toHaveLength(1);
    } finally {
      await m.stop();
    }
  });

  test("the Add account sheet: the command, then the sign-in from link to code", async ({ context, page }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const name = `lab-${tag()}`;
    const m = await poolDaemon(key, name);
    try {
      await page.goto(`${CONTROL_BASE}/usage`);
      const s = section(page, name);
      await s.locator("[data-pool-add]").click();
      const sheet = page.locator("[data-pool-sheet]");
      await expect(sheet.getByRole("heading", { level: 2 })).toHaveText(`Add a Claude account to ${name}`);
      // Sign-in first when the pool has accounts; the command group under it.
      await expect(sheet.locator("section").first()).toHaveAttribute("data-pool-signin-group", "");
      await expect(sheet.locator("[data-pool-command] .cmdwell")).toContainText("sessionpipe pool add --import");
      await expect(sheet.locator("[data-pool-command]")).toContainText("sessionpipe pool add --login");
      await expect(sheet.locator("[data-pool-signin]")).toBeFocused();
      await sheet.locator("[data-pool-signin]").click();
      await expect.poll(() => m.seen.map((c) => c.pool_action)).toEqual(["login.begin"]);
      // Link ready: Open claude.ai, the URL in a well, the code field focused, Done waiting for a #.
      const open = sheet.locator("[data-pool-open]");
      await expect(open).toHaveAttribute("href", "https://claude.ai/oauth/authorize?e2e=1");
      await expect(open).toHaveAttribute("target", "_blank");
      await expect(sheet.locator(".cmdwell", { hasText: "https://claude.ai" })).toBeVisible();
      const code = sheet.locator("[data-pool-code]");
      await expect(code).toBeFocused();
      await expect(sheet.locator("[data-pool-done]")).toBeDisabled();
      expect(await sheet.innerHTML()).not.toContain("pl_e2e1");
      await code.fill("expired#x");
      await sheet.locator("[data-pool-done]").click();
      await expect.poll(() => m.seen.map((c) => c.pool_action)).toEqual(["login.begin", "login.complete"]);
      expect(m.seen[1]!.pool_account).toBe("pl_e2e1");
      expect(m.seen[1]!.pool_code).toBe("expired#x");
      await expect(sheet.locator("[data-pool-error]")).toHaveText(
        "The sign-in took too long. Start over to get a new link.",
      );
      expect(await axeBad(page, "sheet")).toEqual([]);
      await sheet.locator("[data-pool-restart]").click();
      await expect
        .poll(() => m.seen.map((c) => c.pool_action))
        .toEqual(["login.begin", "login.complete", "login.begin"]);
      await expect(code).toHaveValue("");
      await code.fill("abc#state");
      await code.press("Enter");
      await expect
        .poll(() => m.seen.map((c) => c.pool_action))
        .toEqual(["login.begin", "login.complete", "login.begin", "login.complete"]);
      await expect(sheet).toHaveCount(0);
      await expect(s.locator("li.pool-acct .pool-title")).toHaveText(["Misha", "Fiction", "Spacesheep", "New"]);
      await expect(s.locator("[data-pool-live]")).toHaveText(`Added New to ${name}`);
    } finally {
      await m.stop();
    }
  });

  test("the Add account sheet turns a pool that is off on before the sign-in, never refused", async ({
    context,
    page,
  }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const name = `lab-${tag()}`;
    const m = await poolDaemon(key, name, { on: false });
    try {
      await page.goto(`${CONTROL_BASE}/usage`);
      const s = section(page, name);
      await s.locator("[data-pool-add]").click();
      const sheet = page.locator("[data-pool-sheet]");
      // The lead says what the one button does; the button reads as it always does.
      await expect(sheet.locator("[data-pool-lead]")).toHaveText(
        `${name} turns its pool on, then opens a sign-in link; you sign in on claude.ai and paste the code it shows. Nothing from the account reaches this device.`,
      );
      await expect(sheet.locator("[data-pool-signin]")).toHaveText(/Sign in/);
      await sheet.locator("[data-pool-signin]").click();
      // `on` first (the page's own switch command, a fresh confirm), then login.begin once
      // its ack is delivered; the link arrives and no pool_off line is ever shown.
      await expect.poll(() => m.seen.map((c) => c.pool_action)).toEqual(["on", "login.begin"]);
      await expect(sheet.locator("[data-pool-code]")).toBeVisible();
      await expect(sheet.locator("[data-pool-error]")).toHaveCount(0);
      expect(m.state.on).toBe(true);
    } finally {
      await m.stop();
    }
  });
});
