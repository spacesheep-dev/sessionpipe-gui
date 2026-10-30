// SPDX-License-Identifier: Apache-2.0
// A workflow run's state machine (shared/api.ts WorkflowRun): pure functions from a run,
// the clock and which machines are online to the next run. The server owns every move:
// which step is ready (every step it runs after is done), what its text resolves to, that
// a failed step skips whatever depends on it, when the run waits for a signer or for a
// machine, and what a command's final ack settles. The browser only claims a ready step,
// signs it and brings the command's id back (routes.ts); index.ts drives this from
// control's acks and a one-second clock. Nothing here touches a file or a timer.
import {
  type ControlActivity,
  type RunStatus,
  type SessionKey,
  type StepRun,
  WAITING_SIGNER_MS,
  WORKFLOW_TEXT_MAX,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from "../../shared/api.js";
import { isFinal } from "../control/parse.js";
import { EXPIRES_MAX_MS } from "../control/state.js";

/** A claim (`sending`) that brought no command id back within this long (the tab closed,
 *  the passkey prompt was dismissed) is offered to the signers again. */
export const CLAIM_TTL_MS = 60_000;
/** The longest a `sent` step waits for its command's final ack: the queue's longest life
 *  (a day, EXPIRES_MAX_MS) and a minute. The queue itself expires the command and the ack
 *  settles the step well before; this is for a record that never comes back (its machine
 *  removed, its queue pruned, an ack lost): the step fails with NO_ANSWER, what depends on
 *  it skips, and the run ends instead of reading `running` for good. */
export const SENT_TTL_MS = EXPIRES_MAX_MS + 60_000;
export const NO_ANSWER = "no answer: the machine never settled the command within a day";

/** Why a step fails when its text is nothing once filled (`{{prev}}` alone after a reply
 *  that never came): no signer could send it, so the run does not wait for one. */
export const EMPTY_TEXT = "nothing to send: the text was empty once its placeholders were filled";

export const RUN_FINAL = new Set<RunStatus>(["done", "failed", "cancelled"]);
export const runEnded = (run: Pick<WorkflowRun, "status">): boolean => RUN_FINAL.has(run.status);

/** Which machines can take a command right now, by machine id. */
export type Online = (machineId: string) => boolean;

/** Why a move was refused, as the route answers it: 412 `conflict` for anything a tab
 *  should re-read the run over, 404 for a step the run does not have. */
export class RunError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly why: string,
  ) {
    super(why);
  }
}

const iso = (now: number): string => new Date(now).toISOString();

/** The steps a step runs after: `after` as given, else the step before it in the plan
 *  (none for the first one). */
export function afterOf(plan: readonly WorkflowStep[], i: number): string[] {
  const s = plan[i]!;
  if (s.after) return s.after;
  return i > 0 ? [plan[i - 1]!.id] : [];
}

