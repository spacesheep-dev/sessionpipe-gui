// SPDX-License-Identifier: Apache-2.0
// A stand-in authenticator and signing device, so the test door and the tests run on
// real signatures: a passkey (P-256, or RSA for RS256) that answers WebAuthn assertions
// the way a platform authenticator does, a browser day key that signs commands, and an
// app's device key (TestDeviceKey) that signs the device message (CONTROL.md §3.2).
// A software key can't be honest about `store: "hardware"`: TestDeviceKey claims it only
// so the device path runs end to end without a Secure Enclave, and only here.
// Test keys only: made fresh per process, never written anywhere, and only reachable
// through the loopback test door (testdoor.ts) or a test file.
import {
  type Assertion,
  b64url,
  COMMAND_TYPE,
  GRANT_TYPE,
  type GrantBundle,
  pairChallenge,
  RS256,
  type SignedCommand,
  sha256,
} from "sessionpipe-core/control";
import type { TrustedKey } from "../../shared/api.js";
import {
  type DeviceGrant,
  type DevicePurpose,
  type DeviceSignature,
  deviceKeyId,
  deviceMessage,
} from "./devicekeys.js";

const enc = new TextEncoder();
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type Bytes = Uint8Array<ArrayBuffer>;

/** A raw r‖s ECDSA signature as the DER a WebAuthn authenticator returns. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (v: Uint8Array) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let b = v.slice(i);
    if ((b[0] as number) & 0x80) b = new Uint8Array([0, ...b]);
    return new Uint8Array([0x02, b.length, ...b]);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

export interface AssertOptions {
  origin?: string;
  flags?: number;
  type?: string;
  crossOrigin?: boolean;
}

/** The browser origin a passkey for `rpId` would be used from: plain http only on localhost. */
export function originFor(rpId: string): string {
  return rpId === "localhost" ? "http://localhost" : `https://${rpId}`;
}

export class TestPasskey {
  constructor(
    readonly key: TrustedKey,
    private readonly priv: CryptoKey,
    readonly rpId: string,
    readonly origin: string,
  ) {}

  static async create(o: { rpId?: string; origin?: string; alg?: number } = {}): Promise<TestPasskey> {
    const rpId = o.rpId ?? "localhost";
    const origin = o.origin ?? originFor(rpId);
    const rsa = o.alg === RS256;
    const pair = rsa
      ? await crypto.subtle.generateKey(
          {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
          },
          true,
          ["sign", "verify"],
        )
      : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));
    const id = b64url(crypto.getRandomValues(new Uint8Array(24)));
    return new TestPasskey({ id, alg: rsa ? RS256 : -7, spki }, pair.privateKey, rpId, origin);
  }

  async assert(challenge: Uint8Array, o: AssertOptions = {}): Promise<Assertion> {
    const cd = enc.encode(
      JSON.stringify({
        type: o.type ?? "webauthn.get",
        challenge: b64url(challenge),
        origin: o.origin ?? this.origin,
        crossOrigin: o.crossOrigin ?? false,
      }),
    );
    const ad = new Uint8Array(37);
    ad.set(await sha256(this.rpId), 0);
    ad[32] = o.flags ?? 0x05;
    ad.set([0, 0, 0, 7], 33);
    const signed = new Uint8Array(ad.length + 32);
    signed.set(ad, 0);
    signed.set(await sha256(cd), ad.length);
    let sig: Uint8Array;
    if (this.key.alg === RS256) {
      sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, this.priv, signed as Bytes));
    } else {
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.priv, signed as Bytes),
      );
      sig = rawToDer(raw);
    }
    return { cred: this.key.id, ad: b64url(ad), cd: b64url(cd), sig: b64url(sig) };
  }

  /** The enrollment proof for a machine's pairing code (CONTROL.md §2 step 2). */
  async enroll(machine: string, code: string, o: AssertOptions = {}): Promise<Assertion> {
    return this.assert(await pairChallenge(machine, code), o);
  }
}

/** A browser's day key, vouched for by a passkey's grant (CONTROL.md §3.2). */
export class TestDayKey {
  constructor(
    private readonly priv: CryptoKey,
    readonly pub: string,
  ) {}

