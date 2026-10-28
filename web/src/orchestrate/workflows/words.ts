// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The words of the Workflows page (UX-SPEC §4, binding): a
// step's name, a run's state in a row and in the bar, a step's right column and second
// line, a duration as "2 m 05 s", a start time as "Today 14:02", and what is wrong with a
// workflow before it is saved (the same rules the server's readWorkflow applies, said the
// way the editor's save state says them). Pure functions, tested; nothing here renders.
import {
  type ControlActivity,
  type MachineControl,
  type StepRun,
  WORKFLOW_STEPS_MAX,
  WORKFLOW_TEXT_MAX,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from "@shared/api";
import { harnessMark } from "../../lib/format";

/** A run is still moving: its steps may change under the page. */
export const runLive = (r: Pick<WorkflowRun, "status">): boolean => r.status === "running" || r.status === "waiting";

/** A step's name: the one given, else its number ("Step 2"). */
export const stepName = (step: Pick<WorkflowStep, "name">, i: number): string => step.name?.trim() || `Step ${i + 1}`;

/** The agent of a step, in a person's words: "Claude Code · new session", or the session's
 *  title when the step prompts one (`title` looks it up; its key's harness otherwise). */
export function agentWords(step: Pick<WorkflowStep, "agent">, title?: (key: string) => string | undefined): string {
  if ("harness" in step.agent) return `${harnessMark(step.agent.harness).label} · new session`;
  const t = title?.(step.agent.session);
  return t ?? harnessMark(step.agent.session.split(":")[0] ?? "").label;
}

/** The harness a step runs on. */
export const stepHarness = (step: Pick<WorkflowStep, "agent">): string =>
  "harness" in step.agent ? step.agent.harness : (step.agent.session.split(":")[0] ?? "");

/** The steps a step runs after, as the plan reads it: `after` as given, else the one
 *  before it (none for the first). */
export function afterOf(plan: readonly Pick<WorkflowStep, "id" | "after">[], i: number): string[] {
  const s = plan[i]!;
  if (s.after) return s.after;
  return i > 0 ? [plan[i - 1]!.id] : [];
}

/** "after Review", "after Implement and Review"; "" for a root. */
export function afterWords(plan: readonly WorkflowStep[], i: number): string {
  const names = afterOf(plan, i).map((id) => {
    const j = plan.findIndex((s) => s.id === id);
    return j >= 0 ? stepName(plan[j]!, j) : id;
  });
  if (!names.length) return "";
  if (names.length === 1) return `after ${names[0]}`;
  return `after ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "40 s", "2 m 05 s", "1 h 05 m": a finished span, the spec's grammar for one. */
export function durExact(msTotal: number | undefined): string {
  if (msTotal === undefined || Number.isNaN(msTotal)) return "";
  const s = Math.max(0, Math.round(msTotal / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${String(s % 60).padStart(2, "0")} s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")} m`;
  return `${Math.floor(h / 24)} d`;
}

/** "Today 14:02", "Yesterday 09:10", "12 Oct". */
export function startedLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `Today ${hm}`;
  if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return `Yesterday ${hm}`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const spanOf = (run: Pick<WorkflowRun, "startedAt" | "endedAt">): number | undefined =>
  run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : undefined;

/** The step running right now (sent, else sending), by plan order. */
export function runningStep(run: WorkflowRun): { step: WorkflowStep; i: number } | null {
  for (const status of ["sent", "sending", "ready"] as const) {
    const i = run.plan.findIndex((s) => run.steps[s.id]?.status === status);
    if (i >= 0) return { step: run.plan[i]!, i };
  }
  return null;
}

/** The first step that failed, by plan order. */
export function failedStep(run: WorkflowRun): { step: WorkflowStep; i: number } | null {
  const i = run.plan.findIndex((s) => run.steps[s.id]?.status === "failed");
  return i >= 0 ? { step: run.plan[i]!, i } : null;
}

/** The machine a waiting run waits for: the first ready step's. */
export function waitedMachine(run: WorkflowRun, name: (machineId: string) => string | undefined): string {
  const i = run.plan.findIndex((s) => run.steps[s.id]?.status === "ready");
  const id = i >= 0 ? run.plan[i]!.machineId : undefined;
  return (id && name(id)) || "the machine";
}

/** A run's state as a list row says it (UX-SPEC §4.2's table). `tone` is the one accent:
 *  `needs` only for "waiting for a signer". */
export function runRowWords(
  run: WorkflowRun,
  machineName: (machineId: string) => string | undefined,
): { text: string; tone?: "needs" } {
  switch (run.status) {
    case "running": {
      const r = runningStep(run);
      return { text: r ? `running · ${stepName(r.step, r.i)}` : "running" };
    }
    case "waiting":
      return run.waitingFor === "machine"
        ? { text: `waiting for ${waitedMachine(run, machineName)}` }
        : { text: "waiting for a signer", tone: "needs" };
    case "done":
      return { text: `done in ${durExact(spanOf(run))}` };
    case "failed": {
      const f = failedStep(run);
      return { text: f ? `failed at ${stepName(f.step, f.i)}` : "failed" };
    }
    case "cancelled": {
      const n = Object.values(run.steps).filter((s) => s.status === "skipped").length;
      return { text: n ? `cancelled · ${n} ${n === 1 ? "step" : "steps"} skipped` : "cancelled" };
    }
  }
}

/** The bar's meta for a run (UX-SPEC §4.3): the live "started 2 m ago" is the view's to
 *  tick, so a running run gives its prefix and the view appends the time. */
export function runMetaWords(
  run: WorkflowRun,
  machineName: (machineId: string) => string | undefined,
): { text: string; tone?: "needs"; live?: boolean } {
  if (run.status === "running") return { text: "running · started", live: true };
  return runRowWords(run, machineName);
}

/** The glyph a run's row carries: the only mark of its state. */
export type RunGlyph = "spinner" | "done" | "failed" | "cancelled" | "needs";
export function runGlyph(run: Pick<WorkflowRun, "status" | "waitingFor">): RunGlyph {
  switch (run.status) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "waiting":
      return run.waitingFor === "signer" ? "needs" : "spinner";
    default:
      return "spinner";
  }
}