/** Every step a step runs after, transitively. */
export function ancestors(plan: readonly WorkflowStep[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (x: string): void => {
    const i = plan.findIndex((s) => s.id === x);
    if (i < 0) return;
    for (const a of afterOf(plan, i)) {
      if (out.has(a)) continue;
      out.add(a);
      walk(a);
    }
  };
  walk(id);
  return out;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

export type Placeholder =
  | { kind: "input" }
  | { kind: "prev" }
  | { kind: "step"; id: string }
  | { kind: "unknown"; name: string };

/** What is inside one `{{ }}`: `input`, `prev`, `step.<id>`, or nothing we know. */
export function readPlaceholder(raw: string): Placeholder {
  const name = raw.trim();
  if (name === "input") return { kind: "input" };
  if (name === "prev") return { kind: "prev" };
  const m = /^step\.([A-Za-z0-9_-]{1,40})$/.exec(name);
  if (m) return { kind: "step", id: m[1]! };
  return { kind: "unknown", name };
}

/** The placeholders in a text, as written inside the braces. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** Why step `i`'s text could not be filled when its turn comes, or null: an unknown
 *  placeholder, `{{prev}}` on a step with nothing before it, `{{step.x}}` naming a step it
 *  does not run after (its reply may not exist yet), `{{input}}` in a workflow that asks for
 *  none. Refused at save, so a run never stalls on it. */
export function placeholderProblem(
  w: Pick<Workflow, "input">,
  plan: readonly WorkflowStep[],
  i: number,
): string | null {
  const step = plan[i]!;
  const before = ancestors(plan, step.id);
  for (const raw of placeholders(step.text)) {
    const p = readPlaceholder(raw);
    if (p.kind === "unknown") return `{{${raw}}} is not a placeholder: use {{input}}, {{prev}} or {{step.<id>}}`;
    if (p.kind === "prev" && afterOf(plan, i).length === 0) return "{{prev}} needs a step before this one";
    if (p.kind === "step" && !before.has(p.id))
      return plan.some((s) => s.id === p.id)
        ? `{{step.${p.id}}} names a step this one does not run after`
        : `{{step.${p.id}}} names no step`;
    if (p.kind === "input" && !w.input) return "{{input}} needs the workflow to ask for an input";
  }
  return null;
}

/** What a cut fill ends with: a reply longer than a prompt may be is cut, never refused. */
export const CUT_MARK = "\n[… cut here: longer than a prompt may be]";

/** The fills of a text's placeholders cut to fit `budget` characters together: the longest
 *  first, so a short one stays whole; each cut one ends with CUT_MARK, or is dropped when
 *  not even the mark would fit. */
export function fitFills(fills: readonly string[], budget: number): string[] {
  const out = [...fills];
  const total = (): number => out.reduce((n, f) => n + f.length, 0);
  const order = out.map((f, i) => [f.length, i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    const over = total() - budget;
    if (over <= 0) break;
    const keep = out[i]!.length - over - CUT_MARK.length;
    out[i] = keep > 0 ? out[i]!.slice(0, keep) + CUT_MARK : "";
  }
  return out;
}

/** The step's text with its placeholders filled from the run: `{{input}}` the run's input,
 *  `{{prev}}` the reply of the step(s) it runs after (in plan order, joined by a blank
 *  line; one with no reply contributes nothing), `{{step.x}}` that step's reply. The
 *  whole is kept within WORKFLOW_TEXT_MAX, which is what a command's text may be: the
 *  step's own words always fit (checked at save), so what is cut is the fills, the longest
 *  first, each ending with CUT_MARK; a run never stalls on a long reply. */
export function resolveText(run: WorkflowRun, step: WorkflowStep): string {
  const i = run.plan.findIndex((s) => s.id === step.id);
  const reply = (id: string): string => run.steps[id]?.reply ?? "";
  const fill = (raw: string, whole: string): string => {
    const p = readPlaceholder(raw);
    if (p.kind === "input") return run.input ?? "";
    if (p.kind === "prev")
      return afterOf(run.plan, i)
        .map(reply)
        .filter((r) => r !== "")
        .join("\n\n");
    if (p.kind === "step") return reply(p.id);
    return whole;
  };
  const fills = [...step.text.matchAll(PLACEHOLDER)].map((m) => fill(m[1]!, m[0]));
  const fixed = step.text.replace(PLACEHOLDER, "").length;
  const fitted = fitFills(fills, WORKFLOW_TEXT_MAX - fixed);
  let n = 0;
  const text = step.text.replace(PLACEHOLDER, () => fitted[n++]!);
  return text.length > WORKFLOW_TEXT_MAX ? text.slice(0, WORKFLOW_TEXT_MAX) : text;
}

/** A run of `w`: its steps copied into the plan (an edit of the workflow never changes a
 *  run), every step pending, then moved once so the roots are ready. */
export function newRun(w: Workflow, o: { id: string; input?: string; now: number; online: Online }): WorkflowRun {
  const plan = w.steps.map((s) => ({ ...s, agent: { ...s.agent }, ...(s.after ? { after: [...s.after] } : {}) }));
  const steps: Record<string, StepRun> = {};
  for (const s of plan) steps[s.id] = { status: "pending" };
  const run: WorkflowRun = {
    id: o.id,
    workflowId: w.id,
    name: w.name,
    rev: 0,
    status: "running",
    ...(o.input !== undefined ? { input: o.input } : {}),
    startedAt: iso(o.now),
    plan,
    steps,
  };
  const next = advance(run, o.now, o.online);
  return next === run ? { ...run, rev: 1 } : next;
}

/** The run's status read from its steps: a ready step on an offline machine, or one nobody
 *  claimed for WAITING_SIGNER_MS, is `waiting`; anything in flight is `running`; nothing left
 *  to move is `done`, or `failed` when a step failed. `cancelled` is for good. */
function evaluate(run: WorkflowRun, now: number, online: Online): Pick<WorkflowRun, "status" | "waitingFor"> {
  if (run.status === "cancelled") return { status: "cancelled" };
  const ready = run.plan.filter((s) => run.steps[s.id]!.status === "ready");
  if (ready.length) {
    if (ready.some((s) => !online(s.machineId))) return { status: "waiting", waitingFor: "machine" };
    if (ready.some((s) => now - Date.parse(run.steps[s.id]!.readyAt ?? iso(now)) > WAITING_SIGNER_MS))
      return { status: "waiting", waitingFor: "signer" };
    return { status: "running" };
  }
  const all = Object.values(run.steps);
  if (all.some((s) => s.status === "sending" || s.status === "sent" || s.status === "pending"))
    return { status: "running" };
  if (all.some((s) => s.status === "failed")) return { status: "failed" };
  return { status: "done" };
}

/** The run moved forward by what it knows: a pending step whose every `after` is done
 *  becomes ready (its text resolved); one behind a failed or skipped step is skipped; a
 *  claim that went stale is offered again; then the status is read. The same object comes
 *  back when nothing moved, a new one with `rev` bumped when something did. */
export function advance(run: WorkflowRun, now: number, online: Online): WorkflowRun {
  const at = iso(now);
  const steps: Record<string, StepRun> = { ...run.steps };
  let changed = false;
  const set = (id: string, s: StepRun): void => {
    steps[id] = s;
    changed = true;
  };
  if (run.status !== "cancelled") {
    // Plan order: a step only ever runs after earlier ones, so one pass settles a chain.
    for (let i = 0; i < run.plan.length; i++) {
      const step = run.plan[i]!;
      const s = steps[step.id]!;
      const after = afterOf(run.plan, i).map((id) => steps[id]!);
      if (s.status === "pending") {
        if (after.some((a) => a.status === "failed" || a.status === "skipped"))
          set(step.id, { status: "skipped", endedAt: at });
        else if (after.every((a) => a.status === "done")) {
          const text = resolveText({ ...run, steps }, step);
          // Nothing once filled is nothing a signer could send: the step fails here, what
          // depends on it skips in this same pass, and the run never waits for a signer
          // that has nothing to sign.
          if (text.trim()) set(step.id, { status: "ready", readyAt: at, text });
          else set(step.id, { status: "failed", error: EMPTY_TEXT, endedAt: at });
        }
      } else if (
        s.status === "sending" &&
        !s.commandId &&
        now - Date.parse(s.claimedAt ?? s.readyAt ?? at) > CLAIM_TTL_MS
      ) {
        const { claimedAt: _stale, ...rest } = s;
        set(step.id, { ...rest, status: "ready", readyAt: at });
      } else if (s.status === "sent" && now - Date.parse(s.sentAt ?? at) > SENT_TTL_MS) {
        set(step.id, { ...s, status: "failed", error: NO_ANSWER, endedAt: at });
      }
    }
  }
  const next: WorkflowRun = { ...run, steps };
  const read = evaluate(next, now, online);
  if (read.status !== run.status || read.waitingFor !== run.waitingFor) changed = true;
  if (!changed) return run;
  next.status = read.status;
  if (read.waitingFor) next.waitingFor = read.waitingFor;
  else delete next.waitingFor;
  if (runEnded(next) && !next.endedAt) next.endedAt = at;
  next.rev = run.rev + 1;
  return next;
}

const sameRev = (run: WorkflowRun, rev: number): void => {
  if (rev !== run.rev) throw new RunError(412, "conflict", "the run moved; read it again");
};
const stepOf = (run: WorkflowRun, id: string): StepRun => {
  const s = run.steps[id];
  if (!s) throw new RunError(404, "not_found", "no such step");
  return s;
};

/** A tab claims a ready step to sign it. The claim is the idempotency guard across tabs:
 *  `rev` must be the run's, and the step must still be ready. */
export function claim(run: WorkflowRun, stepId: string, rev: number, now: number): WorkflowRun {
  sameRev(run, rev);
  const s = stepOf(run, stepId);
  if (runEnded(run)) throw new RunError(412, "conflict", `the run is ${run.status}`);
  if (s.status !== "ready")
    throw new RunError(412, "conflict", s.status === "sending" ? "another tab has it" : "the step is not ready");
  return {
    ...run,
    rev: run.rev + 1,
    steps: { ...run.steps, [stepId]: { ...s, status: "sending", claimedAt: iso(now) } },
  };
}

/** The tab that claimed a step queued its command: the step is sent, and the run is read
 *  again (a wait for a signer ends). The claim is the guard here, not the rev: between a
 *  tab's claim and its command another step's claim or ack moves the run (two roots
 *  claimed at once), and the id must still land; `rev` is read only to be sure the tab
 *  holds this run at all (a re-offered claim leaves the step `ready`, which refuses).
 *  `session` is the one the command named (the uuid a start chose, the session a prompt
 *  goes to): known from this moment, so the run view can link it and a cancel can offer
 *  to stop it while the step runs; the ack's own session replaces it when it settles. */
export function sent(
  run: WorkflowRun,
  stepId: string,
  commandId: string,
  rev: number,
  now: number,
  online: Online,
  session?: SessionKey,
): WorkflowRun {
  if (rev > run.rev) throw new RunError(412, "conflict", "the run moved; read it again");
  const s = stepOf(run, stepId);
  if (s.status !== "sending") throw new RunError(412, "conflict", "the step was not being sent");
  const next: WorkflowRun = {
    ...run,
    rev: run.rev + 1,
    steps: {
      ...run.steps,
      [stepId]: { ...s, status: "sent", commandId, sentAt: iso(now), ...(session ? { session } : {}) },
    },
  };
  return advance(next, now, online);
}

/** The tab that claimed a step could not queue its command: the receiver refused the
 *  command itself (the core's `bad_fields`, precheck's closed lists), which no signer can
 *  mend. The step is failed with the refusal's `code: detail`, its dependants skip, and
 *  the run moves on, instead of the claim being offered again every CLAIM_TTL_MS. Guarded
 *  like `sent`: the step must still be `sending`. */
export function fail(
  run: WorkflowRun,
  stepId: string,
  error: string,
  rev: number,
  now: number,
  online: Online,
): WorkflowRun {
  if (rev > run.rev) throw new RunError(412, "conflict", "the run moved; read it again");
  const s = stepOf(run, stepId);
  if (s.status !== "sending") throw new RunError(412, "conflict", "the step was not being sent");
  const { claimedAt: _claimed, ...rest } = s;
  const next: WorkflowRun = {
    ...run,
    rev: run.rev + 1,
    steps: { ...run.steps, [stepId]: { ...rest, status: "failed", error, endedAt: iso(now) } },
  };
  return advance(next, now, online);
}

/** A control message reached a final ack: the step whose command it is settles (`delivered`
 *  is done, with the reply; anything else failed, with the machine's code and detail), its
 *  session is the one the ack named, and the run moves on. Null when the message is no
 *  step's, or not final yet. */
export function settle(run: WorkflowRun, a: ControlActivity, now: number, online: Online): WorkflowRun | null {
  const id = Object.keys(run.steps).find((k) => run.steps[k]!.commandId === a.id);
  if (!id) return null;
  const s = run.steps[id]!;
  if (s.status !== "sent" || !isFinal(a.outcome)) return null;
  const at = iso(now);
  const session = a.ackSession ?? a.session;
  const step: StepRun =
    a.outcome === "delivered"
      ? { ...s, status: "done", endedAt: at, ...(a.reply !== undefined ? { reply: a.reply } : {}) }
      : {
          ...s,
          status: "failed",
          endedAt: at,
          error: a.code ? (a.detail ? `${a.code}: ${a.detail}` : a.code) : (a.detail ?? a.outcome ?? "failed"),
        };
  if (session) step.session = session;
  return advance({ ...run, rev: run.rev + 1, steps: { ...run.steps, [id]: step } }, now, online);
}

/** Cancel: every step not yet sent is skipped and the run is cancelled for good. A step
 *  already sent runs on (its `cancel` is the browser's to sign) and still settles. */
export function cancel(run: WorkflowRun, now: number): WorkflowRun {
  if (runEnded(run)) return run;
  const at = iso(now);
  const steps: Record<string, StepRun> = {};
  for (const [id, s] of Object.entries(run.steps))
    steps[id] =
      s.status === "pending" || s.status === "ready" || s.status === "sending" ? { status: "skipped", endedAt: at } : s;
  const next: WorkflowRun = { ...run, rev: run.rev + 1, status: "cancelled", endedAt: at, steps };
  delete next.waitingFor;
  return next;
}
