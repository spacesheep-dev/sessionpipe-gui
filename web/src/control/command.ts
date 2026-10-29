// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A command the way CONTROL.md §3.1 writes it, signed the way §3.2
// signs it (by this page's signer: the passkey and its day key in a browser, the app's
// device key in the native app, signer.ts), sent through POST /api/ui/control/send. The
// string is written once and the signature covers those exact bytes; the server passes it
// on byte for byte.
import {
  type ControlActivity,
  POOL_SESSION,
  type PoolAction,
  type SessionKey,
  type StartFile,
  type StartPermission,
} from "@shared/api";
import { noteOwnSend } from "../lib/toasts";
import { controlApi, type SendBody, type TrustedKey } from "./api";
import { nonce } from "./bytes";
import { dropGrant, sign, signerKind } from "./signer";

export const COMMAND_TYPE = "sessionpipe.control";
/** The session a `key.add` names: the machine's own key store (CONTROL.md §2). */
export const KEY_STORE_SESSION = "sessionpipe:keys";

export type CommandFields =
  /** `replyTo` (CONTROL.md §3.1 `reply_to`, a handoff): the session on the same machine
   *  the daemon relays the answer into. Inside the signed bytes; only when the machine's
   *  hello said `handoff` (orchestrate/handoff decides). */
  | { kind: "prompt"; session: string; text: string; replyTo?: SessionKey }
  | { kind: "permission.answer"; session: string; for: string; decision: "allow" | "deny"; note?: string }
  | { kind: "cancel"; session: string; note?: string }
  /** `files`, `permission` and `model` only when the machine's hello advertised them
   *  (CONTROL.md §2): a daemon that predates a field ignores it. NewSession.tsx decides. */
  | {
      kind: "start";
      session: string;
      text: string;
      cwd: string;
      files?: StartFile[];
      permission?: StartPermission;
      model?: string;
      replyTo?: SessionKey;
    }
  /** A device this browser's passkey vouches for: the machine adds `key` to its store. */
  | { kind: "key.add"; key: TrustedKey; name?: string }
  /** The machine's account pool (DESIGN §2.3), on `POOL_SESSION`: `account` for enable,
   *  disable, remove, refresh and login.complete (there: the pending login id), `order`
   *  for order (every account id), `code` for login.complete (the pasted `code#state`). */
  | { kind: "pool"; action: PoolAction; account?: string; order?: string[]; code?: string };

/** The command string, fields in the spec's order, no field a kind does not own. */
export function commandString(machine: string, f: CommandFields): string {
  const session = f.kind === "key.add" ? KEY_STORE_SESSION : f.kind === "pool" ? POOL_SESSION : f.session;
  const o: Record<string, unknown> = { v: 1, t: COMMAND_TYPE, machine, kind: f.kind, session };
  switch (f.kind) {
    case "prompt":
      o.text = f.text;
      if (f.replyTo) o.reply_to = f.replyTo;
      break;
    case "permission.answer":
      o.for = f.for;
      o.decision = f.decision;
      if (f.note) o.note = f.note;
      break;
    case "cancel":
      if (f.note) o.note = f.note;
      break;
    case "start":
      o.text = f.text;
      o.cwd = f.cwd;
      if (f.files?.length)
        o.files = f.files.map((x) => ({ name: x.name, type: x.type, size: x.size, sha256: x.sha256 }));
      if (f.permission) o.permission = f.permission;
      if (f.model) o.model = f.model;
      if (f.replyTo) o.reply_to = f.replyTo;
      break;
    case "key.add":
      // The key whole: a device key's type, store and uv are inside the signed bytes, or
      // the machine would store it as a passkey (CONTROL.md §2).
      o.key =
        f.key.type === "device"
          ? { id: f.key.id, alg: f.key.alg, spki: f.key.spki, type: f.key.type, store: f.key.store, uv: f.key.uv }
          : { id: f.key.id, alg: f.key.alg, spki: f.key.spki };
      if (f.name) o.name = f.name;
      break;
    case "pool":
      o.pool_action = f.action;
      if (f.account) o.pool_account = f.account;
      if (f.order) o.pool_order = [...f.order];
      if (f.code) o.pool_code = f.code;
      break;
  }
  o.nonce = nonce();
  o.iat = Date.now();
  return JSON.stringify(o);
}

