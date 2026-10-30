// SPDX-License-Identifier: Apache-2.0
// The `pool` control kind (CONTROL.md, the pool; DESIGN §2.3): a machine-level command on `sessionpipe:pool`
// that turns a machine's account pool on or off, enables, disables, removes, refreshes or
// reorders its accounts, or signs a new one in. It is verified exactly like a `key.add`
// (CONTROL.md §5: a grant from a trusted key plus the day key's signature over the exact
// bytes, or one confirm over sha256(cmd); the receiver's ten-minute age window; no nonce
// store here), but this receiver's sessionpipe-core (0.10.0) closes its kind set in
// `parseCommand`, which `verifyCommand` runs first, so a pool command is `unknown_kind`
// there whatever its signature says. The signature checks themselves are exported one by
// one (`parseGrant`, `verifyAssertion`, `sha256`, `fromB64url`), so this file reads the
// fields with its own strict parser, mirroring the core's common rules, and runs the same
// checks in the same order with the same refusal codes. The one piece the core keeps to
// itself, the day key's P-256 signature over the command bytes, is ten lines of WebCrypto
// here. Once a core that lists `pool` in CONTROL_KINDS is installed, `coreTakesPool()` is
// true and `verifyPoolCommand` hands the whole check to `verifyCommand`: nothing here
// outlives the core's catching up.
import * as core from "sessionpipe-core/control";
import {
  type Assertion,
  CMD_MAX,
  COMMAND_TYPE,
  type DeviceSignature,
  fromB64url,
  NOTE_MAX,
  parseGrant,
  RECEIVER_MAX_AGE_MS,
  type RefusalCode,
  type SignedCommand,
  SKEW_MS,
  sha256,
  type TrustedKey,
  verifyAssertion,
} from "sessionpipe-core/control";
import {
  POOL_ACCOUNT_ACTIONS,
  POOL_ACCOUNT_REQUIRED,
  POOL_ACCOUNTS_MAX,
  POOL_ACTIONS,
  POOL_CODE_MAX,
  POOL_CONFIRM_ACTIONS,
  POOL_SESSION,
  type PoolAction,
} from "../../shared/api.js";
import { MACHINE_RE, poolIdOk } from "./parse.js";

/** A `pool` command's fields, read from the exact string. */
export interface PoolCommand {
  v: 1;
  t: typeof COMMAND_TYPE;
  machine: string;
  kind: "pool";
  session: typeof POOL_SESSION;
  pool_action: PoolAction;
  pool_account?: string;
  pool_order?: string[];
  pool_code?: string;
  note?: string;
  nonce: string;
  iat: number;
}

/** The core's codes, `unknown_kind` (a core that does not list the kind), and the daemon's
 *  `confirm_required`: a confirm-only action signed with the day grant alone. */
export type PoolRefusal = RefusalCode | "unknown_kind" | "confirm_required";
export type PoolParsed = { ok: true; cmd: PoolCommand } | { ok: false; code: PoolRefusal; why: string };
export type PoolVerdict =
  | { ok: true; cmd: PoolCommand; via: "grant" | "confirm"; key: string }
  | { ok: false; code: PoolRefusal; why: string };

export interface PoolVerifyOptions {
  machine: string;
  rpId: string;
  trusted: TrustedKey[];
  now: number;
  maxAgeMs?: number;
}

const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const COMMON_FIELDS = ["v", "t", "machine", "kind", "session", "nonce", "iat", "note"];
export const POOL_FIELDS = ["pool_action", "pool_account", "pool_order", "pool_code"] as const;

const bad = (code: PoolRefusal, why: string): { ok: false; code: PoolRefusal; why: string } => ({
  ok: false,
  code,
  why,
});

/** Does this receiver's core know the `pool` kind itself? Asked of the core, never assumed
 *  from a version (tilde.ts, devicekeys.ts do the same). */
export function coreTakesPool(c: Pick<typeof core, "CONTROL_KINDS"> = core): boolean {
  try {
    return (c.CONTROL_KINDS as readonly string[]).includes("pool");
  } catch {
    return false;
  }
}

/** Is this string a `pool` command at all (by its `kind`), before anything is verified?
 *  The send route asks this to pick the verifier; a string that is not JSON is nobody's. */
