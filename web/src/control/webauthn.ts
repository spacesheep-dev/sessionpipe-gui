// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The two WebAuthn ceremonies the control channel needs
// (CONTROL.md §2, §3.2): making a passkey for the receiver's rp id, and asserting over a
// 32-byte challenge with it. The passkeys this browser made are remembered per rp id
// (credential id, alg, SPKI) in localStorage, so a later approval or grant can name them.
import { type Assertion, controlApi, type TrustedKey, tlsInfo, wrongOriginHere } from "./api";
import { b64url, fromB64url, randomBytes } from "./bytes";
import { wrongOriginWords } from "./origin";

export const ES256 = -7;
export const RS256 = -257;

/** Why no control affordance can work here: passkeys need a secure context. */
export const INSECURE_HINT = "passkeys need https or localhost: open this page on the machine running sessionpipe-gui";

/** The hint for this page. On the wrong address (not under the rp id, while a sending
 *  origin exists) it is the guard's one line, control/origin.ts; with TLS mode on, the one
 *  origin passkeys work on (the `.local` rp id makes http://localhost stop signing too);
 *  otherwise INSECURE_HINT. */
export function insecureHint(): string {
  const wrong = wrongOriginHere();
  if (wrong) return wrongOriginWords(wrong);
  const tls = tlsInfo();
  if (!tls?.on) return INSECURE_HINT;
  return `passkeys work only at ${tls.httpsUrl} (TLS mode); the Setup page gets you there`;
}

/** Is `location.hostname` the rp id or under it (CONTROL.md §3.2)? True when `rp` is unknown. */
export function rpMatchesHere(rp: string | null | undefined): boolean {
  if (!rp || typeof location === "undefined") return true;
  const h = location.hostname.toLowerCase();
  return h === rp.toLowerCase() || h.endsWith(`.${rp.toLowerCase()}`);
}

/** Can this page use passkeys at all? False over plain LAN http (a phone on the Wi-Fi),
 *  and, given the rp id, on an origin that is not under it (http://localhost with a
 *  `.local` rp id: the browser would refuse the ceremony). */
export function passkeysAvailable(rp?: string | null): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof PublicKeyCredential !== "undefined" &&
    !!navigator.credentials?.create &&
    rpMatchesHere(rp)
  );
}

export interface StoredPasskey extends TrustedKey {
  name?: string;
  createdAt: string;
}

const storeKey = (rp: string) => `sessionpipe.passkeys:${rp}`;

export function storedPasskeys(rp: string): StoredPasskey[] {
  try {
    const raw = localStorage.getItem(storeKey(rp));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list)
      ? list.filter(
          (k): k is StoredPasskey =>
            !!k && typeof k === "object" && typeof (k as StoredPasskey).id === "string" && "spki" in (k as object),
        )
      : [];
  } catch {
    return [];
  }
}

export function rememberPasskey(rp: string, key: StoredPasskey): void {
  try {
    const list = storedPasskeys(rp).filter((k) => k.id !== key.id);
    list.unshift(key);
    localStorage.setItem(storeKey(rp), JSON.stringify(list.slice(0, 10)));
  } catch {
    // private mode or storage full: the key still works for this page load
  }
}

export function forgetPasskey(rp: string, id: string): void {
  try {
    localStorage.setItem(storeKey(rp), JSON.stringify(storedPasskeys(rp).filter((k) => k.id !== id)));
  } catch {
    // ignore
  }
}

/** A short name for the device, offered as the key's name ("iPhone", "Mac"). */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux box";
  return "this browser";
}

/** What the setup page learned about this https origin: whether the browser trusts its
 *  certificate (its probe of the https origin succeeded, or the server says the CA is
 *  trusted). Unknown until it says. */
let originTrust: boolean | null = null;
export function noteOriginTrust(trusted: boolean | null): void {
  originTrust = trusted;
}

/** The browser refused the ceremony because it does not trust this origin's certificate.
 *  Chrome says so in the error itself ("WebAuthn is not supported on sites with TLS
 *  certificate errors"); otherwise a NotAllowedError on an https origin the setup page
 *  found untrusted means the same. */
export function certificateRefusal(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name !== "NotAllowedError") return false;
  if (/certificate|TLS/i.test(err.message ?? "")) return true;
  return typeof location !== "undefined" && location.protocol === "https:" && originTrust === false;
}

export const UNTRUSTED_CERT_HINT =
  "Your browser doesn't trust this certificate yet. On a Mac: Setup → Trust, then quit and reopen the browser.";

/** What the person did, in words, when a ceremony ends without a credential. */
export function webauthnError(e: unknown): string {
  const err = e as { name?: string; message?: string } | null;
  if (certificateRefusal(e)) return UNTRUSTED_CERT_HINT;
  switch (err?.name) {
    case "NotAllowedError":
      return "The passkey prompt was dismissed or timed out.";
    case "InvalidStateError":
      return "This passkey is already registered here.";
    case "NotSupportedError":
      return "This browser cannot make a passkey of a kind the machine accepts.";
    case "SecurityError":
      return insecureHint();
    case "AbortError":
      return "The passkey prompt was cancelled.";
    default:
      return err?.message ?? String(e);
  }
}

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
