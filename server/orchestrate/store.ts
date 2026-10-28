// SPDX-License-Identifier: Apache-2.0
// Where workflows and their runs live: <stateDir>/workflows.json and
// <stateDir>/workflow-runs.json, each written whole and private (0600, a temp file renamed
// over it) the way control keeps its files, so a restart finds every run where it was. A
// workflow arrives whole on PUT and is read here (readWorkflow): what breaks the contract
// is refused with the route's status, never patched up. A broken file is set aside, never
// lost, and read as empty.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  START_PERMISSIONS,
  type StepAgent,
  type StepRun,
  validModel,
  WORKFLOW_STEPS_MAX,
  WORKFLOW_TEXT_MAX,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from "../../shared/api.js";
import { HARNESS_RE, MACHINE_RE, SESSION_REF } from "../control/parse.js";
import { placeholderProblem, RUN_FINAL, runEnded } from "./runs.js";

/** Saved workflows kept at most, and runs (the oldest ended ones go first). */
export const WORKFLOWS_MAX = 200;
export const RUNS_MAX = 200;
export const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const NAME_MAX = 80;
const CWD_RE = /^(\/|~(\/|$)|[A-Za-z]:[\\/])/;
const CWD_MAX = 1024;
const TEMPLATE_MAX = 40;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL = /[\u0000-\u001f\u007f]/;
const STEP_STATUS = new Set<string>(["pending", "ready", "sending", "sent", "done", "failed", "skipped"]);

/** Why a workflow was refused, as the route answers it (`reason`, and `error` saying what to fix). */
export class WorkflowError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly error: string,
  ) {
    super(error);
  }
}

const malformed = (error: string): WorkflowError => new WorkflowError(400, "malformed", error);
const badStep = (i: number, error: string): WorkflowError =>
  new WorkflowError(400, "bad_step", `step ${i + 1}: ${error}`);

function readName(v: unknown, what: string, fail: (error: string) => WorkflowError): string {
  if (typeof v !== "string") throw fail(`${what} is text`);
  const t = v.trim();
  if (!t || t.length > NAME_MAX || CONTROL.test(t)) throw fail(`${what} is 1 to ${NAME_MAX} characters`);
  return t;
}

function readStep(raw: unknown, i: number, earlier: readonly WorkflowStep[]): WorkflowStep {
  const fail = (error: string): WorkflowError => badStep(i, error);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail("a step is an object");
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || !ID_RE.test(s.id)) throw fail("id is 1 to 40 letters, digits, _ or -");
  if (earlier.some((e) => e.id === s.id)) throw fail(`id ${s.id} is used twice`);
  if (typeof s.machineId !== "string" || !MACHINE_RE.test(s.machineId))
    throw fail("machineId is a paired machine's id");
  const a = s.agent as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== "object" || Array.isArray(a)) throw fail("agent is { harness } or { session }");
  let agent: StepAgent;
  if (typeof a.harness === "string" && a.session === undefined) {
    if (!HARNESS_RE.test(a.harness)) throw fail("agent.harness is a harness name");
    agent = { harness: a.harness };
  } else if (typeof a.session === "string" && a.harness === undefined) {
    if (!SESSION_REF.test(a.session)) throw fail("agent.session is <harness>:<id>");
    agent = { session: a.session };
  } else throw fail("agent is { harness } or { session }, one of the two");
  if (typeof s.text !== "string" || !s.text.trim()) throw fail("text is the step's prompt");
  if (s.text.length > WORKFLOW_TEXT_MAX)
    throw new WorkflowError(413, "too_large", `step ${i + 1}: text is at most ${WORKFLOW_TEXT_MAX} characters`);
  const step: WorkflowStep = { id: s.id, machineId: s.machineId, agent, text: s.text };
  const given = (k: string): boolean => s[k] !== undefined && s[k] !== null && s[k] !== "";
  if (given("name")) step.name = readName(s.name, "name", fail);
  if (given("cwd")) {
    if (typeof s.cwd !== "string" || !CWD_RE.test(s.cwd) || s.cwd.length > CWD_MAX || CONTROL.test(s.cwd))
      throw fail("cwd is an absolute folder, or one under ~");
    step.cwd = s.cwd;
  }
  if (given("permission")) {
    if (!(START_PERMISSIONS as readonly unknown[]).includes(s.permission))
      throw fail(`permission is one of ${START_PERMISSIONS.join(", ")}`);
    step.permission = s.permission as WorkflowStep["permission"];
  }
  if (given("model")) {
    if (!validModel(s.model)) throw fail("model is 1 to 100 characters, no leading dash");
    step.model = s.model;
  }
  // A prompt to an existing session carries neither (CONTROL.md §3.1: a start's fields).
  if ("session" in agent && (step.permission || step.model))
    throw fail("a step that prompts an existing session takes no permission or model");
  if (s.after !== undefined && s.after !== null) {
    if (!Array.isArray(s.after)) throw fail("after is a list of step ids");
    const after: string[] = [];
    for (const id of s.after) {
      if (typeof id !== "string" || !earlier.some((e) => e.id === id))
        throw fail(`after names ${typeof id === "string" ? id : "something"} that is not a step before this one`);
      if (!after.includes(id)) after.push(id);
    }
    step.after = after;
  }
  return step;
}

