// SPDX-License-Identifier: Apache-2.0
// The signer's reading of the runs (runner.ts): one ready step becomes one claim with a
// start (a harness) or a prompt (a session); two tabs settle through the claim (a 412's
// run shows the step `sending`, so nothing is offered for it); a page with no grant, or
// one that cannot sign, offers nothing; a machine that is offline, a harness it does not
// run, a start with no folder, a claim this tab already holds: nothing either.
import type { MachineControl, WorkflowRun, WorkflowStep } from "@shared/api";
import { describe, expect, it } from "vitest";
import { type Claim, claimKey, commandFor, plan, type RunnerMachine } from "./runner";

const MACHINE = "m_lab00000000000001";
const lab: RunnerMachine = {
  machineId: MACHINE,
  online: true,
  folders: ["/Users/demo/code", "/Users/demo/work"],
  harnesses: ["claude-code", "codex"],
  start: {
    "claude-code": { permissions: ["read", "safe"], permission: "safe", anyModel: true },
    codex: { permissions: ["read", "safe"], permission: "safe", models: ["gpt-5.4-codex"] },
  },
};

const implement: WorkflowStep = {
  id: "implement",
  name: "Implement",
  machineId: MACHINE,
  agent: { harness: "claude-code" },
  text: "Implement this: {{input}}",
  permission: "safe",
  model: "sonnet",
};
const review: WorkflowStep = {
  id: "review",
  name: "Review",
  machineId: MACHINE,
  agent: { session: "codex:01A" },
  text: "Review:\n\n{{prev}}",
};

function run(o: Partial<WorkflowRun> & { steps: WorkflowRun["steps"] }): WorkflowRun {
  return {
    id: "01RUN",
    workflowId: "w1",
    name: "Implement, then review",
    rev: 1,
    status: "running",
    input: "add retries",
    startedAt: "2026-10-28T10:00:00.000Z",
    plan: [implement, review],
    ...o,
  };
}

const uuid = () => "00000000-0000-4000-8000-000000000001";
const signer = { canSign: true, grant: true };
const input = (runs: WorkflowRun[], o: Partial<Parameters<typeof plan>[0]> = {}) =>
  plan({ runs, machines: [lab], signer, held: new Set(), uuid, ...o });

describe("runner: one ready step", () => {
  const r = run({
    steps: { implement: { status: "ready", text: "Implement this: add retries" }, review: { status: "pending" } },
  });

  it("claims it with a start: a fresh session of the harness, the resolved text, the machine's first folder, the options the hello offers", () => {
    const claims = input([r]);
    expect(claims).toHaveLength(1);
    const c = claims[0] as Claim;
    expect(c).toMatchObject({ runId: "01RUN", stepId: "implement", rev: 1, machineId: MACHINE });
    expect(c.fields).toEqual({
      kind: "start",
      session: `claude-code:${uuid()}`,
      text: "Implement this: add retries",
      cwd: "/Users/demo/code",
      permission: "safe",
      model: "sonnet",
    });
  });

  it("drops a level or a model the hello does not offer for that harness", () => {
    const codex: WorkflowStep = { ...implement, agent: { harness: "codex" }, permission: "auto", model: "o3" };
    const c = commandFor(
      run({ plan: [codex], steps: { implement: { status: "ready", text: "x" } } }),
      codex,
      lab,
      uuid,
    );
    expect(c).toEqual({ kind: "start", session: `codex:${uuid()}`, text: "x", cwd: "/Users/demo/code" });
  });

  it("takes the step's own folder over the machine's", () => {
    const c = commandFor(
      run({ steps: { implement: { status: "ready", text: "x" } } }),
      { ...implement, cwd: "/Users/demo/work" },
      lab,
      uuid,
    );
    expect(c).toMatchObject({ kind: "start", cwd: "/Users/demo/work" });
  });

  it("offers nothing for a start with no folder anywhere, or a harness the machine does not run", () => {
    const bare: RunnerMachine = { machineId: MACHINE, online: true, harnesses: ["claude-code"] };
    expect(commandFor(r, implement, bare, uuid)).toBeNull();
    const gemini: WorkflowStep = { ...implement, agent: { harness: "gemini-cli" } };
    expect(commandFor(r, gemini, lab, uuid)).toBeNull();
  });

  it("offers nothing for a step whose text is not resolved yet", () => {
    expect(commandFor(run({ steps: { implement: { status: "ready" } } }), implement, lab, uuid)).toBeNull();
  });
});