export interface SendOptions {
  /** Sign with one confirm over sha256(cmd) (a passkey tap, or Touch ID) instead of the day grant. */
  confirm?: boolean;
  /** Fires right before a prompt, so the page can say what the tap is for. */
  onTap?: () => void;
  /** Sign with the grant already held, never a prompt (signer.ts NoGrantError when none);
   *  a grant the machine refused is dropped, not replaced. The workflows runner's way. */
  noPrompt?: boolean;
  expiresInS?: number;
  /** The session whose page sends it (`SendBody.from`): unsigned, the receiver's own note
   *  on the activity, so the page shows the ask at once while the events are on their way. */
  from?: SessionKey;
}

/** Sign `cmd` for `rp` with the day grant (one passkey tap, or one Touch ID, a day), or with a confirm. */
export async function signCommand(
  rp: string,
  cmd: string,
  o: SendOptions & { fresh?: boolean } = {},
): Promise<Omit<SendBody, "machineId">> {
  return sign(rp, cmd, o);
}

/** The grant did not satisfy the verifier: a fresh tap is worth one more try. */
const GRANT_FAULTS = new Set(["bad_grant", "outside_grant", "bad_csig", "bad_assertion"]);
/** The verifier's `code` on a 422, whichever door answered (ControlError from /send, the
 *  workflow route's error for a step's command); undefined for anything else. */
const faultCode = (e: unknown): string | undefined =>
  e && typeof e === "object" && (e as { status?: unknown }).status === 422 ? (e as { code?: string }).code : undefined;

/** Sign one command for `machineId` and hand the signed body to `deliver`: /send for the
 *  page's own commands (sendCommand), the run's PATCH for a workflow step (useRunner.ts),
 *  which queues it only once the server has seen the step is still this tab's. A refusal
 *  of the cached grant drops it and tries once more with a new one; any other refusal is
 *  thrown as `deliver` threw it. */
export async function signAndDeliver<T>(
  rp: string,
  machineId: string,
  fields: CommandFields,
  deliver: (body: SendBody) => Promise<T>,
  o: SendOptions = {},
): Promise<T> {
  const cmd = commandString(machineId, fields);
  const attempt = async (fresh = false): Promise<T> => {
    const signed = await signCommand(rp, cmd, { ...o, fresh });
    const body: SendBody = { machineId, ...signed };
    if (o.expiresInS) body.expires_in_s = o.expiresInS;
    if (o.from) body.from = o.from;
    return deliver(body);
  };
  try {
    return await attempt();
  } catch (e) {
    const code = faultCode(e);
    if (!o.confirm && code && GRANT_FAULTS.has(code)) {
      await dropGrant(rp);
      // A caller that may not prompt (the workflows runner) stops here: the grant is
      // gone, every useGrant on the page reads so, and the page the person is on asks.
      if (o.noPrompt) throw e;
      // The app's signer gets one fresh grant after a refusal (it rate-limits the rest).
      return attempt(signerKind() === "device");
    }
    throw e;
  }
}

/** Build, sign and send one command to `machineId`. A refusal of the cached grant drops
 *  it and tries once more with a new one; any other refusal is thrown as ControlError. */
export function sendCommand(
  rp: string,
  machineId: string,
  fields: CommandFields,
  o: SendOptions = {},
): Promise<ControlActivity> {
  return signAndDeliver(
    rp,
    machineId,
    fields,
    async (body) => {
      const carried = await controlApi.send(body);
      noteOwnSend(carried.id);
      return carried;
    },
    o,
  );
}
