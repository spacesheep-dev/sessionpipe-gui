// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// A session nothing has happened in (a program started the harness and stopped it, as an
// IDE's provider probe does from its maintenance folder) stays off the board until its
// first turn; its page still opens. Both shapes the probes send: a start and an end, and
// an unattended start alone. A terminal a person has just opened is not one of them.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { EVENTS, INFO, openBoard, openPage, sessionUrl, ulid } from "./helpers.js";

const FOLDER = "~/.ide/provider-maintenance-workspace";

/** Events for one Claude Code session at tier 1: by default a probe in its folder,
 *  unattended; `attended` makes it a terminal a person has open. */
function probe(attended = false) {
  const sessionId = randomUUID();
  let seq = 0;
  let clock = Date.now() - 30_000;
  const ev = (type: string, data: Record<string, unknown>) => {
    clock += 500;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 1,
      harness: { name: "claude-code", version: "2.1.296" },
      session: { id: sessionId, seq: seq++, machine: "e2e-box", cwd: attended ? "~/code/e2e" : FOLDER, attended },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  return { sessionId, ev };
}

async function post(request: APIRequestContext, events: Record<string, unknown>[]) {
  const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
  const res = await request.post(EVENTS, {
    headers: { "content-type": "application/json", authorization: `Bearer ${sinkToken}`, "sessionpipe-protocol": "1" },
    data: { events },
  });
  expect(res.status()).toBe(202);
}

test.describe("empty sessions", () => {
  test("an unattended start, with or without its end, stays off the board until a turn; an open terminal stays on", async ({
    page,
    request,
  }) => {
    const ended = probe();
    const open = probe();
    const terminal = probe(true);
    await post(request, [
      ended.ev("session.started", { source: "startup" }),
      ended.ev("session.ended", { reason: "other" }),
      open.ev("session.started", { source: "startup" }),
      terminal.ev("session.started", { source: "startup" }),
    ]);
    await openBoard(page);
    // Done is folded by default: open it, so a row there would be drawn.
    const done = page.locator('section.group--done button.group-toggle[aria-expanded="false"]');
    if (await done.count()) await done.click();
    const card = (id: string) => page.locator(`a.card-link[href="${sessionUrl("claude-code", id)}"]`);
    await expect(page.locator("section.group").first()).toBeVisible();
    await expect(card(ended.sessionId)).toHaveCount(0);
    await expect(card(open.sessionId)).toHaveCount(0);
    // A terminal someone has just opened stays: its first message can come from here.
    await expect(card(terminal.sessionId)).toHaveCount(1);

    // The receiver keeps them: the page opens on the session, not on "No such session".
    await openPage(page, sessionUrl("claude-code", ended.sessionId));
    await expect(page.locator("h1.sess-title")).toBeVisible();
    await expect(page.getByText("No such session here")).toHaveCount(0);

    // Its first turn puts the open one on the board.
    await post(request, [
      open.ev("turn.started", { turn_id: "t1", prompt_chars: 12 }),
      open.ev("turn.ended", { turn_id: "t1", reason: "stop", ms: 800 }),
    ]);
    await openBoard(page);
    await expect(card(open.sessionId)).toHaveCount(1);
    await expect(card(ended.sessionId)).toHaveCount(0);
  });
});
