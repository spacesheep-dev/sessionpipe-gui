// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The Handoff sheet (web/src/orchestrate/handoff): "Ask another agent…" from a session's
// control strip, from a reply's menu and from the palette, on a machine whose hello says
// `ask` and `handoff`; the rows it fills from the session (From, the agent that is not its
// own harness, the session's folder), the switch that brings the answer back, and Ask: a
// signed `start` the fake daemon takes with `reply_to` naming the asking session, `from`
// and `replyTo` on the activity, and the row the asking session shows at once.
// A row's menu has the item with no key beside it (⇧A is the session view's own, and shows
// in its "⋯"). An older machine's session, or one on a machine that is not paired, gets
// neither the strip's button nor the menu's item: an ask from there would only be refused.
// The open sheet has the whole window, as New session's has: its scrim over the sidebar and
// the page bar at each desktop size, and on a phone the sheet over the tab bar. A
// right-click on the dimmed window opens no menu, and a phone's sheet dragged down takes
// its drag's mark with it, so the next sheet has its dim.
// Against the second e2e instance (test door on, rp id localhost) through fake daemons.
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  CONTROL_BASE,
  type FakeDaemon,
  fakeDaemon,
  type PageKey,
  passkeyPage,
  postSession,
  seenSetupHere,
  sinkToken,
} from "./control-helpers.js";
import { ulid } from "./helpers.js";

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "desktop project");

const tag = () => randomUUID().slice(0, 6);
const sheet = (page: Page) => page.locator("[data-handoff]");
const rowValue = (page: Page, row: string) => sheet(page).locator(`[data-hs-row=${row}] button.sel`);

/** A machine on sessionpipe with `ask` and a handoff: Claude Code and Codex, one folder. */
const asking = (name: string) => ({
  name,
  harnesses: ["claude-code", "codex"],
  folders: ["/Users/e2e/code"],
  mode: "auto" as const,
  ask: true,
  handoff: true,
  start: {
    "claude-code": { permissions: ["read", "safe", "edits", "auto"], permission: "auto", any_model: true },
    codex: { permissions: ["read", "safe", "auto"], permission: "auto", models: ["gpt-6-astra"] },
  },
});
/** A 0.10 daemon: it neither asks nor takes handoffs. */
const older = (name: string) => ({
  name,
  harnesses: ["claude-code", "codex"],
  folders: ["/Users/e2e/code"],
  mode: "auto" as const,
});

