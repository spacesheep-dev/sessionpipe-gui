// SPDX-License-Identifier: Apache-2.0
// The signer's reading of the runs (runner.ts): one ready step becomes one claim with a
// start (a harness) or a prompt (a session); two tabs settle through the claim (a 412's
// run shows the step `sending`, so nothing is offered for it); a page with no grant, or
// one that cannot sign, offers nothing; a run this browser did not start, a machine that
// trusts none of its keys: nothing either; a machine that is offline, a harness it does
// not run, a start with no folder, a level or a model the hello does not offer (never
// signed without it), a claim this tab already holds.
import type { MachineControl, WorkflowRun, WorkflowStep } from "@shared/api";
import { describe, expect, it } from "vitest";
import { type Claim, claimKey, commandFor, grantGoodAt, plan, type RunnerMachine, unsignable } from "./runner";

const MACHINE = "m_lab00000000000001";
const KEY = { id: "key-of-this-page", alg: -7, addedAt: "2026-10-28T09:00:00.000Z" };
const lab: RunnerMachine = {
  machineId: MACHINE,
  online: true,
  keys: [KEY],
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
const signer = { canSign: true, grant: true, keyIds: new Set([KEY.id]) };
const input = (runs: WorkflowRun[], o: Partial<Parameters<typeof plan>[0]> = {}) =>
  plan({ runs, machines: [lab], signer, mine: new Set(runs.map((r) => r.id)), held: new Set(), uuid, ...o });

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

  it("never signs a step without the level or the model it names: one the hello does not offer is unsignable, and says so", () => {
    const label = (h: string) => (h === "codex" ? "Codex" : h);
    const r1 = run({ steps: { implement: { status: "ready", text: "x" } } });
    const level: WorkflowStep = { ...implement, agent: { harness: "codex" }, permission: "auto" };
    expect(commandFor(run({ plan: [level], steps: r1.steps }), level, lab, uuid)).toBeNull();
    expect(unsignable(level, lab, label)).toBe("doesn't offer auto for Codex");
    const model: WorkflowStep = { ...implement, agent: { harness: "codex" }, model: "o3" };
    expect(commandFor(run({ plan: [model], steps: r1.steps }), model, lab, uuid)).toBeNull();
    expect(unsignable(model, lab, label)).toBe("doesn't offer the model o3 for Codex");
    // Offered: carried as written. Named by neither: nothing to check.
    const fine: WorkflowStep = {
      ...implement,
      agent: { harness: "codex" },
      permission: "read",
      model: "gpt-5.4-codex",
    };
    expect(commandFor(run({ plan: [fine], steps: r1.steps }), fine, lab, uuid)).toMatchObject({
      permission: "read",
      model: "gpt-5.4-codex",
    });
    expect(unsignable(fine, lab, label)).toBeNull();
    expect(unsignable({ ...implement, permission: undefined, model: undefined }, lab, label)).toBeNull();
    expect(unsignable(review, { ...lab, harnesses: [] }, label)).toBeNull();
    expect(input([run({ plan: [level], steps: r1.steps })])).toEqual([]);
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
    const bare: RunnerMachine = { machineId: MACHINE, online: true, keys: [KEY], harnesses: ["claude-code"] };
    expect(commandFor(r, implement, bare, uuid)).toBeNull();
    expect(unsignable(implement, bare, (h) => h)).toBe("has no folder a new session could start in");
    const gemini: WorkflowStep = { ...implement, agent: { harness: "gemini-cli" } };
    expect(commandFor(r, gemini, lab, uuid)).toBeNull();
    expect(unsignable(gemini, lab, (h) => h)).toBe("doesn't run gemini-cli");
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
        { ...implement, id: "second", after: [], agent: { harness: "codex" }, model: undefined },
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
    expect(input([ready], { signer: { ...signer, grant: false } })).toEqual([]);
    expect(input([ready], { signer: { ...signer, canSign: false } })).toEqual([]);
  });

  it("a run this browser did not start (and was not told to sign): nothing, until it is marked", () => {
    expect(input([ready], { mine: new Set() })).toEqual([]);
    expect(input([ready], { mine: new Set(["other"]) })).toEqual([]);
    expect(input([ready], { mine: new Set(["other", ready.id]) })).toHaveLength(1);
  });

  it("a machine that trusts none of this page's keys: nothing (the signature would be refused)", () => {
    expect(input([ready], { signer: { ...signer, keyIds: new Set(["someone-else"]) } })).toEqual([]);
    expect(input([ready], { machines: [{ ...lab, keys: [] }] })).toEqual([]);
    expect(input([ready], { machines: [{ ...lab, keys: [{ ...KEY, id: "other" }, KEY] }] })).toHaveLength(1);
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

// The runner only ever reads a MachineControl's five fields: a change to the contract shows here.
const _typed: RunnerMachine = {} as MachineControl;
void _typed;

describe("grantGoodAt", () => {
  it("a grant is good while its end is ahead of the clock; lapsed, unread or due, it is not", () => {
    const now = Date.parse("2026-10-28T12:00:00.000Z");
    expect(grantGoodAt(now + 60_000, now)).toBe(true);
    // Read as a number an hour ago, lapsed since: the clock wins, and the runner re-reads.
    expect(grantGoodAt(now - 1, now)).toBe(false);
    expect(grantGoodAt(now, now)).toBe(false);
    expect(grantGoodAt(null, now)).toBe(false);
    expect(grantGoodAt(undefined, now)).toBe(false);
  });
});
