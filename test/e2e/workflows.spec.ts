// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Workflows (web/src/orchestrate/workflows, server/orchestrate): the list with its
// templates, a workflow made in the editor and saved by itself, Run, and the run view
// moving a step through this page as the signer: the server offers the step, the page
// waits for a passkey, Unlock now takes the day grant, the runner claims the step, signs
// one `start` the fake daemon takes and acks, and the step and the run end as done. The
// list then names the last run. Against the second e2e instance (test door on, rp id
// localhost) through a fake daemon (control-helpers.ts).
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  CONTROL_BASE,
  type FakeDaemon,
  fakeDaemon,
  type PageKey,
  passkeyPage,
  seenSetupHere,
  sinkToken,
} from "./control-helpers.js";

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "desktop project");

const tag = () => randomUUID().slice(0, 6);
const advertising = (name: string) => ({
  name,
  harnesses: ["claude-code", "codex"],
  folders: ["/Users/e2e/code"],
  mode: "auto" as const,
  start: {
    "claude-code": { permissions: ["read", "safe", "edits", "auto"], permission: "auto", any_model: true },
    codex: { permissions: ["read", "safe", "auto"], permission: "auto", models: ["gpt-6-astra"] },
  },
});

interface Run {
  id: string;
  status: string;
  rev: number;
  steps: Record<string, { status: string; commandId?: string; session?: string; reply?: string }>;
}
const api = async (page: Page) =>
  (await (await page.request.get(`${CONTROL_BASE}/api/ui/workflows`)).json()) as {
    workflows: { id: string; name: string }[];
    runs: Run[];
  };

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

test("the list: the templates are the empty state; the rail and g w reach it", async ({ page }) => {
  await page.goto(`${CONTROL_BASE}/`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  await page.keyboard.press("g");
  await page.keyboard.press("w");
  await expect(page).toHaveURL(/\/workflows$/);
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  await expect(page.locator("[data-template]")).toHaveCount(3);
  await expect(page.locator("[data-template=implement-review]")).toContainText("Implement, then review");
  await expect(page.locator("[data-template=second-opinion]")).toContainText("Second opinion");
  await expect(page.locator("[data-template=plan-build-test]")).toContainText("Plan, build, test");
});

test("a workflow written in the editor saves itself, runs, and this page signs its step", async ({ page }) => {
  const name = `wf-${tag()}`;
  const m = await fakeDaemon(key, advertising(name), {
    sinkToken: sink,
    script: (c) => ({
      pauseMs: 400,
      events: true,
      acks: [
        { outcome: "taken", mode: "sdk" },
        { outcome: "delivered", mode: "sdk", session: c.session, reply: "Hello from the step." },
      ],
    }),
  });
  daemons.push(m);
  await page.goto(`${CONTROL_BASE}/workflows`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  await page.locator("[data-wf-new]").click();
  await expect(page).toHaveURL(/\/workflows\/[A-Za-z0-9_-]+$/);
  const editor = page.locator("[data-wf-editor]");
  await expect(editor).toBeVisible();
  await editor.locator("[data-wf-name]").fill(`Say hello ${name}`);
  await editor.locator("[data-wf-add]").click();
  await editor.locator("[data-wf-step-name]").fill("Greet");
  await editor.locator("[data-wf-row=agent] button.sel").click();
  await page.locator(".sel-opt", { hasText: `${name} › Claude Code · new session` }).click();
  await expect(editor.locator("[data-wf-row=folder] button.sel")).toHaveAttribute("data-value", "/Users/e2e/code");
  await editor.locator("[data-wf-prompt]").fill("Say hello and stop.");
  // Autosave: the bar says so, and the server has it.
  await expect(page.locator(".wf-bar-meta")).toHaveText("Saved", { timeout: 10_000 });
  const id = decodeURIComponent(page.url().split("/").pop()!);
  await expect.poll(async () => (await api(page)).workflows.find((w) => w.id === id)?.name).toBe(`Say hello ${name}`);

  // Run: no input named, so it starts at once and the run view opens on it.
  await page.locator("[data-wf-run]").click();
  await expect(page).toHaveURL(/\/workflows\/runs\/[0-9A-Z]{26}$/);
  const view = page.locator("[data-wf-run-view]");
  await expect(view).toBeVisible();
  // The step's id was made when it was added, before it had a name: "step".
  const step = view.locator("[data-step=step]");
  await expect(step).toContainText("Greet");
  await expect(step).toContainText("Claude Code");
  // Nobody signed within 2 s: the run waits for a signer, and this page can be one once
  // it holds the day grant.
  await expect(step).toContainText("Waiting for your passkey.", { timeout: 10_000 });
  await page.locator("[data-wf-unlock]").click();
  // The runner claims, signs the start, brings the command id back; the machine acks.
  await expect(step).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(page.locator(".bar-meta")).toContainText("done in");
  const cmd = m.seen.find((c) => c.kind === "start")!;
  expect(cmd).toMatchObject({ cwd: "/Users/e2e/code", text: "Say hello and stop." });
  expect(cmd.session).toMatch(/^claude-code:/);
  const runId = decodeURIComponent(page.url().split("/").pop()!);
  const run = (await api(page)).runs.find((r) => r.id === runId)!;
  expect(run.status).toBe("done");
  const greet = run.steps.step!;
  expect(greet).toMatchObject({ status: "done", session: cmd.session, reply: "Hello from the step." });
  expect(greet.commandId).toBeTruthy();
  // The reply folds open under the step.
  await step.locator("summary", { hasText: "Show the reply" }).click();
  await expect(step).toContainText("Hello from the step.");

  // The list names the run.
  await page.goto(`${CONTROL_BASE}/workflows`);
  await expect(page.locator(`[data-workflow="${id}"]`)).toContainText("last run done");
});
