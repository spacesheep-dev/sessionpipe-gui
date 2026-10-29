// SPDX-License-Identifier: Apache-2.0
// The ways a run can go wrong, and that it never gets stuck there: the receiver restarted
// with a run mid-flight (a ready step, a claimed one, a sent one, one waiting for its
// machine), a signer tab that closed between its claim and its command, two tabs claiming
// one step at once, a machine that answers before the tab's second move lands, a command
// the machine refused or that expired before it took it, a machine that went away, a
// workflow deleted or edited under its run, a run cancelled or deleted with a step in
// flight, and the longest workflow there is. The pure machine and the service over a fake
// control with a clock the test owns; the routes over real HTTP where the races are real.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ControlActivity,
  type MachineControl,
  ROUTES,
  type StreamMessage,
  WAITING_SIGNER_MS,
  WORKFLOW_STEPS_MAX,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { createOrchestrate, type Orchestrate } from "./index.js";
import { advance, CLAIM_TTL_MS, claim, NO_ANSWER, newRun, RunError, SENT_TTL_MS, sent, settle } from "./runs.js";

const MACHINE = "m_failure0000000000001";
const T0 = Date.parse("2026-10-28T10:00:00.000Z");
const all = () => true;
const CMD = (n: number) => `01K8CMD00000000000000${String(n).padStart(5, "0")}`.slice(0, 26).toUpperCase();

const step = (id: string, text: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  machineId: MACHINE,
  agent: { harness: "claude-code" },
  text,
  ...extra,
});
const doc = (steps: WorkflowStep[], extra: Partial<Workflow> = {}) => ({ name: "Failure modes", steps, ...extra });
const ack = (id: string, extra: Partial<ControlActivity> = {}): ControlActivity => ({
  id,
  machineId: MACHINE,
  kind: "start",
  session: "claude-code:new-1",
  at: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + 3600_000).toISOString(),
  outcome: "delivered",
  ...extra,
});
const refused = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    if (e instanceof RunError) return `${e.status} ${e.reason}: ${e.why}`;
    throw e;
  }
};

/** A run driven through one step: claimed, sent, delivered with `reply`. */
function deliver(run: WorkflowRun, id: string, commandId: string, reply: string, now: number): WorkflowRun {
  let r = claim(run, id, run.rev, now);
  r = sent(r, id, commandId, r.rev, now, all);
  return settle(r, ack(commandId, { reply, ackSession: `claude-code:${id}-session` }), now, all)!;
}

describe("the longest workflow", () => {
  const w = (steps: WorkflowStep[]): Workflow => ({
    id: "long",
    name: "Twenty",
    steps,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
  });

  it("twenty steps in a chain run through, each resolved from the one before", () => {
    const steps = Array.from({ length: WORKFLOW_STEPS_MAX }, (_, i) =>
      step(`s${i}`, i === 0 ? "start" : `${i} after [{{prev}}]`),
    );
    let run = newRun(w(steps), { id: "r", now: T0, online: all });
    expect(Object.values(run.steps).map((s) => s.status)).toEqual(["ready", ...Array(19).fill("pending")]);
    for (let i = 0; i < steps.length; i++) {
      const id = `s${i}`;
      expect(run.steps[id]!.status).toBe("ready");
      // Only the next step moves: nothing further down is ready before its turn.
      expect(Object.values(run.steps).filter((s) => s.status === "ready")).toHaveLength(1);
      run = deliver(run, id, CMD(i), `r${i}`, T0 + i * 1000);
    }
    expect(run.status).toBe("done");
    expect(run.steps.s19!.text).toBe("19 after [r18]");
    expect(run.steps.s1!.text).toBe("1 after [r0]");
    expect(Object.values(run.steps).every((s) => s.status === "done")).toBe(true);
    // One rev per change, from rev 1: every step's claim, its command, its ack, and the
    // move the ack sets off (the next step ready; for the last, the run done).
    expect(run.rev).toBe(1 + 4 * WORKFLOW_STEPS_MAX);
  });

  it("nineteen roots and a join: every root is ready at once, and prev joins their replies in plan order", () => {
    const roots = Array.from({ length: WORKFLOW_STEPS_MAX - 1 }, (_, i) => step(`r${i}`, `root ${i}`, { after: [] }));
    const join = step("join", "Compare:\n{{prev}}", { after: roots.map((s) => s.id) });
    let run = newRun(w([...roots, join]), { id: "r", now: T0, online: all });
    expect(Object.values(run.steps).filter((s) => s.status === "ready")).toHaveLength(WORKFLOW_STEPS_MAX - 1);
    expect(run.steps.join!.status).toBe("pending");
    // Delivered out of order: the join still reads them in plan order.
    const order = [...roots.keys()].reverse();
    for (const i of order) run = deliver(run, `r${i}`, CMD(i), `reply ${i}`, T0 + i * 1000);
    expect(run.steps.join).toMatchObject({
      status: "ready",
      text: `Compare:\n${order
        .reverse()
        .map((i) => `reply ${i}`)
        .join("\n\n")}`,
    });
    run = deliver(run, "join", CMD(99), "compared", T0 + 60_000);
    expect(run.status).toBe("done");
  });
});

