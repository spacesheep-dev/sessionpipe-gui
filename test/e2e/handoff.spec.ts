// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The Handoff sheet (web/src/orchestrate/handoff): "Ask another agent…" from a session's
// control strip, from a reply's menu and from the palette, on a machine whose hello says
// `ask` and `handoff`; the rows it fills from the session (From, the agent that is not its
// own harness, the session's folder), the switch that brings the answer back, and Ask: a
// signed `start` the fake daemon takes, `from` on the activity, and the row the asking
// session shows at once. The switch is turned off before sending: this receiver's
// sessionpipe-core (0.10.0) refuses `reply_to` ahead of the machine, and the sheet says so.
// An older machine's session gets the disabled item with its reason and no strip button.
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

  // The switch is on by default (the hello says handoff). This receiver's core predates
  // `reply_to`, so sending with it on is refused before the machine, with the way out.
  const back = sheet(page).locator("[data-hs-row=back] [role=switch]");
  await expect(back).toHaveAttribute("aria-checked", "true");
  await text.fill("Review the rounding fix for off-by-one cents.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet(page).locator(".ns-status")).toHaveText(
    "Not sent: this receiver's sessionpipe is older than bringing answers back. Turn the switch off, or update it.",
    { timeout: 15_000 },
  );
  await expect(sheet(page)).toBeVisible();
  await back.click();
  await expect(back).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet(page)).toHaveCount(0, { timeout: 15_000 });

  // The machine took a start of codex in the session's folder, without reply_to.
  await expect.poll(() => m.seen.find((c) => c.kind === "start"), { timeout: 15_000 }).toBeTruthy();
  const cmd = m.seen.find((c) => c.kind === "start")!;
  expect(cmd).toMatchObject({ cwd: "/Users/e2e/code", text: "Review the rounding fix for off-by-one cents." });
  expect(cmd.session).toMatch(/^codex:/);
  expect(cmd.reply_to).toBeUndefined();
  // The activity remembers which page sent it, unsigned.
  const act = (await (await fetch(`${CONTROL_BASE}/api/ui/control/activity?limit=5`)).json()) as {
    activity: { kind: string; from?: string; replyTo?: string }[];
  };
  const row = act.activity.find((a) => a.kind === "start")!;
  expect(row.from).toBe(`${s.harness}:${s.id}`);
  expect(row.replyTo).toBeUndefined();
  // The asking session shows the row at once, from the activity.
  await expect(page.locator(".ask").first()).toContainText("You asked Codex");
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

test("an older machine: the strip offers no ask, and the menu item says what it needs", async ({ page }) => {
  const name = `ho-old-${tag()}`;
  const m = await fakeDaemon(key, older(name), { sinkToken: sink });
  daemons.push(m);
  const s = await postSession(sink, { machine: name, cwd: "/Users/e2e/code", title: `Old ${name}` });
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  // The hello said neither `ask` nor `handoff`: the strip's button reads it the way the
  // menu item does and is not shown (a capability shows only where the hello says so).
  await expect(page.locator(".ctl textarea")).toBeVisible();
  await expect(page.locator("[data-ctl-ask]")).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  const item = page.getByRole("menuitem", { name: "Ask another agent…" });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toHaveAttribute("aria-description", `${name} needs a newer sessionpipe for this`);
});
