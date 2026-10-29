// SPDX-License-Identifier: Apache-2.0
// The two guards a workflow write wears, and the signer's second move as the browser makes
// it. The write guard: every POST takes JSON, body or not (an empty POST is a simple
// request any site could make), and a request a browser marks as cross-site is refused
// before anything is read; a DELETE carries no body and preflights anyway. The one-move
// send (PATCH { step, send }): the signed command is verified as /send verifies it, then
// queued and the step marked `sent` with nothing awaited in between, so a step that was
// cancelled, re-offered or taken by another tab while the verifier worked queues nothing;
// a refusal of the command itself fails the step (no claim is offered again for it), a
// signer's fault leaves the claim where it was. Over real HTTP with the test keys, and
// over a fake control for the races the clock owns.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ControlActivity,
  type MachineControl,
  ROUTES,
  type StreamMessage,
  type Workflow,
  type WorkflowRun,
} from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { commandStr, signCommand, TestDayKey, TestPasskey } from "../control/testkeys.js";
import type { VerifiedSend } from "../control/ui.js";
import { HttpError } from "../http/router.js";
import { createOrchestrate, STEP_EXPIRES_MS } from "./index.js";
import { CLAIM_TTL_MS } from "./runs.js";

const WF = ROUTES.ui.workflows;
const CONTROL = ROUTES.control;
const MACHINE = "m_sendmove00000000001";
const SESSION = "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e";

type Res = { status: number; body: Record<string, unknown> };
async function call(
  url: string,
  method: string,
  p: string,
  o: { body?: unknown; headers?: Record<string, string>; bearer?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.body !== undefined) headers["content-type"] ??= "application/json";
  const r = await fetch(`${url}${p}`, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : null });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

/** One prompt to a session; with `{{input}}` the workflow asks for one. */
const doc = (text = "Look at {{input}}"): Partial<Workflow> => ({
  name: "One prompt",
  ...(text.includes("{{input}}") ? { input: { label: "Task" } } : {}),
  steps: [{ id: "a", machineId: MACHINE, agent: { session: SESSION }, text }],
});

