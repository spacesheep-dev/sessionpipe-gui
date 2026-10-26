// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The native app's signer, through the shell's `identity` plugin
// (sp-identity: the Secure Enclave device key, Touch ID, the day key and the grant, all in
// Rust and Swift). Loaded only inside the shell (signer.ts imports it dynamically), never
// in a browser, so everything the app alone needs lives here: what Rust holds per rp id,
// whether this page can sign, and the app's words. Rust validates each command, writes the
// grant string itself and rate-limits; this file names the receiver and passes the bytes.
import type { Info, KeyType } from "@shared/api";
import { invoke } from "../native/bridge";
import { type DeviceSignature, lastInfo, rpId, type SendBody, type TrustedKey } from "./api";
import { notifySigner, type SignOptions } from "./signer";

/** What Rust answers `status` with: no key is made and no prompt shows. */
export interface NativeStatus {
  /** A presence-gated hardware key can be made and used here. */
  available: boolean;
  /** Why not, in words ("Sending needs a real iPhone"). */
  reason?: string;
  /** The device key for this rp id, once made. */
  key?: TrustedKey;
  /** When the current day grant ends (epoch ms), when one is held. */
  grantExp?: number | null;
}

/** A refusal from the plugin: `code` is stable, `message` is for the person. */
export interface NativeError {
  code: string;
  message: string;
}

type Shell = {
  platform?: unknown;
  features?: unknown;
  receiver?: { id?: unknown; name?: unknown; local?: unknown } | null;
};
const shell = (): Shell | undefined => (globalThis as { sessionpipeShell?: Shell }).sessionpipeShell;

/** The receiver this window shows, as the shell knows it (its id names it to Rust). */
export const shellReceiver = (): string | null => {
  const id = shell()?.receiver?.id;
  return typeof id === "string" && id ? id : null;
};

/** The shell advertises `signer` where it was built with one: the macOS release
 *  (`identity`), never a dev build, Linux or Windows. Rust's `status` then says whether
 *  this device can hold the key (never in a simulator, never as a software key). */
const builtToSign = (): boolean => {
  const f = shell()?.features;
  return Array.isArray(f) && f.includes("signer");
};
const shellSigns = (): boolean => builtToSign() && !!shellReceiver();

/** The receiver named (Settings may name another), else this window's. */
const receiver = (other?: string): string => {
  const id = other ?? shellReceiver();
  if (!id) throw { code: "unknown_receiver", message: "No receiver is open in this window." } satisfies NativeError;
  return id;
};

// --- the plugin's commands ----------------------------------------------------------------

/** `rp` null: the receiver's own rp id, as the shell knows it. */
export const status = (rp: string | null, other?: string) =>
  invoke<NativeStatus>("plugin:identity|status", { receiver: receiver(other), rp });

export const forget = (rp: string | null, other?: string) =>
  invoke<void>("plugin:identity|forget", { receiver: receiver(other), rp });

const call = (rp: string, cmd: string | null, mode: "grant" | "confirm", fresh: boolean) =>
  invoke<Omit<SendBody, "machineId">>("plugin:identity|sign", { receiver: receiver(), rp, cmd, mode, fresh });

/** Sign the exact bytes. A `key.add` always goes as a confirm: one Touch ID that names
 *  the device (Rust refuses it under the grant anyway). */
export function sign(rp: string, cmd: string, o: SignOptions = {}) {
  const keyAdd = (() => {
    try {
      return (JSON.parse(cmd) as { kind?: unknown }).kind === "key.add";
    } catch {
      return false;
    }
  })();
  o.onTap?.();
  return call(rp, cmd, o.confirm || keyAdd ? "confirm" : "grant", !!o.fresh);
}

/** One Touch ID now for the day grant, ahead of the first send. */
export const unlock = (rp: string) => call(rp, null, "grant", false).then(() => undefined);

export async function key(rp: string): Promise<TrustedKey> {
  const k = await invoke<TrustedKey>("plugin:identity|key", { receiver: receiver(), rp });
  keys.set(rp, k);
  notifySigner();
  return k;
}

export const pair = (code: string) =>
  invoke<{ key: TrustedKey; proof: DeviceSignature }>("plugin:identity|pair", { receiver: receiver(), code });

export async function grantExpiry(rp: string): Promise<number | null> {
  if (!shellSigns()) return null;
  try {
    return (await status(rp)).grantExp ?? null;
  } catch {
    return null;
  }
}