/** A workflow as PUT sends it, read whole: `id` is the path's (a body id must agree),
 *  `createdAt` the existing one's, `updatedAt` now. Throws WorkflowError: 400 `malformed`
 *  (the document), 400 `bad_step` (one step, named), 413 `too_large` (over
 *  WORKFLOW_STEPS_MAX steps or WORKFLOW_TEXT_MAX characters). Keys it does not know are
 *  dropped. */
export function readWorkflow(v: unknown, o: { id: string; now: string; existing?: Workflow }): Workflow {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw malformed("Send the whole workflow as JSON.");
  const b = v as Record<string, unknown>;
  if (b.id !== undefined && b.id !== o.id) throw malformed("id does not match the path");
  const name = readName(b.name, "name", malformed);
  let input: Workflow["input"];
  if (b.input !== undefined && b.input !== null) {
    if (typeof b.input !== "object" || Array.isArray(b.input)) throw malformed("input is { label }");
    input = { label: readName((b.input as Record<string, unknown>).label, "input.label", malformed) };
  }
  if (!Array.isArray(b.steps) || !b.steps.length) throw malformed("a workflow has at least one step");
  if (b.steps.length > WORKFLOW_STEPS_MAX)
    throw new WorkflowError(413, "too_large", `at most ${WORKFLOW_STEPS_MAX} steps`);
  const steps: WorkflowStep[] = [];
  for (let i = 0; i < b.steps.length; i++) steps.push(readStep(b.steps[i], i, steps));
  steps.forEach((_, i) => {
    const why = placeholderProblem({ input }, steps, i);
    if (why) throw badStep(i, why);
  });
  const w: Workflow = { id: o.id, name, steps, createdAt: o.existing?.createdAt ?? o.now, updatedAt: o.now };
  if (input) w.input = input;
  if (typeof b.template === "string" && b.template && b.template.length <= TEMPLATE_MAX && !CONTROL.test(b.template))
    w.template = b.template;
  return w;
}

/** A run as the file has it: the shape only (the state machine wrote it); null when broken. */
function readRun(v: unknown): WorkflowRun | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id) || typeof r.workflowId !== "string" || typeof r.name !== "string")
    return null;
  if (typeof r.rev !== "number" || !Number.isInteger(r.rev) || r.rev < 0) return null;
  if (typeof r.status !== "string" || !["running", "waiting", ...RUN_FINAL].includes(r.status as never)) return null;
  if (typeof r.startedAt !== "string" || !Array.isArray(r.plan) || !r.steps || typeof r.steps !== "object") return null;
  for (const s of Object.values(r.steps as Record<string, unknown>)) {
    if (!s || typeof s !== "object" || !STEP_STATUS.has(String((s as StepRun).status))) return null;
  }
  return r as unknown as WorkflowRun;
}

