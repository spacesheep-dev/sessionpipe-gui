// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate. Workflows across agents and machines (DESIGN §3.1): the saved
// workflows and their runs (store.ts), the run's state machine (runs.ts), and what drives
// it here: control's acks (a step's command reaching a final ack settles the step) and a
// one-second clock (a ready step nobody claims, a machine coming online or going away).
// The server never signs anything: a ready step waits for a browser that can, which
// claims it, signs the `start` or `prompt` and brings the command's id back (routes.ts).
// Every change goes out as one `workflowRun` stream frame (the whole run), a save or a
// delete as a `workflows` frame. `createOrchestrate(deps)` is the contract app.ts and the
// routes code against.
//
//   store.ts   <stateDir>/workflows.json, workflow-runs.json; readWorkflow
//   runs.ts    the pure state machine, unit-tested on its own
//   routes.ts  /api/ui/workflows/* (ARCHITECTURE.md "UI API")
import { ulid } from "sessionpipe-core";
import type { ControlActivity, StreamMessage, Workflow, WorkflowRun } from "../../shared/api.js";
import type { Control } from "../control/index.js";
import { advance, cancel, claim, newRun, type Online, runEnded, sent, settle } from "./runs.js";
import { OrchestrateStore, readWorkflow, WorkflowError } from "./store.js";

export interface OrchestrateDeps {
  stateDir: string;
  /** Control: its stream (the acks), the activity (acks that landed while this receiver
   *  was down) and the paired machines (which are online). */
  control: Pick<Control, "subscribe" | "activity" | "machines">;
  /** Stream frames out (the Broadcast the stream route forwards). */
  broadcast: (m: StreamMessage) => void;
  /** How often runs are read again for the clock rules (default 1 s). */
  tickMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

export interface Orchestrate {
  workflows(): Workflow[];
  workflow(id: string): Workflow | undefined;
  /** Read and save the whole document; throws WorkflowError with the route's status. */
  saveWorkflow(id: string, body: unknown): Workflow;
  deleteWorkflow(id: string): boolean;
  runs(): WorkflowRun[];
  run(id: string): WorkflowRun | undefined;
  /** Start a run; throws WorkflowError 404 `not_found`, 400 `malformed` (the input). */
  startRun(workflowId: string, input: unknown): WorkflowRun;
  /** The signer's two moves (runs.ts claim / sent); throw RunError. */
  claim(runId: string, stepId: string, rev: number): WorkflowRun;
  sent(runId: string, stepId: string, commandId: string, rev: number): WorkflowRun;
  cancel(runId: string): WorkflowRun;
  deleteRun(runId: string): boolean;
  /** Read every live run again now (the clock rules); the timer does this every second. */
  tick(): void;
  close(): void;
}

/** The longest input a run takes, like a prompt's text. */
const INPUT_MAX = 20_000;

export function createOrchestrate(deps: OrchestrateDeps): Orchestrate {
  const store = new OrchestrateStore(deps.stateDir);
  const now = deps.now ?? Date.now;
  /** Which machines are online right now, by id, from control's reading of their polls. */
  const online = (): Online => {
    const up = new Set<string>();
    for (const m of deps.control.machines().values()) if (m.online) up.add(m.machineId);
    return (id) => up.has(id);
  };
  const put = (run: WorkflowRun): WorkflowRun => {
    store.putRun(run);
    deps.broadcast({ kind: "workflowRun", run });
    return run;
  };
  const workflowsChanged = (): void => deps.broadcast({ kind: "workflows", workflows: store.workflows() });
  const must = (id: string): WorkflowRun => {
    const run = store.run(id);
    if (!run) throw new WorkflowError(404, "not_found", "No such run.");
    return run;
  };

  /** A control message: the step whose command it is settles, and its run moves on. */
  const onActivity = (a: ControlActivity): void => {
    for (const run of store.runs()) {
      if (!Object.values(run.steps).some((s) => s.commandId === a.id)) continue;
      const next = settle(run, a, now(), online());
      if (next && next !== run) put(next);
    }
  };
  // Acks that landed while this receiver was down: control kept them in its queue files.
  const resync = (): void => {
    const live = store.runs().filter((r) => Object.values(r.steps).some((s) => s.status === "sent"));
    if (!live.length) return;
    const acts = new Map(deps.control.activity(1000).map((a) => [a.id, a]));
    for (const run of live)
      for (const s of Object.values(run.steps)) {
        const a = s.status === "sent" && s.commandId ? acts.get(s.commandId) : undefined;
        if (a) onActivity(a);
      }
  };
  const offControl = deps.control.subscribe((m) => {
    if (m.kind === "control") onActivity(m.message);
  });
  resync();

  const tick = (): void => {
    const t = now();
    const up = online();
    for (const run of store.runs()) {
      if (runEnded(run)) continue;
      const next = advance(run, t, up);
      if (next !== run) put(next);
    }
  };
  const timer = setInterval(tick, deps.tickMs ?? 1000);
  timer.unref();

  return {
    workflows: () => store.workflows(),
    workflow: (id) => store.workflow(id),
    saveWorkflow(id, body) {
      const w = readWorkflow(body, { id, now: new Date(now()).toISOString(), existing: store.workflow(id) });
      store.saveWorkflow(w);
      workflowsChanged();
      return w;
    },
    deleteWorkflow(id) {
      if (!store.deleteWorkflow(id)) return false;
      workflowsChanged();
      return true;
    },
    runs: () => store.runs(),
    run: (id) => store.run(id),
    startRun(workflowId, input) {
      const w = store.workflow(workflowId);
      if (!w) throw new WorkflowError(404, "not_found", "No such workflow.");
      let text: string | undefined;
      if (input !== undefined && input !== null) {
        if (typeof input !== "string") throw new WorkflowError(400, "malformed", "input is text");
        if (input.length > INPUT_MAX)
          throw new WorkflowError(413, "too_large", `input is at most ${INPUT_MAX} characters`);
        if (input.trim()) text = input;
      }
      if (w.input && text === undefined)
        throw new WorkflowError(400, "malformed", `This workflow asks for ${w.input.label}.`);
      return put(
        newRun(w, { id: ulid(now()), ...(text !== undefined ? { input: text } : {}), now: now(), online: online() }),
      );
    },
    claim: (runId, stepId, rev) => put(claim(must(runId), stepId, rev, now())),
    sent(runId, stepId, commandId, rev) {
      const run = put(sent(must(runId), stepId, commandId, rev, now(), online()));
      // The machine may have answered already: a daemon that long-polls takes a command
      // within milliseconds and refuses one at once, while the tab's PATCH with the id
      // comes over a slower link. That ack found no step holding its id; look again now.
      const a = deps.control.activity(1000).find((x) => x.id === commandId);
      if (a) onActivity(a);
      return store.run(runId) ?? run;
    },
    cancel(runId) {
      const run = must(runId);
      const next = cancel(run, now());
      return next === run ? run : put(next);
    },
    deleteRun(runId) {
      const run = store.run(runId);
      if (!run || !store.deleteRun(runId)) return false;
      deps.broadcast({ kind: "workflowRun", run, deleted: true });
      return true;
    },
    tick,
    close() {
      clearInterval(timer);
      offControl();
    },
  };
}
