// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The Files drawer on a session: the files its tools named (from the receiver's whole-
// session index), one file's changes and text rebuilt from its Read and the Edits after
// it, its versions, a comment on a range of lines that becomes a review message in the
// composer, the Problems tab's jump to a failed tool, and the keys.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { EVENTS, INFO, openPage, sessionUrl, ulid } from "./helpers.js";

const numbered = (lines: string[]) => lines.map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join("\n");

/** One tier-3 Claude Code session: a Read of a file (numbered, as Claude Code returns
 *  it), two Edits to it, a Write of a new file, a Bash that failed, then a second Read of
 *  the first file (a later version). */
async function postSession(request: APIRequestContext) {
  const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
  const harness = "claude-code";
  const sessionId = randomUUID();
  const title = `E2E files ${sessionId.slice(0, 8)}`;
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
      // Under acme, like every e2e repo: the Review page's test reads the headings.
      session: {
        id: sessionId,
        seq: seq++,
        machine: "e2e-box",
        cwd,
        repo: "github.com/acme/e2e-files",
        title,
        title_source: "custom",
      },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const tool = (name: string, input: Record<string, unknown>, output: string, ok = true) => {
    const call_id = `c${seq}`;
    return [
      ev("tool.started", { tool: name, call_id, turn_id: "t1", input }),
      ev("tool.ended", { tool: name, call_id, turn_id: "t1", input, output, ok, ms: 20 }),
    ];
  };
  const file = `${cwd}/src/outbox.ts`;
  // Over the list page's 200-character preview, so the drawer has to fetch the whole Read.
  const banner = `// ${"The outbox: append-only JSONL files, one per session, read by sinks by cursor. ".repeat(3)}`;
  const events = [
    ev("session.started", { source: "startup" }),
    ev("turn.started", { turn_id: "t1", prompt_chars: 40 }),
    ...tool(
      "Read",
      { file_path: file },
      numbered([banner, "import { open } from 'node:fs';", "const limit = 1 << 20;", "export { limit };"]),
    ),
    ...tool(
      "Edit",
      { file_path: file, old_string: "const limit = 1 << 20;", new_string: "const limit = MAX_BATCH;" },
      "ok",
    ),
    ...tool("Write", { file_path: `${cwd}/src/new.test.ts`, content: "test('x', () => {});\n" }, "ok"),
    ...tool("Bash", { command: "npm test" }, "FAIL src/new.test.ts\n  expected 1, got 2", false),
    ev("turn.ended", { turn_id: "t1", reason: "stop", ms: 5000 }),
  ];
  const res = await request.post(EVENTS, {
    headers: { "content-type": "application/json", authorization: `Bearer ${sinkToken}`, "sessionpipe-protocol": "1" },
    data: { events },
  });
  expect(res.status()).toBe(202);
  return { harness, sessionId, title };
}

const drawer = (page: Page) => page.locator(".files");

