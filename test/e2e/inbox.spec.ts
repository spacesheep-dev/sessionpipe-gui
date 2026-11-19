// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The inbox: the demo's permission prompts appear as rows (Allow disabled with the
// unpaired reason, since no demo machine is paired), leave when the demo clears them, and
// count in the tab title's "(n)" and the nav badge. Notifications: the "Notify me" switch,
// behind the bell in the page bar, asks the browser once and persists; a new prompt
// notifies a background tab. The browser's Notification is mocked, since Chromium would
// never grant it here. On a paired machine, a prompt whose hook stopped waiting moves
// down to the terminal's, saying why, with nothing to press.
import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CONTROL_BASE, fakeDaemon, passkeyPage, postPrompt, seenSetupHere, sinkToken } from "./control-helpers.js";
import { openPage, strandedMarks } from "./helpers.js";

declare global {
  interface Window {
    __notifications: { title: string; body?: string; tag?: string; onclick: (() => void) | null }[];
    __permissionRequests: number;
  }
}

/** Every test's prompts and answers reach every page on the one e2e server, as banners at
 *  the top right, over a row's pair: a test that points at the pair keeps them out of it. */
const hideBanners = (page: Page) => page.addStyleTag({ content: ".toasts { display: none !important; }" });

/** A Notification that records itself; its permission lives in localStorage so it survives
 *  a reload like the real one would. `focused: false` makes the page look like a background tab. */
const mockNotifications = (page: Page, opts: { permission?: string; focused?: boolean } = {}) =>
  page.addInitScript(
    ({ permission, focused }) => {
      window.__notifications = [];
      window.__permissionRequests = 0;
      const key = "__e2e.notification.permission";
      if (permission) localStorage.setItem(key, permission);
      class MockNotification {
        static get permission() {
          return localStorage.getItem(key) ?? "default";
        }
        static requestPermission() {
          window.__permissionRequests++;
          localStorage.setItem(key, "granted");
          return Promise.resolve("granted");
        }
        onclick: (() => void) | null = null;
        constructor(
          public title: string,
          public options: { body?: string; tag?: string } = {},
        ) {
          window.__notifications.push(this as never);
        }
        close() {}
      }
      Object.defineProperty(window, "Notification", { value: MockNotification, configurable: true });
      if (focused === false) document.hasFocus = () => false;
    },
    { permission: opts.permission, focused: opts.focused },
  );

/** Reads the first answerable row in one go (it may vanish any moment: the demo's windows
 *  last about two seconds), or null when there is none yet. */
/** The bell's popover in the page bar, opened. */
const bell = async (page: Page) => {
  const head = page.locator(".inbox-head");
  const btn = head.getByRole("button", { name: "Notifications" });
  if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
  return head.getByRole("dialog", { name: "Notifications" });
};

const readRow = async (page: Page) => {
  const row = page.locator(".inbox-row--answerable").first();
  if ((await row.count()) === 0) return null;
  try {
    return {
      id: await row.getAttribute("data-attention", { timeout: 500 }),
      title: await row.locator(".inbox-title").textContent({ timeout: 500 }),
      machine: await row.locator(".inbox-machine").textContent({ timeout: 500 }),
      kind: await row.locator(".inbox-kind").textContent({ timeout: 500 }),
      tool: await row.locator(".inbox-what code").textContent({ timeout: 500 }),
      msg: await row.locator(".inbox-msg").textContent({ timeout: 500 }),
      age: await row.locator(".inbox-age").textContent({ timeout: 500 }),
      answer: await row.locator(".inbox-answer").getAttribute("data-answer", { timeout: 500 }),
      allowDisabled: await row.getByRole("button", { name: "Allow" }).isDisabled({ timeout: 500 }),
      denyDisabled: await row.getByRole("button", { name: "Deny" }).isDisabled({ timeout: 500 }),
      // Why Allow / Deny are off is said once under the page bar, not on every row.
      note: await page.locator(".inbox-reason").first().textContent({ timeout: 500 }),
      group: await row.locator("xpath=ancestor::section[1]").getAttribute("aria-label", { timeout: 500 }),
      title_: await page.title(),
      badge: await page.locator("nav.rail a[data-nav='inbox'] .nav-badge").textContent({ timeout: 500 }),
    };
  } catch {
    return null;
  }
};