interface WorkflowsFile {
  v: 1;
  workflows: Workflow[];
}
interface RunsFile {
  v: 1;
  runs: WorkflowRun[];
}

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The file parsed, or null when missing; a file that is not JSON is set aside (never
 *  lost) and read as null. */
function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    try {
      renameSync(file, `${file}.bad-${Date.now()}`);
    } catch {
      // nothing to set aside
    }
    return null;
  }
}

export class OrchestrateStore {
  private readonly workflowsFile: string;
  private readonly runsFile: string;
  private workflowList: Workflow[] = [];
  private runList: WorkflowRun[] = [];

  constructor(stateDir: string) {
    this.workflowsFile = path.join(stateDir, "workflows.json");
    this.runsFile = path.join(stateDir, "workflow-runs.json");
    const wf = readJson(this.workflowsFile) as Partial<WorkflowsFile> | null;
    for (const raw of Array.isArray(wf?.workflows) ? wf.workflows : []) {
      const r = raw as Partial<Workflow>;
      if (typeof r?.id !== "string" || !ID_RE.test(r.id) || this.workflowList.some((w) => w.id === r.id)) continue;
      try {
        this.workflowList.push(
          readWorkflow(r, {
            id: r.id,
            now: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
            existing: typeof r.createdAt === "string" ? (r as Workflow) : undefined,
          }),
        );
      } catch {
        // a workflow that no longer reads is left out, the rest kept
      }
    }
    const rf = readJson(this.runsFile) as Partial<RunsFile> | null;
    for (const raw of Array.isArray(rf?.runs) ? rf.runs : []) {
      const run = readRun(raw);
      if (run && !this.runList.some((r) => r.id === run.id)) this.runList.push(run);
    }
  }

  // --- workflows ----------------------------------------------------------------

  /** Newest updated first. */
  workflows(): Workflow[] {
    return [...this.workflowList].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  workflow(id: string): Workflow | undefined {
    return this.workflowList.find((w) => w.id === id);
  }

  /** Save (replace by id, or add). Throws 413 `too_many` past WORKFLOWS_MAX. */
  saveWorkflow(w: Workflow): void {
    const i = this.workflowList.findIndex((x) => x.id === w.id);
    if (i < 0 && this.workflowList.length >= WORKFLOWS_MAX)
      throw new WorkflowError(413, "too_many", `at most ${WORKFLOWS_MAX} workflows; delete one first`);
    if (i < 0) this.workflowList.push(w);
    else this.workflowList[i] = w;
    this.commitWorkflows();
  }

  deleteWorkflow(id: string): boolean {
    const before = this.workflowList.length;
    this.workflowList = this.workflowList.filter((w) => w.id !== id);
    if (this.workflowList.length === before) return false;
    this.commitWorkflows();
    return true;
  }

  // --- runs ---------------------------------------------------------------------

  /** Newest started first. */
  runs(): WorkflowRun[] {
    return [...this.runList].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  run(id: string): WorkflowRun | undefined {
    return this.runList.find((r) => r.id === id);
  }

  /** Put a run (replace by id, or add). Past RUNS_MAX the oldest ended runs are dropped. */
  putRun(run: WorkflowRun): void {
    const i = this.runList.findIndex((r) => r.id === run.id);
    if (i < 0) this.runList.push(run);
    else this.runList[i] = run;
    if (this.runList.length > RUNS_MAX) {
      const ended = this.runList.filter(runEnded).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
      const drop = new Set(ended.slice(0, this.runList.length - RUNS_MAX).map((r) => r.id));
      this.runList = this.runList.filter((r) => !drop.has(r.id));
    }
    this.commitRuns();
  }

  deleteRun(id: string): boolean {
    const before = this.runList.length;
    this.runList = this.runList.filter((r) => r.id !== id);
    if (this.runList.length === before) return false;
    this.commitRuns();
    return true;
  }

  private commitWorkflows(): void {
    writeAtomic(this.workflowsFile, { v: 1, workflows: this.workflowList } satisfies WorkflowsFile);
  }
  private commitRuns(): void {
    writeAtomic(this.runsFile, { v: 1, runs: this.runList } satisfies RunsFile);
  }
}
