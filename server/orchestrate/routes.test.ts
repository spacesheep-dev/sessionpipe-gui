// SPDX-License-Identifier: Apache-2.0
// The workflow routes over real HTTP, and the service over control: a run driven from a
// claim through a queued command to the machine's ack, the If-Match guard, the stream
// frames, cancel and delete; the clock rules with a fake control; what a restart finds.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ControlActivity,
  type MachineControl,
  ROUTES,
  type StreamMessage,
  WAITING_SIGNER_MS,
  type Workflow,
  type WorkflowRun,
} from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { createOrchestrate } from "./index.js";
import { CLAIM_TTL_MS } from "./runs.js";

const WF = ROUTES.ui.workflows;
const CONTROL = ROUTES.control;
const MACHINE = "m_workflow000000000001";

type Res = { status: number; body: Record<string, unknown>; etag: string | null };
async function call(
  url: string,
  method: string,
  p: string,
  o: { body?: unknown; headers?: Record<string, string>; bearer?: string; raw?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.body !== undefined || o.raw !== undefined) headers["content-type"] ??= "application/json";
  const r = await fetch(`${url}${p}`, {
    method,
    headers,
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  const text = await r.text();
  return {
    status: r.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    etag: r.headers.get("etag"),
  };
}

/** An SSE reader that hands back the next frame of a kind. */
async function streamOf(url: string) {
  const res = await fetch(`${url}${ROUTES.ui.stream}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const next = async (kind: string, pred: (m: StreamMessage) => boolean = () => true): Promise<StreamMessage> => {
    for (;;) {
      const i = buf.indexOf("\n\n");
      if (i >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        const m = data ? (JSON.parse(data.slice(6)) as StreamMessage) : null;
        if (m?.kind === kind && pred(m)) return m;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buf += dec.decode(value, { stream: true });
    }
  };
  return { next, close: () => reader.cancel() };
}

const doc = (steps: Workflow["steps"], extra: Partial<Workflow> = {}) => ({
  name: "Implement, then review",
  steps,
  ...extra,
});
const harnessStep = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  machineId: MACHINE,
  agent: { harness: "claude-code" },
  text,
  ...extra,
});

describe("without the test door", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };

  beforeAll(async () => {
    tmp = tempDir();
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true });
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("the { step, commandId } move is not a move: a loopback caller cannot bind a command to a step", async () => {
    expect((await call(app.url, "PUT", `${WF}/w`, { body: doc([harnessStep("a", "A")]) })).status).toBe(200);
    const run = (await call(app.url, "POST", `${WF}/w/run`, { body: {} })).body as unknown as WorkflowRun;
    const patch = (body: unknown) =>
      call(app.url, "PATCH", `${WF}/runs/${run.id}`, { body, headers: { "if-match": String(run.rev) } });
    const claimed = await patch({ step: "a", status: "sending" });
    expect(claimed.status).toBe(200);
    const rev = (claimed.body as unknown as WorkflowRun).rev;
    const bound = await call(app.url, "PATCH", `${WF}/runs/${run.id}`, {
      body: { step: "a", commandId: "01K8CMD000000000000000ABCD" },
      headers: { "if-match": String(rev) },
    });
    expect(bound.status).toBe(400);
    expect(bound.body).toMatchObject({
      reason: "malformed",
      error: 'Send { step, status: "sending" } or { step, send }.',
    });
    expect((await call(app.url, "GET", WF)).body).toMatchObject({ runs: [{ steps: { a: { status: "sending" } } }] });
  });
});

describe("workflow routes", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  let token: string;
  const url = (p: string) => `${app.url}${p}`;

  beforeAll(async () => {
    tmp = tempDir();
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, testDoor: true });
    const r = await call(app.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine: MACHINE } });
    token = r.body.token as string;
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("GET is empty at first; PUT reads the whole document and the stream says so; bad ones are refused", async () => {
    expect((await call(app.url, "GET", WF)).body).toEqual({ workflows: [], runs: [] });
    const s = await streamOf(app.url);
    await s.next("snapshot");
    const saved = await call(app.url, "PUT", `${WF}/review`, {
      body: doc([harnessStep("a", "Implement {{input}}"), harnessStep("b", "Review:\n{{prev}}")], {
        input: { label: "Task" },
      }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ id: "review", name: "Implement, then review", input: { label: "Task" } });
    const frame = (await s.next("workflows")) as { workflows: Workflow[] };
    expect(frame.workflows.map((w) => w.id)).toEqual(["review"]);
    expect((await call(app.url, "GET", WF)).body).toMatchObject({ workflows: [{ id: "review" }], runs: [] });

    expect(
      (await call(app.url, "PUT", `${WF}/review`, { body: doc([harnessStep("a", "{{nope}}")]) })).body,
    ).toMatchObject({ reason: "bad_step" });
    expect((await call(app.url, "PUT", `${WF}/review`, { body: { name: "x", steps: [] } })).status).toBe(400);
    expect(
      (await call(app.url, "PUT", `${WF}/review`, { body: doc([harnessStep("a", "x".repeat(20_001))]) })).status,
    ).toBe(413);
    expect((await call(app.url, "PUT", `${WF}/review`, { raw: "{nope" })).status).toBe(400);
    expect(
      (await call(app.url, "PUT", `${WF}/review`, { raw: "{}", headers: { "content-type": "text/plain" } })).status,
    ).toBe(415);
    expect((await call(app.url, "PUT", `${WF}/bad id`, { body: doc([harnessStep("a", "x")]) })).status).toBe(400);
    // Still the saved one.
    expect(((await call(app.url, "GET", WF)).body.workflows as Workflow[])[0]!.steps).toHaveLength(2);
    expect((await call(app.url, "DELETE", `${WF}/nope`)).status).toBe(404);
    await s.close();
  });

  it("a run from claim to the machine's ack: ready → sending → sent → done, the next step resolved from the reply", async () => {
    const s = await streamOf(app.url);
    await s.next("snapshot");
    // The machine has not polled yet: the run waits for it.
    const noInput = await call(app.url, "POST", `${WF}/review/run`, { body: {} });
    expect(noInput.status).toBe(400);
    expect(noInput.body.error).toBe("This workflow asks for Task.");
    const started = await call(app.url, "POST", `${WF}/review/run`, { body: { input: "dark mode" } });
    expect(started.status).toBe(201);
    const run0 = started.body as unknown as WorkflowRun;
    expect(run0).toMatchObject({
      workflowId: "review",
      status: "waiting",
      waitingFor: "machine",
      rev: 1,
      input: "dark mode",
    });
    expect(run0.steps.a).toMatchObject({ status: "ready", text: "Implement dark mode" });
    expect(started.etag).toBe('"1"');
    expect(((await s.next("workflowRun")) as { run: WorkflowRun }).run.id).toBe(run0.id);

    // The machine polls: online. Within a tick the run reads running (or waiting for a signer).
    expect((await call(app.url, "GET", `${CONTROL}?machine=${MACHINE}&wait=0`, { bearer: token })).status).toBe(204);
    const moved = (await s.next("workflowRun", (m) => m.kind === "workflowRun" && m.run.waitingFor !== "machine")) as {
      run: WorkflowRun;
    };
    expect(["running", "waiting"]).toContain(moved.run.status);
    let run = (await call(app.url, "GET", WF)).body.runs as WorkflowRun[];
    expect(run[0]!.id).toBe(run0.id);
    let rev = run[0]!.rev;

    // The claim: If-Match is the guard.
    const patch = (body: unknown, ifMatch?: number | string) =>
      call(app.url, "PATCH", `${WF}/runs/${run0.id}`, {
        body,
        headers: ifMatch !== undefined ? { "if-match": String(ifMatch) } : {},
      });
    expect((await patch({ step: "a", status: "sending" })).status).toBe(428);
    const stale = await patch({ step: "a", status: "sending" }, rev + 7);
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({ reason: "conflict", run: { id: run0.id, rev } });
    const claimed = await patch({ step: "a", status: "sending" }, `"${rev}"`);
    expect(claimed.status).toBe(200);
    expect((claimed.body as unknown as WorkflowRun).steps.a!.status).toBe("sending");
    rev = (claimed.body as unknown as WorkflowRun).rev;
    // Another tab that read the run before the claim.
    expect((await patch({ step: "a", status: "sending" }, rev - 1)).status).toBe(412);
    expect((await patch({ step: "a", status: "sending" }, rev)).body).toMatchObject({
      reason: "conflict",
      error: "another tab has it",
    });
    expect((await patch({ step: "zz", status: "sending" }, rev)).status).toBe(404);
    expect((await patch({ step: "a" }, rev)).status).toBe(400);
    expect((await patch({ step: "a", commandId: "nope" }, rev)).status).toBe(400);

    // The tab signs and queues the command (the test door plays the signer).
    const queued = await call(app.url, "POST", `${CONTROL}/_test/enqueue`, {
      body: {
        machine: MACHINE,
        message: {
          kind: "start",
          session: "claude-code:00000000-0000-4000-8000-000000000123",
          text: "Implement dark mode",
          cwd: "/Users/me/proj",
        },
      },
    });
    expect(queued.status).toBe(201);
    const commandId = queued.body.id as string;
    const sent = await patch({ step: "a", commandId }, rev);
    expect(sent.status).toBe(200);
    expect((sent.body as unknown as WorkflowRun).steps.a).toMatchObject({ status: "sent", commandId });
    expect((sent.body as unknown as WorkflowRun).status).toBe("running");
    rev = (sent.body as unknown as WorkflowRun).rev;

    // The machine takes it and answers: the step is done, b is ready with the reply in it.
    await call(app.url, "POST", `${CONTROL}/ack`, {
      bearer: token,
      body: { acks: [{ id: commandId, outcome: "taken", at: new Date().toISOString(), mode: "sdk" }] },
    });
    const acked = await call(app.url, "POST", `${CONTROL}/ack`, {
      bearer: token,
      body: {
        acks: [
          {
            id: commandId,
            outcome: "delivered",
            at: new Date().toISOString(),
            mode: "sdk",
            reply: "Done: 3 files.",
            session: "claude-code:00000000-0000-4000-8000-000000000123",
          },
        ],
      },
    });
    expect(acked.status).toBe(202);
    const settled = (await s.next(
      "workflowRun",
      (m) => m.kind === "workflowRun" && m.run.steps.a?.status === "done",
    )) as { run: WorkflowRun };
    expect(settled.run.steps.a).toMatchObject({
      status: "done",
      reply: "Done: 3 files.",
      session: "claude-code:00000000-0000-4000-8000-000000000123",
    });
    expect(settled.run.steps.b).toMatchObject({ status: "ready", text: "Review:\nDone: 3 files." });
    expect(settled.run.rev).toBeGreaterThan(rev);

    // Cancel: the ready step is skipped and the run is cancelled; a second cancel changes nothing.
    const cancelled = await call(app.url, "POST", `${WF}/runs/${run0.id}/cancel`, { body: {} });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: "cancelled",
      steps: { a: { status: "done" }, b: { status: "skipped" } },
    });
    expect(((await s.next("workflowRun")) as { run: WorkflowRun }).run.status).toBe("cancelled");
    expect((await call(app.url, "POST", `${WF}/runs/${run0.id}/cancel`, { body: {} })).body).toMatchObject({
      rev: (cancelled.body as { rev: number }).rev,
    });
    expect((await call(app.url, "POST", `${WF}/runs/nope/cancel`, { body: {} })).status).toBe(404);

    // Delete: gone, with a frame saying so.
    expect((await call(app.url, "DELETE", `${WF}/runs/${run0.id}`)).status).toBe(204);
    expect(await s.next("workflowRun")).toMatchObject({ kind: "workflowRun", deleted: true, run: { id: run0.id } });
    expect((await call(app.url, "DELETE", `${WF}/runs/${run0.id}`)).status).toBe(404);
    run = (await call(app.url, "GET", WF)).body.runs as WorkflowRun[];
    expect(run).toEqual([]);
    // Deleting the workflow leaves nothing behind.
    expect((await call(app.url, "DELETE", `${WF}/review`)).status).toBe(204);
    expect(((await s.next("workflows")) as { workflows: Workflow[] }).workflows).toEqual([]);
    expect((await call(app.url, "POST", `${WF}/review/run`, { body: {} })).status).toBe(404);
    await s.close();
  });

  it("the routes need the UI's auth", async () => {
    const r = await fetch(url(WF), { headers: { "x-forwarded-for": "203.0.113.9" } });
    // No proxy is trusted here, so loopback is still this machine; the guard is the same
    // one every /api/ui route wears (ui.test.ts covers the cookie).
    expect(r.status).toBe(200);
  });
});

describe("the service over a fake control", () => {
  let tmp: { dir: string; cleanup: () => void };
  let clock = Date.parse("2026-10-28T10:00:00.000Z");
  const frames: StreamMessage[] = [];
  const listeners = new Set<(m: StreamMessage) => void>();
  const activity: ControlActivity[] = [];
  let online = true;
  const control = {
    subscribe: (l: (m: StreamMessage) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    activity: () => activity,
    machines: () => new Map<string, MachineControl>([["box", { machineId: MACHINE, online, keys: [], queued: 0 }]]),
    // The one-move send is the routes' (send.test.ts); the service here is driven by hand.
    activityById: (id: string) => activity.find((a) => a.id === id),
    verifySend: () => Promise.reject(new Error("not here")),
    queueSend: () => {
      throw new Error("not here");
    },
  };
  const emitAck = (a: ControlActivity) => {
    activity.push(a);
    for (const l of listeners) l({ kind: "control", message: a });
  };
  const make = () =>
    createOrchestrate({
      stateDir: tmp.dir,
      control,
      broadcast: (m) => frames.push(m),
      tickMs: 3600_000,
      now: () => clock,
    });
  beforeAll(() => {
    tmp = tempDir();
  });
  afterAll(() => tmp.cleanup());
  afterEach(() => {
    frames.length = 0;
  });

  it("the clock: waiting for a signer after WAITING_SIGNER_MS, a stale claim offered again, a machine going away", () => {
    const svc = make();
    try {
      svc.saveWorkflow("w", doc([harnessStep("a", "A")]));
      let run = svc.startRun("w", undefined);
      expect(run.status).toBe("running");
      clock += WAITING_SIGNER_MS + 1;
      svc.tick();
      run = svc.run(run.id)!;
      expect(run).toMatchObject({ status: "waiting", waitingFor: "signer" });
      run = svc.claim(run.id, "a", run.rev);
      expect(run.steps.a!.status).toBe("sending");
      clock += CLAIM_TTL_MS + 1;
      svc.tick();
      run = svc.run(run.id)!;
      expect(run.steps.a!.status).toBe("ready");
      online = false;
      svc.tick();
      expect(svc.run(run.id)).toMatchObject({ status: "waiting", waitingFor: "machine" });
      online = true;
      svc.tick();
      expect(svc.run(run.id)).toMatchObject({ status: "running" });
      clock += WAITING_SIGNER_MS + 1;
      svc.tick();
      expect(svc.run(run.id)).toMatchObject({ status: "waiting", waitingFor: "signer" });
      expect(frames.filter((f) => f.kind === "workflowRun").length).toBeGreaterThanOrEqual(5);
      expect(svc.deleteRun(run.id)).toBe(true);
    } finally {
      svc.close();
    }
  });

  it("an ack that landed while the receiver was down settles the step at boot", () => {
    let svc = make();
    let run: WorkflowRun;
    try {
      run = svc.startRun("w", undefined);
      run = svc.claim(run.id, "a", run.rev);
      run = svc.sent(run.id, "a", "01K8CMD000000000000000DOWN", run.rev);
      expect(run.steps.a!.status).toBe("sent");
    } finally {
      svc.close();
    }
    // The machine answered while nothing was listening; control kept the ack.
    activity.push({
      id: "01K8CMD000000000000000DOWN",
      machineId: MACHINE,
      kind: "start",
      session: "claude-code:x",
      at: new Date(clock).toISOString(),
      expiresAt: new Date(clock + 3600_000).toISOString(),
      outcome: "delivered",
      reply: "while you were out",
    });
    svc = make();
    try {
      expect(svc.run(run.id)).toMatchObject({
        status: "done",
        steps: { a: { status: "done", reply: "while you were out" } },
      });
      // A live ack after boot settles too (a second run).
      let r2 = svc.startRun("w", undefined);
      r2 = svc.claim(r2.id, "a", r2.rev);
      r2 = svc.sent(r2.id, "a", "01K8CMD000000000000000LIVE", r2.rev);
      emitAck({ ...activity[0]!, id: "01K8CMD000000000000000LIVE", outcome: "refused", code: "folder", detail: "no" });
      expect(svc.run(r2.id)).toMatchObject({
        status: "failed",
        steps: { a: { status: "failed", error: "folder: no" } },
      });
      expect(frames.filter((f) => f.kind === "workflowRun").length).toBeGreaterThanOrEqual(4);
    } finally {
      svc.close();
    }
  });

  it("refuses an input that is not text, or too long, and a run of a workflow that is gone", () => {
    const svc = make();
    try {
      const err = (f: () => unknown) => {
        try {
          f();
          return null;
        } catch (e) {
          return `${(e as { status: number }).status} ${(e as { reason: string }).reason}`;
        }
      };
      expect(err(() => svc.startRun("w", 7))).toBe("400 malformed");
      expect(err(() => svc.startRun("w", "x".repeat(20_001)))).toBe("413 too_large");
      expect(err(() => svc.startRun("zz", undefined))).toBe("404 not_found");
      expect(err(() => svc.claim("zz", "a", 1))).toBe("404 not_found");
      expect(svc.deleteWorkflow("w")).toBe(true);
      expect(err(() => svc.startRun("w", undefined))).toBe("404 not_found");
      expect(frames.some((f) => f.kind === "workflows" && f.workflows.length === 0)).toBe(true);
    } finally {
      svc.close();
    }
  });
});