/** One finished turn of a session, so its page has a reply to ask about. */
async function postTurn(token: string, s: { harness: string; id: string; machine: string }, reply: string) {
  let seq = 1;
  let clock = Date.now() - 20_000;
  const ev = (type: string, data: Record<string, unknown>, hook: string) => {
    clock += 500;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 2,
      harness: { name: s.harness, version: "2.1.296", event: hook },
      session: { id: s.id, seq: seq++, machine: s.machine, cwd: "/Users/e2e/code" },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const turn = randomUUID();
  await fetch(`${CONTROL_BASE}/api/sessionpipe/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "sessionpipe-protocol": "1" },
    body: JSON.stringify({
      events: [
        ev(
          "turn.started",
          { turn_id: turn, prompt_chars: 24, prompt: "Check the refund rounding." },
          "UserPromptSubmit",
        ),
        ev("turn.transcript", { turn_id: turn, assistant: reply }, "Stop"),
        ev("turn.ended", { turn_id: turn, reason: "end_turn" }, "Stop"),
      ],
    }),
  });
}

let key: PageKey;
let sink: string;
const daemons: FakeDaemon[] = [];
test.afterAll(async () => {
  await Promise.all(daemons.map((d) => d.stop()));
});

test.beforeEach(async ({ context, page }) => {
  await seenSetupHere(context);
  key = await passkeyPage(context, page);
  sink ??= await sinkToken();
});

test("the strip's Ask another agent…: the sheet, its rows, and a start the machine takes", async ({ page }) => {
  const name = `ho-ask-${tag()}`;
  const m = await fakeDaemon(key, asking(name), { sinkToken: sink });
  daemons.push(m);
  const s = await postSession(sink, { machine: name, cwd: "/Users/e2e/code", title: `Refunds ${name}` });
  await postTurn(sink, { ...s, machine: name }, "The rounding happens in `prorate()`: it floors cents.");
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");

  await page.locator("[data-ctl-ask]").click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole("heading", { name: "Ask another agent" })).toBeVisible();
  // From is the session; the agent defaults to the harness that is not its own; the
  // folder is the session's, since the machine allows it.
  await expect(sheet(page).locator("[data-hs-row=from]")).toContainText(`Refunds ${name}`);
  await expect(sheet(page).locator("[data-hs-row=from]")).toContainText(name);
  await expect(rowValue(page, "agent")).toContainText("Codex · new session");
  await expect(rowValue(page, "folder")).toHaveAttribute("data-value", "/Users/e2e/code");
  // The text is our one line and the last reply.
  const text = sheet(page).locator("[data-hs-text]");
  await expect(text).toHaveValue(/^Give a second opinion on the reply below\./);
  await expect(text).toHaveValue(/---\nThe rounding happens in `prorate\(\)`: it floors cents\.$/);
  await expect(sheet(page).locator(".ns-status")).toHaveText(`${name} is listening.`);

  // The switch is on by default (the hello says handoff): the answer is asked back here.
  const back = sheet(page).locator("[data-hs-row=back] [role=switch]");
  await expect(back).toHaveAttribute("aria-checked", "true");
  await text.fill("Review the rounding fix for off-by-one cents.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet(page)).toHaveCount(0, { timeout: 15_000 });

  // The machine took a start of codex in the session's folder, and inside the signed bytes
  // the session its answer goes back to: the one that asked.
  await expect.poll(() => m.seen.find((c) => c.kind === "start"), { timeout: 15_000 }).toBeTruthy();
  const cmd = m.seen.find((c) => c.kind === "start")!;
  expect(cmd).toMatchObject({ cwd: "/Users/e2e/code", text: "Review the rounding fix for off-by-one cents." });
  expect(cmd.session).toMatch(/^codex:/);
  expect(cmd.reply_to).toBe(`${s.harness}:${s.id}`);
  // The activity says where the answer goes, as signed, and which page sent it, unsigned.
  const act = (await (await fetch(`${CONTROL_BASE}/api/ui/control/activity?limit=5`)).json()) as {
    activity: { kind: string; from?: string; replyTo?: string }[];
  };
  const row = act.activity.find((a) => a.kind === "start")!;
  expect(row.from).toBe(`${s.harness}:${s.id}`);
  expect(row.replyTo).toBe(`${s.harness}:${s.id}`);
  // The asking session shows the row at once, from the activity.
  await expect(page.locator(".ask").first()).toContainText("You asked Codex");
});

/** What is under a point of the window: the sheet's scrim, the sheet, or the page. */
const under = (page: Page, at: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest(".ns-scrim") ? "scrim" : el?.closest("[data-handoff]") ? "sheet" : "page";
  }, at);
const centre = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
};

test("the sheet dims the whole window, as New session's does: a click on the sidebar closes it and goes nowhere", async ({
  page,
}) => {
  const name = `ho-dim-${tag()}`;
  const m = await fakeDaemon(key, asking(name), { sinkToken: sink });
  daemons.push(m);
  const s = await postSession(sink, { machine: name, cwd: "/Users/e2e/code", title: `Ledger ${name}` });
  await postTurn(sink, { ...s, machine: name }, "The ledger balances to the cent.");
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  const url = page.url();

  for (const size of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await page.locator("[data-ctl-ask]").click();
    await expect(sheet(page)).toBeVisible();
    // Out of the docked bar: neither its measure nor its layer under the sidebar holds it.
    expect(await sheet(page).evaluate((el) => el.closest(".sess-ctl") === null)).toBe(true);
    expect(await page.locator(".ns-scrim").boundingBox()).toEqual({ x: 0, y: 0, ...size });
    // The sheet keeps its place: its own width, centred, dropped from under the title band.
    const band = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar")),
    );
    await expect.poll(async () => (await sheet(page).boundingBox())?.y).toBe(band);
    const box = (await sheet(page).boundingBox())!;
    expect(box.width).toBe(640);
    expect(box.x).toBe((size.width - 640) / 2);
    // Everything around it is under the scrim: the sidebar, a link in it, the bar's back
    // and ⋯ at either end of the window, and the composer.
    const board = await centre(page, ".rail [data-nav=board]");
    const points = [
      { x: 100, y: 400 },
      board,
      await centre(page, ".main .bar-back"),
      await centre(page, ".main .bar [aria-label='More actions']"),
      await centre(page, ".ctl textarea"),
    ];
    for (const at of points) expect(await under(page, at), `${at.x},${at.y} at ${size.width}`).toBe("scrim");
    // A right-click there is the sheet's as well, and the sheet has no menu: the bar's
    // own (Send a message…) does not open over the dimmed window.
    await page.mouse.click(100, 400, { button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(sheet(page)).toBeVisible();

    // A click on the sidebar's Board is the scrim's: the sheet closes, the page stays.
    await page.mouse.click(board.x, board.y);
    await expect(sheet(page)).toHaveCount(0);
    expect(page.url()).toBe(url);
    await expect(page.locator(".ns-scrim")).toHaveCount(0);
  }

  // Esc closes it too, and the focus is back on the button that opened it. (The sheet
  // takes the focus once more 120 ms after it opens, for a menu that gives its own back
  // late: a timer set after that one runs after it, so Esc is pressed once it has.)
  const ask = page.locator("[data-ctl-ask]");
  await ask.click();
  await expect(sheet(page).locator("[data-hs-text]")).toBeFocused();
  await page.evaluate(() => new Promise((done) => setTimeout(done, 150)));
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(ask).toBeFocused();
  expect(page.url()).toBe(url);
});

// A phone and a tablet are touch screens: under 840 px a window with a mouse keeps the
// desktop's layout down to 720 (lib/device.ts), so the tablet here has a finger. The phone
// has the tab bar, the tablet the touch app's sidebar in its place.
test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("a phone's sheet covers the tab bar, and a tablet's is a form sheet over a dim that covers its sidebar", async ({
    page,
  }) => {
    const name = `ho-full-${tag()}`;
    const m = await fakeDaemon(key, asking(name), { sinkToken: sink });
    daemons.push(m);
    const s = await postSession(sink, { machine: name, cwd: "/Users/e2e/code", title: `Totals ${name}` });
    await postTurn(sink, { ...s, machine: name }, "The totals are summed once.");

    for (const [size, pages, beside] of [
      [{ width: 390, height: 844 }, "nav.tabbar", "sheet"],
      [{ width: 834, height: 1194 }, "nav.rail", "scrim"],
    ] as const) {
      await page.setViewportSize(size);
      await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
      await expect(page.locator(".ctl textarea")).toBeVisible();
      const tabbar = await centre(page, pages);
      expect(await under(page, tabbar)).toBe("page");
      await page.locator("[data-ctl-ask]").click();
      await expect(sheet(page)).toBeVisible();
      expect(await sheet(page).evaluate((el) => el.closest(".sess-ctl") === null)).toBe(true);
      // Nothing of the page takes a tap beside it (the bar's ⋯, the composer), nor the tab
      // bar or the sidebar under it: on a phone the sheet is the whole screen, edge to edge;
      // on a tablet a sheet of at most 540 in the middle, over a dim that puts it away.
      await page.evaluate(() =>
        Promise.allSettled(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
            .map((a) => a.finished),
        ),
      );
      const box = (await sheet(page).boundingBox())!;
      if (beside === "sheet") expect(box).toEqual({ x: 0, y: 0, ...size });
      else {
        expect(box.width).toBeLessThanOrEqual(540);
        expect(Math.abs(box.x + box.width / 2 - size.width / 2)).toBeLessThanOrEqual(1);
      }
      for (const at of [tabbar, { x: size.width - 4, y: 24 }, { x: size.width - 4, y: size.height - 120 }])
        expect(await under(page, at), `${at.x},${at.y} at ${size.width}`).toBe(beside);
      await sheet(page).locator("[data-hs-cancel]").click();
      await expect(sheet(page)).toHaveCount(0);
    }
  });
});

test("a phone's sheet dragged down takes its mark with it: the next sheet has its dim", async ({ page }) => {
  const name = `ho-drag-${tag()}`;
  const m = await fakeDaemon(key, asking(name), { sinkToken: sink });
  daemons.push(m);
  const s = await postSession(sink, { machine: name, cwd: "/Users/e2e/code", title: `Sums ${name}` });
  await postTurn(sink, { ...s, machine: name }, "The sums carry over.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  await expect(page.locator(".ctl textarea")).toBeVisible();
  /** Every element that carries the drag's mark (lib/motion.ts useSheetDrag), by class. */
  const marked = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("*"))
        .filter((el) => el.style.getPropertyValue("--sheet-drag") !== "")
        .map((el) => el.className || el.localName),
    );

  await page.locator("[data-ctl-ask]").click();
  await expect.poll(async () => (await sheet(page).boundingBox())?.y).toBe(0);
  // By its title, past the two fifths of its height that let it go. While it is held the
  // mark is on the sheet's own element in the body, never on the body.
  const from = await centre(page, "[data-handoff] .ns-bar-title");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 13; i++) await page.mouse.move(from.x, from.y + 40 * i);
  expect(await marked()).toEqual(["hs-host"]);
  await page.mouse.up();
  await expect(sheet(page)).toHaveCount(0);
  expect(await marked()).toEqual([]);

  // The page's ⋯ sheet reads the mark from wherever it is set above it: its dim is whole.
  await page.locator(".main .bar [aria-label='More actions']").click();
  await expect(page.locator(".menu-sheet")).toBeVisible();
  await expect(page.locator(".menu-sheet-host .menu-scrim")).toHaveCSS("opacity", "1");
});

test("a reply's menu asks about that turn; ⌘K has the verb; Esc keeps the draft", async ({ page }) => {
  const name = `ho-reply-${tag()}`;
  const m = await fakeDaemon(key, asking(name), { sinkToken: sink });
  daemons.push(m);
  const s = await postSession(sink, { machine: name, cwd: "/Users/e2e/code", title: `Webhooks ${name}` });
  await postTurn(sink, { ...s, machine: name }, "Retries back off exponentially, capped at five.");
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");

  // The reply, in the timeline (Advanced) or the chat.
  await page.locator(".reply, .chat-card").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Ask another agent about this…" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator("[data-hs-text]")).toHaveValue(/Retries back off exponentially, capped at five\.$/);
  await sheet(page).locator("[data-hs-text]").fill("Is five enough?");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("ask another");
  await page.locator(".pal-row, [role=option]", { hasText: "Ask another agent…" }).first().click();
  await expect(sheet(page)).toBeVisible();
  // The draft came back.
  await expect(sheet(page).locator("[data-hs-text]")).toHaveValue("Is five enough?");
});

test("a row's menu asks with no key beside it; the session's own \"⋯\" shows ⇧A, the key that asks there", async ({
  page,
}) => {
  const name = `ho-keys-${tag()}`;
  const m = await fakeDaemon(key, asking(name), { sinkToken: sink });
  daemons.push(m);
  const s = await postSession(sink, { machine: name, cwd: "/Users/e2e/code", title: `Keys ${name}` });
  const ask = page.getByRole("menuitem", { name: "Ask another agent…" });
  // The board's row: ⇧A does nothing there, so the item shows no key, and it opens the sheet.
  await page.goto(`${CONTROL_BASE}/`);
  await page
    .locator("article.card", { hasText: `Keys ${name}` })
    .locator(".card-title")
    .click({ button: "right" });
  await expect(ask).toBeVisible();
  await expect(ask).not.toHaveAttribute("aria-disabled");
  await expect(ask.locator(".menu-keys")).toHaveCount(0);
  await ask.click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator("[data-hs-row=from]")).toContainText(`Keys ${name}`);
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  // Its own page: the key presses the strip's button, and the menu says so.
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  await expect(page.locator("[data-ctl-ask]")).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(ask).toBeVisible();
  await expect(ask.locator(".menu-keys")).toHaveText(/a$/i);
});

test("an older machine, and one that is not paired: neither the strip nor a menu offers an ask that would be refused", async ({
  page,
}) => {
  const name = `ho-old-${tag()}`;
  const m = await fakeDaemon(key, older(name), { sinkToken: sink });
  daemons.push(m);
  const s = await postSession(sink, { machine: name, cwd: "/Users/e2e/code", title: `Old ${name}` });
  const lone = `ho-lone-${tag()}`;
  await postSession(sink, { machine: lone, cwd: "/Users/e2e/code", title: `Lone ${lone}` });
  const ask = page.getByRole("menuitem", { name: "Ask another agent…" });
  const here = page.getByRole("menuitem", { name: "New session here" });
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  // The hello said neither `ask` nor `handoff`: the strip's button is not shown (a
  // capability shows only where the hello says so), and the menu reads it the same way:
  // no item, where it was a greyed one.
  await expect(page.locator(".ctl textarea")).toBeVisible();
  await expect(page.locator("[data-ctl-ask]")).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(here).toBeVisible();
  await expect(ask).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Its row on the board: a session can be started there, and nothing asked.
  await page.goto(`${CONTROL_BASE}/`);
  await page
    .locator("article.card", { hasText: `Old ${name}` })
    .locator(".card-title")
    .click({ button: "right" });
  await expect(here).toBeVisible();
  await expect(ask).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  // A machine that is not paired here: neither, and no rule where the two were. (A menu
  // opens no sooner than 400 ms after the last one did.)
  await expect(async () => {
    await page
      .locator("article.card", { hasText: `Lone ${lone}` })
      .locator(".card-title")
      .click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Open as page" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(here).toHaveCount(0);
  await expect(ask).toHaveCount(0);
  await expect(page.locator(".menu > .menu-sep + .menu-sep")).toHaveCount(0);
});

/** A session started for `parent` (sessionpipe ask: `delegated_by` on its events), in a
 *  state: one that needs you (a Bash prompt open), one working (a turn open), one done. */
async function postAsked(
  token: string,
  o: { machine: string; harness: string; title: string; parent: string; state: "needs_you" | "working" | "done" },
): Promise<{ harness: string; id: string; key: string }> {
  const id = randomUUID();
  let seq = 0;
  let clock = Date.now() - 20_000;
  const ev = (type: string, data: Record<string, unknown>) => {
    clock += 500;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 1,
      harness: { name: o.harness, version: "2.1.296", event: "Hook" },
      session: {
        id,
        seq: seq++,
        machine: o.machine,
        cwd: "/Users/e2e/code",
        title: o.title,
        title_source: "custom",
        delegated_by: o.parent,
      },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const events = [ev("session.started", { source: "startup" }), ev("turn.started", { turn_id: "t1" })];
  if (o.state === "needs_you")
    events.push(ev("attention.needed", { attention_id: `att_${id}`, kind: "permission", tool: "Bash" }));
  if (o.state === "done") events.push(ev("turn.ended", { turn_id: "t1" }), ev("session.ended", { reason: "exit" }));
  await fetch(`${CONTROL_BASE}/api/sessionpipe/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "sessionpipe-protocol": "1" },
    body: JSON.stringify({ events }),
  });
  return { harness: o.harness, id, key: `${o.harness}:${id}` };
}

