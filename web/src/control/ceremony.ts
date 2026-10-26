// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The two WebAuthn ceremonies the control channel needs
// (CONTROL.md §2, §3.2): making a passkey for the receiver's rp id, and asserting over a
// 32-byte challenge with it. Out of the page's entry: the first send, approval or new
// passkey loads them (webauthn.ts holds what the page reads before that).
import { type Assertion, controlApi } from "./api";
import { b64url, fromB64url, randomBytes } from "./bytes";
import { ES256, RS256, rememberPasskey, type StoredPasskey } from "./webauthn";

/** Make a passkey for `rp` (CONTROL.md §2: ES256 first, RS256 second; a resident key when
 *  the authenticator offers one; the person verified). The challenge is the receiver's
 *  (GET /challenge), since creation has no deterministic one of its own. */
export async function registerPasskey(rp: string, name: string): Promise<StoredPasskey> {
  const c = await controlApi.challenge();
  const challenge = fromB64url(c.challenge);
  if (!challenge) throw new Error("The receiver sent an unreadable challenge.");
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: rp, name: "sessionpipe-gui" },
      user: { id: randomBytes(16), name: `sessionpipe · ${name}`, displayName: name },
      pubKeyCredParams: [
        { type: "public-key", alg: ES256 },
        { type: "public-key", alg: RS256 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was made.");
  const resp = cred.response as AuthenticatorAttestationResponse;
  const alg = resp.getPublicKeyAlgorithm?.();
  const spki = resp.getPublicKey?.();
  if (!spki || (alg !== ES256 && alg !== RS256))
    throw new Error("This browser cannot hand over the passkey's public key in a shape the machine can use.");
  const key: StoredPasskey = {
    id: b64url(cred.rawId),
    alg,
    spki: b64url(spki),
    name,
    createdAt: new Date().toISOString(),
  };
  rememberPasskey(rp, key);
  return key;
}

/** One assertion over `challenge` (32 bytes) with a passkey for `rp`. `allow` narrows the
 *  prompt to those credential ids; empty lets the browser offer every resident key. */
export async function assertPasskey(rp: string, challenge: Uint8Array, allow: string[] = []): Promise<Assertion> {
  const allowCredentials: PublicKeyCredentialDescriptor[] = [];
  for (const id of allow) {
    const raw = fromB64url(id);
    if (raw) allowCredentials.push({ type: "public-key", id: raw });
  }
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: challenge as Uint8Array<ArrayBuffer>,
      rpId: rp,
      userVerification: "required",
      timeout: 120_000,
      ...(allowCredentials.length ? { allowCredentials } : {}),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey answered.");
  const resp = cred.response as AuthenticatorAssertionResponse;
  return {
    cred: b64url(cred.rawId),
    ad: b64url(resp.authenticatorData),
    cd: b64url(resp.clientDataJSON),
    sig: b64url(resp.signature),
  };
}