describe("the service over a fake control", () => {
  let tmp: { dir: string; cleanup: () => void };
  let clock: number;
  let online: boolean;
  const frames: StreamMessage[] = [];
  const listeners = new Set<(m: StreamMessage) => void>();
  const activity: ControlActivity[] = [];
  /** Whether the newest-first list still reaches the acks (a busy receiver's does not). */
  let listed = true;
  const control = {
    subscribe: (l: (m: StreamMessage) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    activity: () => (listed ? [...activity].reverse() : []),
    activityById: (id: string) => activity.find((a) => a.id === id),
    machines: () => new Map<string, MachineControl>([["box", { machineId: MACHINE, online, keys: [], queued: 0 }]]),
    // The one-move send is the routes' (send.test.ts); the service here is driven by hand.
    verifySend: () => Promise.reject(new Error("not here")),
    queueSend: () => {
      throw new Error("not here");
    },
  };
  /** The machine answers: the ack is kept (control's queue file) and announced (its stream). */
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
  /** The service with a workflow saved and a run started. */
  const booted = (steps: WorkflowStep[]): { svc: Orchestrate; run: WorkflowRun } => {
    const svc = make();
    svc.saveWorkflow("w", doc(steps));
    return { svc, run: svc.startRun("w", undefined) };
  };
  const runFrames = () => frames.filter((f) => f.kind === "workflowRun");

  beforeEach(() => {
    // Every test starts in its own state dir, on its own clock, with the machine polling.
    tmp = tempDir();
    clock = T0;
    online = true;
    frames.length = 0;
    activity.length = 0;
    listeners.clear();
  });
  afterEach(() => tmp.cleanup());

  it("a restart finds a ready step still ready, and the wait for a signer counts from before it", () => {
    const { svc, run } = booted([step("a", "A")]);
    svc.close();
    clock += WAITING_SIGNER_MS + 1;
    const again = make();
    try {
      expect(again.run(run.id)).toMatchObject({ status: "running", steps: { a: { status: "ready" } } });
      again.tick();
      expect(again.run(run.id)).toMatchObject({ status: "waiting", waitingFor: "signer" });
      expect(runFrames().at(-1)).toMatchObject({ run: { id: run.id, waitingFor: "signer" } });
    } finally {
      again.close();
    }
  });

  it("the signer tab closed after its claim: the claim outlives a restart, times out, and the step is offered again", () => {
    const { svc, run } = booted([step("a", "A")]);
    const claimed = svc.claim(run.id, "a", run.rev);
    expect(claimed.steps.a).toMatchObject({ status: "sending", claimedAt: new Date(clock).toISOString() });
    svc.close();
    clock += CLAIM_TTL_MS;
    const again = make();
    try {
      // Restored as claimed; the TTL has not passed yet.
      again.tick();
      expect(again.run(run.id)!.steps.a!.status).toBe("sending");
      clock += 1;
      again.tick();
      const offered = again.run(run.id)!;
      expect(offered.steps.a).toMatchObject({ status: "ready", readyAt: new Date(clock).toISOString() });
      expect(offered.steps.a!.claimedAt).toBeUndefined();
      // The dead tab's command, if it ever comes, is nobody's: the step is not being sent.
      expect(refused(() => again.sent(run.id, "a", CMD(1), claimed.rev))).toBe(
        "412 conflict: the step was not being sent",
      );
      // Another tab takes it from here.
      const mine = again.claim(run.id, "a", offered.rev);
      const moved = again.sent(run.id, "a", CMD(2), mine.rev);
      expect(moved.steps.a).toMatchObject({ status: "sent", commandId: CMD(2) });
      expect(moved.status).toBe("running");
    } finally {
      again.close();
    }
  });

  it("a restart with a sent step: the ack that comes after boot settles the restored run", () => {
    const { svc, run } = booted([step("a", "A"), step("b", "Then {{prev}}")]);
    let r = svc.claim(run.id, "a", run.rev);
    r = svc.sent(run.id, "a", CMD(1), r.rev);
    svc.close();
    const again = make();
    try {
      expect(again.run(run.id)).toMatchObject({
        status: "running",
        steps: { a: { status: "sent", commandId: CMD(1) } },
      });
      emitAck(ack(CMD(1), { reply: "after the restart", ackSession: "claude-code:s1" }));
      expect(again.run(run.id)).toMatchObject({
        status: "running",
        steps: {
          a: { status: "done", reply: "after the restart", session: "claude-code:s1" },
          b: { status: "ready", text: "Then after the restart" },
        },
      });
    } finally {
      again.close();
    }
  });

  it("a restart finds a sent step's ack by its id, not through the newest thousand", () => {
    const { svc, run } = booted([step("a", "A"), step("b", "Then {{prev}}")]);
    let r = svc.claim(run.id, "a", run.rev);
    r = svc.sent(run.id, "a", CMD(7), r.rev);
    svc.close();
    // The ack landed while the receiver was down, under more than a thousand newer messages.
    activity.push(ack(CMD(7), { reply: "found by id", ackSession: "claude-code:s7" }));
    listed = false;
    const again = make();
    try {
      expect(again.run(run.id)).toMatchObject({
        status: "running",
        steps: { a: { status: "done", reply: "found by id" }, b: { status: "ready", text: "Then found by id" } },
      });
    } finally {
      listed = true;
      again.close();
    }
  });

  it("a sent step whose command never comes back fails after a day, and the run ends", () => {
    const w = {
      id: "w",
      name: "W",
      steps: [step("a", "A"), step("b", "Then {{prev}}")],
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    };
    let run = newRun(w, { id: "r", now: T0, online: all });
    run = claim(run, "a", run.rev, T0);
    run = sent(run, "a", CMD(9), run.rev, T0, all);
    expect(run.status).toBe("running");
    // Just under the deadline: still running (the queue's own expiry would have spoken by now).
    expect(advance(run, T0 + SENT_TTL_MS, all)).toBe(run);
    const late = advance(run, T0 + SENT_TTL_MS + 1, all);
    expect(late.steps.a).toMatchObject({ status: "failed", error: NO_ANSWER, commandId: CMD(9) });
    expect(late.steps.b!.status).toBe("skipped");
    expect(late).toMatchObject({ status: "failed", rev: run.rev + 1 });
    expect(late.endedAt).toBeDefined();
    expect(SENT_TTL_MS).toBe(24 * 3600_000 + 60_000);
  });

  it("a run waiting for its machine at restart runs once the machine is back", () => {
    online = false;
    const { svc, run } = booted([step("a", "A")]);
    expect(run).toMatchObject({ status: "waiting", waitingFor: "machine" });
    svc.close();
    online = true;
    const again = make();
    try {
      // Restored as it was written; the first tick reads the machine.
      expect(again.run(run.id)).toMatchObject({ status: "waiting", waitingFor: "machine" });
      again.tick();
      expect(again.run(run.id)).toMatchObject({ status: "running" });
      expect(again.run(run.id)!.waitingFor).toBeUndefined();
    } finally {
      again.close();
    }
  });

  it("the machine answers before the tab's second move lands: the step still settles", () => {
    // A daemon that long-polls takes a command within milliseconds and refuses one at once;
    // the tab's PATCH with the command's id comes over a slower link. The ack found no step
    // holding its id when it landed, so the service looks again once the id is known.
    const { svc, run } = booted([step("a", "A"), step("b", "B")]);
    try {
      const claimed = svc.claim(run.id, "a", run.rev);
      emitAck(ack(CMD(1), { outcome: "refused", code: "folder", detail: "/x is not allowed" }));
      // Nothing to settle yet: the step holds no command id.
      expect(svc.run(run.id)!.steps.a!.status).toBe("sending");
      const moved = svc.sent(run.id, "a", CMD(1), claimed.rev);
      expect(moved.steps.a).toMatchObject({ status: "failed", error: "folder: /x is not allowed" });
      expect(moved.steps.b!.status).toBe("skipped");
      expect(moved.status).toBe("failed");
      expect(svc.run(run.id)).toEqual(moved);
      expect(runFrames().at(-1)).toMatchObject({ run: { id: run.id, status: "failed" } });

      // The same with an answer: the reply reaches the next step.
      const r2 = svc.startRun("w", undefined);
      const c2 = svc.claim(r2.id, "a", r2.rev);
      emitAck(ack(CMD(2), { reply: "quick", ackSession: "claude-code:q" }));
      const m2 = svc.sent(r2.id, "a", CMD(2), c2.rev);
      expect(m2.steps.a).toMatchObject({ status: "done", reply: "quick", session: "claude-code:q" });
      expect(m2.steps.b).toMatchObject({ status: "ready", text: "B" });
      // A still-open command (taken, not final) settles nothing early.
      const r3 = svc.startRun("w", undefined);
      const c3 = svc.claim(r3.id, "a", r3.rev);
      emitAck(ack(CMD(3), { outcome: "taken" }));
      expect(svc.sent(r3.id, "a", CMD(3), c3.rev).steps.a).toMatchObject({ status: "sent", commandId: CMD(3) });
    } finally {
      svc.close();
    }
  });

  it("refused, expired, unsupported and failed each fail the step in the machine's words and skip what followed", () => {
    const { svc } = booted([step("a", "A"), step("b", "B"), step("side", "S", { after: [] })]);
    try {
      const cases: [Partial<ControlActivity>, string][] = [
        [
          { outcome: "refused", code: "start_limit", detail: "3 of 3 headless sessions running" },
          "start_limit: 3 of 3 headless sessions running",
        ],
        [{ outcome: "expired", detail: "expired before the machine took it" }, "expired before the machine took it"],
        [{ outcome: "unsupported" }, "unsupported"],
        [{ outcome: "failed", code: "spawn" }, "spawn"],
      ];
      for (const [i, [outcome, error]] of cases.entries()) {
        let run = svc.startRun("w", undefined);
        run = svc.claim(run.id, "a", run.rev);
        run = svc.sent(run.id, "a", CMD(10 + i), run.rev);
        emitAck(ack(CMD(10 + i), outcome));
        run = svc.run(run.id)!;
        expect(run.steps.a).toMatchObject({ status: "failed", error, endedAt: new Date(clock).toISOString() });
        expect(run.steps.b!.status).toBe("skipped");
        // The side root still runs, so the run is not over yet.
        expect(run.steps.side!.status).toBe("ready");
        expect(run.status).toBe("running");
        run = svc.claim(run.id, "side", run.rev);
        run = svc.sent(run.id, "side", CMD(20 + i), run.rev);
        emitAck(ack(CMD(20 + i), { reply: "side done" }));
        expect(svc.run(run.id)).toMatchObject({ status: "failed", steps: { side: { status: "done" } } });
        expect(svc.run(run.id)!.endedAt).toBeDefined();
      }
    } finally {
      svc.close();
    }
  });

  it("the machine goes away mid-run: a sent step settles when its ack comes, the next waits, and runs on when it is back", () => {
    const { svc, run } = booted([step("a", "A"), step("b", "B")]);
    try {
      let r = svc.claim(run.id, "a", run.rev);
      r = svc.sent(run.id, "a", CMD(1), r.rev);
      online = false;
      svc.tick();
      // A sent step is the machine's: the run is still running, not waiting.
      expect(svc.run(run.id)).toMatchObject({ status: "running", steps: { a: { status: "sent" } } });
      // The machine comes back only to answer, then goes again (its poll ended; the reply came).
      emitAck(ack(CMD(1), { reply: "done before the drop" }));
      expect(svc.run(run.id)).toMatchObject({
        status: "waiting",
        waitingFor: "machine",
        steps: { a: { status: "done" }, b: { status: "ready" } },
      });
      // The wait for a machine outranks the wait for a signer, however long it lasts.
      clock += WAITING_SIGNER_MS * 10;
      svc.tick();
      expect(svc.run(run.id)).toMatchObject({ status: "waiting", waitingFor: "machine" });
      // Back: a signer is wanted now, and the step is still the one to claim.
      online = true;
      svc.tick();
      expect(svc.run(run.id)).toMatchObject({ status: "waiting", waitingFor: "signer" });
      r = svc.claim(run.id, "b", svc.run(run.id)!.rev);
      r = svc.sent(run.id, "b", CMD(2), r.rev);
      expect(r.status).toBe("running");
      emitAck(ack(CMD(2), { reply: "all done" }));
      expect(svc.run(run.id)!.status).toBe("done");
    } finally {
      svc.close();
    }
  });

  it("a workflow deleted or edited under its run: the run keeps its plan and finishes", () => {
    const { svc, run } = booted([step("a", "A"), step("b", "Review {{prev}}")]);
    try {
      expect(svc.deleteWorkflow("w")).toBe(true);
      expect(svc.workflow("w")).toBeUndefined();
      expect(svc.run(run.id)).toMatchObject({ status: "running", workflowId: "w" });
      let r = svc.claim(run.id, "a", run.rev);
      r = svc.sent(run.id, "a", CMD(1), r.rev);
      emitAck(ack(CMD(1), { reply: "the diff" }));
      expect(svc.run(run.id)!.steps.b).toMatchObject({ status: "ready", text: "Review the diff" });
      // No new run of a workflow that is gone; the old run is still listed.
      expect(() => svc.startRun("w", undefined)).toThrow(/No such workflow/);
      expect(svc.runs().map((x) => x.id)).toEqual([run.id]);

      // Saved again with other steps: the run on the old plan goes on as before.
      svc.saveWorkflow("w", doc([step("a", "Something else"), step("c", "C")]));
      expect(svc.run(run.id)!.plan.map((s) => s.id)).toEqual(["a", "b"]);
      r = svc.claim(run.id, "b", svc.run(run.id)!.rev);
      r = svc.sent(run.id, "b", CMD(2), r.rev);
      emitAck(ack(CMD(2), { reply: "reviewed" }));
      expect(svc.run(run.id)).toMatchObject({ status: "done", plan: [{ id: "a", text: "A" }, { id: "b" }] });
      // The new document's run starts from the new plan.
      const fresh = svc.startRun("w", undefined);
      expect(fresh.plan.map((s) => s.id)).toEqual(["a", "c"]);
      expect(fresh.steps.a!.text).toBe("Something else");
    } finally {
      svc.close();
    }
  });

  it("cancelled with a claim in flight: the claim is skipped, the tab's command is nobody's, a sent step still settles", () => {
    const { svc, run } = booted([step("a", "A"), step("b", "B", { after: [] }), step("c", "C", { after: ["a", "b"] })]);
    try {
      let r = svc.claim(run.id, "a", run.rev);
      r = svc.sent(run.id, "a", CMD(1), r.rev);
      const held = svc.claim(run.id, "b", r.rev);
      const stopped = svc.cancel(run.id);
      expect(stopped).toMatchObject({
        status: "cancelled",
        steps: { a: { status: "sent" }, b: { status: "skipped" }, c: { status: "skipped" } },
      });
      expect(refused(() => svc.sent(run.id, "b", CMD(2), held.rev))).toBe("412 conflict: the step was not being sent");
      expect(refused(() => svc.claim(run.id, "c", stopped.rev))).toBe("412 conflict: the run is cancelled");
      svc.tick();
      expect(svc.run(run.id)).toEqual(stopped);
      emitAck(ack(CMD(1), { reply: "late" }));
      expect(svc.run(run.id)).toMatchObject({ status: "cancelled", steps: { a: { status: "done", reply: "late" } } });
      expect(svc.run(run.id)!.endedAt).toBe(stopped.endedAt);
    } finally {
      svc.close();
    }
  });

  it("a run deleted with a step in flight: its ack later moves nothing, and a restart does not bring it back", () => {
    const { svc, run } = booted([step("a", "A")]);
    let r = svc.claim(run.id, "a", run.rev);
    r = svc.sent(run.id, "a", CMD(1), r.rev);
    expect(svc.deleteRun(run.id)).toBe(true);
    frames.length = 0;
    emitAck(ack(CMD(1), { reply: "too late" }));
    expect(svc.run(run.id)).toBeUndefined();
    expect(frames).toEqual([]);
    svc.close();
    const again = make();
    try {
      expect(again.runs()).toEqual([]);
    } finally {
      again.close();
    }
  });
});

describe("the routes, where the races are real", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  let token: string;
  const WF = ROUTES.ui.workflows;
  const CONTROL = ROUTES.control;

  type Res = { status: number; body: Record<string, unknown> };
  const call = async (
    method: string,
    p: string,
    o: { body?: unknown; headers?: Record<string, string>; bearer?: string } = {},
  ): Promise<Res> => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${app.url}${p}`, {
      method,
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const patch = (runId: string, body: unknown, rev: number) =>
    call("PATCH", `${WF}/runs/${runId}`, { body, headers: { "if-match": String(rev) } });
  const poll = () => call("GET", `${CONTROL}?machine=${MACHINE}&wait=0`, { bearer: token });
  const acks = (list: Record<string, unknown>[]) =>
    call("POST", `${CONTROL}/ack`, {
      bearer: token,
      body: { acks: list.map((a) => ({ at: new Date().toISOString(), ...a })) },
    });
  const enqueue = async (text: string, expiresInS?: number): Promise<string> => {
    const r = await call("POST", `${CONTROL}/_test/enqueue`, {
      body: {
        machine: MACHINE,
        message: {
          kind: "start",
          session: "claude-code:00000000-0000-4000-8000-000000000321",
          text,
          cwd: "/Users/me/proj",
        },
        ...(expiresInS ? { expires_in_s: expiresInS } : {}),
      },
    });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const runOf = async (id: string): Promise<WorkflowRun> =>
    ((await call("GET", WF)).body.runs as WorkflowRun[]).find((r) => r.id === id)!;
  const start = async (wid: string, steps: WorkflowStep[]): Promise<WorkflowRun> => {
    expect((await call("PUT", `${WF}/${wid}`, { body: doc(steps) })).status).toBe(200);
    const r = await call("POST", `${WF}/${wid}/run`, { body: {} });
    expect(r.status).toBe(201);
    return r.body as unknown as WorkflowRun;
  };

  beforeAll(async () => {
    tmp = tempDir();
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, testDoor: true });
    const r = await call("POST", `${CONTROL}/_test/enroll`, { body: { machine: MACHINE } });
    token = r.body.token as string;
    // The machine polls once: online for the rest of the file.
    expect((await poll()).status).toBe(204);
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("two tabs claim one step at once: one wins, the other reads the run it lost to and offers nothing for it", async () => {
    const run = await start("race", [step("a", "A")]);
    const [x, y] = await Promise.all([
      patch(run.id, { step: "a", status: "sending" }, run.rev),
      patch(run.id, { step: "a", status: "sending" }, run.rev),
    ]);
    const [won, lost] = x.status === 200 ? [x, y] : [y, x];
    expect(won.status).toBe(200);
    expect(lost.status).toBe(412);
    expect(lost.body).toMatchObject({ reason: "conflict", run: { rev: (won.body as { rev: number }).rev } });
    expect((lost.body.run as WorkflowRun).steps.a!.status).toBe("sending");
    // Only the winner's command lands; the loser's, with the run it was handed, is refused too.
    const id = await enqueue("A");
    const other = await enqueue("A again");
    const rev = (won.body as { rev: number }).rev;
    expect((await patch(run.id, { step: "a", commandId: id }, rev)).status).toBe(200);
    const late = await patch(run.id, { step: "a", commandId: other }, rev + 1);
    expect(late.status).toBe(412);
    expect(late.body.error).toBe("the step was not being sent");
    expect((await runOf(run.id)).steps.a).toMatchObject({ status: "sent", commandId: id });
  });

  it("the daemon refuses before the tab's second move lands: the step fails instead of running forever", async () => {
    const run = await start("quick", [step("a", "A"), step("b", "B")]);
    const claimed = await patch(run.id, { step: "a", status: "sending" }, run.rev);
    expect(claimed.status).toBe(200);
    const id = await enqueue("A");
    // The machine takes it and refuses at once, before the tab brings the id back.
    const took = await poll();
    expect(took.status).toBe(200);
    expect((took.body.messages as { id: string }[]).map((m) => m.id)).toContain(id);
    expect(
      (await acks([{ id, outcome: "refused", code: "folder", detail: "/Users/me/proj is not allowed" }])).status,
    ).toBe(202);
    const moved = await patch(run.id, { step: "a", commandId: id }, (claimed.body as { rev: number }).rev);
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      status: "failed",
      steps: { a: { status: "failed", error: "folder: /Users/me/proj is not allowed" }, b: { status: "skipped" } },
    });
    expect(await runOf(run.id)).toMatchObject({ status: "failed" });
  });

  it("a command that expires before the machine takes it fails its step with that said", async () => {
    const run = await start("expiry", [step("a", "A")]);
    const claimed = await patch(run.id, { step: "a", status: "sending" }, run.rev);
    const id = await enqueue("A", 1);
    const moved = await patch(run.id, { step: "a", commandId: id }, (claimed.body as { rev: number }).rev);
    expect(moved.body).toMatchObject({ status: "running", steps: { a: { status: "sent" } } });
    // The machine never took it. Its next poll, past the second, expires the queue (and
    // hands out whatever else is waiting there, never this one).
    await new Promise((r) => setTimeout(r, 1100));
    const later = await poll();
    expect(((later.body.messages as { id: string }[] | undefined) ?? []).map((m) => m.id)).not.toContain(id);
    await expect.poll(async () => (await runOf(run.id)).steps.a!.status, { timeout: 5000 }).toBe("failed");
    expect(await runOf(run.id)).toMatchObject({
      status: "failed",
      steps: { a: { status: "failed", error: "expired before the machine took it" } },
    });
  });

  it("the longest workflow saves and starts with every root ready; one step more is refused", async () => {
    const roots = Array.from({ length: WORKFLOW_STEPS_MAX }, (_, i) => step(`r${i}`, `root ${i}`, { after: [] }));
    const run = await start("wide", roots);
    expect(Object.values(run.steps).filter((s) => s.status === "ready")).toHaveLength(WORKFLOW_STEPS_MAX);
    expect(run.status).toBe("running");
    const more = await call("PUT", `${WF}/wide`, { body: doc([...roots, step("r20", "one more", { after: [] })]) });
    expect(more.status).toBe(413);
    expect(more.body).toMatchObject({ reason: "too_large" });
    // The saved one is still the twenty.
    expect(((await call("GET", WF)).body.workflows as Workflow[]).find((w) => w.id === "wide")!.steps).toHaveLength(
      WORKFLOW_STEPS_MAX,
    );
  });
});