test.describe("inbox", () => {
  test("a demo permission is a row that needs an answer, Allow disabled until the machine pairs, gone when cleared", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openPage(page, "/inbox");
    await expect(page.locator("nav.rail a[data-nav='inbox']")).toHaveAttribute("aria-current", "page");
    // With nothing open the page says so.
    if ((await page.locator(".inbox-row").count()) === 0)
      await expect(page.locator(".inbox-empty .state-title")).toHaveText("Nothing needs you");
    // The demo asks for a permission every 6–20 s and keeps it open ~2 s; read the row in one go.
    let seen: Awaited<ReturnType<typeof readRow>> = null;
    await expect
      .poll(
        async () => {
          const r = await readRow(page);
          if (r) seen = r;
          return r;
        },
        { timeout: 60_000, message: "an answerable row with its facts" },
      )
      .toMatchObject({
        id: expect.stringMatching(/\S/),
        title: expect.stringMatching(/\S/),
        machine: expect.stringMatching(/\S/),
        kind: "permission",
        tool: expect.stringMatching(/^\S+$/),
        msg: expect.stringMatching(/\S/),
        age: expect.stringMatching(/ago|just now/),
        answer: "unpaired",
        allowDisabled: true,
        denyDisabled: true,
        note: expect.stringMatching(/pair .+ to send messages/),
        group: "Needs an answer",
        title_: expect.stringMatching(/^\(\d+\) Inbox · sessionpipe gui$/),
        badge: expect.stringMatching(/^[1-9]\d*$/),
      });
    // The row leaves with the demo's attention.cleared, live, and the title drops its count
    // once no session needs you: nothing is left in the Inbox.
    await expect(page.locator(`.inbox-row[data-attention="${seen!.id}"]`)).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(
        async () => {
          const n = await page.locator(".inbox-row").count();
          const t = await page.title();
          return n === 0 ? t : `${n} rows: ${t}`;
        },
        { timeout: 30_000 },
      )
      .toBe("Inbox · sessionpipe gui");
    await expect(page.locator("nav.rail a[data-nav='inbox'] .nav-badge")).toHaveCount(0);
    await expect(page.locator("nav.rail a[data-nav='board'] .nav-badge")).toHaveCount(0);
  });

  test("a row click opens the session beside the page", async ({ page }) => {
    test.setTimeout(90_000);
    await openPage(page, "/inbox");
    await expect.poll(() => page.locator(".inbox-row").count(), { timeout: 60_000 }).toBeGreaterThan(0);
    const row = page.locator(".inbox-row").first();
    const title = (await row.locator(".inbox-title").textContent())!;
    await row.locator(".inbox-main").click();
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    await expect(page.locator("aside.panel .panel-title")).toHaveText(title);
    await expect(page).toHaveURL(/\/inbox\?(.*&)?s=/);
  });

  test("the title prefix follows the open prompts on every page", async ({ page }) => {
    test.setTimeout(90_000);
    await openPage(page, "/feed");
    await expect
      .poll(() => page.title(), { timeout: 60_000, message: "a (n) prefix on the Feed title" })
      .toMatch(/^\(\d+\) Feed · sessionpipe gui$/);
    await expect.poll(() => page.title(), { timeout: 30_000 }).toBe("Feed · sessionpipe gui");
  });

  test("Notify me asks the browser once and persists across a reload", async ({ page }) => {
    await mockNotifications(page);
    await openPage(page, "/inbox");
    const toggle = page.locator(".inbox-head").getByRole("switch", { name: "Notify me" });
    await bell(page);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => window.__permissionRequests)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("sessionpipe-gui.notify"))).toBe("1");

    await page.reload();
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await bell(page);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    // Granted already: turning it on again asks nothing; the Settings dialog's Notifications
    // section (where the header's "Sounds" link goes) shows the same switch.
    expect(await page.evaluate(() => window.__permissionRequests)).toBe(0);
    await (await bell(page)).getByRole("link", { name: "Sounds" }).click();
    await expect(page).toHaveURL(/\/inbox\?settings=notifications$/);
    const st = page.locator(".ntf").getByRole("switch", { name: "Notify me" });
    await expect(st).toHaveAttribute("aria-checked", "true");
    await st.click();
    await expect(st).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => localStorage.getItem("sessionpipe-gui.notify"))).toBeNull();
    await openPage(page, "/inbox");
    await bell(page);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("a blocked permission keeps the switch off and says why", async ({ page }) => {
    await mockNotifications(page, { permission: "denied" });
    await openPage(page, "/inbox");
    // Said once under the page bar, as a condition with its way out, not beside the switch.
    const notice = page.locator(".page.inbox > .inbox-notes .notify-hint");
    await expect(notice).toContainText("Notifications are off for this site");
    await notice.getByRole("button", { name: "How to allow" }).click();
    await expect(notice).toContainText("set Notifications to Allow");
    const toggle = page.locator(".inbox-head").getByRole("switch", { name: "Notify me" });
    await bell(page);
    await expect(toggle).toBeDisabled();
  });

  test("a new prompt notifies a background tab, and the notification opens the inbox", async ({ page }) => {
    test.setTimeout(90_000);
    await mockNotifications(page, { permission: "granted", focused: false });
    await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.notify", "1"));
    await openPage(page, "/");
    // Nothing for what was already open at the first snapshot…
    expect(await page.evaluate(() => window.__notifications.length)).toBe(0);
    // …one for the next permission the stream brings.
    await expect
      .poll(() => page.evaluate(() => window.__notifications.map((n) => n.title)), {
        timeout: 60_000,
        message: "a notification for a new permission prompt",
      })
      .toContainEqual(expect.stringMatching(/^.+ needs you · \S+$/));
    await page.evaluate(() => window.__notifications[0]!.onclick?.());
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.locator("nav.rail a[data-nav='inbox']")).toHaveAttribute("aria-current", "page");
  });
});