export function looksLikePool(cmd: unknown): boolean {
  if (typeof cmd !== "string" || !cmd || cmd.length > CMD_MAX) return false;
  try {
    const c = JSON.parse(cmd) as { kind?: unknown } | null;
    return !!c && typeof c === "object" && c.kind === "pool";
  } catch {
    return false;
  }
}

/** Read a `pool` command's fields from the exact string: the common rules as the core's
 *  parseCommand has them, then DESIGN §2.3's field rules per action. Structure only. */
export function parsePoolCommand(str: unknown): PoolParsed {
  if (typeof str !== "string" || !str || str.length > CMD_MAX)
    return bad("malformed", "the command is missing or too long");
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(str);
  } catch {
    return bad("malformed", "the command is not JSON");
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) return bad("malformed", "the command is not an object");
  if (c.v !== 1 || c.t !== COMMAND_TYPE) return bad("not_a_command", "not a sessionpipe control command");
  if (typeof c.machine !== "string" || !MACHINE_RE.test(c.machine)) return bad("malformed", "which machine?");
  if (c.kind !== "pool") return bad("unknown_kind", "the command asks for something unknown");
  if (c.session !== POOL_SESSION) return bad("bad_session", `a pool command names ${POOL_SESSION}`);
  if (typeof c.nonce !== "string" || !NONCE_RE.test(c.nonce))
    return bad("bad_nonce", "the nonce is missing or malformed");
  if (typeof c.iat !== "number" || !Number.isInteger(c.iat) || c.iat <= 0)
    return bad("malformed", "the command has no signing time");
  const has = (k: string) => c[k] !== undefined;

  const action = c.pool_action;
  if (typeof action !== "string" || !(POOL_ACTIONS as readonly string[]).includes(action))
    return bad("bad_fields", `pool_action is one of ${POOL_ACTIONS.join(", ")}`);
  const mayName = (POOL_ACCOUNT_ACTIONS as readonly string[]).includes(action);
  const mustName = (POOL_ACCOUNT_REQUIRED as readonly string[]).includes(action);
  if (has("pool_account") ? !mayName || !poolIdOk(c.pool_account) : mustName)
    return bad(
      "bad_fields",
      mayName
        ? `a pool ${action} names the account in pool_account: 1 to 128 letters, digits and ._:-`
        : `a pool ${action} carries no pool_account`,
    );
  if (action === "order") {
    const o = c.pool_order;
    if (!Array.isArray(o) || o.length < 1 || o.length > POOL_ACCOUNTS_MAX || !o.every(poolIdOk))
      return bad("bad_fields", `a pool order lists 1 to ${POOL_ACCOUNTS_MAX} account ids in pool_order`);
    if (new Set(o).size !== o.length) return bad("bad_fields", "a pool order names each account once");
  } else if (has("pool_order")) return bad("bad_fields", `a pool ${action} carries no pool_order`);
  if (action === "login.complete") {
    const code = c.pool_code;
    if (typeof code !== "string" || !code.trim() || code.length > POOL_CODE_MAX || CONTROL_CHAR.test(code))
      return bad(
        "bad_fields",
        `login.complete carries the pasted code in pool_code, at most ${POOL_CODE_MAX} characters`,
      );
  } else if (has("pool_code")) return bad("bad_fields", `a pool ${action} carries no pool_code`);

  for (const k of Object.keys(c))
    if (!COMMON_FIELDS.includes(k) && !(POOL_FIELDS as readonly string[]).includes(k))
      return bad("bad_fields", `the command carries a field its kind doesn't have: ${k.slice(0, 40)}`);
  if (has("note") && (typeof c.note !== "string" || c.note.length > NOTE_MAX))
    return bad("bad_fields", `a note is text, at most ${NOTE_MAX} characters`);
  return { ok: true, cmd: c as unknown as PoolCommand };
}

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

/** The day key's ECDSA P-256 signature over the command's exact bytes (CONTROL.md §3.2),
 *  as the core checks it: a 64-byte raw r‖s, the key from the grant's SPKI. */
export async function verifyCsig(cmd: string, csig: unknown, pub: string): Promise<boolean> {
  const sig = fromB64url(csig);
  const spki = fromB64url(pub);
  if (sig?.length !== 64 || !spki) return false;
  try {
    const key = await crypto.subtle.importKey("spki", spki as Bytes, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig as Bytes, enc.encode(cmd) as Bytes);
  } catch {
    return false;
  }
}