/** The names of the failed steps a skipped step waited on, "Review failed". */
function skippedBecause(run: WorkflowRun, i: number): string {
  const seen = new Set<string>();
  const walk = (j: number): string | null => {
    for (const id of afterOf(run.plan, j)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const k = run.plan.findIndex((s) => s.id === id);
      if (k < 0) continue;
      const st = run.steps[id]?.status;
      if (st === "failed") return `${stepName(run.plan[k]!, k)} failed`;
      if (st === "skipped") {
        const deeper = walk(k);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  return walk(i) ?? "cancelled";
}

export type StepGlyph = "idle" | "needs" | "spinner" | "done" | "failed" | "skipped";

/** A step's row (UX-SPEC §4.3's table): its glyph, its right column, and its second line
 *  with the line's tone. The live "running 40 s" is the view's to tick (`live`). */
export function stepRowWords(
  run: WorkflowRun,
  i: number,
  o: {
    machineName: (machineId: string) => string | undefined;
    /** The activity of the step's command, when the page knows it. */
    activity?: ControlActivity;
    /** The activity's status line (control/words.ts sentLine), when there is one. */
    sentLine?: string | null;
    /** The activity's failure (control/words.ts startFailureWords / promptFailureWords). */
    failureWords?: string | null;
    /** This page can sign but holds no grant yet: the signer line offers Unlock now. */
    needsUnlock?: boolean;
    /** This page could sign, but the run was not started here (mine.ts): the signer line
     *  offers Sign here. */
    elsewhere?: boolean;
    /** This page could sign, but the step's machine trusts none of its keys. */
    untrusted?: boolean;
    /** Why this page cannot sign the step as written (runner.ts unsignable), after the
     *  machine's name: "doesn't offer read for Claude Code". */
    unsignable?: string | null;
  },
): { glyph: StepGlyph; right: string; live?: boolean; second?: string; tone?: "needs" | "err" } {
  const step = run.plan[i]!;
  const s: StepRun = run.steps[step.id] ?? { status: "pending" };
  const machine = o.machineName(step.machineId) ?? "the machine";
  switch (s.status) {
    case "pending":
      return { glyph: "idle", right: afterWords(run.plan, i) };
    case "ready":
      if (run.status === "waiting" && run.waitingFor === "machine")
        return { glyph: "idle", right: "", second: `Waiting for ${machine}. It sends when the machine is back.` };
      if (o.unsignable)
        return {
          glyph: "needs",
          right: "",
          second: `${machine} ${o.unsignable}. Change the step and run it again.`,
          tone: "err",
        };
      if (run.status === "waiting" && run.waitingFor === "signer")
        return {
          glyph: "needs",
          right: "",
          second: o.needsUnlock
            ? "Waiting for your passkey."
            : o.untrusted
              ? `Waiting for a signer. ${machine} trusts no passkey from this browser.`
              : o.elsewhere
                ? "Waiting for a signer. This run was started elsewhere."
                : "Waiting for a signer. Open this page on a device that can sign.",
          tone: "needs",
        };
      return { glyph: "idle", right: "starting…" };
    case "sending":
      return { glyph: "spinner", right: "sending…" };
    case "sent":
      return { glyph: "spinner", right: "running", live: true, second: o.sentLine ?? undefined };
    case "done":
      return {
        glyph: "done",
        right: durExact(s.sentAt && s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.sentAt) : undefined),
      };
    case "failed":
      return { glyph: "failed", right: "failed", second: o.failureWords ?? s.error ?? undefined, tone: "err" };
    case "skipped":
      return {
        glyph: "skipped",
        right: `skipped · ${run.status === "cancelled" ? "cancelled" : skippedBecause(run, i)}`,
      };
  }
}

// ----- the editor: what is wrong with a workflow, before the server says ------------

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** The ids of the steps a step runs after, transitively (the ones whose reply it may name). */
function ancestors(plan: readonly WorkflowStep[], id: string): Set<string> {
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

/** Why the workflow cannot be saved as it is, in the save state's words ("Couldn't save:
 *  <this>"), or null. The server's readWorkflow applies the same rules; these are the
 *  ones a person can trip while editing, said first and in the editor's own words. */
export function saveProblem(w: Pick<Workflow, "input" | "steps" | "name">): string | null {
  if (!w.name.trim()) return "the workflow needs a name";
  if (w.steps.length === 0) return "add a step first";
  if (w.steps.length > WORKFLOW_STEPS_MAX) return `up to ${WORKFLOW_STEPS_MAX} steps`;
  for (let i = 0; i < w.steps.length; i++) {
    const s = w.steps[i]!;
    const n = i + 1;
    if (!ID_RE.test(s.id)) return `step ${n} has no id`;
    if (w.steps.findIndex((x) => x.id === s.id) !== i) return `step ${n}'s id is used twice`;
    if (!s.machineId) return `step ${n} needs a machine`;
    if (!s.text.trim()) return `step ${n} needs a prompt`;
    if (s.text.length > WORKFLOW_TEXT_MAX)
      return `step ${n}'s prompt is over ${WORKFLOW_TEXT_MAX.toLocaleString()} characters`;
    if (s.after) {
      for (const id of s.after) {
        if (id === s.id) return `step ${n} can't run after itself`;
        const j = w.steps.findIndex((x) => x.id === id);
        if (j < 0 || j >= i) return `step ${n} can only run after a step above it`;
      }
    }
    if ("session" in s.agent && (s.permission || s.model)) return `step ${n} prompts a session, which takes no options`;
    const before = ancestors(w.steps, s.id);
    for (const m of s.text.matchAll(PLACEHOLDER)) {
      const raw = m[1]!.trim();
      if (raw === "input") {
        if (!w.input) return `step ${n} names {{input}}, but the workflow takes none`;
        continue;
      }
      if (raw === "prev") {
        if (afterOf(w.steps, i).length === 0) return `step ${n} names {{prev}}, but nothing runs before it`;
        continue;
      }
      const st = /^step\.([A-Za-z0-9_-]{1,40})$/.exec(raw);
      if (!st) return `step ${n} names {{${raw}}}, which isn't a placeholder`;
      if (!w.steps.some((x) => x.id === st[1])) return `step ${n} names {{step.${st[1]}}}, which there isn't`;
      if (!before.has(st[1]!)) return `step ${n} names {{step.${st[1]}}}, which doesn't run before it`;
    }
  }
  return null;
}

/** The error a server refusal reads as, after "Couldn't save: ". */
export function serverSaveWords(e: unknown): string {
  const err = e as { status?: number; reason?: string; error?: string; message?: string };
  if (err?.reason === "too_large" && err.error) return err.error.replace(/^at most/, "up to");
  if (err?.reason === "too_many") return err.error ?? "too many workflows";
  if (err?.error) return err.error;
  if (err?.status === 401) return "this page lost its key; reload it from the terminal's link";
  return err?.message ?? "the server didn't answer";
}

/** A workflow id for a new document: a slug of its name and a short random tail. */
export function newWorkflowId(
  name: string,
  random: () => string = () => Math.random().toString(36).slice(2, 8),
): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const id = `${slug || "workflow"}-${random()}`;
  return id.slice(0, 40);
}

/** A step id a new step gets: a slug of its name, unique in the plan. */
export function newStepId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "step";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

/** The machine's name for an id, from the paired machines. */
export const machineNameOf =
  (machines: readonly { name: string; control?: Pick<MachineControl, "machineId"> }[]) =>
  (machineId: string): string | undefined =>
    machines.find((m) => m.control?.machineId === machineId)?.name;
