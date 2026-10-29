// SPDX-License-Identifier: Apache-2.0
// /api/ui/workflows/* (ROUTES.ui.workflows; ARCHITECTURE.md "UI API"): the saved
// workflows and their runs, behind the UI guard like every /api/ui route. A write here
// sets a signer to work (a run's ready steps are what the owner's open tab signs), so
// every one of them, body or not, takes JSON only (the content type forces a CORS
// preflight this server never answers) and refuses a request a browser marks as coming
// from another site (`Sec-Fetch-Site: cross-site`, or an `Origin` of `null`): a page on
// another origin cannot start or cancel a run through the loopback-is-trusted rule, not
// even with an empty POST. A run's PATCH carries `If-Match: <rev>`: the claim is the
// idempotency guard across tabs, and 412 `conflict` (with the run as it is now) is the
// word that another tab has it, or that the run moved on. The signed command of a
// claimed step comes back through the same PATCH (`send`), queued only once the server
// has seen the step is still this claim's (index.ts).
import { ROUTES, type RunBody, type WorkflowRun } from "../../shared/api.js";
import { type Ctx, type Handler, HttpError, type Reply, type Router } from "../http/router.js";
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

/** Why a write is refused before anything is read: it came from another site (the browser
 *  says so; a native shell or a curl sends neither header), or it is not JSON (a DELETE
 *  carries no body, and is never a simple request: a cross-site one preflights, which
 *  this server never answers). Null when it may go on. */
export function writeProblem(ctx: Ctx): Reply | null {
  const site = String(ctx.req.headers["sec-fetch-site"] ?? "");
  const origin = String(ctx.req.headers.origin ?? "");
  if (site === "cross-site" || origin === "null") return { status: 403, json: { reason: "cross_site" } };
  if (ctx.req.method === "DELETE") return null;
  const type = String(ctx.req.headers["content-type"] ?? "");
  if (!/^application\/json\b/i.test(type)) return { status: 415, json: { reason: "json_only" } };
  const announced = Number(ctx.req.headers["content-length"]);
  if (Number.isFinite(announced) && announced > BODY_MAX) return { status: 413, json: { reason: "too_large" } };
  return null;
}

export function registerOrchestrate(
  router: Router,
  svc: Orchestrate,
  uiGuard: (h: Handler) => Handler,
  opts: { testDoor?: boolean } = {},
): void {
  const base = ROUTES.ui.workflows;
  const jsonOnly = writeProblem;
  /** Every write: the UI guard, then the write guard, before the handler reads a thing. */
  const guard = (h: Handler): Handler => uiGuard((ctx) => writeProblem(ctx) ?? h(ctx));
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
    uiGuard(() => ({
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
      // An empty body (JSON still announced) starts a run with no input.
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

  // The signer's two moves: a claim ({ step, status: "sending" }) and the command it signed
  // ({ step, send: <a /send body> }: verified, queued and marked sent here in one move), each
  // against the run's rev. { step, commandId } is the second move for a command queued
  // through /send itself (the test door; a page never does this: the command would run
  // even when the step is no longer this claim's).
  // `{ step, commandId }` binds a command queued through /send to a claimed step: the test
  // door's move (the e2e suite plays the signer that way), never a production route. Open,
  // any loopback caller could paste a delivered command's reply into a run's next prompts,
  // which the owner's tab then signs without asking (mine.ts).
  const MOVES = opts.testDoor
    ? 'Send { step, status: "sending" }, { step, send } or { step, commandId }.'
    : 'Send { step, status: "sending" } or { step, send }.';
  router.add(
    "PATCH",
    `${base}/runs/:id`,
    guard(async (ctx): Promise<Reply> => {
      const rid = id(ctx.params.id);
      if (typeof rid !== "string") return rid;
      const b = await body<{ step?: unknown; status?: unknown; commandId?: unknown; send?: unknown }>(ctx);
      if (isReply(b)) return b;
      if (!b || typeof b !== "object" || typeof b.step !== "string" || !ID_RE.test(b.step))
        return { status: 400, json: { reason: "malformed", error: MOVES } };
      const rev = readIfMatch(ctx);
      if (rev === null)
        return { status: 428, json: { reason: "precondition_required", error: "Send If-Match with the run's rev." } };
      const run = svc.run(rid);
      if (!run) return { status: 404, json: { reason: "not_found" } };
      try {
        if (b.status === "sending" && b.commandId === undefined && b.send === undefined)
          return runReply(svc.claim(rid, b.step, rev));
        if (b.send && typeof b.send === "object" && b.status === undefined && b.commandId === undefined)
          return runReply(await svc.send(rid, b.step, rev, b.send));
        if (
          opts.testDoor &&
          typeof b.commandId === "string" &&
          /^[0-9A-HJKMNP-TV-Z]{26}$/.test(b.commandId) &&
          b.status === undefined &&
          b.send === undefined
        )
          return runReply(svc.sent(rid, b.step, b.commandId, rev));
        return { status: 400, json: { reason: "malformed", error: MOVES } };
      } catch (e) {
        if (e instanceof RunError && e.status === 412) {
          const current = svc.run(rid) ?? run;
          return {
            status: 412,
            json: { reason: "conflict", error: e.why, run: current },
            headers: { "cache-control": "no-store", etag: `"${current.rev}"` },
          };
        }
        // The verifier's word on a signed command (a signer's fault), as /send gives it.
        if (e instanceof HttpError) return { status: e.status, json: e.body ?? { reason: "refused" } };
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
