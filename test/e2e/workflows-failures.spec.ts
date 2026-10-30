// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// A workflow run that does not go well, as the run view shows it: a step whose start the
// machine refuses fails the run there (the row says why, the step after it says what it
// waited on), and a machine that is paired but not polling holds the run until it is
// back, with Cancel the way out. Against the second e2e instance through a fake daemon
// (control-helpers.ts), the workflow saved over the API so the editor stays out of it.
// The signer's two moves are made by hand through the test door, and the step is sent
// before its machine ever polls: no page here holds a day grant, so no other spec's step
// is claimed from here, and no other page can claim this one (the page's own signing path
// is workflows.spec.ts).
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  CONTROL_BASE,
  type FakeDaemon,
  fakeDaemon,
  type PageKey,
  passkeyPage,
  seenSetupHere,
} from "./control-helpers.js";

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "desktop project");

const CONTROL = `${CONTROL_BASE}/api/sessionpipe/v1/control`;
const WORKFLOWS = `${CONTROL_BASE}/api/ui/workflows`;
const tag = () => randomUUID().slice(0, 6);
const advertising = (name: string) => ({
  name,
  harnesses: ["claude-code"],
  folders: ["/Users/e2e/code"],
  mode: "auto" as const,
  start: { "claude-code": { permissions: ["read", "safe", "edits", "auto"], permission: "auto", any_model: true } },
});

interface Run {
  id: string;
  rev: number;
  status: string;
  waitingFor?: string;
  steps: Record<string, { status: string; error?: string }>;
}

/** Two steps on `machine`, saved whole, and a run of them started. */
async function startRun(page: Page, machine: FakeDaemon): Promise<{ run: Run; workflowId: string }> {
  const id = `wf-${tag()}`;
  const steps = [
    { id: "greet", name: "Greet", machineId: machine.id, agent: { harness: "claude-code" }, text: "Say hello." },
    {
      id: "answer",
      name: "Answer",
      machineId: machine.id,
      agent: { harness: "claude-code" },
      text: "Reply to {{prev}}",
    },
  ];
  const saved = await page.request.put(`${WORKFLOWS}/${id}`, { data: { name: `Failure ${id}`, steps } });
  expect(saved.status()).toBe(200);
  // Every write is JSON, an empty one too (routes.ts: no other site can make it).
  const started = await page.request.post(`${WORKFLOWS}/${id}/run`, { data: {} });
  expect(started.status()).toBe(201);
  return { run: (await started.json()) as Run, workflowId: id };
}

const runOf = async (page: Page, id: string): Promise<Run> => {
  const all = (await (await page.request.get(WORKFLOWS)).json()) as { runs: Run[] };
  return all.runs.find((r) => r.id === id)!;
};

/** The signer's two moves on a ready step, by hand: the claim under the run's rev, a
 *  start signed by the test door and queued for the machine, and its id brought back. */
async function signByHand(page: Page, m: FakeDaemon, run: Run, step: string, text: string): Promise<string> {
  const claimed = await page.request.patch(`${WORKFLOWS}/runs/${run.id}`, {
    data: { step, status: "sending" },
    headers: { "if-match": String(run.rev) },
  });
  expect(claimed.status()).toBe(200);
  const rev = ((await claimed.json()) as Run).rev;
  const queued = await page.request.post(`${CONTROL}/_test/enqueue`, {
    data: {
      machine: m.id,
      message: { kind: "start", session: `claude-code:${randomUUID()}`, text, cwd: "/Users/e2e/code" },
    },
  });
  expect(queued.status()).toBe(201);
  const { id } = (await queued.json()) as { id: string };
  const sent = await page.request.patch(`${WORKFLOWS}/runs/${run.id}`, {
    data: { step, commandId: id },
    headers: { "if-match": String(rev) },
  });
  expect(sent.status()).toBe(200);
  return id;
}

/** One poll as the daemon, answering every command it is handed with `acks`; the commands. */
async function pollAndAck(m: FakeDaemon, acks: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const auth = { authorization: `Bearer ${m.token}`, "content-type": "application/json" };
  const r = await fetch(`${CONTROL}?machine=${m.id}&wait=0`, { headers: auth });
  expect(r.status).toBe(200);
  const { messages } = (await r.json()) as { messages: { id: string; cmd: string }[] };
  const res = await fetch(`${CONTROL}/ack`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      acks: messages.flatMap((msg) => acks.map((a) => ({ id: msg.id, at: new Date().toISOString(), ...a }))),
    }),
  });
  expect(res.status).toBe(202);
  return messages.map((msg) => JSON.parse(msg.cmd) as Record<string, unknown>);
}

let key: PageKey;
const daemons: FakeDaemon[] = [];
test.afterAll(async () => {
  await Promise.all(daemons.map((d) => d.stop()));
});