// A paired machine (the test-door instance, control-helpers.ts): Claude Code's hook waits
// 125 s for an answer, so past 120 s a prompt can no longer be answered from here.
test.describe("inbox: a prompt's answer window", () => {
  test("a prompt its hook stopped waiting on waits in the terminal, saying so, with nothing to press; a fresh one moves there as its window runs out", async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const token = await sinkToken();
    const d = await fakeDaemon(key, { name: `window-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] });
    const late = await postPrompt(token, { machine: d.name, title: "Asked 130 s ago", agoMs: 130_000 });
    const fresh = await postPrompt(token, { machine: d.name, title: "Asked 112 s ago", agoMs: 112_000 });
    try {
      await page.goto(`${CONTROL_BASE}/inbox`);
      // On a line of its own, a sentence.
      const words = `Too late to answer from here; answer it on ${d.name}.`;
      const terminal = page.locator("section[aria-label='Waiting in a terminal']");
      const lateRow = terminal.locator(`.inbox-row[data-attention="${late.attention}"]`);
      await expect(lateRow.locator(".inbox-late")).toHaveText(words);
      expect(await strandedMarks(lateRow.locator(".inbox-late"))).toEqual([]);
      await expect(lateRow.getByRole("button", { name: /^(Allow|Deny)$/ })).toHaveCount(0);
      // Inside its window: answerable as ever, and no page line for the late one.
      const freshRow = page.locator(`.inbox-row[data-attention="${fresh.attention}"]`);
      await expect(freshRow.locator("xpath=ancestor::section[1]")).toHaveAttribute("aria-label", "Needs an answer");
      await expect(freshRow.locator(".inbox-answer")).toHaveAttribute("data-answer", "open");
      await expect(freshRow.getByRole("button", { name: "Allow" })).toBeEnabled();
      // (Other specs' prompts on this instance may have a page line of their own.)
      const lines = page.locator(".inbox-reason", { hasText: /too late|paired/i });
      await expect(lines).toHaveCount(0);
      // Its window runs out with the page open: it moves down, and says why.
      await expect(terminal.locator(`.inbox-row[data-attention="${fresh.attention}"] .inbox-late`)).toHaveText(words, {
        timeout: 20_000,
      });
      await expect(freshRow.getByRole("button", { name: /^(Allow|Deny)$/ })).toHaveCount(0);
      await expect(lines).toHaveCount(0);
    } finally {
      await late.clear();
      await fresh.clear();
      await d.stop();
    }
  });
});

test.describe("inbox: an answer refused", () => {
  test("says it as the session's page does: Not sent, and why; Allow stays", async ({ context, page }) => {
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const token = await sinkToken();
    const d = await fakeDaemon(key, { name: `refuse-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] });
    const asked = await postPrompt(token, { machine: d.name, title: "Asked a moment ago", agoMs: 5_000 });
    try {
      await page.route("**/api/ui/control/send", (r) =>
        r.fulfill({ status: 422, json: { reason: "refused", code: "nonce_store" } }),
      );
      await page.goto(`${CONTROL_BASE}/inbox`);
      await hideBanners(page);
      const row = page.locator(`.inbox-row[data-attention="${asked.attention}"]`);
      // With a pointer the pair shows on the hovered row.
      await row.hover();
      await row.getByRole("button", { name: "Allow" }).click();
      const note = row.locator(".inbox-note--err");
      await expect(note).toHaveText("Not sent: the machine could not record the nonce, so it did not run it");
      await expect(row.getByRole("button", { name: "Allow" })).toBeEnabled();
      // The line takes room of its own at the row's end, the pair shown beside it: hovered
      // or not, it lies over neither the time nor the machine.
      const box = async (l: Locator) => (await l.boundingBox())!;
      for (const hovered of [false, true]) {
        if (hovered) await row.hover();
        else await page.mouse.move(0, 0);
        await expect(row.getByRole("button", { name: "Allow" })).toHaveCSS("opacity", "1");
        const n = await box(note);
        for (const part of [".inbox-age", ".inbox-where"]) {
          await expect(row.locator(part), `${part}, hovered: ${hovered}`).toBeVisible();
          const p = await box(row.locator(part));
          expect(n.x >= p.x + p.width || p.x >= n.x + n.width, `${part}, hovered: ${hovered}`).toBe(true);
        }
      }
    } finally {
      await asked.clear();
      await d.stop();
    }
  });
});

