// SPDX-License-Identifier: Apache-2.0
// What the board's browser calls under /api/ui/control/*: the pairings to approve, the
// approval itself (an enrollment proof the core verifier checks), sending a signed
// command (the verifier as the receiver's early word, §5), the activity, the machines,
// and device requests (a phone's own passkey, trusted once a device the machine already
// trusts signs a `key.add` for it, CONTROL.md §2). Every route needs the UI's own auth (loopback, or the UI key cookie).
// Documented route by route in README.md beside this file.
import { randomBytes } from "node:crypto";
import {
  type Assertion,
  b64url,
  keyUsable,
  pairChallenge,
  RECEIVER_MAX_AGE_MS,
  type SignedCommand,
  verifyCommand,
  verifyEnrollment,
} from "sessionpipe-core/control";
import { START_FILE_MAX_BYTES, type StartFile, type TrustedKey } from "../../shared/api.js";
import type { Ctx, Handler, Reply, Router } from "../http/router.js";
import { HttpError } from "../http/router.js";
import { MEDIA_TYPE_RE } from "./files.js";
import { CODE_RE, MACHINE_RE } from "./parse.js";
import { filesProblem, precheck } from "./precheck.js";
import { requestOrigin } from "./routes.js";
import {
  type ControlState,
  type DeviceRequestRow,
  type MachineRow,
  type PairingRow,
  type Proof,
  toActivity,
} from "./state.js";

export interface UiRouteDeps {
  state: ControlState;
  /** Read on every call: TLS mode turned on at runtime switches it. */
  rpId: () => string;
  uiAuth: (ctx: Ctx) => boolean;
  /** ROUTES.ui.control */
  base: string;
  /** Device keys are taken (devicekeys.ts); off, a device key or signature is a 400. */
  device: boolean;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
/** A device name as the phone typed it: printed on the approving page and kept by `control keys`. */
export const DEVICE_NAME_MAX = 40;

const b64 = (v: unknown, min: number, max: number) =>
  typeof v === "string" && v.length >= min && v.length <= max && B64URL_RE.test(v);

/** A key as a page sends it: a passkey `{id, alg, spki}`, or (`device`) a device key
 *  with `type`, `store` and `uv` (CONTROL.md §2). The shape only, and closed: whether a
 *  machine could use it is core's `keyUsable`. Null when it breaks the shape. */
export function readKey(v: unknown, device: boolean): TrustedKey | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const k = v as Record<string, unknown>;
  if (!b64(k.id, 16, 1400) || (k.alg !== -7 && k.alg !== -257) || !b64(k.spki, 40, 2000)) return null;
  const typed = k.type !== undefined;
  if (typed && !device) return null;
  const allowed = typed ? ["id", "alg", "spki", "type", "store", "uv"] : ["id", "alg", "spki"];
  if (Object.keys(k).some((f) => !allowed.includes(f))) return null;
  const key: TrustedKey = { id: k.id as string, alg: k.alg as number, spki: k.spki as string };
  if (typed) Object.assign(key, { type: k.type, store: k.store, uv: k.uv });
  return key;
}

/** A pairing proof as a page sends it: a passkey's assertion `{cred, ad, cd, sig}`, or
 *  (`device`) a device key's signature `{cred, sig}` (CONTROL.md §3.2). Null otherwise. */
export function readProof(v: unknown, device: boolean): Proof | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  const str = (x: unknown, max: number) => typeof x === "string" && x.length > 0 && x.length <= max;
  if (!str(p.cred, 1400) || !str(p.sig, 4000)) return null;
  if (device && p.ad === undefined && p.cd === undefined && Object.keys(p).length === 2)
    return { cred: p.cred as string, sig: p.sig as string };
  if (!str(p.ad, 8000) || !str(p.cd, 8000)) return null;
  return { cred: p.cred as string, ad: p.ad as string, cd: p.cd as string, sig: p.sig as string };
}

const keyShape = (device: boolean) => (device ? "key: {id, alg, spki[, type, store, uv]}" : "key: {id, alg, spki}");
const proofShape = (device: boolean) =>
  device ? "proof: {cred, ad, cd, sig} or {cred, sig}" : "proof: {cred, ad, cd, sig}";

/** A short label from the user agent, for the approving page ("iPhone"). */
export function deviceLabel(ua: string | undefined): string {
  const s = ua ?? "";
  if (/iPhone/.test(s)) return "iPhone";
  if (/iPad/.test(s)) return "iPad";
  if (/Android/.test(s)) return "Android phone";
  if (/Macintosh/.test(s)) return "Mac";
  if (/Windows/.test(s)) return "Windows PC";
  if (/Linux/.test(s)) return "Linux box";
  return "a browser";
}

