// SPDX-License-Identifier: Apache-2.0
// The machine wire of HTTP.md §3: pair and its status (sink token or poll key), then
// hello, the long-poll, acks and off, each with the machine's own token and nothing
// else. A sink token on a machine call is 401, a machine token anywhere else is 401.
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Ctx, Reply, Router } from "../http/router.js";
import { HttpError } from "../http/router.js";
import { CODE_RE, MACHINE_RE, POLL_KEY_RE, parseAcks, parseHello } from "./parse.js";
import { type ControlState, keyOf, type MachineRow, type MessageRow, WAIT_MAX_S } from "./state.js";

export interface MachineRouteDeps {
  state: ControlState;
  sinkToken: () => string;
  /** ROUTES.control */
  base: string;
}

/** Equal secrets, in constant time whatever their lengths. */
export function secretEquals(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

const unauthorized = (error: string) => new HttpError(401, { reason: "unauthorized", error });
const notFound = () => new HttpError(404, { reason: "not_found" });

/** The origin a machine reached us on, for the pairing url the terminal prints and the
 *  WebAuthn origin check. Through a trusted proxy (ctx.remote.forwarded) the proxy's
 *  X-Forwarded-Host and -Proto name the origin the browser saw. */
export function requestOrigin(ctx: Ctx): string {
  const h = ctx.req.headers;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
  const host = (ctx.remote.forwarded ? one(h["x-forwarded-host"]) : undefined) ?? h.host;
  const proto = one(h["x-forwarded-proto"]) === "https" ? "https" : "http";
  return host ? `${proto}://${host}` : "http://localhost";
}

/** The machine a bearer belongs to; 401 for any other bearer (the daemon then stops polling). */
export function machineGate(state: ControlState, ctx: Ctx): MachineRow {
  const m = state.machineByToken(ctx.bearer());
  if (!m) throw unauthorized("Not this machine's token. Run `sessionpipe control pair` again.");
  return m;
}

/** control-poll.json: the carried command, byte for byte, with its signature parts. */
export function wireMessage(m: MessageRow): Record<string, unknown> {
  return {
    id: m.id,
    cmd: m.cmd,
    ...(m.csig ? { csig: m.csig } : {}),
    ...(m.grant ? { grant: m.grant } : {}),
    ...(m.confirm ? { confirm: m.confirm } : {}),
    at: m.at,
    expires_at: m.expiresAt,
  };
}

export function registerMachineRoutes(router: Router, d: MachineRouteDeps): void {
  const { state, base } = d;

  // CONTROL.md §2 step 1 (and renewal, step 3; and open pairing).
  router.post(`${base}/pair`, async (ctx): Promise<Reply> => {
    const bearer = ctx.bearer();
    const body = await ctx.json<Record<string, unknown>>(64 * 1024);
    const facts = parseHello(body);
    if (!facts)
      throw new HttpError(400, {
        reason: "bad_request",
        error: "Send control-pair.json: name, harnesses, modes, version.",
      });
    let pollKey: string | undefined;
    if (bearer === undefined) {
      if (typeof body.poll_key !== "string" || !POLL_KEY_RE.test(body.poll_key))
        throw new HttpError(401, {
          reason: "token_required",
          error: "Pair with the sink token (--token), or send a poll_key for open pairing.",
        });
      pollKey = body.poll_key;
    } else if (!secretEquals(bearer, d.sinkToken())) {
      throw unauthorized("That is not this receiver's sink token.");
    }
    const existingId = typeof body.machine === "string" && MACHINE_RE.test(body.machine) ? body.machine : undefined;
    let m = existingId ? state.machine(existingId) : undefined;
    if (existingId && !m)
      throw new HttpError(404, {
        reason: "not_found",
        error: "This machine was forgotten here. Pair it again without its old id.",
      });
    if (m) state.applyFacts(m, facts);
    else m = state.createMachine(state.newMachineId(), facts);
    const p = state.startPairing(m, { fromIp: ctx.remote.ip, ...(pollKey ? { pollKey } : {}) });
    return {
      status: 201,
      json: {
        machine: m.id,
        code: p.code,
        url: `${requestOrigin(ctx)}/pair?code=${encodeURIComponent(p.code)}`,
        check: p.check,
        expires_at: p.expiresAt,
      },
    };
  });

  // CONTROL.md §2 step 3–4: the terminal asks how its pairing stands.
  router.get(`${base}/pair`, (ctx): Reply => {
    const code = ctx.url.searchParams.get("code") ?? "";
    const found = CODE_RE.test(code) ? state.findPairing(code) : undefined;
    if (!found) throw notFound();
    const { machine, pairing } = found;
    const bearer = ctx.bearer();
    const allowed = secretEquals(bearer, d.sinkToken()) || (pairing.open && state.pollKeyMatches(pairing, bearer));
    if (!allowed) throw unauthorized("The pairing's sink token or poll_key, please.");
    if (pairing.deliveredAt) throw notFound();
    if (!pairing.approved)
      return {
        status: 200,
        json: { status: Date.parse(pairing.expiresAt) > Date.now() ? "pending" : "expired" },
        headers: { "cache-control": "no-store" },
      };
    const { key, proof, by } = pairing.approved;
    const out: Record<string, unknown> = {
      status: "paired",
      // The whole key: a device key keeps its type, store and uv, or the machine would
      // store it as a passkey and refuse every signature it makes (CONTROL.md §2).
      key: keyOf(key),
      proof,
    };
    // The machine's own token, minted once, at its first pairing (§2 step 4). A second
    // key added later leaves the token as it is.
    if (!machine.tokenHash) out.token = state.mintToken(machine);
    if (pairing.open) {
      out.sink_token = d.sinkToken();
      out.account = by;
    }
    state.markDelivered(pairing);
    return { status: 200, json: out, headers: { "cache-control": "no-store" } };
  });

  router.post(`${base}/hello`, async (ctx): Promise<Reply> => {
    const m = machineGate(state, ctx);
    const h = parseHello(await ctx.json(256 * 1024));
    if (!h) throw new HttpError(400, { reason: "bad_request", error: "Send control-hello.json." });
    state.hello(m, h);
    return { status: 204 };
  });

  // The long-poll: 200 with every message waiting, 204 after `wait` seconds of nothing.
  router.get(base, async (ctx): Promise<Reply | undefined> => {
    const machine = ctx.url.searchParams.get("machine") ?? "";
    if (!MACHINE_RE.test(machine)) throw new HttpError(400, { reason: "bad_request", error: "Which machine?" });
    const m = machineGate(state, ctx);
    if (m.id !== machine) throw unauthorized("That token belongs to another machine.");
    const asked = Number(ctx.url.searchParams.get("wait") ?? WAIT_MAX_S);
    const wait = Math.max(0, Math.min(Number.isFinite(asked) ? asked : WAIT_MAX_S, WAIT_MAX_S));
    const gone = new AbortController();
    const onClose = () => gone.abort();
    ctx.res.on("close", onClose);
    const messages = await state.poll(m, wait * 1000, gone.signal);
    ctx.res.off("close", onClose);
    if (gone.signal.aborted) return undefined;
    if (!messages.length) return { status: 204, headers: { "cache-control": "no-store" } };
    return { status: 200, json: { messages: messages.map(wireMessage) }, headers: { "cache-control": "no-store" } };
  });

  router.post(`${base}/ack`, async (ctx): Promise<Reply> => {
    const m = machineGate(state, ctx);
    const acks = parseAcks(await ctx.json(4 * 1024 * 1024), () => new Date().toISOString());
    if (!acks) throw new HttpError(400, { reason: "bad_request", error: "Send control-ack.json." });
    return { status: 202, json: state.ack(m, acks) };
  });

  // HTTP.md §3: a file a start names, by its hash, to a machine paired here (one account
  // per GUI). 404 when it is not held: never uploaded, or expired.
  router.get(`${base}/files/:sha`, (ctx): Reply | undefined => {
    machineGate(state, ctx);
    const f = state.files.get(ctx.params.sha ?? "");
    if (!f) throw notFound();
    ctx.res.writeHead(200, {
      "content-type": f.type,
      "content-length": String(f.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(f.path).pipe(ctx.res);
    return undefined;
  });

  router.post(`${base}/off`, (ctx): Reply => {
    const m = machineGate(state, ctx);
    state.removeMachine(m.id);
    return { status: 204 };
  });
}