/** Is this a `pool` command the machine may be asked to run? The core's checks in the
 *  core's order (CONTROL.md §5), by the core's own primitives where it exports them: the
 *  exact bytes parse; the command is for this machine; it is signed (a grant from a
 *  trusted key and the day key's signature, or a confirm over sha256(cmd)); it was signed
 *  within the window. With a core that knows the kind, the core's `verifyCommand` decides. */
export async function verifyPoolCommand(
  s: SignedCommand | null | undefined,
  o: PoolVerifyOptions,
  c: Pick<typeof core, "CONTROL_KINDS" | "verifyCommand"> = core,
): Promise<PoolVerdict> {
  if (!s || typeof s !== "object") return bad("malformed", "nothing to verify");
  const p = parsePoolCommand(s.cmd);
  if (!p.ok) return p;
  const cmd = p.cmd;
  if (coreTakesPool(c)) {
    const v = await c.verifyCommand(s, { ...o, maxAgeMs: o.maxAgeMs ?? RECEIVER_MAX_AGE_MS });
    return v.ok ? (needsConfirm(cmd, v.via) ?? { ok: true, cmd, via: v.via, key: v.key }) : bad(v.code, v.why);
  }
  if (cmd.machine !== o.machine) return bad("wrong_machine", "the command is for another machine");
  let via: "grant" | "confirm" | null = null;
  let keyId = "";
  let refusal: { code: PoolRefusal; why: string } | null = null;
  if (s.grant && s.csig) {
    const bundle = s.grant;
    const g = parseGrant(bundle.str, o.rpId);
    if (!g.ok) refusal = { code: "bad_grant", why: g.why };
    else {
      const key = o.trusted.find((k) => k && k.id === bundle.cred);
      if (!key) refusal = { code: "untrusted_key", why: "the grant was signed with a key this machine doesn't trust" };
      else {
        const a = await verifyAssertion(await sha256(bundle.str), bundle, key, o.rpId, "grant");
        if (!a.ok) refusal = { code: "bad_assertion", why: a.why };
        else if (!(await verifyCsig(s.cmd, s.csig, g.grant.pub)))
          refusal = {
            code: "bad_csig",
            why: "the command's signature doesn't verify — it was changed after it was signed",
          };
        else if (cmd.iat < g.grant.iat - SKEW_MS || cmd.iat > g.grant.exp)
          refusal = { code: "outside_grant", why: "the command was signed outside its grant's window" };
        else {
          via = "grant";
          keyId = key.id;
        }
      }
    }
  }
  if (!via && s.confirm) {
    const confirm = s.confirm as Assertion | DeviceSignature;
    const key = o.trusted.find((k) => k && k.id === confirm.cred);
    if (!key) refusal = { code: "untrusted_key", why: "confirmed with a key this machine doesn't trust" };
    else {
      const a = await verifyAssertion(await sha256(s.cmd), confirm, key, o.rpId, "confirm");
      if (a.ok) {
        via = "confirm";
        keyId = key.id;
      } else refusal = { code: "bad_assertion", why: a.why };
    }
  }
  if (!via) return refusal ? bad(refusal.code, refusal.why) : bad("unsigned", "the command isn't signed");
  if (cmd.iat > o.now + SKEW_MS) return bad("future", "the command is dated in the future (is this clock right?)");
  if (o.now - cmd.iat > (o.maxAgeMs ?? RECEIVER_MAX_AGE_MS))
    return bad("too_old", "the command was signed too long ago");
  return needsConfirm(cmd, via) ?? { ok: true, cmd, via, key: keyId };
}

/** The contract's last word on a verified pool command (CONTROL.md §6, POOL_CONFIRM_ACTIONS):
 *  on, off, remove, order, disable and login.complete take a fresh confirm, never the day
 *  grant alone. The daemon refuses one with `confirm_required`; so does this early verify,
 *  so nothing is queued that the machine would only send back. */
function needsConfirm(cmd: PoolCommand, via: "grant" | "confirm"): ReturnType<typeof bad> | null {
  if (via === "confirm" || !POOL_CONFIRM_ACTIONS.includes(cmd.pool_action)) return null;
  return bad("confirm_required", `pool ${cmd.pool_action} needs a fresh confirm, not a day grant`);
}