test.describe("files drawer", () => {
  test("lists the files a session touched and shows one as its changes, then its text", async ({ page, request }) => {
    const s = await postSession(request);
    await openPage(page, sessionUrl(s.harness, s.sessionId));
    await expect(page.locator("h1.sess-title")).toContainText(s.title);
    await page.locator(".sess-bar").getByRole("button", { name: "Files" }).click();
    await expect(drawer(page)).toBeVisible();
    const rows = drawer(page).locator("button.files-row");
    await expect(rows).toHaveCount(2);
    await expect(drawer(page).locator(".files-dir")).toHaveText(["src"]);
    // In path order, the fact with its time.
    await expect(rows.nth(0)).toContainText("new.test.ts");
    await expect(rows.nth(0).locator(".files-row-fact")).toHaveText(/^new · \d+ (s|m) ago$/);
    await expect(rows.nth(1).locator(".files-row-fact")).toHaveText(/^edited · read · \d+ (s|m) ago$/);

    await rows.nth(1).click();
    await expect(page).toHaveURL(/\?file=src%2Foutbox\.ts/);
    await expect(drawer(page).locator(".files-title")).toHaveText("src/outbox.ts");
    await expect(drawer(page).locator(".fv-note")).toContainText(/As read at \d\d:\d\d, with 1 edit after it\./);
    // Changes first: the line taken out in red, the one put in, the rest folded or kept as context.
    await expect(drawer(page).locator("label.seg-opt.seg-on")).toHaveText("Changes");
    await expect(drawer(page).locator("li.fv-line.is-del .fv-text")).toContainText("const limit = 1 << 20;");
    await expect(drawer(page).locator("li.fv-line.is-add .fv-text")).toHaveText("const limit = MAX_BATCH;");
    // The whole text, with the edited line marked.
    await drawer(page).locator("label.seg-opt", { hasText: "Text" }).click();
    const lines = drawer(page).locator("li.fv-line");
    await expect(lines).toHaveCount(4);
    await expect(lines.nth(2).locator(".fv-text")).toHaveText("const limit = MAX_BATCH;");
    await expect(lines.nth(2)).toHaveClass(/is-changed/);
    await expect(lines.nth(0)).not.toHaveClass(/is-changed/);

    // A reload opens on the same file, by the URL; Back goes to the list and the parameter goes with it.
    await page.reload();
    await expect(drawer(page).locator(".files-title")).toHaveText("src/outbox.ts");
    await drawer(page).getByRole("button", { name: "Back to the files" }).click();
    await expect(rows).toHaveCount(2);
    await expect(page).not.toHaveURL(/file=/);
  });

  test("a comment on a range of lines becomes a review message in the composer", async ({ page, request }) => {
    const s = await postSession(request);
    await openPage(page, `${sessionUrl(s.harness, s.sessionId)}?file=src%2Foutbox.ts`);
    await drawer(page).locator("label.seg-opt", { hasText: "Text" }).click();
    const lines = drawer(page).locator("li.fv-line");
    await expect(lines).toHaveCount(4);
    await lines.nth(2).locator("button.fv-gutter").click();
    await lines
      .nth(3)
      .locator("button.fv-gutter")
      .click({ modifiers: ["Shift"] });
    await expect(drawer(page).locator(".fv-form-where")).toContainText("Lines 3–4");
    await drawer(page).getByRole("textbox", { name: "Comment" }).fill("Name the constant after what it bounds.");
    await drawer(page).getByRole("button", { name: "Add comment" }).click();
    const review = drawer(page).locator(".files-review");
    await expect(review.locator(".files-review-item")).toHaveCount(1);
    await expect(review.locator(".files-review-where")).toHaveText("outbox.ts:3–4");
    // Unpaired, nothing can be signed here: the one way is the composer, said so under it.
    await expect(review.getByRole("button", { name: /^Send/ })).toHaveCount(0);
    await expect(review.locator(".files-review-note")).toHaveText("Pair e2e-box to send from here.");
    await review.getByRole("button", { name: "Add to message" }).click();
    await expect(review).toHaveCount(0);
    await expect(page.locator(".ctl textarea")).toHaveValue(
      [
        "A review comment on your changes. Please address it, then say what you changed.",
        "",
        "`src/outbox.ts:3-4`",
        "```ts",
        "const limit = MAX_BATCH;",
        "export { limit };",
        "```",
        "Name the constant after what it bounds.",
      ].join("\n"),
    );
  });

  test("a suggestion replaces the lines in the message", async ({ page, request }) => {
    const s = await postSession(request);
    await openPage(page, `${sessionUrl(s.harness, s.sessionId)}?file=src%2Foutbox.ts`);
    await drawer(page).locator("li.fv-line.is-add button.fv-gutter").click();
    await drawer(page).getByRole("button", { name: "Suggest a replacement" }).click();
    await drawer(page).getByRole("textbox", { name: "Replacement" }).fill("const limit = MAX_BATCH_BYTES;");
    await drawer(page).getByRole("button", { name: "Add comment" }).click();
    await expect(drawer(page).locator(".files-review-kind")).toHaveText("suggestion");
    await drawer(page).getByRole("button", { name: "Add to message" }).click();
    await expect(page.locator(".ctl textarea")).toHaveValue(
      /Replace with:\n```ts\nconst limit = MAX_BATCH_BYTES;\n```$/,
    );
  });

  test("the Problems tab lists the failed tool and jumps to its row; Esc steps back", async ({ page, request }) => {
    const s = await postSession(request);
    await openPage(page, sessionUrl(s.harness, s.sessionId));
    await page.keyboard.press("Shift+F");
    await expect(drawer(page)).toBeVisible();
    await drawer(page).locator("label.seg-opt", { hasText: "Problems · 1" }).click();
    const problem = drawer(page).locator("button.files-problem");
    await expect(problem).toHaveCount(1);
    await expect(problem.locator(".files-problem-tool")).toHaveText("Bash");
    await expect(problem.locator(".files-problem-subject")).toHaveText("npm test");
    await expect(problem.locator(".files-problem-text")).toHaveText("FAIL src/new.test.ts\n  expected 1, got 2");
    await problem.click();
    await expect(page.locator(".timeline li.tool.is-target")).toHaveCount(1);
    // Esc from anywhere: a file open steps back to the list, the list closes the drawer.
    await drawer(page)
      .locator("label.seg-opt", { hasText: /^Files/ })
      .click();
    await drawer(page).locator("button.files-row").first().click();
    await expect(drawer(page).locator(".files-title")).toBeVisible();
    await page.locator("h1.sess-title").click();
    await page.keyboard.press("Escape");
    await expect(drawer(page).locator("button.files-row").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
  });

  test("the keys: arrows move over the files and the lines, Enter opens, n finds the change", async ({
    page,
    request,
  }) => {
    const s = await postSession(request);
    await openPage(page, sessionUrl(s.harness, s.sessionId));
    await page.keyboard.press("Shift+F");
    // ⇧F puts focus in the filter; ↓ moves to the rows, Enter opens.
    await expect(drawer(page).getByRole("searchbox", { name: "Filter files" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(drawer(page).locator("button.files-row").nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(drawer(page).locator("button.files-row").nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(drawer(page).locator(".files-title")).toHaveText("src/outbox.ts");
    await expect(drawer(page).locator(".files-title")).toBeFocused();
    // In the text, ↓ walks the line numbers, n jumps to the change, Enter opens the comment.
    await drawer(page).locator("label.seg-opt", { hasText: "Text" }).click();
    await drawer(page).locator("li.fv-line").first().locator("button.fv-gutter").focus();
    await page.keyboard.press("n");
    await expect(drawer(page).locator("li.fv-line.is-changed button.fv-gutter")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(drawer(page).getByRole("textbox", { name: "Comment" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer(page).locator(".fv-form")).toHaveCount(0);
    await expect(drawer(page)).toBeVisible();
  });
});
