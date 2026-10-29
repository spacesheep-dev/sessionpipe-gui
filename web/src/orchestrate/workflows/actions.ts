// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. What a workflow's and a run's menus do, built once so the
// list, the editor and the run view act the same (UX-SPEC §4.1–4.3): run (asking for the
// input when the workflow names one, then the run's page), duplicate, rename, delete (with
// its runs, as the confirm promises), cancel a run (and stop its running steps, when the
// person keeps that option), delete a run. Each returns when it is done, and says a
// refusal through the toast stack's error toast, never silently.
import { type MachineSummary, type SessionKey, splitKey, type Workflow, type WorkflowRun } from "@shared/api";
import { confirmAction } from "../../components/ContextMenu";
import { rpId } from "../../control/api";
import { sendCommand } from "../../control/command";
import { harnessMark } from "../../lib/format";
import { absoluteUrl, copyText } from "../../lib/menus";
import { navigate } from "../../lib/router";
import { pushToast } from "../../lib/toasts";
import { workflowsApi } from "./api";
import { askCancel, askInput } from "./dialogs";
import { forgetMine, markMine } from "./mine";
import { applyRun, draft, dropRun, dropWorkflow, putDraft, putWorkflow, workflowsState } from "./state";
import { newWorkflowId, runLive, stepName } from "./words";

export const workflowPath = (id: string): string => `/workflows/${encodeURIComponent(id)}`;
export const runPath = (id: string): string => `/workflows/runs/${encodeURIComponent(id)}`;
/** The editor on a fresh copy of a template, or on a new workflow. */
export const newWorkflowPath = (template?: string): string =>
  template ? `/workflows/new?template=${encodeURIComponent(template)}` : "/workflows/new";

const said = (title: string, body?: string): void =>
  pushToast({
    id: `wf-err|${Date.now()}`,
    kind: "error",
    sticky: false,
    title,
    verb: "Couldn't",
    label: "error",
    body,
    at: Date.now(),
  });

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Run: the input first when the workflow names one, then the run's page. A workflow that
 *  is not saved yet (a draft) is saved first by the editor, which calls this after. */
export async function runWorkflow(w: Workflow): Promise<void> {
  let input: string | undefined;
  if (w.input) {
    const typed = await askInput({ title: `Run ${w.name}`, label: w.input.label, action: "Run" });
    if (typed === null) return;
    input = typed;
  }
  try {
    const run = await workflowsApi.run(w.id, input !== undefined ? { input } : {});
    markMine(run.id);
    applyRun(run);
    navigate(runPath(run.id));
  } catch (e) {
    said(`Couldn't run ${w.name}`, words(e));
  }
}

/** Run again: the same input, a new run. */
export async function runAgain(run: WorkflowRun): Promise<void> {
  try {
    const next = await workflowsApi.run(run.workflowId, run.input !== undefined ? { input: run.input } : {});
    markMine(next.id);
    applyRun(next);
    navigate(runPath(next.id));
  } catch (e) {
    said(`Couldn't run ${run.name} again`, words(e));
  }
}

/** A copy, unsaved, in the editor. */
export function duplicateWorkflow(w: Workflow): void {
  const now = new Date().toISOString();
  const name = `${w.name} copy`;
  const copy: Workflow = {
    ...w,
    id: newWorkflowId(name),
    name,
    steps: w.steps.map((s) => ({ ...s })),
    createdAt: now,
    updatedAt: now,
  };
  putDraft(copy);
  navigate(workflowPath(copy.id));
}

export async function renameWorkflow(w: Workflow): Promise<void> {
  const name = await askInput({ title: "Rename", label: "Name", initial: w.name, action: "Rename" });
  if (name === null || name === w.name) return;
  const next = { ...w, name };
  if (draft(w.id)) {
    putDraft(next);
    return;
  }
  try {
    putWorkflow(await workflowsApi.save(next));
  } catch (e) {
    said(`Couldn't rename ${w.name}`, words(e));
  }
}

