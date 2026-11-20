// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// A plan review on a computer (ExitPlanMode, tier 3, the plan in the call's input): the
// plan is read in the conversation, whole, right under its call, and the page opens on its
// first line; the dock asks the one question, with Keep planning and Approve plan. A plan
// answered before the page opened folds to eight lines and "Show all". Below tier 3 there
// is no plan: the dock says the prompt's message. The phone keeps the plan on its card
// (mobile.spec.ts).
import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { CONTROL_BASE, type FakeDaemon, fakeDaemon, passkeyPage, seenSetupHere, sinkToken } from "./control-helpers.js";
import { composer, sessionUrl, ulid } from "./helpers.js";

test.skip(({ isMobile }) => isMobile, "desktop project; the widths are set per test");

const HEAD = "Plan: render invoice PDFs in the background";
const LAST = "Last step: switch the flag on for everyone.";
/** 120 lines of Markdown: a heading, parts with their own headings and steps, a last line. */
const PLAN = [
  `## ${HEAD}`,
  "",
  ...Array.from({ length: 23 }, (_, i) => [
    `### Part ${i + 1}`,
    "",
    `1. What part ${i + 1} changes.`,
    `2. \`Why\` part ${i + 1} is needed.`,
    "",
  ]).flat(),
  LAST,
  "",
  "That is the whole plan.",
].join("\n");

