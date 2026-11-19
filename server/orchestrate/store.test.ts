// SPDX-License-Identifier: Apache-2.0
// What a saved workflow must be, and the two files: private, written whole, read back the same.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKFLOW_STEPS_MAX, WORKFLOW_TEXT_MAX, type WorkflowRun } from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { cancel, newRun } from "./runs.js";
import { OrchestrateStore, RUNS_MAX, readWorkflow, WorkflowError } from "./store.js";

const M = "m_machine00000000000001";
const NOW = "2026-10-28T10:00:00.000Z";
const base = {
  name: "Second opinion",
  steps: [
    { id: "ask", machineId: M, agent: { harness: "codex" }, text: "Review {{input}}", cwd: "/Users/me/proj" },
    { id: "compare", machineId: M, agent: { session: "claude-code:abc" }, text: "Compare: {{prev}}" },
  ],
  input: { label: "The diff" },
};
const read = (doc: unknown) => {
  try {
    return readWorkflow(doc, { id: "wf", now: NOW });
  } catch (e) {
    if (e instanceof WorkflowError) return `${e.status} ${e.reason}: ${e.error}`;
    throw e;
  }
};
const withStep = (patch: Record<string, unknown>, i = 0) => ({
  ...base,
  steps: base.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)),
});

describe("readWorkflow", () => {
  it("reads a whole document, drops what it does not know, keeps createdAt", () => {
    const w = readWorkflow({ ...base, id: "wf", extra: 1, template: "second-opinion" }, { id: "wf", now: NOW });
    expect(w).toEqual({
      id: "wf",
      name: "Second opinion",
      input: { label: "The diff" },
      template: "second-opinion",
      steps: base.steps,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const later = readWorkflow(base, { id: "wf", now: "2026-10-29T00:00:00.000Z", existing: w });
    expect(later.createdAt).toBe(NOW);
    expect(later.updatedAt).toBe("2026-10-29T00:00:00.000Z");
  });

  it("refuses a malformed document", () => {
    expect(read(null)).toMatch(/^400 malformed/);
    expect(read([])).toMatch(/^400 malformed/);
    expect(read({ ...base, id: "other" })).toBe("400 malformed: id does not match the path");
    expect(read({ ...base, name: "" })).toMatch(/^400 malformed: name/);
    expect(read({ ...base, name: "x".repeat(81) })).toMatch(/^400 malformed: name/);
    expect(read({ ...base, input: "x" })).toBe("400 malformed: input is { label }");
    expect(read({ ...base, input: { label: "" } })).toMatch(/^400 malformed: input.label/);
    expect(read({ ...base, steps: [] })).toBe("400 malformed: a workflow has at least one step");
    expect(read({ ...base, steps: "x" })).toBe("400 malformed: a workflow has at least one step");
  });

  it("refuses a bad step, naming it", () => {
    expect(read(withStep({ id: "has space" }))).toMatch(/^400 bad_step: step 1: id/);
    expect(read(withStep({ id: "ask" }, 1))).toBe("400 bad_step: step 2: id ask is used twice");
    expect(read(withStep({ machineId: "nope" }))).toMatch(/^400 bad_step: step 1: machineId/);
    expect(read(withStep({ agent: {} }))).toMatch(/^400 bad_step: step 1: agent is/);
    expect(read(withStep({ agent: { harness: "codex", session: "a:b" } }))).toMatch(/one of the two/);
    expect(read(withStep({ agent: { harness: "Codex!" } }))).toMatch(/agent.harness/);
    expect(read(withStep({ agent: { session: "nocolon" } }))).toMatch(/agent.session/);
    expect(read(withStep({ text: "  " }))).toBe("400 bad_step: step 1: text is the step's prompt");
    expect(read(withStep({ cwd: "relative/dir" }))).toMatch(/cwd is an absolute folder/);
    expect(read(withStep({ permission: "full" }))).toMatch(/permission is one of/);
    expect(read(withStep({ model: "-x" }))).toMatch(/model is/);
    expect(read(withStep({ permission: "read" }, 1))).toMatch(/takes no permission or model/);
    expect(read(withStep({ after: "ask" }, 1))).toMatch(/after is a list/);
    expect(read(withStep({ after: ["compare"] }, 1))).toMatch(/after names compare that is not a step before/);
    expect(read(withStep({ after: ["zz"] }, 1))).toMatch(/after names zz/);
    expect(read(withStep({ after: [1] }, 1))).toMatch(/after names something/);
    expect(read(withStep({ text: "{{nope}}" }))).toMatch(/^400 bad_step: step 1: \{\{nope\}\} is not a placeholder/);
    expect(read(withStep({ text: "{{prev}}" }))).toBe("400 bad_step: step 1: {{prev}} needs a step before this one");
    expect(read({ ...base, input: undefined })).toBe(
      "400 bad_step: step 1: {{input}} needs the workflow to ask for an input",
    );
  });

  it("refuses what is too large with 413", () => {
    expect(read(withStep({ text: "x".repeat(WORKFLOW_TEXT_MAX + 1) }))).toMatch(/^413 too_large: step 1: text/);
    const many = {
      ...base,
      steps: Array.from({ length: WORKFLOW_STEPS_MAX + 1 }, (_, i) => ({ ...base.steps[0], id: `s${i}` })),
    };
    expect(read(many)).toBe(`413 too_large: at most ${WORKFLOW_STEPS_MAX} steps`);
    const most = {
      ...base,
      steps: Array.from({ length: WORKFLOW_STEPS_MAX }, (_, i) => ({ ...base.steps[0], id: `s${i}` })),
    };
    expect(typeof read(most)).toBe("object");
  });

  it("reads the optional fields, and `after: []` as a root; a `~` folder is fine", () => {
    const w = readWorkflow(withStep({ name: " Ask ", cwd: "~/proj", text: "Compare", after: [] }, 1), {
      id: "wf",
      now: NOW,
    });
    expect(w.steps[1]).toMatchObject({ name: "Ask", cwd: "~/proj", after: [] });
    // A prompt to a session takes no permission or model: these went on a harness step.
    expect(
      read(withStep({ agent: { harness: "codex" }, permission: "safe", model: "gpt-5", after: ["ask"] }, 1)),
    ).toMatchObject({
      steps: [expect.anything(), expect.objectContaining({ permission: "safe", model: "gpt-5", after: ["ask"] })],
    });
    // Empty or null optional fields are not set, and an absent cwd is left to the runner.
    expect((read(withStep({ name: "", cwd: null, model: "" })) as { steps: object[] }).steps[0]).toEqual({
      id: "ask",
      machineId: M,
      agent: { harness: "codex" },
      text: "Review {{input}}",
    });
  });
});

describe("OrchestrateStore", () => {
  let tmp: { dir: string; cleanup: () => void };
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.cleanup());

  const run = (id: string, status: WorkflowRun["status"], startedAt: string): WorkflowRun => ({
    id,
    workflowId: "wf",
    name: "n",
    rev: 1,
    status,
    startedAt,
    plan: [{ ...base.steps[0]!, id: "a" }],
    steps: { a: { status: status === "running" ? "ready" : "done" } },
  });

  it("writes both files private and whole, with no temp file left, and reads them back the same", () => {
    const store = new OrchestrateStore(tmp.dir);
    expect(store.workflows()).toEqual([]);
    expect(store.runs()).toEqual([]);
    const w = readWorkflow(base, { id: "wf", now: NOW });
    store.saveWorkflow(w);
    store.putRun(run("01K8RUN000000000000000AAAA", "running", NOW));
    for (const f of ["workflows.json", "workflow-runs.json"]) {
      const file = path.join(tmp.dir, f);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8")).v).toBe(1);
    }
    expect(readdirSync(tmp.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const again = new OrchestrateStore(tmp.dir);
    expect(again.workflows()).toEqual([w]);
    expect(again.runs()).toEqual(store.runs());
    // Replace by id, newest updated first.
    store.saveWorkflow({ ...w, name: "Renamed", updatedAt: "2026-10-29T00:00:00.000Z" });
    store.saveWorkflow({ ...w, id: "other", updatedAt: "2026-10-28T00:00:00.000Z" });
    expect(store.workflows().map((x) => x.name)).toEqual(["Renamed", "Second opinion"]);
    expect(store.deleteWorkflow("other")).toBe(true);
    expect(store.deleteWorkflow("other")).toBe(false);
    expect(store.workflow("wf")?.name).toBe("Renamed");
  });

  it("sets a broken file aside and starts empty; a run that no longer reads is left out", () => {
    writeFileSync(path.join(tmp.dir, "workflows.json"), "{nope");
    writeFileSync(
      path.join(tmp.dir, "workflow-runs.json"),
      JSON.stringify({ v: 1, runs: [run("01K8RUN000000000000000AAAA", "done", NOW), { id: "x" }, null] }),
    );
    const store = new OrchestrateStore(tmp.dir);
    expect(store.workflows()).toEqual([]);
    expect(store.runs().map((r) => r.id)).toEqual(["01K8RUN000000000000000AAAA"]);
    expect(readdirSync(tmp.dir).some((f) => f.startsWith("workflows.json.bad-"))).toBe(true);
    expect(existsSync(path.join(tmp.dir, "workflows.json"))).toBe(false);
  });

  // A run whose plan the state machine cannot walk threw from every tick (advance:
  // `steps[step.id]!.status`, `afterOf(...).map((id) => steps[id]!)`), and the server
  // exited a second after each start. Such a run is left out; the good one beside it stays.
  const planned = (id: string, plan: unknown[], steps: Record<string, unknown>): unknown => ({
    ...run(id, "running", NOW),
    plan,
    steps,
  });
  const GOOD = "01K8RUN000000000000000GOOD";
  const good = planned(
    GOOD,
    [
      { ...base.steps[0], id: "ask" },
      { ...base.steps[1], id: "compare", after: ["ask"] },
    ],
    { ask: { status: "done", reply: "r" }, compare: { status: "pending" } },
  ) as WorkflowRun;
  const step = (id: string, extra: Record<string, unknown> = {}) => ({ ...base.steps[0], id, ...extra });
  const broken: [string, unknown][] = [
    ["a plan step that is not an object", planned("01K8RUN00000000000000BAD1", [null], {})],
    ["a plan step with no entry in steps", planned("01K8RUN00000000000000BAD2", [step("a")], {})],
    [
      "an after that is not a step id",
      planned("01K8RUN00000000000000BAD3", [step("a"), step("b", { after: [5] })], {
        a: { status: "done" },
        b: { status: "pending" },
      }),
    ],
    [
      "an after naming a step that is not before it",
      planned("01K8RUN00000000000000BAD4", [step("a", { after: ["b"] }), step("b")], {
        a: { status: "pending" },
        b: { status: "pending" },
      }),
    ],
    [
      "an after that is not a list",
      planned("01K8RUN00000000000000BAD5", [step("a"), step("b", { after: "a" })], {
        a: { status: "done" },
        b: { status: "pending" },
      }),
    ],
    [
      "a plan step id that is not an id",
      planned("01K8RUN00000000000000BAD6", [step("../x")], { "../x": { status: "pending" } }),
    ],
    [
      "a plan step id used twice",
      planned("01K8RUN00000000000000BAD7", [step("a"), step("a")], { a: { status: "pending" } }),
    ],
    [
      "a plan step with no text",
      planned("01K8RUN00000000000000BAD8", [step("a", { text: undefined })], { a: { status: "pending" } }),
    ],
    // fitFills reads `.length` and `.slice` of every fill: an object with a length threw.
    [
      "an input that is not text",
      {
        ...(planned("01K8RUN00000000000000BAD9", [step("a")], { a: { status: "pending" } }) as object),
        input: { length: 5 },
      },
    ],
    [
      "a reply that is not text",
      planned("01K8RUN0000000000000BAD10", [step("a"), step("b", { text: "{{prev}}", after: ["a"] })], {
        a: { status: "done", reply: { length: 99999 } },
        b: { status: "pending" },
      }),
    ],
    [
      "a session that is not text",
      planned("01K8RUN0000000000000BAD12", [step("a")], { a: { status: "done", session: 5 } }),
    ],
    // The run's status is read from every entry: a pending one no step names never ends.
    [
      "an entry in steps that no plan step names",
      planned("01K8RUN0000000000000BAD11", [step("a")], { a: { status: "done" }, zz: { status: "pending" } }),
    ],
  ];
  it.each(broken)("leaves out a run with %s and keeps the good one whole", (_, bad) => {
    const file = path.join(tmp.dir, "workflow-runs.json");
    writeFileSync(file, JSON.stringify({ v: 1, runs: [bad, good] }));
    const store = new OrchestrateStore(tmp.dir);
    expect(store.runs().map((r) => r.id)).toEqual([GOOD]);
    // The file as it was is set aside, so the run left out is not lost.
    const aside = readdirSync(tmp.dir).filter((f) => f.startsWith("workflow-runs.json.bad-"));
    expect(aside).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(tmp.dir, aside[0]!), "utf8")).runs).toEqual([bad, good]);
    // A second start finds nothing to set aside.
    expect(new OrchestrateStore(tmp.dir).runs().map((r) => r.id)).toEqual([GOOD]);
    expect(readdirSync(tmp.dir).filter((f) => f.startsWith("workflow-runs.json.bad-"))).toHaveLength(1);
    // The next write keeps the good run whole; the one left out is not written back.
    store.putRun(run("01K8RUN000000000000000AAAA", "done", NOW));
    expect(new OrchestrateStore(tmp.dir).run(GOOD)).toEqual(good);
    expect(JSON.parse(readFileSync(file, "utf8")).runs.map((r: WorkflowRun) => r.id)).toEqual([
      GOOD,
      "01K8RUN000000000000000AAAA",
    ]);
  });

  it("sets aside a runs file whose runs are not a list, and keeps one where every run reads as it is", () => {
    const file = path.join(tmp.dir, "workflow-runs.json");
    writeFileSync(file, JSON.stringify({ v: 1, runs: { not: "a list" } }));
    expect(new OrchestrateStore(tmp.dir).runs()).toEqual([]);
    expect(readdirSync(tmp.dir).filter((f) => f.startsWith("workflow-runs.json.bad-"))).toHaveLength(1);
    const whole = `${JSON.stringify({ v: 1, runs: [good] })}\n`;
    writeFileSync(file, whole);
    new OrchestrateStore(tmp.dir);
    expect(readFileSync(file, "utf8")).toBe(whole);
    expect(readdirSync(tmp.dir).filter((f) => f.startsWith("workflow-runs.json.bad-"))).toHaveLength(1);
  });

  it("leaves a runs file as it is, and sets nothing aside, when it cannot be rewritten", () => {
    const file = path.join(tmp.dir, "workflow-runs.json");
    const text = JSON.stringify({ v: 1, runs: [broken[0]![1], good] });
    writeFileSync(file, text);
    const blocker = `${file}.${process.pid}.tmp`;
    mkdirSync(blocker);
    expect(new OrchestrateStore(tmp.dir).runs().map((r) => r.id)).toEqual([GOOD]);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(readdirSync(tmp.dir).filter((f) => f.includes(".bad-"))).toEqual([]);
    rmSync(blocker, { recursive: true });
    new OrchestrateStore(tmp.dir);
    expect(readdirSync(tmp.dir).filter((f) => f.includes(".bad-"))).toHaveLength(1);
  });

  it("keeps a run it left out in the file until the file can be set aside", () => {
    const file = path.join(tmp.dir, "workflow-runs.json");
    const bad = broken[1]![1];
    writeFileSync(file, JSON.stringify({ v: 1, runs: [bad, good] }));
    // No copy can be made: a folder already has the name of the copy.
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const blocker = `${file}.bad-1700000000000`;
    mkdirSync(blocker);
    const store = new OrchestrateStore(tmp.dir);
    expect(store.runs().map((r) => r.id)).toEqual([GOOD]);
    // A write meanwhile keeps the run left out in the file, beside the runs that read.
    store.putRun(run("01K8RUN000000000000000AAAA", "done", NOW));
    expect(JSON.parse(readFileSync(file, "utf8")).runs).toContainEqual(bad);
    rmSync(blocker, { recursive: true });
    now.mockRestore();
    // Once a copy can be made, the file is set aside with that run, then written without it.
    store.putRun(run("01K8RUN000000000000000BBBB", "done", NOW));
    const aside = readdirSync(tmp.dir).filter((f) => f.startsWith("workflow-runs.json.bad-"));
    expect(aside).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(tmp.dir, aside[0]!), "utf8")).runs).toContainEqual(bad);
    expect(
      JSON.parse(readFileSync(file, "utf8"))
        .runs.map((r: WorkflowRun) => r.id)
        .sort(),
    ).toEqual(["01K8RUN000000000000000AAAA", "01K8RUN000000000000000BBBB", GOOD].sort());
  });

  it("does not write back a duplicate of a run that is gone, while the file cannot be set aside", () => {
    const file = path.join(tmp.dir, "workflow-runs.json");
    writeFileSync(file, JSON.stringify({ v: 1, runs: [good, { ...good, rev: 2 }, broken[1]![1]] }));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mkdirSync(`${file}.bad-1700000000000`);
    const store = new OrchestrateStore(tmp.dir);
    expect(store.deleteRun(GOOD)).toBe(true);
    now.mockRestore();
    const runs = JSON.parse(readFileSync(file, "utf8")).runs;
    expect(runs).toEqual([broken[1]![1]]);
    expect(new OrchestrateStore(tmp.dir).run(GOOD)).toBeUndefined();
  });

  it("reads back every run the server writes, also one with a step called __proto__", () => {
    const wf = readWorkflow(withStep({ id: "__proto__" }), { id: "wf", now: NOW });
    const started = newRun(wf, { id: "01K8RUN0000000000000PROTO1", now: Date.parse(NOW), online: () => true });
    const ended = cancel(
      newRun(wf, { id: "01K8RUN0000000000000PROTO2", now: Date.parse(NOW), online: () => true }),
      Date.parse(NOW),
    );
    const store = new OrchestrateStore(tmp.dir);
    store.putRun(started);
    store.putRun(ended);
    const again = new OrchestrateStore(tmp.dir);
    expect(again.run(started.id)).toEqual(JSON.parse(JSON.stringify(started)));
    expect(again.run(ended.id)).toEqual(JSON.parse(JSON.stringify(ended)));
    expect(Object.hasOwn(again.run(ended.id)!.steps, "__proto__")).toBe(true);
    expect(readdirSync(tmp.dir).filter((f) => f.includes(".bad-"))).toEqual([]);
  });

  it("keeps at most RUNS_MAX runs, dropping the oldest ended ones first", () => {
    const store = new OrchestrateStore(tmp.dir);
    const at = (i: number) => new Date(Date.parse(NOW) + i * 1000).toISOString();
    store.putRun(run("01K8RUN000000000000LIVE00", "running", at(0)));
    for (let i = 1; i <= RUNS_MAX + 2; i++) store.putRun(run(`01K8RUN${String(i).padStart(19, "0")}`, "done", at(i)));
    const runs = store.runs();
    expect(runs).toHaveLength(RUNS_MAX);
    expect(runs.some((r) => r.id === "01K8RUN000000000000LIVE00")).toBe(true);
    expect(runs.some((r) => r.id === `01K8RUN${String(1).padStart(19, "0")}`)).toBe(false);
    expect(store.deleteRun("01K8RUN000000000000LIVE00")).toBe(true);
    expect(store.deleteRun("01K8RUN000000000000LIVE00")).toBe(false);
  });
});