/** Delete, after the confirm; its runs go with it, as the confirm says. */
export async function deleteWorkflow(w: Workflow, o: { leave?: boolean } = {}): Promise<boolean> {
  const ok = await confirmAction({
    title: `Delete ${w.name}?`,
    body: "Its runs are deleted too.",
    action: "Delete",
    danger: true,
  });
  if (!ok) return false;
  try {
    if (draft(w.id)) putDraft({ ...w, steps: [] });
    else await workflowsApi.remove(w.id);
    dropWorkflow(w.id);
    for (const r of workflowsState().runs.filter((r) => r.workflowId === w.id)) {
      try {
        await workflowsApi.removeRun(r.id);
      } catch {
        // a run already gone
      }
      dropRun(r.id);
      forgetMine(r.id);
    }
    if (o.leave) navigate("/workflows");
    return true;
  } catch (e) {
    said(`Couldn't delete ${w.name}`, words(e));
    return false;
  }
}

export const copyWorkflowLink = (id: string): Promise<void> => copyText(absoluteUrl(workflowPath(id)));
export const copyRunLink = (id: string): Promise<void> => copyText(absoluteUrl(runPath(id)));

/** The steps a cancel could also stop: sent, with a session, on a machine paired here. */
export function stoppableSteps(
  run: WorkflowRun,
  machines: readonly MachineSummary[],
): { stepId: string; name: string; session: SessionKey; machine: MachineSummary }[] {
  const out: { stepId: string; name: string; session: SessionKey; machine: MachineSummary }[] = [];
  run.plan.forEach((step, i) => {
    const s = run.steps[step.id];
    if (s?.status !== "sent" || !s.session) return;
    const machine = machines.find((m) => m.control?.machineId === step.machineId);
    if (!machine?.control) return;
    out.push({ stepId: step.id, name: stepName(step, i), session: s.session, machine });
  });
  return out;
}

/** Cancel a run: the confirm, the server's cancel, and a signed `cancel` for each running
 *  step the person chose to stop (offered, never required). */
export async function cancelRun(
  run: WorkflowRun,
  machines: readonly MachineSummary[],
  canStop: boolean,
): Promise<void> {
  if (!runLive(run)) return;
  const stoppable = canStop ? stoppableSteps(run, machines) : [];
  const option =
    stoppable.length === 1
      ? `Also stop ${stoppable[0]!.name} on ${stoppable[0]!.machine.name}`
      : stoppable.length > 1
        ? `Also stop ${stoppable.map((s) => s.name).join(", ")}`
        : undefined;
  const answer = await askCancel({
    title: "Cancel this run?",
    body: "Steps that haven't started are skipped.",
    option,
  });
  if (!answer) return;
  try {
    applyRun(await workflowsApi.cancel(run.id));
  } catch (e) {
    said(`Couldn't cancel ${run.name}`, words(e));
    return;
  }
  if (!answer.option) return;
  let rp: string;
  try {
    rp = await rpId();
  } catch {
    return;
  }
  for (const s of stoppable) {
    try {
      await sendCommand(rp, s.machine.control!.machineId, { kind: "cancel", session: s.session });
    } catch (e) {
      said(`Couldn't stop ${harnessMark(splitKey(s.session).harness).label} on ${s.machine.name}`, words(e));
    }
  }
}

export async function deleteRun(run: WorkflowRun, o: { leave?: string } = {}): Promise<boolean> {
  const ok = await confirmAction({
    title: "Delete this run?",
    body: "Its steps' sessions stay.",
    action: "Delete",
    danger: true,
  });
  if (!ok) return false;
  try {
    await workflowsApi.removeRun(run.id);
    dropRun(run.id);
    forgetMine(run.id);
    if (o.leave) navigate(o.leave);
    return true;
  } catch (e) {
    said(`Couldn't delete the run`, words(e));
    return false;
  }
}
