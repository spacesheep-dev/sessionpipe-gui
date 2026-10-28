// SPDX-License-Identifier: Apache-2.0
// The run's state machine, rule by rule: what is ready, how text resolves, what a failure
// skips, when the run waits and for whom, the claim as the guard across tabs, what an ack
// settles, and cancel.
import { describe, expect, it } from "vitest";
import {
  type ControlActivity,
  WAITING_SIGNER_MS,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from "../../shared/api.js";
import {
  advance,
  afterOf,
  ancestors,
  CLAIM_TTL_MS,
  cancel,
  claim,
  newRun,
  placeholderProblem,
  placeholders,
  RunError,
  readPlaceholder,
  sent,
  settle,
} from "./runs.js";

const M = "m_machine00000000000001";
const T0 = Date.parse("2026-10-28T10:00:00.000Z");
const all = () => true;
const none = () => false;

const step = (id: string, text: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  machineId: M,
  agent: { harness: "claude-code" },
  text,
  ...extra,
});
const workflow = (steps: WorkflowStep[], extra: Partial<Workflow> = {}): Workflow => ({
  id: "wf",
  name: "Implement, then review",
  steps,
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
  ...extra,
});
const ack = (id: string, extra: Partial<ControlActivity> = {}): ControlActivity => ({
  id,
  machineId: M,
  kind: "start",
  session: "claude-code:new-1",
  at: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + 3600_000).toISOString(),
  outcome: "delivered",
  ...extra,
});
const CMD = "01K8CMD000000000000000AAAA";
const CMD2 = "01K8CMD000000000000000BBBB";
const CMD3 = "01K8CMD000000000000000CCCC";

/** A run driven through one step: claimed, sent, delivered with `reply`. */
function deliver(run: WorkflowRun, id: string, commandId: string, reply: string, now: number): WorkflowRun {
  let r = claim(run, id, run.rev, now);
  r = sent(r, id, commandId, r.rev, now, all);
  return settle(r, ack(commandId, { reply, ackSession: `claude-code:${id}-session` }), now, all)!;
}

describe("the graph", () => {
  it("afterOf: as given, else the step before, none for the first; ancestors are transitive", () => {
    const plan = [step("a", "x"), step("b", "x"), step("c", "x", { after: [] }), step("d", "x", { after: ["a", "c"] })];
    expect(plan.map((_, i) => afterOf(plan, i))).toEqual([[], ["a"], [], ["a", "c"]]);
    expect([...ancestors(plan, "d")].sort()).toEqual(["a", "c"]);
    expect([...ancestors([step("a", "x"), step("b", "x"), step("c", "x")], "c")].sort()).toEqual(["a", "b"]);
    expect(ancestors(plan, "nope").size).toBe(0);
  });

  it("reads placeholders, trimming inside the braces", () => {
    expect(placeholders("Do {{input}} after {{ prev }} and {{step.a}} but not {single} or {{}}")).toEqual([
      "input",
      " prev ",
      "step.a",
      "",
    ]);
    expect(readPlaceholder(" prev ")).toEqual({ kind: "prev" });
    expect(readPlaceholder("step.review-1")).toEqual({ kind: "step", id: "review-1" });
    expect(readPlaceholder("steps.a")).toEqual({ kind: "unknown", name: "steps.a" });
    expect(readPlaceholder("")).toEqual({ kind: "unknown", name: "" });
  });

  it("refuses at save what a run could not fill: unknown, prev on a root, a step not run after, input with none", () => {
    const w = workflow([]);
    const plan = [
      step("a", "Plan {{input}}"),
      step("b", "Review {{prev}} and {{step.a}}"),
      step("c", "{{step.b}}", { after: ["a"] }),
    ];
    expect(placeholderProblem(w, plan, 0)).toBe("{{input}} needs the workflow to ask for an input");
    expect(placeholderProblem({ input: { label: "Task" } }, plan, 0)).toBeNull();
    expect(placeholderProblem(w, plan, 1)).toBeNull();
    expect(placeholderProblem(w, plan, 2)).toBe("{{step.b}} names a step this one does not run after");
    expect(placeholderProblem(w, [step("a", "{{prev}}")], 0)).toBe("{{prev}} needs a step before this one");
    expect(placeholderProblem(w, [step("a", "x"), step("b", "{{prev}}", { after: [] })], 1)).toBe(
      "{{prev}} needs a step before this one",
    );
    expect(placeholderProblem(w, [step("a", "{{step.zz}}")], 0)).toBe("{{step.zz}} names no step");
    expect(placeholderProblem(w, [step("a", "{{foo}}")], 0)).toBe(
      "{{foo}} is not a placeholder: use {{input}}, {{prev}} or {{step.<id>}}",
    );
    expect(placeholderProblem(w, [step("a", "{{ step.a }}", { after: [] })], 0)).toBe(
      "{{step.a}} names a step this one does not run after",
    );
  });
});

