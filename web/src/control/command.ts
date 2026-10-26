// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A command the way CONTROL.md §3.1 writes it, signed the way §3.2
// signs it (by this page's signer: the passkey and its day key in a browser, the app's
// device key in the native app, signer.ts), sent through POST /api/ui/control/send. The
// string is written once and the signature covers those exact bytes; the server passes it
// on byte for byte.
import type { ControlActivity, StartFile, StartPermission } from "@shared/api";
import { noteOwnSend } from "../lib/toasts";
import { ControlError, controlApi, type SendBody, type TrustedKey } from "./api";
import { nonce } from "./bytes";
import { dropGrant, sign, signerKind } from "./signer";

export const COMMAND_TYPE = "sessionpipe.control";
/** The session a `key.add` names: the machine's own key store (CONTROL.md §2). */
export const KEY_STORE_SESSION = "sessionpipe:keys";

export type CommandFields =
  | { kind: "prompt"; session: string; text: string }
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
    }
  /** A device this browser's passkey vouches for: the machine adds `key` to its store. */
  | { kind: "key.add"; key: TrustedKey; name?: string };

/** The command string, fields in the spec's order, no field a kind does not own. */
export function commandString(machine: string, f: CommandFields): string {
  const session = f.kind === "key.add" ? KEY_STORE_SESSION : f.session;
  const o: Record<string, unknown> = { v: 1, t: COMMAND_TYPE, machine, kind: f.kind, session };
  switch (f.kind) {
    case "prompt":
      o.text = f.text;
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
  expiresInS?: number;
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

/** Build, sign and send one command to `machineId`. A refusal of the cached grant drops
 *  it and tries once more with a new one; any other refusal is thrown as ControlError. */
export async function sendCommand(
  rp: string,
  machineId: string,
  fields: CommandFields,
  o: SendOptions = {},
): Promise<ControlActivity> {
  const cmd = commandString(machineId, fields);
  const attempt = async (fresh = false): Promise<ControlActivity> => {
    const signed = await signCommand(rp, cmd, { ...o, fresh });
    const body: SendBody = { machineId, ...signed };
    if (o.expiresInS) body.expires_in_s = o.expiresInS;
    const carried = await controlApi.send(body);
    noteOwnSend(carried.id);
    return carried;
  };
  try {
    return await attempt();
  } catch (e) {
    if (!o.confirm && e instanceof ControlError && e.code && GRANT_FAULTS.has(e.code)) {
      await dropGrant(rp);
      // The app's signer gets one fresh grant after a refusal (it rate-limits the rest).
      return attempt(signerKind() === "device");
    }
    throw e;
  }
}
