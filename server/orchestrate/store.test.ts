// SPDX-License-Identifier: Apache-2.0
// What a saved workflow must be, and the two files: private, written whole, read back the same.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKFLOW_STEPS_MAX, WORKFLOW_TEXT_MAX, type WorkflowRun } from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
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
    plan: [],
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