describe("a run", () => {
  it("starts with its roots ready and their text resolved from the input; the rest pending", () => {
    const w = workflow(
      [step("a", "Implement: {{input}}"), step("b", "Review:\n{{prev}}"), step("c", "Also {{input}}", { after: [] })],
      { input: { label: "Task" } },
    );
    const run = newRun(w, { id: "run1", input: "add dark mode", now: T0, online: all });
    expect(run).toMatchObject({
      id: "run1",
      workflowId: "wf",
      name: w.name,
      rev: 1,
      status: "running",
      input: "add dark mode",
    });
    expect(run.plan).toEqual(w.steps);
    expect(run.plan).not.toBe(w.steps);
    expect(run.steps).toEqual({
      a: { status: "ready", readyAt: new Date(T0).toISOString(), text: "Implement: add dark mode" },
      b: { status: "pending" },
      c: { status: "ready", readyAt: new Date(T0).toISOString(), text: "Also add dark mode" },
    });
    expect(run.waitingFor).toBeUndefined();
  });

  it("moves a step ready when every step it runs after is done; prev joins several replies with a blank line", () => {
    const w = workflow([
      step("a", "A"),
      step("b", "B", { after: [] }),
      step("c", "Compare:\n{{prev}}\n\nA said {{step.a}}", { after: ["a", "b"] }),
    ]);
    let run = newRun(w, { id: "r", now: T0, online: all });
    expect(run.steps.c!.status).toBe("pending");
    run = deliver(run, "a", CMD, "reply A", T0 + 1000);
    expect(run.steps.a).toMatchObject({
      status: "done",
      reply: "reply A",
      session: "claude-code:a-session",
      commandId: CMD,
    });
    expect(run.steps.c!.status).toBe("pending");
    run = deliver(run, "b", CMD2, "reply B", T0 + 2000);
    expect(run.steps.c).toMatchObject({ status: "ready", text: "Compare:\nreply A\n\nreply B\n\nA said reply A" });
    expect(run.status).toBe("running");
  });

  it("a step with no reply contributes nothing to prev, and the session falls back to the command's", () => {
    const w = workflow([step("a", "A"), step("b", "B", { after: [] }), step("c", "[{{prev}}]", { after: ["a", "b"] })]);
    let run = newRun(w, { id: "r", now: T0, online: all });
    run = claim(run, "a", run.rev, T0);
    run = sent(run, "a", CMD, run.rev, T0, all);
    run = settle(run, ack(CMD, { kind: "prompt", session: "codex:thread-1" }), T0, all)!;
    expect(run.steps.a).toMatchObject({ status: "done", session: "codex:thread-1" });
    expect(run.steps.a!.reply).toBeUndefined();
    run = deliver(run, "b", CMD2, "only B", T0);
    expect(run.steps.c!.text).toBe("[only B]");
  });

  it("ends done when every step is done, with endedAt", () => {
    const w = workflow([step("a", "A"), step("b", "{{prev}}")]);
    let run = newRun(w, { id: "r", now: T0, online: all });
    run = deliver(run, "a", CMD, "one", T0);
    run = deliver(run, "b", CMD2, "two", T0 + 5000);
    expect(run.status).toBe("done");
    expect(run.endedAt).toBe(new Date(T0 + 5000).toISOString());
    expect(advance(run, T0 + 9000, all)).toBe(run);
  });

  it("a failed step skips what depends on it, transitively; the run fails once nothing can move", () => {
    const w = workflow([
      step("a", "A"),
      step("b", "B"),
      step("c", "C"),
      step("side", "S", { after: [] }),
      step("join", "J", { after: ["c", "side"] }),
    ]);
    let run = newRun(w, { id: "r", now: T0, online: all });
    run = claim(run, "a", run.rev, T0);
    run = sent(run, "a", CMD, run.rev, T0, all);
    run = settle(run, ack(CMD, { outcome: "refused", code: "folder", detail: "/x is not allowed" }), T0, all)!;
    expect(run.steps.a).toMatchObject({ status: "failed", error: "folder: /x is not allowed" });
    expect(run.steps.b!.status).toBe("skipped");
    expect(run.steps.c!.status).toBe("skipped");
    expect(run.steps.join!.status).toBe("skipped");
    // The side branch still runs: the run is not failed yet.
    expect(run.steps.side!.status).toBe("ready");
    expect(run.status).toBe("running");
    run = deliver(run, "side", CMD2, "fine", T0 + 1000);
    expect(run.status).toBe("failed");
    expect(run.endedAt).toBeDefined();
  });

  it("an expired or unsupported command fails its step with the outcome as the error", () => {
    const w = workflow([step("a", "A")]);
    let run = newRun(w, { id: "r", now: T0, online: all });
    run = claim(run, "a", run.rev, T0);
    run = sent(run, "a", CMD, run.rev, T0, all);
    const expired = settle(
      run,
      ack(CMD, { outcome: "expired", detail: "expired before the machine took it" }),
      T0,
      all,
    )!;
    expect(expired.steps.a).toMatchObject({ status: "failed", error: "expired before the machine took it" });
    const unsupported = settle(run, ack(CMD, { outcome: "unsupported" }), T0, all)!;
    expect(unsupported.steps.a).toMatchObject({ status: "failed", error: "unsupported" });
    expect(unsupported.status).toBe("failed");
  });

  it("settles nothing on a message that is no step's, or not final yet", () => {
    const w = workflow([step("a", "A")]);
    let run = newRun(w, { id: "r", now: T0, online: all });
    expect(settle(run, ack(CMD), T0, all)).toBeNull();
    run = claim(run, "a", run.rev, T0);
    run = sent(run, "a", CMD, run.rev, T0, all);
    expect(settle(run, ack(CMD2), T0, all)).toBeNull();
    expect(settle(run, ack(CMD, { outcome: "taken" }), T0, all)).toBeNull();
    expect(settle(run, ack(CMD, { outcome: "progress", reply: "so far" }), T0, all)).toBeNull();
    expect(settle(run, ack(CMD, { outcome: undefined }), T0, all)).toBeNull();
    // Settled once: a duplicate final ack changes nothing more.
    const done = settle(run, ack(CMD, { reply: "ok" }), T0, all)!;
    expect(settle(done, ack(CMD, { reply: "again" }), T0, all)).toBeNull();
  });
});