describe("the write guard", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  beforeAll(async () => {
    tmp = tempDir();
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, testDoor: true });
    await call(app.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine: MACHINE } });
    expect((await call(app.url, "PUT", `${WF}/one`, { body: doc("Hi") })).status).toBe(200);
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("a POST with no body, or not JSON, is 415: run and cancel alike", async () => {
    expect((await call(app.url, "POST", `${WF}/one/run`)).body).toMatchObject({ reason: "json_only" });
    expect((await call(app.url, "POST", `${WF}/one/run`)).status).toBe(415);
    const started = await call(app.url, "POST", `${WF}/one/run`, { body: {} });
    expect(started.status).toBe(201);
    const id = (started.body as unknown as WorkflowRun).id;
    expect((await call(app.url, "POST", `${WF}/runs/${id}/cancel`)).status).toBe(415);
    expect(
      (await call(app.url, "POST", `${WF}/runs/${id}/cancel`, { body: {}, headers: { "content-type": "text/plain" } }))
        .status,
    ).toBe(415);
    expect((await call(app.url, "GET", WF)).body).toMatchObject({
      runs: [{ id, status: expect.not.stringMatching(/cancelled/) }],
    });
    expect((await call(app.url, "POST", `${WF}/runs/${id}/cancel`, { body: {} })).status).toBe(200);
  });

  it("a request the browser marks cross-site, or with a null origin, is 403 whatever it carries; a DELETE needs no body", async () => {
    const cross = { "sec-fetch-site": "cross-site" };
    expect((await call(app.url, "POST", `${WF}/one/run`, { body: {}, headers: cross })).status).toBe(403);
    expect((await call(app.url, "POST", `${WF}/one/run`, { headers: cross })).body).toMatchObject({
      reason: "cross_site",
    });
    expect((await call(app.url, "PUT", `${WF}/two`, { body: doc("Hi"), headers: cross })).status).toBe(403);
    expect((await call(app.url, "DELETE", `${WF}/one`, { headers: cross })).status).toBe(403);
    expect((await call(app.url, "PATCH", `${WF}/runs/x`, { body: {}, headers: { origin: "null" } })).status).toBe(403);
    // The page's own requests say same-origin, a native shell or a curl say nothing: both go on.
    expect((await call(app.url, "GET", WF, { headers: cross })).status).toBe(200);
    expect((await call(app.url, "DELETE", `${WF}/nope`, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(
      404,
    );
    expect((await call(app.url, "DELETE", `${WF}/nope`)).status).toBe(404);
    expect((await call(app.url, "GET", WF)).body).toMatchObject({ workflows: [{ id: "one" }] });
  });
});

describe("the one-move send over real HTTP", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  let token: string;
  let pk: TestPasskey;
  let day: TestDayKey;
  const patch = (run: WorkflowRun, body: unknown, rev = run.rev) =>
    call(app.url, "PATCH", `${WF}/runs/${run.id}`, { body, headers: { "if-match": String(rev) } });
  const start = async (input = "the diff"): Promise<WorkflowRun> => {
    const r = await call(app.url, "POST", `${WF}/one/run`, { body: { input } });
    expect(r.status).toBe(201);
    return r.body as unknown as WorkflowRun;
  };
  const claimed = async (input?: string): Promise<WorkflowRun> => {
    const run = await start(input);
    const r = await patch(run, { step: "a", status: "sending" });
    expect(r.status).toBe(200);
    return r.body as unknown as WorkflowRun;
  };
  /** A prompt signed the way the page signs it, for the step's resolved text. */
  const signed = async (run: WorkflowRun, key = pk) => ({
    machineId: MACHINE,
    ...(await signCommand(key, day, commandStr(MACHINE, { session: SESSION, text: run.steps.a!.text }))),
  });
  /** What the machine is handed now, as the daemon would take it: each is acked delivered,
   *  so the next poll shows only what was queued since. */
  const queued = async (): Promise<string[]> => {
    const r = await fetch(`${app.url}${CONTROL}?machine=${MACHINE}&wait=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (r.status === 204) return [];
    const ids = ((await r.json()) as { messages: { id: string }[] }).messages.map((m) => m.id);
    const at = new Date().toISOString();
    for (const id of ids)
      await call(app.url, "POST", `${CONTROL}/ack`, {
        bearer: token,
        body: { acks: [{ id, outcome: "delivered", at, mode: "sdk", reply: "ok" }] },
      });
    return ids;
  };

  beforeAll(async () => {
    tmp = tempDir();
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, testDoor: true });
    pk = await TestPasskey.create();
    day = await TestDayKey.create();
    const r = await call(app.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine: MACHINE, key: pk.key } });
    token = r.body.token as string;
    expect((await call(app.url, "PUT", `${WF}/one`, { body: doc() })).status).toBe(200);
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("verifies, queues and marks the step sent in one move; the machine is handed exactly that command", async () => {
    const run = await claimed();
    const r = await patch(run, { step: "a", send: await signed(run) });
    expect(r.status).toBe(200);
    const next = r.body as unknown as WorkflowRun;
    // The session is the command's from this moment: the run view links it, a cancel can stop it.
    expect(next.steps.a).toMatchObject({ status: "sent", text: "Look at the diff", session: SESSION });
    expect(next.steps.a!.commandId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(next.status).toBe("running");
    expect(await queued()).toEqual([next.steps.a!.commandId]);
    // The move is spent: the same signed body again is a 412, and nothing more is queued.
    expect((await patch(next, { step: "a", send: await signed(run) })).status).toBe(412);
    expect(await queued()).toEqual([]);
    await call(app.url, "POST", `${WF}/runs/${run.id}/cancel`, { body: {} });
  });

  it("a step no longer this claim's queues nothing: cancelled under the signer, or a rev from the future", async () => {
    const run = await claimed();
    const body = await signed(run);
    expect((await patch(run, { step: "a", send: body }, run.rev + 5)).status).toBe(412);
    const cancelled = await call(app.url, "POST", `${WF}/runs/${run.id}/cancel`, { body: {} });
    expect(cancelled.body).toMatchObject({ status: "cancelled", steps: { a: { status: "skipped" } } });
    const late = await patch(run, { step: "a", send: body });
    expect(late.status).toBe(412);
    expect(late.body).toMatchObject({ reason: "conflict", run: { status: "cancelled" } });
    expect(await queued()).toEqual([]);
  });

  it("a signer's fault leaves the claim as it was: an untrusted key is 422 and the step still sending", async () => {
    const run = await claimed();
    const stranger = await TestPasskey.create();
    const r = await patch(run, { step: "a", send: await signed(run, stranger) });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: "untrusted_key" });
    const now = (await call(app.url, "GET", WF)).body.runs as WorkflowRun[];
    expect(now.find((x) => x.id === run.id)!.steps.a).toMatchObject({ status: "sending" });
    expect(await queued()).toEqual([]);
    // The right key then goes through under the same rev: the claim is the guard.
    expect((await patch(run, { step: "a", send: await signed(run) })).status).toBe(200);
    expect(await queued()).toHaveLength(1);
    await call(app.url, "POST", `${WF}/runs/${run.id}/cancel`, { body: {} });
  });

  it("a refusal of the command itself fails the step with the code, and the run with it; nothing is queued", async () => {
    const run = await claimed();
    // The page signed something the core refuses (bad_fields): a text with nothing in it.
    const bad = {
      machineId: MACHINE,
      ...(await signCommand(pk, day, commandStr(MACHINE, { session: SESSION, text: "" }))),
    };
    const r = await patch(run, { step: "a", send: bad });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: "failed",
      steps: { a: { status: "failed", error: expect.stringMatching(/^bad_fields: /) } },
    });
    expect(await queued()).toEqual([]);
    // A precheck refusal reads the same way: a permission on a prompt.
    const run2 = await claimed();
    const stray = {
      machineId: MACHINE,
      ...(await signCommand(pk, day, commandStr(MACHINE, { session: SESSION, text: "x", permission: "read" }))),
    };
    const r2 = await patch(run2, { step: "a", send: stray });
    expect(r2.status).toBe(200);
    expect((r2.body as unknown as WorkflowRun).steps.a!.error).toMatch(/^bad_fields: /);
  });

  it("a malformed send, or one for a step that is not sending, is refused before the verifier sees it", async () => {
    const run = await start();
    expect((await patch(run, { step: "a", send: await signed(run) })).status).toBe(412);
    expect((await patch(run, { step: "a", send: "nope" })).status).toBe(400);
    expect((await patch(run, { step: "a", send: {}, status: "sending" })).status).toBe(400);
    expect((await patch(run, { step: "zz", send: await signed(run) })).status).toBe(404);
    expect(await queued()).toEqual([]);
  });
});

describe("the one-move send over a fake control: what lands while the verifier works", () => {
  let tmp: { dir: string; cleanup: () => void };
  let clock = Date.parse("2026-10-28T12:00:00.000Z");
  const activity: ControlActivity[] = [];
  const queuedCmds: string[] = [];
  const queuedOpts: VerifiedSend["opts"][] = [];
  let verify: (body: unknown) => Promise<VerifiedSend> = () => Promise.reject(new Error("unset"));
  const control = {
    subscribe: () => () => true,
    activity: () => activity,
    activityById: (id: string) => activity.find((a) => a.id === id),
    machines: () =>
      new Map<string, MachineControl>([["box", { machineId: MACHINE, online: true, keys: [], queued: 0 }]]),
    verifySend: (body: unknown) => verify(body),
    queueSend: (v: VerifiedSend): ControlActivity => {
      const id = `01K8CMD0000000000000${String(queuedCmds.length).padStart(6, "0")}`;
      queuedCmds.push(id);
      queuedOpts.push(v.opts);
      return {
        id,
        machineId: MACHINE,
        kind: "prompt",
        session: SESSION,
        at: new Date(clock).toISOString(),
        expiresAt: new Date(clock + 3600_000).toISOString(),
        ...(v ? {} : {}),
      } as ControlActivity;
    },
  };
  const verified = {} as VerifiedSend;
  const frames: StreamMessage[] = [];
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

  it("a cancel during verification: nothing is queued; a claim offered again meanwhile: nothing either", async () => {
    const svc = make();
    try {
      svc.saveWorkflow("w", doc("Hi"));
      let run = svc.startRun("w", undefined);
      run = svc.claim(run.id, "a", run.rev);
      let release!: () => void;
      verify = () =>
        new Promise((r) => {
          release = () => r(verified);
        });
      const inFlight = svc.send(run.id, "a", run.rev, {});
      await new Promise((r) => setTimeout(r, 0));
      svc.cancel(run.id);
      release();
      await expect(inFlight).rejects.toMatchObject({ status: 412 });
      expect(queuedCmds).toEqual([]);

      // The claim went stale while the passkey prompt sat: the server offered the step
      // again, so the late signature is refused and nothing runs twice.
      let r2 = svc.startRun("w", undefined);
      r2 = svc.claim(r2.id, "a", r2.rev);
      const late = svc.send(r2.id, "a", r2.rev, {});
      await new Promise((r) => setTimeout(r, 0));
      clock += CLAIM_TTL_MS + 1;
      svc.tick();
      expect(svc.run(r2.id)!.steps.a!.status).toBe("ready");
      release();
      await expect(late).rejects.toMatchObject({ status: 412, why: "the step was not being sent" });
      expect(queuedCmds).toEqual([]);

      // The usual way: verified, queued, sent, in one move. The command is queued for the
      // queue's longest life, a day, whatever the body asked: a step is an agent's whole
      // task, and the default hour failed a long one as expired while it still ran.
      verify = () => Promise.resolve({ ...verified, opts: { expiresInMs: 3600_000, from: "claude-code:x" } });
      let r3 = svc.startRun("w", undefined);
      r3 = svc.claim(r3.id, "a", r3.rev);
      r3 = await svc.send(r3.id, "a", r3.rev, {});
      expect(r3.steps.a).toMatchObject({ status: "sent", commandId: queuedCmds[0] });
      expect(queuedCmds).toHaveLength(1);
      expect(queuedOpts).toEqual([{ expiresInMs: STEP_EXPIRES_MS, from: "claude-code:x" }]);
      expect(STEP_EXPIRES_MS).toBe(24 * 3600_000);
    } finally {
      svc.close();
    }
  });

  it("the verifier's refusals: a signer's fault is thrown as it is, the command's own fails the step", async () => {
    const svc = make();
    try {
      let run = svc.startRun("w", undefined);
      run = svc.claim(run.id, "a", run.rev);
      verify = () => Promise.reject(new HttpError(422, { reason: "the grant is not this key's", code: "bad_grant" }));
      await expect(svc.send(run.id, "a", run.rev, {})).rejects.toMatchObject({ status: 422 });
      expect(svc.run(run.id)!.steps.a!.status).toBe("sending");
      verify = () => Promise.reject(new HttpError(422, { reason: "cwd is not an allowed folder", code: "folder" }));
      const failed = await svc.send(run.id, "a", run.rev, {});
      expect(failed).toMatchObject({
        status: "failed",
        steps: { a: { status: "failed", error: "folder: cwd is not an allowed folder" } },
      });
      expect(failed.steps.a!.claimedAt).toBeUndefined();
      // Anything that is not the verifier's 422 is the caller's to read.
      let r2 = svc.startRun("w", undefined);
      r2 = svc.claim(r2.id, "a", r2.rev);
      verify = () => Promise.reject(new HttpError(404, { reason: "not_found" }));
      await expect(svc.send(r2.id, "a", r2.rev, {})).rejects.toMatchObject({ status: 404 });
      expect(svc.run(r2.id)!.steps.a!.status).toBe("sending");
    } finally {
      svc.close();
    }
  });
});