describe("runner: start vs prompt", () => {
  it("signs a prompt to the session a step names, with the resolved text", () => {
    const r = run({
      steps: {
        implement: { status: "done", reply: "Done: retries added.", sentAt: "2026-10-28T10:00:01.000Z" },
        review: { status: "ready", text: "Review:\n\nDone: retries added." },
      },
    });
    const claims = input([r]);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.fields).toEqual({
      kind: "prompt",
      session: "codex:01A",
      text: "Review:\n\nDone: retries added.",
    });
  });

  it("claims every ready root at once (a fan-out), in plan order", () => {
    const two = run({
      plan: [
        { ...implement, id: "first", after: [] },
        { ...implement, id: "second", after: [], agent: { harness: "codex" } },
      ],
      steps: { first: { status: "ready", text: "q" }, second: { status: "ready", text: "q" } },
    });
    expect(input([two]).map((c) => c.stepId)).toEqual(["first", "second"]);
  });
});

describe("runner: two tabs", () => {
  const ready = run({ steps: { implement: { status: "ready", text: "x" }, review: { status: "pending" } } });

  it("a claim names the run's rev; the run a 412 hands back (the step sending) yields no claim", () => {
    expect(input([ready])[0]!.rev).toBe(1);
    // The other tab's claim went through first: the server's answer to ours is this run.
    const conflict = run({
      rev: 2,
      steps: {
        implement: { status: "sending", text: "x", claimedAt: "2026-10-28T10:00:02.000Z" },
        review: { status: "pending" },
      },
    });
    expect(input([conflict])).toEqual([]);
  });

  it("a claim this tab holds (in flight, or just refused) is not offered again", () => {
    expect(input([ready], { held: new Set([claimKey("01RUN", "implement")]) })).toEqual([]);
    expect(input([ready], { held: new Set([claimKey("01RUN", "review")]) })).toHaveLength(1);
  });
});

describe("runner: when it must do nothing", () => {
  const ready = run({ steps: { implement: { status: "ready", text: "x" }, review: { status: "pending" } } });

  it("no grant, or no way to sign here: nothing (the server says waiting)", () => {
    expect(input([ready], { signer: { canSign: true, grant: false } })).toEqual([]);
    expect(input([ready], { signer: { canSign: false, grant: true } })).toEqual([]);
  });

  it("a run that ended, a step that is not ready, a machine that is offline or not paired", () => {
    expect(input([run({ ...ready, status: "cancelled" })])).toEqual([]);
    expect(
      input([run({ steps: { implement: { status: "sent", commandId: "01C" }, review: { status: "pending" } } })]),
    ).toEqual([]);
    expect(input([ready], { machines: [{ ...lab, online: false }] })).toEqual([]);
    expect(input([ready], { machines: [] })).toEqual([]);
  });

  it("a waiting run (nobody signed within two seconds) is still this tab's to claim", () => {
    expect(input([run({ ...ready, status: "waiting", waitingFor: "signer" })])).toHaveLength(1);
    expect(
      input([run({ ...ready, status: "waiting", waitingFor: "machine" })], { machines: [{ ...lab, online: false }] }),
    ).toEqual([]);
  });
});

// The runner only ever reads a MachineControl's four fields: a change to the contract shows here.
const _typed: RunnerMachine = {} as MachineControl;
void _typed;
