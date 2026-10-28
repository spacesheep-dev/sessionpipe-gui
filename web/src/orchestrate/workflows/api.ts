// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The browser's side of /api/ui/workflows (server/orchestrate/
// routes.ts, ROUTES.ui.workflows): the saved workflows and their runs, a save, a run's
// start, and the signer's two moves on a run (a claim, then the signed command itself,
// which the server verifies, queues and marks sent in one move), each under `If-Match:
// <rev>`. Every write is JSON, an empty one too (the server takes nothing else, so no
// other site can make it). Errors by `reason`; a 412 carries the run as it is now, so the
// page resyncs from it instead of guessing; a 422 carries the verifier's `code`. Every URL
// goes through lib/net.ts.
import { ROUTES, type RunBody, type Workflow, type WorkflowRun } from "@shared/api";
import type { SendBody } from "../../control/api";
import { apiUrl } from "../../lib/net";

const BASE = ROUTES.ui.workflows;

/** A refusal from the server: the status, the body's `reason`, its sentence, on a 412 the
 *  run as the server holds it (`conflict`: another tab has the step, or the run moved on),
 *  and on a 422 the verifier's `code` (a `send`: the same words /send uses). */
export class WorkflowsError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly error?: string,
    readonly run?: WorkflowRun,
    readonly code?: string,
  ) {
    super(error ?? reason);
    this.name = "WorkflowsError";
  }
}

async function call<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // no body
  }
  if (!res.ok) {
    const reason = typeof json.reason === "string" ? json.reason : `http_${res.status}`;
    const error = typeof json.error === "string" ? json.error : undefined;
    const run = json.run && typeof json.run === "object" ? (json.run as WorkflowRun) : undefined;
    const code = typeof json.code === "string" ? json.code : undefined;
    throw new WorkflowsError(res.status, reason, error, run, code);
  }
  return json as T;
}

const enc = encodeURIComponent;

export const workflowsApi = {
  /** Everything: the saved workflows (newest updated first) and the runs (newest first). */
  all: () => call<{ workflows: Workflow[]; runs: WorkflowRun[] }>("GET", BASE),
  /** The whole document; the server answers with it as read (ids, times). */
  save: (w: Workflow) => call<Workflow>("PUT", `${BASE}/${enc(w.id)}`, w),
  remove: (id: string) => call<void>("DELETE", `${BASE}/${enc(id)}`),
  run: (id: string, body: RunBody) => call<WorkflowRun>("POST", `${BASE}/${enc(id)}/run`, body),
  /** The claim: the step is this tab's to sign. 412 `conflict` when another tab has it. */
  claim: (runId: string, step: string, rev: number) =>
    call<WorkflowRun>("PATCH", `${BASE}/runs/${enc(runId)}`, { step, status: "sending" }, { "if-match": String(rev) }),
  /** The command this tab signed for the step it claimed, as a /send body: the server
   *  verifies it, queues it and marks the step sent in one move, or refuses it with
   *  nothing queued (412 the step is no longer this claim's; 422 the signer's fault, by
   *  `code`). A refusal of the command itself comes back as the run, the step failed. */
  send: (runId: string, step: string, body: SendBody, rev: number) =>
    call<WorkflowRun>("PATCH", `${BASE}/runs/${enc(runId)}`, { step, send: body }, { "if-match": String(rev) }),
  cancel: (runId: string) => call<WorkflowRun>("POST", `${BASE}/runs/${enc(runId)}/cancel`, {}),
  removeRun: (runId: string) => call<void>("DELETE", `${BASE}/runs/${enc(runId)}`),
};
