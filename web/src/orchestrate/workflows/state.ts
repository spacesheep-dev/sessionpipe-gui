// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The page's copy of the workflows and their runs: read whole
// from GET /api/ui/workflows when the page opens and again after every snapshot (a
// reconnect may follow a restart), then kept by the stream's `workflowRun` frames (the
// whole run, `rev` bumped; one older than what is held changes nothing; `deleted` takes it
// away) and `workflows` frames (the whole list after a save or a delete). One tiny
// external store, so the runner (useRunner.ts) and the pages read the same runs. A save
// the page makes lands here at once, then the server's answer replaces it.
//
// The frames reach this module through `attachStore`: the app's Store (data/store.ts)
// hands every frame to `onMessage`, and the two kinds this page owns are read from there.
// Should the stream carry neither for a while, a live run is read again every POLL_MS, so
// a run still moves on the page.
import type { StreamMessage, Workflow, WorkflowRun } from "@shared/api";
import { useSyncExternalStore } from "react";
import type { Store } from "../../data/store";
import { workflowsApi } from "./api";
import { runLive } from "./words";

export interface WorkflowsState {
  workflows: readonly Workflow[];
  runs: readonly WorkflowRun[];
  /** The first read landed (or failed: `error`). */
  loaded: boolean;
  /** The last read's failure, in a sentence; null once one lands. */
  error: string | null;
}

let state: WorkflowsState = { workflows: [], runs: [], loaded: false, error: null };
const listeners = new Set<() => void>();
const commit = (next: WorkflowsState): void => {
  state = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const get = () => state;

export function useWorkflowsState(): WorkflowsState {
  return useSyncExternalStore(subscribe, get, get);
}
export const workflowsState = get;

const byStartedDesc = (a: WorkflowRun, b: WorkflowRun): number =>
  a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0;
const byUpdatedDesc = (a: Workflow, b: Workflow): number =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;

/** A run as a frame or an answer brought it: replaces the one held when its `rev` is not
 *  older; a run not held yet is added. */
export function applyRun(run: WorkflowRun): void {
  const held = state.runs.find((r) => r.id === run.id);
  if (held && held.rev > run.rev) return;
  const runs = held ? state.runs.map((r) => (r.id === run.id ? run : r)) : [run, ...state.runs];
  commit({ ...state, runs: [...runs].sort(byStartedDesc) });
}

export function dropRun(id: string): void {
  if (!state.runs.some((r) => r.id === id)) return;
  commit({ ...state, runs: state.runs.filter((r) => r.id !== id) });
}

/** The whole list, as a `workflows` frame or the first read brings it. */
export function setWorkflows(workflows: readonly Workflow[]): void {
  commit({ ...state, workflows: [...workflows].sort(byUpdatedDesc) });
}

/** One workflow, as the page saved it (then the server's answer, through the same door). */
export function putWorkflow(w: Workflow): void {
  const rest = state.workflows.filter((x) => x.id !== w.id);
  commit({ ...state, workflows: [w, ...rest].sort(byUpdatedDesc) });
}

export function dropWorkflow(id: string): void {
  if (!state.workflows.some((w) => w.id === id)) return;
  commit({ ...state, workflows: state.workflows.filter((w) => w.id !== id) });
}

/** A frame from the stream, for the two kinds this page owns; any other is ignored. */
export function applyFrame(m: StreamMessage): void {
  if (m.kind === "workflowRun") {
    if (m.deleted) dropRun(m.run.id);
    else applyRun(m.run);
  } else if (m.kind === "workflows") setWorkflows(m.workflows);
}

let reading: Promise<void> | null = null;
/** Read everything again. One read at a time; a second ask while one is out joins it. */
export function reload(): Promise<void> {
  if (reading) return reading;
  reading = workflowsApi
    .all()
    .then((r) => {
      // Runs the page moved past the read's copy (a frame between the two) keep their place.
      const runs = r.runs.map((run) => {
        const held = state.runs.find((x) => x.id === run.id);
        return held && held.rev > run.rev ? held : run;
      });
      commit({
        workflows: [...r.workflows].sort(byUpdatedDesc),
        runs: [...runs].sort(byStartedDesc),
        loaded: true,
        error: null,
      });
    })
    .catch((e: unknown) => {
      commit({ ...state, loaded: true, error: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

/** How often a live run is read again while no frame carries it. */
export const POLL_MS = 3000;

/** Follows the app's stream for this page's frames and reads everything again after
 *  each snapshot (the first, and every reconnect). Returns the function that detaches. */
export function attachStore(store: Store): () => void {
  const offFrames = store.onMessage(applyFrame);
  let lastSnapshot: string | null = null;
  const onStore = () => {
    const at = store.get().snapshotAt;
    if (at && at !== lastSnapshot) {
      lastSnapshot = at;
      void reload();
    }
  };
  onStore();
  const off = store.subscribe(onStore);
  const poll = setInterval(() => {
    if (document.visibilityState !== "visible" || !state.runs.some(runLive)) return;
    if (store.get().connection !== "live") return;
    void reload();
  }, POLL_MS);
  return () => {
    clearInterval(poll);
    off();
    offFrames();
  };
}

// ----- unsaved documents: a new workflow, a template's copy, a duplicate ------------

/** A workflow the editor holds before its first save (UX-SPEC §4.1: a template row opens
 *  the editor on a fresh copy, saved on first change). By id, for this page load only. */
const drafts = new Map<string, Workflow>();
export const putDraft = (w: Workflow): void => void drafts.set(w.id, w);
export const draft = (id: string): Workflow | undefined => drafts.get(id);
export const dropDraft = (id: string): void => void drafts.delete(id);
