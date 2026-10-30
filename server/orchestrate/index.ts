// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate. Workflows across agents and machines (DESIGN §3.1): the saved
// workflows and their runs (store.ts), the run's state machine (runs.ts), and what drives
// it here: control's acks (a step's command reaching a final ack settles the step) and a
// one-second clock (a ready step nobody claims, a machine coming online or going away).
// The server never signs anything: a ready step waits for a browser that can, which
// claims it, signs the `start` or `prompt` and brings the command's id back (routes.ts).
// The browser's signed command comes back here too (`send`): the receiver verifies it as
// /send does, and only then, in one move with no await between, checks the step is still
// this claim's and the run still live, queues it and marks the step `sent`. A command
// never runs on a machine for a step that was re-offered, taken by another tab or
// cancelled, and a refusal of the command itself fails the step instead of leaving it to
// be claimed and refused again every CLAIM_TTL_MS. Every change goes out as one
// `workflowRun` stream frame (the whole run), a save or a delete as a `workflows` frame.
// `createOrchestrate(deps)` is the contract app.ts and the routes code against.
//
//   store.ts   <stateDir>/workflows.json, workflow-runs.json; readWorkflow
//   runs.ts    the pure state machine, unit-tested on its own
//   routes.ts  /api/ui/workflows/* (ARCHITECTURE.md "UI API")
import { ulid } from "sessionpipe-core";
import type { ControlActivity, StreamMessage, Workflow, WorkflowRun } from "../../shared/api.js";
import type { Control } from "../control/index.js";
import { EXPIRES_MAX_MS } from "../control/state.js";
import { SIGNER_FAULTS } from "../control/ui.js";
import { HttpError } from "../http/router.js";
import { advance, cancel, claim, fail, newRun, type Online, RunError, runEnded, sent, settle } from "./runs.js";
import { OrchestrateStore, readWorkflow, WorkflowError } from "./store.js";

export interface OrchestrateDeps {
  stateDir: string;
  /** Control: its stream (the acks), the activity (acks that landed while this receiver
   *  was down), the paired machines (which are online), and the two halves of /send for
   *  a step's command (verify, then queue). */
  control: Pick<Control, "subscribe" | "activity" | "activityById" | "machines" | "verifySend" | "queueSend">;
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
  /** The signer's second move as the browser makes it: the signed command (a /send body)
   *  verified, then queued and the step marked `sent` in one move, or refused before
   *  anything is queued (RunError 412 when the step is no longer this claim's or the run
   *  ended; HttpError from the verifier for a signer's fault, the step left `sending`);
   *  a refusal of the command itself fails the step and comes back as the run. */
  send(runId: string, stepId: string, rev: number, body: unknown): Promise<WorkflowRun>;
  cancel(runId: string): WorkflowRun;
  deleteRun(runId: string): boolean;
  /** Read every live run again now (the clock rules); the timer does this every second. */
  tick(): void;
  close(): void;
}

/** The longest input a run takes, like a prompt's text. */
const INPUT_MAX = 20_000;
/** How long a step's command stays queued: the queue's longest (a day), not its default
 *  hour. A step is an agent's whole task; expireQueue expires a `taken` row too, so under
 *  the default an implement step still running after an hour failed as `expired`. The
 *  body's own `expires_in_s` is not the signer's to shorten here: the run owns the step. */
export const STEP_EXPIRES_MS = EXPIRES_MAX_MS;

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
  /** `sent`'s own guard, read before anything is queued (runs.ts sent). */
  const stillSending = (run: WorkflowRun, stepId: string, rev: number): void => {
    if (rev > run.rev) throw new RunError(412, "conflict", "the run moved; read it again");
    if (runEnded(run)) throw new RunError(412, "conflict", `the run is ${run.status}`);
    const s = run.steps[stepId];
    if (!s) throw new RunError(404, "not_found", "no such step");
    if (s.status !== "sending") throw new RunError(412, "conflict", "the step was not being sent");
  };
  const markSent = (runId: string, stepId: string, commandId: string, rev: number): WorkflowRun => {
    // The command as queued names the step's session from now on (a start's uuid, a
    // prompt's target); the ack's own replaces it when the step settles. By its id, not
    // through the newest thousand: a busy receiver carries more than that.
    const a = deps.control.activityById(commandId);
    const run = put(sent(must(runId), stepId, commandId, rev, now(), online(), a?.session));
    // The machine may have answered already: a daemon that long-polls takes a command
    // within milliseconds and refuses one at once, while the tab's PATCH with the id
    // comes over a slower link. That ack found no step holding its id; look again now.
    if (a) onActivity(a);
    return store.run(runId) ?? run;
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
  // Each sent step's command is looked up by its id; one whose record is gone (its machine
  // removed, its queue pruned) is left to the sent deadline (runs.ts SENT_TTL_MS).
  const resync = (): void => {
    for (const run of store.runs())
      for (const s of Object.values(run.steps)) {
        const a = s.status === "sent" && s.commandId ? deps.control.activityById(s.commandId) : undefined;
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
    sent: (runId, stepId, commandId, rev) => markSent(runId, stepId, commandId, rev),
    async send(runId, stepId, rev, body) {
      // The step must be this claim's before the (async) verification and again, with
      // nothing awaited in between, when the command is queued: a cancel or a re-offer
      // that lands during the verifier's work still means nothing is queued.
      stillSending(must(runId), stepId, rev);
      let verified: Awaited<ReturnType<typeof deps.control.verifySend>>;
      try {
        verified = await deps.control.verifySend(body);
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 422) throw e;
        const { code, reason: why } = (e.body ?? {}) as { code?: string; reason?: string };
        if (!code || SIGNER_FAULTS.has(code)) throw e;
        // The command itself was refused: no signer can mend it, so the step fails.
        return put(fail(must(runId), stepId, why ? `${code}: ${why}` : code, rev, now(), online()));
      }
      stillSending(must(runId), stepId, rev);
      const a = deps.control.queueSend({ ...verified, opts: { ...verified.opts, expiresInMs: STEP_EXPIRES_MS } });
      return markSent(runId, stepId, a.id, rev);
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