/** The parent's own word that it asked `to` and has its answer: a delegation that names it. */
async function postDelegation(token: string, p: { harness: string; id: string; machine: string }, to: string) {
  let seq = 1;
  let clock = Date.now() - 10_000;
  const ev = (type: string, data: Record<string, unknown>) => {
    clock += 500;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 1,
      harness: { name: p.harness, version: "2.1.296", event: "Hook" },
      session: { id: p.id, seq: seq++, machine: p.machine, cwd: "/Users/e2e/code" },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const ask = { ask_id: `ask_${randomUUID()}`, via: "ask", harness: harnessOfKey(to), to };
  await fetch(`${CONTROL_BASE}/api/sessionpipe/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "sessionpipe-protocol": "1" },
    body: JSON.stringify({ events: [ev("delegation.started", ask), ev("delegation.ended", { ...ask, ok: true })] }),
  });
}
const harnessOfKey = (k: string) => k.slice(0, k.indexOf(":"));

test("a parent's Asked sessions: each with its state, agent and computer, the one that needs you first; Open and Message", async ({
  page,
}) => {
  const name = `ho-kids-${tag()}`;
  const m = await fakeDaemon(key, asking(name), { sinkToken: sink });
  daemons.push(m);
  const p = await postSession(sink, { machine: name, cwd: "/Users/e2e/code", title: `Parent ${name}` });
  const parent = `${p.harness}:${p.id}`;
  // Started in this order: the newest is the working one, the oldest the one that needs you.
  const needs = await postAsked(sink, {
    machine: name,
    harness: "codex",
    title: "Run the suite",
    parent,
    state: "needs_you",
  });
  // One on another computer, which the parent's own delegation names: a later stage's
  // shape, which today's data can already carry.
  const done = await postAsked(sink, {
    machine: `${name}-b`,
    harness: "codex",
    title: "Review the copy",
    parent,
    state: "done",
  });
  await postDelegation(sink, { ...p, machine: name }, done.key);
  // One on another computer that only its own hooks say was started for this parent: no
  // lineage today, so not listed.
  await postAsked(sink, { machine: `${name}-c`, harness: "codex", title: "Says so", parent, state: "working" });
  const work = await postAsked(sink, {
    machine: name,
    harness: "claude-code",
    title: "Draft the note",
    parent,
    state: "working",
  });
  await page.goto(`${CONTROL_BASE}/s/${p.harness}/${p.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");

  const kids = page.locator("section.kids");
  await expect(kids.getByRole("heading", { name: /Asked sessions/ })).toBeVisible();
  const rows = kids.locator("li.kids-row");
  await expect(rows).toHaveCount(3);
  // The one that needs you first, marked; then the newest started.
  await expect(rows.nth(0)).toHaveAttribute("data-kid", needs.key);
  await expect(rows.nth(0)).toHaveAttribute("data-state", "needs_you");
  await expect(rows.nth(1)).toHaveAttribute("data-kid", work.key);
  await expect(rows.nth(2)).toHaveAttribute("data-kid", done.key);
  // Each says its state, its agent and its computer (this session's own, named all the same).
  for (const [i, state, agent, title, computer] of [
    [0, "needs you", "Codex", "Run the suite", name],
    [1, "working", "Claude Code", "Draft the note", name],
    [2, "done", "Codex", "Review the copy", `${name}-b`],
  ] as const) {
    await expect(rows.nth(i).locator(".kids-word")).toHaveText(state);
    await expect(rows.nth(i).locator(".kids-agent")).toHaveText(agent);
    await expect(rows.nth(i).locator(".kids-where")).toHaveText(computer);
    await expect(rows.nth(i).locator(".kids-title")).toHaveText(title);
  }

  // Message: Ask another agent… aimed at that session, the answer brought back.
  await rows.nth(1).hover();
  await rows.nth(1).getByRole("button", { name: "Message Claude Code" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(rowValue(page, "agent")).toContainText("Draft the note");
  await expect(sheet(page).locator("[data-hs-row=back] [role=switch]")).toHaveAttribute("aria-checked", "true");
  await expect(sheet(page).locator("[data-hs-text]")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  // The one on another computer is no agent this session can ask today: no Message there,
  // in the row or its menu.
  await rows.nth(2).hover();
  await expect(rows.nth(2).getByRole("button", { name: /^Message/ })).toHaveCount(0);
  await rows.nth(2).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open beside" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Message/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // In the working one's menu, Message is there too.
  await rows.nth(1).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Message…" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Open: the row goes to the child's page, whose bar says whom it works for.
  await rows.nth(0).locator("a.kids-link").click();
  await expect(page).toHaveURL(new RegExp(`/s/codex/${needs.id}`));
  await expect(page.locator(".sess-for a")).toHaveText(`Parent ${name}`);
  // One level: the child asked nobody, and a session that asked none has no list at all.
  await expect(page.locator("section.kids")).toHaveCount(0);
});

test("Message on an asked session leaves the parent's own kept Ask draft as it was", async ({ page }) => {
  const name = `ho-msg-${tag()}`;
  const m = await fakeDaemon(key, asking(name), { sinkToken: sink });
  daemons.push(m);
  const p = await postSession(sink, { machine: name, cwd: "/Users/e2e/code", title: `Parent ${name}` });
  const kid = await postAsked(sink, {
    machine: name,
    harness: "codex",
    title: "Draft the note",
    parent: `${p.harness}:${p.id}`,
    state: "working",
  });
  await page.goto(`${CONTROL_BASE}/s/${p.harness}/${p.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  const text = sheet(page).locator("[data-hs-text]");
  const back = sheet(page).locator("[data-hs-row=back] [role=switch]");

  // The parent's own ask, kept on Esc.
  await page.locator("[data-ctl-ask]").click();
  await expect(sheet(page)).toBeVisible();
  await text.fill("Keep this draft.");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);

  const row = page.locator(`section.kids li.kids-row[data-kid="${kid.key}"]`);
  const message = async () => {
    await row.hover();
    await row.getByRole("button", { name: /^Message/ }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(rowValue(page, "agent")).toContainText("Draft the note");
    await expect(text).toHaveValue("");
  };
  // Opened, edited, toggled and closed: nothing of it is kept, the draft is untouched.
  await message();
  await text.fill("Not a draft.");
  await back.click();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  // Opened again, edited, toggled and sent.
  await message();
  await text.fill("Is the note done?");
  await back.click();
  await expect(back).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet(page)).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(() => m.seen.find((c) => c.kind === "prompt" && c.text === "Is the note done?"), { timeout: 15_000 })
    .toBeTruthy();

  // The parent's own Ask comes back with its draft and the agent it had.
  await page.locator("[data-ctl-ask]").click();
  await expect(sheet(page)).toBeVisible();
  await expect(text).toHaveValue("Keep this draft.");
  await expect(rowValue(page, "agent")).toContainText("Codex · new session");
});
