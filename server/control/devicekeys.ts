// SPDX-License-Identifier: Apache-2.0
// Device keys (sessionpipe CONTROL.md §2 "Device keys", §3.2; Draft): the P-256 key the
// native app holds in hardware where its web view can't do WebAuthn. A machine verifies
// them with sessionpipe-core's verifier, and only a core that knows them can: an older
// one takes the key's shape and refuses every signature it makes. So this receiver takes
// device keys only when its own core verifies one (it exports `deviceMessage`); until
// then it takes passkeys only and says so (Info.control.keyTypes), the app shows "send
// from a browser", and nothing on the page offers a device key. A machine opts in on its
// own (`key_types` in its pairing and hello); the page also needs that (signer.ts).
import * as core from "sessionpipe-core/control";
import type { KeyType } from "../../shared/api.js";

export type DevicePurpose = "grant" | "confirm" | "pair";

/** A device key's signature (CONTROL.md §3.2): its id and 64 bytes r‖s, base64url. */
export interface DeviceSignature {
  cred: string;
  sig: string;
}

/** The day's grant from a device key: its signature over the grant string's hash. */
export interface DeviceGrant extends DeviceSignature {
  str: string;
}

/** Does this sessionpipe-core verify device keys? */
export const coreTakesDevice = (c: object = core): boolean =>
  typeof (c as { deviceMessage?: unknown }).deviceMessage === "function";

/** The kinds of key this receiver stores, carries whole and checks early. */
export const receiverKeyTypes = (device = coreTakesDevice()): KeyType[] =>
  device ? ["passkey", "device"] : ["passkey"];

/** The exact bytes a device key signs: `sessionpipe.device.v1⏎<purpose>⏎<rp id>⏎<challenge>`,
 *  the challenge base64url. The test door's software key signs these; machines verify them
 *  with their own core. */
export function deviceMessage(purpose: DevicePurpose, rpId: string, challenge: Uint8Array): Uint8Array {
  return new TextEncoder().encode(["sessionpipe.device.v1", purpose, rpId, core.b64url(challenge)].join("\n"));
}

/** A device key's id: the SHA-256 of its SPKI bytes, base64url. */
export async function deviceKeyId(spki: string): Promise<string> {
  return core.b64url(await core.sha256(core.fromB64url(spki) ?? new Uint8Array()));
}