/** 140 characters, a chain of two: more than a row shows beside Allow. */
const LONG_COMMAND =
  "rsync -avz --delete --exclude .env ./dist/ deploy@staging.acme.dev:/srv/billing/new && ssh deploy@staging.acme.dev systemctl restart billing";

test.describe("inbox: Allow only beside a whole request", () => {
  test("a short command is whole beside its pair, which hover, the menu and the a key answer; a long one and a plan offer Open, which none of them answer", async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);
    expect(LONG_COMMAND).toHaveLength(140);
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const token = await sinkToken();
    const d = await fakeDaemon(key, { name: `whole-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] });
    const short = await postPrompt(token, {
      machine: d.name,
      title: "A short command",
      agoMs: 3_000,
      message: "npm run deploy -- --target staging",
    });
    // As Claude Code sends it: its first 120 characters, and the whole in the call's input.
    const long = await postPrompt(token, {
      machine: d.name,
      title: "A long command",
      agoMs: 4_000,
      message: LONG_COMMAND.slice(0, 120),
      input: { command: LONG_COMMAND },
    });
    const plan = await postPrompt(token, {
      machine: d.name,
      title: "A plan",
      agoMs: 5_000,
      tool: "ExitPlanMode",
      message: "ExitPlanMode",
    });
    const answers = () => d.seen.filter((c) => c.kind === "permission.answer");
    try {
      await page.goto(`${CONTROL_BASE}/inbox`);
      await hideBanners(page);
      const row = (p: { attention: string }) => page.locator(`.inbox-row[data-attention="${p.attention}"]`);
      // The short one: whole, on its line, with nothing cut; the pair on hover.
      const what = row(short).locator(".inbox-what");
      await expect(what.locator(".inbox-msg")).toHaveText("npm run deploy -- --target staging");
      expect(await what.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(
        true,
      );
      await row(short).hover();
      await expect(row(short).getByRole("button", { name: "Allow" })).toHaveCSS("opacity", "1");
      await expect(row(short).getByRole("button", { name: "Open" })).toHaveCount(0);
      // The long one and the plan: two lines at most, and Open in the pair's place.
      for (const p of [long, plan]) {
        await expect(row(p)).toHaveClass(/inbox-row--open/);
        await row(p).hover();
        await expect(row(p).getByRole("button", { name: "Open" })).toHaveCSS("opacity", "1");
        await expect(row(p).getByRole("button", { name: /^(Allow|Deny|Approve plan|Keep planning)$/ })).toHaveCount(0);
      }
      const lines = await row(long)
        .locator(".inbox-what")
        .evaluate((el) => el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight));
      expect(Math.round(lines)).toBeLessThanOrEqual(2);
      // Their menus answer nothing; the short one's does.
      for (const [p, items] of [
        [long, 0],
        [plan, 0],
        [short, 2],
      ] as const) {
        await expect(async () => {
          await row(p).locator(".inbox-main").click({ button: "right" });
          await expect(page.getByRole("menuitem", { name: "Copy message" })).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 20_000 });
        await expect(
          page.getByRole("menuitem", { name: /^(Allow|Deny) Bash$|^(Approve plan|Keep planning)$/ }),
        ).toHaveCount(items);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menuitem", { name: "Copy message" })).toHaveCount(0);
      }
      // The a key answers nothing on the long one's row, and the short one on its own.
      await row(long).locator(".inbox-main").focus();
      await expect(row(long)).toHaveAttribute("aria-current", "true");
      await page.keyboard.press("a");
      await page.waitForTimeout(1_000);
      expect(answers()).toEqual([]);
      await row(short).locator(".inbox-main").focus();
      await expect(row(short)).toHaveAttribute("aria-current", "true");
      await page.keyboard.press("a");
      await expect
        .poll(() => answers().map((c) => [c.for, c.decision]), { timeout: 15_000 })
        .toEqual([[short.attention, "allow"]]);
      // Open is the row's tap: the session beside the page, its whole command in the block.
      await row(long).hover();
      await row(long).getByRole("button", { name: "Open" }).click();
      await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
      await expect(page.locator("aside.panel .panel-title")).toHaveText("A long command");
      await expect(page.locator("aside.panel .ctl-cmd-block")).toHaveText(LONG_COMMAND.replace(" && ", "&& "));
    } finally {
      await short.clear();
      await long.clear();
      await plan.clear();
      await d.stop();
    }
  });

  test("with a session open beside, a and d with no row under the cursor, or on a row that shows Open or waits in a terminal, answer nothing; with focus in the panel they are the panel's", async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const token = await sinkToken();
    const d = await fakeDaemon(key, { name: `beside-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] });
    const beside = await postPrompt(token, {
      machine: d.name,
      title: "Open beside",
      agoMs: 3_000,
      message: "npm run deploy -- --target staging",
    });
    const long = await postPrompt(token, {
      machine: d.name,
      title: "A long command",
      agoMs: 4_000,
      message: LONG_COMMAND,
    });
    const question = await postPrompt(token, {
      machine: d.name,
      title: "A question",
      agoMs: 5_000,
      tool: "AskUserQuestion",
      message: "AskUserQuestion",
    });
    const answers = () => d.seen.filter((c) => c.kind === "permission.answer").map((c) => [c.for, c.decision]);
    try {
      // Opened beside with no row under the cursor, the focus on the page: a and d are the
      // Inbox's, and answer nothing.
      await page.goto(`${CONTROL_BASE}/inbox?s=${beside.key}`);
      const row = (p: { attention: string }) => page.locator(`.inbox-row[data-attention="${p.attention}"]`);
      await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
      const allow = page.locator("aside.panel .ctl .btn--allow");
      await expect(allow).toBeEnabled({ timeout: 15_000 });
      await expect(row(beside)).toBeVisible();
      await expect(page.locator(".inbox-row[aria-current='true']")).toHaveCount(0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("a");
      await page.keyboard.press("d");
      await page.waitForTimeout(1_000);
      expect(answers()).toEqual([]);
      await expect(row(long)).toHaveClass(/inbox-row--open/);
      await expect(row(question)).toHaveClass(/inbox-row--terminal/);
      for (const p of [long, question]) {
        await row(p).locator(".inbox-main").focus();
        await expect(row(p)).toHaveAttribute("aria-current", "true");
        await page.keyboard.press("a");
        await page.keyboard.press("d");
      }
      await page.waitForTimeout(1_000);
      expect(answers()).toEqual([]);
      await expect(allow).toBeEnabled();
      // Focus in the panel: its a, even on its Deny.
      await page.locator("aside.panel .ctl .btn--deny").focus();
      await page.keyboard.press("a");
      await expect.poll(answers, { timeout: 15_000 }).toEqual([[beside.attention, "allow"]]);
    } finally {
      await beside.clear();
      await long.clear();
      await question.clear();
      await d.stop();
    }
  });

  test("a row that shows Open, peeked beside with Space: a is the panel's, which shows the request whole", async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const token = await sinkToken();
    const d = await fakeDaemon(key, { name: `peek-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] });
    // As Claude Code sends it: its first 120 characters, and the whole in the call's input.
    const long = await postPrompt(token, {
      machine: d.name,
      title: "A long command",
      agoMs: 3_000,
      message: LONG_COMMAND.slice(0, 120),
      input: { command: LONG_COMMAND },
    });
    const question = await postPrompt(token, {
      machine: d.name,
      title: "A question",
      agoMs: 4_000,
      tool: "AskUserQuestion",
      message: "AskUserQuestion",
    });
    const answers = () => d.seen.filter((c) => c.kind === "permission.answer").map((c) => [c.for, c.decision]);
    try {
      await page.goto(`${CONTROL_BASE}/inbox`);
      await hideBanners(page);
      const row = (p: { attention: string }) => page.locator(`.inbox-row[data-attention="${p.attention}"]`);
      await expect(row(long)).toHaveClass(/inbox-row--open/);
      await row(long).locator(".inbox-main").focus();
      await expect(row(long)).toHaveAttribute("aria-current", "true");
      // Not open beside yet: a answers nothing, as before.
      await page.keyboard.press("a");
      await page.keyboard.press("Space");
      const shown = page.locator("aside.panel .panel-body:not(.panel-body--off)");
      await expect(page.locator("aside.panel .panel-title")).toHaveText("A long command");
      await expect(shown.locator(".ctl-cmd-block")).toContainText("rsync -avz --delete");
      await expect(shown.locator(".ctl .btn--allow")).toBeEnabled({ timeout: 15_000 });
      // The cursor is still on the row and the focus outside the panel.
      await expect(row(long)).toHaveAttribute("aria-current", "true");
      expect(await page.evaluate(() => !!document.activeElement?.closest("aside.panel"))).toBe(false);
      expect(answers()).toEqual([]);
      // On another row the keys still answer nothing, the panel's prompt included.
      await row(question).locator(".inbox-main").focus();
      await expect(row(question)).toHaveAttribute("aria-current", "true");
      await page.keyboard.press("a");
      await page.keyboard.press("d");
      await page.waitForTimeout(1_000);
      expect(answers()).toEqual([]);
      // Back on the row that is open beside: a is the panel's.
      await row(long).locator(".inbox-main").focus();
      await expect(row(long)).toHaveAttribute("aria-current", "true");
      await page.keyboard.press("a");
      await expect.poll(answers, { timeout: 15_000 }).toEqual([[long.attention, "allow"]]);
    } finally {
      await long.clear();
      await question.clear();
      await d.stop();
    }
  });
});

test.describe("installable", () => {
  test("the manifest and the install-only service worker are served", async ({ page, request }) => {
    await openPage(page, "/");
    const link = page.locator("link[rel='manifest']");
    await expect(link).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(link).toHaveAttribute("crossorigin", "use-credentials");
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.status()).toBe(200);
    expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
    const m = (await manifest.json()) as { name: string; display: string; icons: { src: string }[]; start_url: string };
    expect(m.name).toBe("sessionpipe gui");
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    for (const icon of m.icons) expect((await request.get(icon.src)).status()).toBe(200);
    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(sw.headers()["content-type"]).toContain("javascript");
    const body = await sw.text();
    expect(body).not.toMatch(/caches\.|respondWith/);
    // Registered and active on this (secure, loopback) origin.
    await expect
      .poll(
        () => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.active?.scriptURL ?? "")),
        {
          timeout: 15_000,
        },
      )
      .toMatch(/\/sw\.js$/);
  });
});