/** A paired machine, and the app in Simple mode (else Advanced, at `lens` when given). */
async function machine(
  context: BrowserContext,
  page: Page,
  simple: boolean,
  lens?: 1 | 2,
): Promise<{ d: FakeDaemon; sink: string }> {
  await seenSetupHere(context);
  const settings = simple ? { mode: "simple" } : { mode: "advanced", tierLens: lens ?? null };
  await context.addInitScript((v) => localStorage.setItem("sessionpipe-gui.settings", v), JSON.stringify(settings));
  const key = await passkeyPage(context, page);
  const sink = await sinkToken();
  const d = await fakeDaemon(key, { name: `plan-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] });
  return { d, sink };
}

/** A Claude Code session asking to start on a plan: its turn read the code, said "Here is
 *  the plan.", and called ExitPlanMode. `answered`: the call ended and the prompt closed
 *  before the page opened. `tier: 2`: no input, so no plan; the prompt's message only. */
async function postPlan(
  sink: string,
  machineName: string,
  o: { answered?: boolean; tier?: 2 | 3; message?: string } = {},
): Promise<{ id: string; key: string; attention: string }> {
  const tier = o.tier ?? 3;
  const id = randomUUID();
  const turn = randomUUID();
  const attention = `perm-${id.slice(0, 8)}`;
  let seq = 0;
  let clock = Date.now() - 6_000;
  const ev = (type: string, data: Record<string, unknown>, hook: string) => {
    clock += 300;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier,
      harness: { name: "claude-code", version: "2.1.296", event: hook },
      session: {
        id,
        seq: seq++,
        machine: machineName,
        cwd: "/Users/e2e/code",
        title: "Invoice PDFs",
        title_source: "custom",
      },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const input = tier === 3 ? { input: { plan: PLAN } } : {};
  const events = [
    ev("session.started", { source: "startup" }, "SessionStart"),
    ev("turn.started", { turn_id: turn, prompt_chars: 40 }, "UserPromptSubmit"),
    ev(
      "turn.progress",
      tier === 3
        ? { turn_id: turn, user: "Plan moving invoice PDFs to a job.", assistant: "Here is the plan." }
        : { turn_id: turn },
      "Progress",
    ),
    ev("tool.started", { tool: "ExitPlanMode", call_id: "toolu_plan", turn_id: turn, ...input }, "PreToolUse"),
    ev(
      "attention.needed",
      { attention_id: attention, kind: "permission", tool: "ExitPlanMode", message: o.message ?? "ExitPlanMode" },
      "PermissionRequest",
    ),
    ...(o.answered
      ? [
          ev("attention.cleared", { attention_id: attention, how: "answered" }, "PreToolUse"),
          ev(
            "tool.ended",
            { tool: "ExitPlanMode", call_id: "toolu_plan", turn_id: turn, ok: true, ms: 4000, ...input },
            "PostToolUse",
          ),
          ev("turn.ended", { turn_id: turn, reason: "stop" }, "Stop"),
        ]
      : []),
  ];
  await fetch(`${CONTROL_BASE}/api/sessionpipe/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sink}`, "sessionpipe-protocol": "1" },
    body: JSON.stringify({ events }),
  });
  return { id, key: `claude-code:${id}`, attention };
}

/** Whether an element's box is (partly) inside the window. */
const inView = (page: Page, text: string) =>
  page
    .locator(".turn-plan")
    .getByText(text, { exact: true })
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    });

for (const size of [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
])
  for (const simple of [true, false])
    test(`at ${size.width}×${size.height} in ${simple ? "Simple" : "Advanced"} the plan is read once, whole, in the conversation, opened on its first line; the dock asks the one question`, async ({
      context,
      page,
    }) => {
      const { d, sink } = await machine(context, page, simple);
      try {
        const p = await postPlan(sink, d.name);
        await page.setViewportSize(size);
        await page.goto(`${CONTROL_BASE}${sessionUrl("claude-code", p.id)}`);
        const panel = page.locator(".timeline .turn-plan");
        await expect(panel).toHaveCount(1);
        // Whole: the timeline's events are cut at 400 characters, the plan is not.
        await expect(panel.getByText(LAST, { exact: true })).toHaveCount(1);
        await expect(page.getByText(HEAD, { exact: true })).toHaveCount(1);
        await expect(page.getByText("What part 7 changes.", { exact: true })).toHaveCount(1);
        const dock = page.locator(".sess-ctl");
        await expect(dock.locator(".ctl-q-text")).toHaveText("Ready to start on this plan?");
        await expect(dock.locator(".md, .ctl-plan, .ctl-plan-msg")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Show the whole plan" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Show all" })).toHaveCount(0);
        await expect(dock.getByRole("button", { name: "Approve plan" })).toBeVisible();
        const h = (await dock.boundingBox())!.height;
        expect(h, `the dock is ${h} px`).toBeLessThan(160);
        // In Advanced, right under its own call's row, which is its name alone: the plan is
        // not said a second time as the call's raw input.
        if (!simple) {
          expect(
            await panel.evaluate((el) => el.previousElementSibling?.textContent?.includes("Plan") ?? false),
            "under the ExitPlanMode row",
          ).toBe(true);
          const call = page.locator(".timeline li.tool:has(+ .turn-plan)");
          await expect(call.locator(".tool-name")).toHaveText("Plan");
          await expect(call.locator(".tool-subject")).toHaveCount(0);
        }
        // The page opens on the plan's first line, not on its last.
        await expect.poll(() => inView(page, HEAD), "its heading is in view").toBe(true);
        expect(await inView(page, LAST), "its last line is below the fold").toBe(false);
        // Copy plan, from its own menu.
        await panel.getByText("What part 2 changes.", { exact: true }).click({ button: "right" });
        await expect(page.getByRole("menuitem", { name: "Copy plan" })).toBeVisible();
        await page.keyboard.press("Escape");
      } finally {
        await d.stop();
      }
    });

test("Keep planning with a note and Approve plan still send, and the plan stays as it was once answered", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  const { d, sink } = await machine(context, page, true);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const keep = await postPlan(sink, d.name);
    await page.goto(`${CONTROL_BASE}${sessionUrl("claude-code", keep.id)}`);
    await expect(page.locator(".turn-plan")).toHaveCount(1);
    const box = composer(page);
    await expect(box).toBeEnabled();
    await box.fill("Keep the old route for a week.");
    await expect(page.getByRole("button", { name: "Approve plan" })).toBeDisabled();
    await box.press("Enter");
    const answers = () => d.seen.filter((c) => c.kind === "permission.answer");
    await expect.poll(() => answers().length, { timeout: 15_000 }).toBe(1);
    expect(answers()[0]).toMatchObject({
      for: keep.attention,
      decision: "deny",
      note: "Keep the old route for a week.",
    });

    const approve = await postPlan(sink, d.name);
    await page.goto(`${CONTROL_BASE}${sessionUrl("claude-code", approve.id)}`);
    await expect(page.locator(".turn-plan")).toHaveCount(1);
    await page.getByRole("button", { name: "Approve plan" }).click();
    await expect.poll(() => answers().length, { timeout: 15_000 }).toBe(2);
    expect(answers()[1]).toMatchObject({ for: approve.attention, decision: "allow" });
    // Answered here, it stays whole: no fold, nothing moves.
    await expect(page.locator(".turn-plan").getByText(LAST, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show all" })).toHaveCount(0);
  } finally {
    await d.stop();
  }
});

for (const simple of [true, false])
  test(`${simple ? "Simple" : "Advanced"}: a plan answered before the page opened is read whole, shown folded with Show all`, async ({
    context,
    page,
  }) => {
    const { d, sink } = await machine(context, page, simple);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const p = await postPlan(sink, d.name, { answered: true });
      await page.goto(`${CONTROL_BASE}${sessionUrl("claude-code", p.id)}`);
      const panel = page.locator(".timeline .turn-plan");
      await expect(panel.getByText(HEAD, { exact: true })).toBeVisible();
      const all = panel.getByRole("button", { name: "Show all" });
      await expect(all).toBeVisible();
      const text = panel.locator(".turn-plan-text");
      const folded = (await text.boundingBox())!.height;
      expect(folded, "eight lines").toBeLessThan(200);
      await expect(page.locator(".sess-ctl .ctl-answer")).toHaveCount(0);
      await all.click();
      await expect(panel.getByRole("button", { name: "Show less" })).toBeVisible();
      await expect(panel.getByText(LAST, { exact: true })).toBeVisible();
      expect((await text.boundingBox())!.height).toBeGreaterThan(folded * 4);
    } finally {
      await d.stop();
    }
  });

for (const at of ["a tier-2 session", "the tier lens at 2"] as const)
  test(`below tier 3 (${at}) there is no plan to read: the dock says the prompt's message, and the conversation has no panel`, async ({
    context,
    page,
  }) => {
    const lens = at === "the tier lens at 2";
    const { d, sink } = await machine(context, page, !lens, lens ? 2 : undefined);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const p = await postPlan(sink, d.name, {
        tier: lens ? 3 : 2,
        message: "ExitPlanMode: move invoice PDFs to a job",
      });
      await page.goto(`${CONTROL_BASE}${sessionUrl("claude-code", p.id)}`);
      const dock = page.locator(".sess-ctl");
      await expect(dock.locator(".ctl-q-text")).toHaveText("Ready to start on this plan?");
      await expect(dock.locator(".ctl-plan-msg")).toHaveText("move invoice PDFs to a job");
      await expect(page.getByText(HEAD, { exact: true })).toHaveCount(0);
      await expect(page.locator(".turn-plan")).toHaveCount(0);
    } finally {
      await d.stop();
    }
  });

test("beside the board, the side panel reads the plan in its own conversation", async ({ context, page }) => {
  const { d, sink } = await machine(context, page, true);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const p = await postPlan(sink, d.name);
    await page.goto(`${CONTROL_BASE}/?s=${encodeURIComponent(p.key)}`);
    const side = page.locator("aside.panel");
    await expect(side.locator(".timeline .turn-plan").getByText(HEAD, { exact: true })).toBeVisible();
    await expect(side.locator(".turn-plan").getByText(LAST, { exact: true })).toHaveCount(1);
    await expect(side.locator(".sess-ctl .ctl-q-text")).toHaveText("Ready to start on this plan?");
    await expect(side.locator(".sess-ctl .md")).toHaveCount(0);
  } finally {
    await d.stop();
  }
});