/** What both ends read of a device request. The key travels too: the approving page puts
 *  it inside the signed command. */
export function deviceView(d: DeviceRequestRow) {
  return {
    requestId: d.requestId,
    check: d.check,
    key: d.key,
    name: d.name,
    device: d.device,
    fromIp: d.fromIp,
    createdAt: d.createdAt,
    expiresAt: d.expiresAt,
    status: d.status,
    ...(d.machineId ? { machineId: d.machineId } : {}),
    ...(d.activityId ? { activityId: d.activityId } : {}),
    ...(d.outcome ? { outcome: d.outcome } : {}),
    ...(d.code ? { code: d.code } : {}),
    ...(d.detail ? { detail: d.detail } : {}),
  };
}

export async function pairingView(machine: MachineRow, pairing: PairingRow, rpId: string) {
  const status = pairing.deliveredAt
    ? "done"
    : pairing.approved
      ? "approved"
      : Date.parse(pairing.expiresAt) > Date.now()
        ? "pending"
        : "expired";
  return {
    code: pairing.code,
    check: pairing.check,
    status,
    open: pairing.open,
    fromIp: pairing.fromIp,
    startedAt: pairing.startedAt,
    expiresAt: pairing.expiresAt,
    machine: {
      id: machine.id,
      name: machine.name,
      harnesses: machine.harnesses,
      modes: machine.modes,
      version: machine.version,
      ...(machine.folders ? { folders: machine.folders } : {}),
      ...(machine.mode ? { mode: machine.mode } : {}),
      ...(machine.accounts ? { accounts: machine.accounts } : {}),
      ...(machine.keyTypes ? { keyTypes: machine.keyTypes } : {}),
      firstPairing: !machine.tokenHash,
      keys: machine.keys.length,
    },
    rpId,
    /** What the passkey signs (CONTROL.md §2 step 2), base64url: pass it as the WebAuthn challenge. */
    challenge: b64url(await pairChallenge(machine.id, pairing.code)),
  };
}