  static async create(): Promise<TestDayKey> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return new TestDayKey(pair.privateKey, b64url(await crypto.subtle.exportKey("spki", pair.publicKey)));
  }

  grantStr(o: { iat: number; exp: number; rp: string }): string {
    return JSON.stringify({ v: 1, t: GRANT_TYPE, pub: this.pub, iat: o.iat, exp: o.exp, rp: o.rp });
  }

  async grant(passkey: TestPasskey, o: { iat: number; exp: number }): Promise<GrantBundle> {
    const str = this.grantStr({ iat: o.iat, exp: o.exp, rp: passkey.rpId });
    const a = await passkey.assert(await sha256(str));
    return { ...a, str };
  }

  async sign(cmd: string): Promise<string> {
    return b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.priv, enc.encode(cmd) as Bytes));
  }
}

/** An app's device key, in software (test door and tests only): it names itself by its
 *  SPKI's hash and signs `sessionpipe.device.v1⏎<purpose>⏎<rp id>⏎<challenge>`, raw r‖s. */
export class TestDeviceKey {
  constructor(
    readonly key: TrustedKey,
    private readonly priv: CryptoKey,
    readonly rpId: string,
  ) {}

  static async create(o: { rpId?: string } = {}): Promise<TestDeviceKey> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));
    const key: TrustedKey = {
      id: await deviceKeyId(spki),
      alg: -7,
      spki,
      type: "device",
      store: "hardware",
      uv: "each-use",
    };
    return new TestDeviceKey(key, pair.privateKey, o.rpId ?? "localhost");
  }

  /** `o.purpose` / `o.rpId` sign another line than the one asked for (a broken signer). */
  async sign(
    purpose: DevicePurpose,
    challenge: Uint8Array,
    o: { purpose?: DevicePurpose; rpId?: string } = {},
  ): Promise<DeviceSignature> {
    const msg = deviceMessage(o.purpose ?? purpose, o.rpId ?? this.rpId, challenge) as Bytes;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.priv, msg);
    return { cred: this.key.id, sig: b64url(sig) };
  }

  async enroll(machine: string, code: string): Promise<DeviceSignature> {
    return this.sign("pair", await pairChallenge(machine, code));
  }

  /** The day grant a device key signs (the native signer writes the same string). */
  async grant(day: TestDayKey, o: { iat: number; exp: number }): Promise<DeviceGrant> {
    const str = day.grantStr({ iat: o.iat, exp: o.exp, rp: this.rpId });
    return { ...(await this.sign("grant", await sha256(str))), str };
  }
}

/** A command as a device key signs it (CONTROL.md §3.2). */
export type DeviceSignedCommand = Omit<SignedCommand, "grant" | "confirm"> & {
  grant?: DeviceGrant;
  confirm?: DeviceSignature;
};

/** A command signed by a device key: its day grant and csig, or a confirm. */
export async function signWithDevice(
  device: TestDeviceKey,
  day: TestDayKey,
  cmd: string,
  o: { confirm?: boolean } = {},
): Promise<DeviceSignedCommand> {
  if (o.confirm) return { cmd, confirm: await device.sign("confirm", await sha256(cmd)) };
  const iat = (JSON.parse(cmd).iat as number) - 60_000;
  return { cmd, csig: await day.sign(cmd), grant: await device.grant(day, { iat, exp: iat + 12 * 3600_000 }) };
}

export const nonce = (n = 16) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** A command string in the field order a browser writes it. `fields` override the defaults;
 *  an `undefined` value drops the field. */
export function commandStr(machine: string, fields: Record<string, unknown>): string {
  const base: Record<string, unknown> = {
    v: 1,
    t: COMMAND_TYPE,
    machine,
    kind: "prompt",
    session: "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e",
    text: "Add the Oct 8 row",
    nonce: nonce(),
    iat: Date.now(),
    ...fields,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return JSON.stringify(base);
}

/** A fully signed command: the grant path by default, a confirm with `confirm: true`. */
export async function signCommand(
  passkey: TestPasskey,
  day: TestDayKey,
  cmd: string,
  o: { confirm?: boolean; grantIat?: number; grantExp?: number } = {},
): Promise<SignedCommand> {
  if (o.confirm) return { cmd, confirm: await passkey.assert(await sha256(cmd)) };
  const iat = o.grantIat ?? (JSON.parse(cmd).iat as number) - 60_000;
  const grant = await day.grant(passkey, { iat, exp: o.grantExp ?? iat + 12 * 3600_000 });
  return { cmd, csig: await day.sign(cmd), grant };
}