test.beforeEach(async ({ context, page }) => {
  await seenSetupHere(context);
  // A passkey for the machine to trust; the page never takes a day grant with it.
  key = await passkeyPage(context, page);
});

test("a start the machine refuses: the run fails at that step, the row says why, the next step is skipped", async ({
  page,
}) => {
  const name = `refusing-${tag()}`;
  const m = await fakeDaemon(key, advertising(name), { offline: true });
  daemons.push(m);
  const { run, workflowId } = await startRun(page, m);
  await page.goto(`${CONTROL_BASE}/workflows/runs/${run.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  const view = page.locator("[data-wf-run-view]");
  await expect(view).toBeVisible();
  const greet = view.locator("[data-step=greet]");
  const answer = view.locator("[data-step=answer]");
  await expect(greet).toContainText(`Waiting for ${name}.`);
  await signByHand(page, m, run, "greet", "Say hello.");
  await expect(greet).toHaveAttribute("data-status", "sent");
  // While it runs, Cancel offers to stop it too: the step knows its session from the
  // command it sent, not only from the ack. Kept running here.
  await page.locator("[data-wf-cancel]").click();
  const confirm = page.locator(".confirm");
  await expect(confirm).toContainText("Cancel this run?");
  await expect(confirm.locator(".wf-dialog-option")).toContainText(`Also stop Greet on ${name}`);
  await confirm.locator("[data-cancel]").click();
  await expect(confirm).toHaveCount(0);
  await expect(greet).toHaveAttribute("data-status", "sent");
  // The machine polls at last, takes the start and refuses it at once.
  const taken = await pollAndAck(m, [{ outcome: "refused", code: "folder", detail: "/Users/e2e/code is not allowed" }]);
  expect(taken).toHaveLength(1);
  expect(taken[0]).toMatchObject({ kind: "start", text: "Say hello.", cwd: "/Users/e2e/code" });
  await expect(greet).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  await expect(greet).toContainText(/doesn't allow that folder|folder: \/Users\/e2e\/code is not allowed/);
  await expect(answer).toHaveAttribute("data-status", "skipped");
  await expect(answer).toContainText("skipped · Greet failed");
  await expect(page.locator(".wf-bar-meta")).toHaveText("failed at Greet");
  // Over: no Cancel, and the server agrees.
  await expect(page.locator("[data-wf-cancel]")).toHaveCount(0);
  expect(await runOf(page, run.id)).toMatchObject({
    status: "failed",
    steps: {
      greet: { status: "failed", error: "folder: /Users/e2e/code is not allowed" },
      answer: { status: "skipped" },
    },
  });

  // The list says where it failed.
  await page.goto(`${CONTROL_BASE}/workflows`);
  await expect(page.locator(`[data-workflow="${workflowId}"]`)).toContainText("last run failed at Greet");
});

test("a machine that is paired but not polling: the run waits for it, nothing is signed, and Cancel skips the steps", async ({
  page,
}) => {
  const name = `away-${tag()}`;
  const m = await fakeDaemon(key, advertising(name), { offline: true });
  daemons.push(m);
  const { run } = await startRun(page, m);
  expect(run).toMatchObject({ status: "waiting", waitingFor: "machine" });
  await page.goto(`${CONTROL_BASE}/workflows/runs/${run.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  const view = page.locator("[data-wf-run-view]");
  const greet = view.locator("[data-step=greet]");
  await expect(greet).toHaveAttribute("data-status", "ready");
  await expect(greet).toContainText(`Waiting for ${name}. It sends when the machine is back.`);
  await expect(page.locator(".wf-bar-meta")).toContainText(`waiting for ${name}`);
  // No passkey is asked for, and the step stays the server's to offer: nothing was signed.
  await expect(page.locator("[data-wf-unlock]")).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect((await runOf(page, run.id)).steps.greet!.status).toBe("ready");

  // Cancel, through its confirm: every step is skipped, the run is over.
  await page.locator("[data-wf-cancel]").click();
  const confirm = page.locator(".confirm");
  await expect(confirm).toContainText("Cancel this run?");
  await confirm.getByRole("button", { name: "Cancel run" }).click();
  await expect(page.locator(".wf-bar-meta")).toHaveText("cancelled · 2 steps skipped");
  await expect(greet).toHaveAttribute("data-status", "skipped");
  await expect(view.locator("[data-step=answer]")).toContainText("skipped · cancelled");
  await expect(page.locator("[data-wf-cancel]")).toHaveCount(0);
  expect(await runOf(page, run.id)).toMatchObject({
    status: "cancelled",
    steps: { greet: { status: "skipped" }, answer: { status: "skipped" } },
  });
});