export function registerUiRoutes(router: Router, d: UiRouteDeps): void {
  const { state, base } = d;
  const rpId = d.rpId;
  const takesDevice = d.device;
  const guarded =
    (h: Handler): Handler =>
    (ctx) => {
      if (!d.uiAuth(ctx)) throw new HttpError(401, { reason: "unauthorized" });
      return h(ctx);
    };
  const challenges = new Map<string, number>();

  router.get(
    `${base}/pairings`,
    guarded(
      async (): Promise<Reply> => ({
        status: 200,
        json: {
          pairings: await Promise.all(
            state.pendingPairings().map(({ machine, pairing }) => pairingView(machine, pairing, rpId())),
          ),
        },
      }),
    ),
  );

  router.get(
    `${base}/pair/:code`,
    guarded(async (ctx): Promise<Reply> => {
      const found = CODE_RE.test(ctx.params.code ?? "") ? state.findPairing(ctx.params.code!) : undefined;
      if (!found) throw new HttpError(404, { reason: "not_found" });
      return { status: 200, json: await pairingView(found.machine, found.pairing, rpId()) };
    }),
  );

  // A random challenge for a WebAuthn ceremony that has no deterministic one (making a
  // passkey with navigator.credentials.create()). Remembered five minutes.
  router.get(
    `${base}/challenge`,
    guarded((ctx): Reply => {
      const now = Date.now();
      for (const [c, t] of challenges) if (t < now) challenges.delete(c);
      const challenge = randomBytes(32).toString("base64url");
      challenges.set(challenge, now + CHALLENGE_TTL_MS);
      return {
        status: 200,
        json: {
          challenge,
          rpId: rpId(),
          origin: requestOrigin(ctx),
          expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
        },
      };
    }),
  );

  // CONTROL.md §2 step 2: the person confirmed the digits with a passkey. The proof is
  // the key's assertion over sha256("sessionpipe.pair:" + machine + ":" + code); only a
  // proof that verifies here goes to the daemon, which verifies it again.
  router.post(
    `${base}/pair/:code/approve`,
    guarded(async (ctx): Promise<Reply> => {
      const found = CODE_RE.test(ctx.params.code ?? "") ? state.findPairing(ctx.params.code!) : undefined;
      if (!found) throw new HttpError(404, { reason: "not_found" });
      const { machine, pairing } = found;
      if (pairing.approved || pairing.deliveredAt) throw new HttpError(409, { reason: "already_approved" });
      if (Date.parse(pairing.expiresAt) <= Date.now()) throw new HttpError(410, { reason: "expired" });
      const body = await ctx.json<{ key?: unknown; proof?: unknown; name?: unknown; by?: unknown }>(64 * 1024);
      const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
      const k = readKey(body.key, takesDevice);
      const p = readProof(body.proof, takesDevice);
      if (!k || !p)
        throw new HttpError(400, {
          reason: "bad_request",
          error: `Send { ${keyShape(takesDevice)}, ${proofShape(takesDevice)} }.`,
        });
      if (!(await keyUsable(k)))
        throw new HttpError(422, { reason: "bad_key", detail: "the key is in a shape no machine can use" });
      // A device proof gets here only when this core verifies one (devicekeys.ts).
      const v = await verifyEnrollment({
        machine: machine.id,
        code: pairing.code,
        key: k,
        proof: p as Assertion,
        rpId: rpId(),
      });
      if (!v.ok) throw new HttpError(422, { reason: "bad_proof", detail: v.why });
      const name = str(body.name, 80) ? (body.name as string).trim() : undefined;
      const by = str(body.by, 200) ? (body.by as string) : "sessionpipe-gui";
      state.approvePairing(
        machine,
        pairing,
        { ...k, addedAt: new Date().toISOString(), ...(name ? { name } : {}) },
        p,
        by,
      );
      return { status: 200, json: { ok: true, machineId: machine.id, keyId: k.id, firstPairing: !machine.tokenHash } };
    }),
  );

  // The pairing is dropped: the terminal's next status poll gets 404 and stops.
  router.post(
    `${base}/pair/:code/reject`,
    guarded((ctx): Reply => {
      const found = CODE_RE.test(ctx.params.code ?? "") ? state.findPairing(ctx.params.code!) : undefined;
      if (!found) throw new HttpError(404, { reason: "not_found" });
      state.dropPairing(found.machine, found.pairing);
      return { status: 204 };
    }),
  );

  // CONTROL.md §2, "a trusted device vouches for a new one": a phone made its own passkey
  // and asks to be trusted. Nothing is trusted here: the request only waits for a device
  // the machine already trusts to sign a `key.add` carrying this key (through /send); the
  // machine's `delivered` ack settles it (state.ts).
  router.post(
    `${base}/devices`,
    guarded(async (ctx): Promise<Reply> => {
      const body = await ctx.json<{ key?: unknown; name?: unknown }>(16 * 1024);
      const k = readKey(body.key, takesDevice);
      if (!k)
        throw new HttpError(400, {
          reason: "bad_request",
          error: `Send { ${keyShape(takesDevice)}, name? }: id and spki base64url, alg -7 or -257.`,
        });
      if (body.name !== undefined && (typeof body.name !== "string" || body.name.length > DEVICE_NAME_MAX))
        throw new HttpError(400, {
          reason: "bad_request",
          error: `name is text, at most ${DEVICE_NAME_MAX} characters.`,
        });
      if (!(await keyUsable(k)))
        throw new HttpError(422, { reason: "bad_key", detail: "the key is in a shape no machine can use" });
      const device = deviceLabel(ctx.req.headers["user-agent"]);
      const typed = typeof body.name === "string" ? body.name.trim() : "";
      const d = state.createDeviceRequest({ key: k, name: typed || device, device, fromIp: ctx.remote.ip });
      return { status: 201, json: deviceView(d) };
    }),
  );

  router.get(
    `${base}/devices`,
    guarded((): Reply => ({ status: 200, json: { devices: state.pendingDeviceRequests().map(deviceView) } })),
  );

  // The phone polls this until `added` (or `failed` / `expired`); a rejected request is 404.
  router.get(
    `${base}/devices/:id`,
    guarded((ctx): Reply => {
      const d = state.deviceRequest(ctx.params.id ?? "");
      if (!d) throw new HttpError(404, { reason: "not_found" });
      return { status: 200, json: deviceView(d), headers: { "cache-control": "no-store" } };
    }),
  );

  router.post(
    `${base}/devices/:id/reject`,
    guarded((ctx): Reply => {
      if (!state.dropDeviceRequest(ctx.params.id ?? "")) throw new HttpError(404, { reason: "not_found" });
      return { status: 204 };
    }),
  );

  // CONTROL.md §3, §5: the browser signed `cmd`; the verifier is our early word, against
  // the machine's enrolled keys, the exact bytes, with the receiver's ten-minute window.
  router.post(
    `${base}/send`,
    guarded(async (ctx): Promise<Reply> => {
      const body = await ctx.json<{
        machineId?: unknown;
        cmd?: unknown;
        csig?: unknown;
        grant?: unknown;
        confirm?: unknown;
        expires_in_s?: unknown;
      }>(256 * 1024);
      if (typeof body.machineId !== "string" || !MACHINE_RE.test(body.machineId))
        throw new HttpError(400, { reason: "bad_request", error: "Which machine?" });
      const m = state.machine(body.machineId);
      if (!m) throw new HttpError(404, { reason: "not_found", error: "No such machine." });
      if (typeof body.cmd !== "string")
        throw new HttpError(400, { reason: "bad_request", error: "cmd is the signed command string." });
      const signed: SignedCommand = { cmd: body.cmd };
      if (typeof body.csig === "string") signed.csig = body.csig;
      if (body.grant && typeof body.grant === "object") signed.grant = body.grant as SignedCommand["grant"];
      if (body.confirm && typeof body.confirm === "object") signed.confirm = body.confirm as SignedCommand["confirm"];
      const verdict = await verifyCommand(signed, {
        machine: m.id,
        rpId: rpId(),
        trusted: m.keys,
        now: Date.now(),
        maxAgeMs: RECEIVER_MAX_AGE_MS,
      });
      if (!verdict.ok) throw new HttpError(422, { reason: verdict.why, code: verdict.code });
      // The second look: what this machine's hello advertised (precheck.ts). The same
      // refusal shape, so the sheet shows the reason before anything is queued.
      const refused = precheck(JSON.parse(signed.cmd) as Record<string, unknown>, m, state.files);
      if (refused) throw new HttpError(422, { reason: refused.why, code: refused.code });
      const ttl = typeof body.expires_in_s === "number" && body.expires_in_s > 0 ? body.expires_in_s * 1000 : undefined;
      const row = state.enqueue(m, signed, verdict.cmd, { via: "ui", ...(ttl ? { expiresInMs: ttl } : {}) });
      return { status: 201, json: toActivity(row) };
    }),
  );

  // One file a start will carry (CONTROL.md §3.1, HTTP.md §3): the raw bytes, the file's
  // media type as content-type, its name in `?name=`. Held a day under its SHA-256 (files.ts);
  // the answer is the entry the signed command names. Nothing about it is in the text.
  router.post(
    `${base}/files`,
    guarded(async (ctx): Promise<Reply> => {
      const name = (ctx.url.searchParams.get("name") ?? "").normalize("NFC");
      const type = String(ctx.req.headers["content-type"] ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      if (!MEDIA_TYPE_RE.test(type) || type.length > 100)
        throw new HttpError(415, { reason: "unsupported_type", error: "Send the file's media type as content-type." });
      const bytes = await ctx.body(START_FILE_MAX_BYTES);
      if (!bytes.length) throw new HttpError(400, { reason: "empty", error: "The file is empty." });
      const bad = filesProblem([{ name, type, size: bytes.length, sha256: "A".repeat(43) }]);
      if (bad) throw new HttpError(400, { reason: "bad_name", error: bad });
      let held: { sha256: string; size: number };
      try {
        held = state.files.put(bytes, type);
      } catch {
        throw new HttpError(507, { reason: "full", error: "Too many files are held here; try again tomorrow." });
      }
      return { status: 201, json: { name, type, size: held.size, sha256: held.sha256 } satisfies StartFile };
    }),
  );

  router.get(
    `${base}/activity`,
    guarded((ctx): Reply => {
      const asked = Number(ctx.url.searchParams.get("limit") ?? 100);
      const limit = Number.isFinite(asked) ? Math.max(1, Math.min(1000, Math.floor(asked))) : 100;
      return { status: 200, json: { activity: state.activity(limit) } };
    }),
  );

  router.get(
    `${base}/machines`,
    guarded(
      (): Reply => ({
        status: 200,
        json: {
          machines: state
            .allMachines()
            .filter((m) => m.tokenHash || m.keys.length)
            .map((m) => ({
              name: m.name,
              createdAt: m.createdAt,
              ...(m.pairedAt ? { pairedAt: m.pairedAt } : {}),
              ...state.machineControl(m),
            })),
        },
      }),
    ),
  );

  // Local only: the row, its token and its queue go; the machine's next poll gets 401
  // and the daemon says so. Keys are never removed one at a time here (CONTROL.md §2).
  router.post(
    `${base}/machines/:id/forget`,
    guarded((ctx): Reply => {
      const id = ctx.params.id ?? "";
      if (!MACHINE_RE.test(id) || !state.removeMachine(id)) throw new HttpError(404, { reason: "not_found" });
      return { status: 204 };
    }),
  );
}