describe("waiting", () => {
  it("for a signer: a ready step nobody claimed for WAITING_SIGNER_MS; a claim ends it", () => {
    const w = workflow([step("a", "A")]);
    const run = newRun(w, { id: "r", now: T0, online: all });
    expect(advance(run, T0 + WAITING_SIGNER_MS, all)).toBe(run);
    const waiting = advance(run, T0 + WAITING_SIGNER_MS + 1, all);
    expect(waiting).toMatchObject({ status: "waiting", waitingFor: "signer", rev: run.rev + 1 });
    const claimed = claim(waiting, "a", waiting.rev, T0 + 3000);
    expect(claimed.steps.a).toMatchObject({ status: "sending", claimedAt: new Date(T0 + 3000).toISOString() });
    // The claim alone leaves the reading to the next look; the sent step is running.
    const sentOn = sent(claimed, "a", CMD, claimed.rev, T0 + 3500, all);
    expect(sentOn.status).toBe("running");
    expect(sentOn.waitingFor).toBeUndefined();
  });

  it("for a machine: a ready step whose machine is offline, whatever the clock says; online again, it runs", () => {
    const w = workflow([step("a", "A")]);
    const run = newRun(w, { id: "r", now: T0, online: none });
    expect(run).toMatchObject({ status: "waiting", waitingFor: "machine" });
    expect(advance(run, T0 + 10_000, none)).toBe(run);
    const up = advance(run, T0 + 10_000, all);
    // Online, but nobody has signed it for 10 s: a signer, then.
    expect(up).toMatchObject({ status: "waiting", waitingFor: "signer" });
    expect(advance(run, T0 + 1000, all)).toMatchObject({ status: "running" });
  });

  it("a claim that brought no command back within CLAIM_TTL_MS is offered again", () => {
    const w = workflow([step("a", "A")]);
    let run = newRun(w, { id: "r", now: T0, online: all });
    run = claim(run, "a", run.rev, T0);
    expect(advance(run, T0 + CLAIM_TTL_MS, all)).toBe(run);
    const again = advance(run, T0 + CLAIM_TTL_MS + 1, all);
    expect(again.steps.a).toMatchObject({ status: "ready", readyAt: new Date(T0 + CLAIM_TTL_MS + 1).toISOString() });
    expect(again.steps.a!.claimedAt).toBeUndefined();
    // The first tab's late command id no longer fits: the rev moved.
    expect(() => sent(run, "a", CMD, run.rev, T0, all)).not.toThrow();
    expect(() => sent(again, "a", CMD, run.rev, T0, all)).toThrow(RunError);
  });
});

