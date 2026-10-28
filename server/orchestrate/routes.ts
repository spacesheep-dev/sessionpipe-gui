// SPDX-License-Identifier: Apache-2.0
// /api/ui/workflows/* (ROUTES.ui.workflows; ARCHITECTURE.md "UI API"): the saved
// workflows and their runs, behind the UI guard like every /api/ui route. Writes take JSON
// only (the content type forces a CORS preflight this server never answers, so a page on
// another origin cannot drive a run through the loopback-is-trusted rule). A run's PATCH
// carries `If-Match: <rev>`: the claim is the idempotency guard across tabs, and 412
// `conflict` (with the run as it is now) is the word that another tab has it, or that the
// run moved on.
import { ROUTES, type RunBody, type WorkflowRun } from "../../shared/api.js";
import type { Ctx, Handler, Reply, Router } from "../http/router.js";
import type { Orchestrate } from "./index.js";
import { RunError } from "./runs.js";
import { ID_RE, WorkflowError } from "./store.js";

/** A workflow's longest body: WORKFLOW_STEPS_MAX steps of WORKFLOW_TEXT_MAX, and some. */
const BODY_MAX = 1024 * 1024;

const runReply = (run: WorkflowRun, status = 200): Reply => ({
  status,
  json: run,
  headers: { "cache-control": "no-store", etag: `"${run.rev}"` },
});

/** `If-Match: 3` or `If-Match: "3"` → 3; null when absent or not a number. */
export function readIfMatch(ctx: Ctx): number | null {
  const raw = ctx.req.headers["if-match"];
  const v = (Array.isArray(raw) ? raw[0] : raw)
    ?.trim()
    .replace(/^W\//, "")
    .replace(/^"(.*)"$/, "$1");
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  return Number(v);
}

export function registerOrchestrate(router: Router, svc: Orchestrate, guard: (h: Handler) => Handler): void {
  const base = ROUTES.ui.workflows;
  const jsonOnly = (ctx: Ctx): Reply | null => {
    const type = String(ctx.req.headers["content-type"] ?? "");
    if (!/^application\/json\b/i.test(type)) return { status: 415, json: { reason: "json_only" } };
    const announced = Number(ctx.req.headers["content-length"]);
    if (Number.isFinite(announced) && announced > BODY_MAX) return { status: 413, json: { reason: "too_large" } };
    return null;
  };
  const body = async <T>(ctx: Ctx): Promise<T | Reply> => {
    const refused = jsonOnly(ctx);
    if (refused) return refused;
    try {
      return await ctx.json<T>(BODY_MAX);
    } catch (e) {
      const status = (e as { status?: number }).status;
      return status === 413
        ? { status: 413, json: { reason: "too_large" } }
        : { status: 400, json: { reason: "malformed" } };
    }
  };
  const isReply = (v: unknown): v is Reply => !!v && typeof v === "object" && "status" in v && "json" in v;
  const id = (v: string | undefined): string | Reply =>
    v && ID_RE.test(v)
      ? v
      : { status: 400, json: { reason: "bad_id", error: "An id is 1 to 40 letters, digits, _ or -." } };
  const refusal = (e: unknown): Reply => {
    if (e instanceof WorkflowError) return { status: e.status, json: { reason: e.reason, error: e.error } };
    if (e instanceof RunError) return { status: e.status, json: { reason: e.reason, error: e.why } };
    throw e;
  };

  router.get(
    base,
    guard(() => ({
      status: 200,
      json: { workflows: svc.workflows(), runs: svc.runs() },
      headers: { "cache-control": "no-store" },
    })),
  );

  router.add(
    "PUT",
    `${base}/:id`,
    guard(async (ctx): Promise<Reply> => {
      const wid = id(ctx.params.id);
      if (typeof wid !== "string") return wid;
      const doc = await body<unknown>(ctx);
      if (isReply(doc)) return doc;
      try {
        return { status: 200, json: svc.saveWorkflow(wid, doc) };
      } catch (e) {
        return refusal(e);
      }
    }),
  );

  router.add(
    "DELETE",
    `${base}/:id`,
    guard((ctx): Reply => {
      const wid = id(ctx.params.id);
      if (typeof wid !== "string") return wid;
      if (!svc.deleteWorkflow(wid)) return { status: 404, json: { reason: "not_found" } };
      return { status: 204, text: "" };
    }),
  );

  router.post(
    `${base}/:id/run`,
    guard(async (ctx): Promise<Reply> => {
      const wid = id(ctx.params.id);
      if (typeof wid !== "string") return wid;
      // An empty body starts a run with no input.
      const announced = Number(ctx.req.headers["content-length"]);
      let input: unknown;
      if (announced > 0 || ctx.req.headers["transfer-encoding"]) {
        const b = await body<RunBody>(ctx);
        if (isReply(b)) return b;
        if (!b || typeof b !== "object" || Array.isArray(b)) return { status: 400, json: { reason: "malformed" } };
        input = b.input;
      }
      try {
        return runReply(svc.startRun(wid, input), 201);
      } catch (e) {
        return refusal(e);
      }
    }),
  );

  // The signer's two moves: a claim ({ step, status: "sending" }) and the command it queued
  // ({ step, commandId }), each against the run's rev.
  router.add(
    "PATCH",
    `${base}/runs/:id`,
    guard(async (ctx): Promise<Reply> => {
      const rid = id(ctx.params.id);
      if (typeof rid !== "string") return rid;
      const b = await body<{ step?: unknown; status?: unknown; commandId?: unknown }>(ctx);
      if (isReply(b)) return b;
      if (!b || typeof b !== "object" || typeof b.step !== "string" || !ID_RE.test(b.step))
        return {
          status: 400,
          json: { reason: "malformed", error: 'Send { step, status: "sending" } or { step, commandId }.' },
        };
      const rev = readIfMatch(ctx);
      if (rev === null)
        return { status: 428, json: { reason: "precondition_required", error: "Send If-Match with the run's rev." } };
      const run = svc.run(rid);
      if (!run) return { status: 404, json: { reason: "not_found" } };
      try {
        if (b.status === "sending" && b.commandId === undefined) return runReply(svc.claim(rid, b.step, rev));
        if (typeof b.commandId === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(b.commandId) && b.status === undefined)
          return runReply(svc.sent(rid, b.step, b.commandId, rev));
        return {
          status: 400,
          json: { reason: "malformed", error: 'Send { step, status: "sending" } or { step, commandId }.' },
        };
      } catch (e) {
        if (e instanceof RunError && e.status === 412) {
          const current = svc.run(rid) ?? run;
          return {
            status: 412,
            json: { reason: "conflict", error: e.why, run: current },
            headers: { "cache-control": "no-store", etag: `"${current.rev}"` },
          };
        }
        return refusal(e);
      }
    }),
  );

  router.post(
    `${base}/runs/:id/cancel`,
    guard((ctx): Reply => {
      const rid = id(ctx.params.id);
      if (typeof rid !== "string") return rid;
      try {
        return runReply(svc.cancel(rid));
      } catch (e) {
        return refusal(e);
      }
    }),
  );

  router.add(
    "DELETE",
    `${base}/runs/:id`,
    guard((ctx): Reply => {
      const rid = id(ctx.params.id);
      if (typeof rid !== "string") return rid;
      if (!svc.deleteRun(rid)) return { status: 404, json: { reason: "not_found" } };
      return { status: 204, text: "" };
    }),
  );
}
