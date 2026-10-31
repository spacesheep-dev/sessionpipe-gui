// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// ⌘K's Files section: `/` then a path finds a file a session changed, and Enter opens
// that session's page on it, in its Files drawer.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { EVENTS, INFO, openBoard, ulid } from "./helpers.js";

/** One tier-3 Claude Code session that reads and edits `src/outbox.ts` under a repo. */
async function postSession(request: APIRequestContext) {
  const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
  const harness = "claude-code";
  const sessionId = randomUUID();
  const title = `E2E palette files ${sessionId.slice(0, 8)}`;
  const cwd = "/Users/dev/code/e2e";
  let seq = 0;
  let clock = Date.now() - 60_000;
  const ev = (type: string, data: Record<string, unknown>) => {
    clock += 1000;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 3,
      harness: { name: harness, version: "2.1.296" },
      session: {
        id: sessionId,
        seq: seq++,
        machine: "e2e-box",
        cwd,
        // A repo of its own, so the file is one row that opens straight (a file several
        // sessions touched asks which first).
        repo: `github.com/acme/palette-${sessionId.slice(0, 8)}`,
        title,
        title_source: "custom",
      },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const tool = (name: string, input: Record<string, unknown>, output: string) => {
    const call_id = `c${seq}`;
    return [
      ev("tool.started", { tool: name, call_id, turn_id: "t1", input }),
      ev("tool.ended", { tool: name, call_id, turn_id: "t1", input, output, ok: true, ms: 20 }),
    ];
  };
  const file = `${cwd}/src/outbox.ts`;
  const events = [
    ev("session.started", { source: "startup" }),
    ev("turn.started", { turn_id: "t1", prompt_chars: 40 }),
    ...tool("Read", { file_path: file }, "     1→const limit = 1 << 20;\n     2→export { limit };"),
    ...tool("Edit", { file_path: file, old_string: "1 << 20", new_string: "MAX_BATCH" }, "ok"),
    ev("turn.ended", { turn_id: "t1", reason: "stop", ms: 5000 }),
  ];
  const res = await request.post(EVENTS, {
    headers: { "content-type": "application/json", authorization: `Bearer ${sinkToken}`, "sessionpipe-protocol": "1" },
    data: { events },
  });
  expect(res.status()).toBe(202);
  return { harness, sessionId, title };
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

test.describe("palette: go to file", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project only");

  test("`/` then a path finds the file; Enter opens the session on it", async ({ page, request }) => {
    const s = await postSession(request);
    await openBoard(page);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.type("/outbox.ts");
    // Our session's row (another run may have touched a namesake path in its own repo).
    const row = dialog(page).locator(".pal-row[data-section='Files']").filter({ hasText: s.title }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator(".pal-label")).toHaveText("src/outbox.ts");
    await expect(row.locator(".pal-detail")).toContainText(`acme/palette-${s.sessionId.slice(0, 8)}`);
    // The matched letters are underlined, as every fuzzy row's are.
    await expect(row.locator("u").first()).toBeVisible();
    await row.click();
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/s/claude-code/${s.sessionId}\\?file=src%2Foutbox\\.ts$`));
    await expect(page.locator("aside.files .files-title")).toHaveText("src/outbox.ts");
  });
});