describe("the claim", () => {
  const w = workflow([step("a", "A"), step("b", "B")]);

  it("needs the run's rev and a ready step; a second tab gets a conflict", () => {
    const run = newRun(w, { id: "r", now: T0, online: all });
    const err = (f: () => unknown) => {
      try {
        f();
        return null;
      } catch (e) {
        return e instanceof RunError ? { status: e.status, reason: e.reason, why: e.why } : e;
      }
    };
    expect(err(() => claim(run, "a", run.rev + 1, T0))).toEqual({
      status: 412,
      reason: "conflict",
      why: "the run moved; read it again",
    });
    expect(err(() => claim(run, "b", run.rev, T0))).toEqual({
      status: 412,
      reason: "conflict",
      why: "the step is not ready",
    });
    expect(err(() => claim(run, "zz", run.rev, T0))).toEqual({ status: 404, reason: "not_found", why: "no such step" });
    const mine = claim(run, "a", run.rev, T0);
    expect(mine.rev).toBe(run.rev + 1);
    // The other tab read the run before the claim: its rev is stale against the stored one.
    expect(err(() => claim(mine, "a", run.rev, T0))).toEqual({
      status: 412,
      reason: "conflict",
      why: "the run moved; read it again",
    });
    // And one that read it after: the step is being sent.
    expect(err(() => claim(mine, "a", mine.rev, T0))).toEqual({
      status: 412,
      reason: "conflict",
      why: "another tab has it",
    });
    expect(err(() => sent(run, "a", CMD, run.rev, T0, all))).toEqual({
      status: 412,
      reason: "conflict",
      why: "the step was not being sent",
    });
    // A sent takes a rev that lags (another step's claim or ack moved the run meanwhile):
    // the claim is the guard. A rev from the future is no tab's.
    expect(sent(mine, "a", CMD, mine.rev - 1, T0, all).steps.a).toMatchObject({ status: "sent", commandId: CMD });
    expect(err(() => sent(mine, "a", CMD, mine.rev + 1, T0, all))).toEqual({
      status: 412,
      reason: "conflict",
      why: "the run moved; read it again",
    });
  });

  it("nothing is claimed on a run that ended", () => {
    const run = cancel(newRun(w, { id: "r", now: T0, online: all }), T0);
    expect(() => claim(run, "a", run.rev, T0)).toThrow(/cancelled/);
  });
});

describe("cancel", () => {
  it("skips every step not yet sent, keeps a sent one running, and is for good", () => {
    const w = workflow([step("a", "A"), step("b", "B", { after: [] }), step("c", "C", { after: ["a", "b"] })]);
    let run = newRun(w, { id: "r", now: T0, online: all });
    run = claim(run, "a", run.rev, T0);
    run = sent(run, "a", CMD, run.rev, T0, all);
    run = claim(run, "b", run.rev, T0);
    const stopped = cancel(run, T0 + 1000);
    expect(stopped).toMatchObject({
      status: "cancelled",
      rev: run.rev + 1,
      endedAt: new Date(T0 + 1000).toISOString(),
    });
    expect(stopped.steps.a!.status).toBe("sent");
    expect(stopped.steps.b).toEqual({ status: "skipped", endedAt: new Date(T0 + 1000).toISOString() });
    expect(stopped.steps.c!.status).toBe("skipped");
    expect(cancel(stopped, T0 + 2000)).toBe(stopped);
    expect(advance(stopped, T0 + 60_000, all)).toBe(stopped);
    // The sent step's ack still lands, and moves nothing else.
    const later = settle(stopped, ack(CMD, { reply: "late" }), T0 + 3000, all)!;
    expect(later.steps.a).toMatchObject({ status: "done", reply: "late" });
    expect(later.status).toBe("cancelled");
    expect(later.steps.c!.status).toBe("skipped");
  });

  it("a done run stays done", () => {
    let run = newRun(workflow([step("a", "A")]), { id: "r", now: T0, online: all });
    run = deliver(run, "a", CMD3, "ok", T0);
    expect(cancel(run, T0)).toBe(run);
  });
});