// --- what Rust holds, per rp id, as it last said -----------------------------------------
const keys = new Map<string, TrustedKey | null>();
const why = new Map<string, string>();

/** Ask Rust what it holds for `rp` (no key is made, no prompt shows). */
export async function refresh(rp: string): Promise<TrustedKey | null> {
  if (!shellSigns()) return null;
  try {
    const s = await status(rp);
    keys.set(rp, s.key ?? null);
    if (!s.available && s.reason) why.set(rp, s.reason);
    else why.delete(rp);
  } catch {
    keys.set(rp, null);
  }
  notifySigner();
  return keys.get(rp) ?? null;
}

export function ownKeys(rp: string): TrustedKey[] {
  const k = keys.get(rp);
  if (k === undefined) void refresh(rp);
  return k ? [k] : [];
}

/** The kinds of key the receiver carries whole: Info.control.keyTypes, else its well-known
 *  `control.signing.key_types`; passkeys only on an older receiver. */
export function keyTypesOf(i: Pick<Info, "control" | "wellKnown"> | undefined): KeyType[] {
  if (!i) return ["passkey"];
  const wk = (i.wellKnown?.control as { signing?: { key_types?: unknown } } | undefined)?.signing?.key_types;
  const list = i.control?.keyTypes ?? (Array.isArray(wk) ? wk : ["passkey"]);
  return (["passkey", "device"] as const).filter((t) => list.includes(t));
}

const receiverTakesDevice = (): boolean => {
  const i = lastInfo();
  if (!i) void rpId().then(notifySigner, () => {});
  return keyTypesOf(i).includes("device");
};

/** The app can sign for `rp`: the shell signs here, Rust didn't say why not, and the
 *  receiver carries device keys whole. */
export const canSign = (rp?: string | null): boolean => shellSigns() && !(rp && why.has(rp)) && receiverTakesDevice();

/** Why the app can't sign for `rp`, with the next step. Each reads as the fallback, not
 *  an error: a browser's passkey still sends. A machine's own reasons (it predates device
 *  keys, or doesn't trust this Mac yet) are signer.ts' updateWords and setupWords. */
export function signHint(rp?: string | null): string {
  const reason = rp ? why.get(rp) : undefined;
  if (reason) return reason;
  if (!builtToSign())
    return shell()?.platform === "macos"
      ? "this build of the app has no signer: send from a browser"
      : "the app signs on a Mac only for now: send from a browser";
  if (!shellReceiver()) return "no receiver is open in this window";
  // Its sessionpipe-core can't verify a device key (server/control/devicekeys.ts).
  if (!receiverTakesDevice())
    return `the receiver can't check this Mac's key yet: update sessionpipe-gui${receiverAt()} to send from the app, or send from a browser`;
  return "reading this Mac's key…";
}

/** Where the receiver this window shows runs, as the person knows it. */
function receiverAt(): string {
  const r = shell()?.receiver;
  if (r?.local === true) return " on this Mac";
  return typeof r?.name === "string" && r.name ? ` on ${r.name}` : "";
}

// --- the app's words ----------------------------------------------------------------------

/** A plugin refusal, in the page's words; null for anything that isn't one. */
export function errorWords(e: unknown): string | null {
  const n = e as { code?: unknown; message?: unknown } | null;
  if (!n || typeof n !== "object" || n instanceof Error || typeof n.code !== "string") return null;
  switch (n.code) {
    case "busy":
      return "finish the Touch ID prompt first";
    case "cancelled":
      return "Touch ID was cancelled, so nothing was signed";
    case "lockout":
      return "Touch ID is locked: unlock it with your password, then try again";
    case "rate_limited":
      return "slow down: too many sends in a row";
    default:
      return typeof n.message === "string" && n.message ? n.message : n.code.replace(/_/g, " ");
  }
}

const REFUSALS: Record<string, string> = {
  untrusted_key:
    "the machine doesn't trust this Mac yet: set up Touch ID on Machines, and approve it from a browser it trusts",
  bad_assertion: "this Mac's signature did not verify",
  bad_grant: "the day grant did not verify; the next send asks for Touch ID again",
  outside_grant: "signed outside the grant's window; the next send asks for Touch ID again",
};
export const refusal = (code: string): string | null => REFUSALS[code] ?? null;
