// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Who signs a command on this page (CONTROL.md §2, §3.2). In a
// browser it is the person's passkey, with the day key it vouches for: webauthn.ts and
// daykey.ts, unchanged. Inside the native app (window.sessionpipeShell) WebAuthn can't run,
// so the app's device key signs instead: a Secure Enclave key behind Touch ID, held and
// used by the shell's Rust `identity` plugin. Everything about it lives in nativeSigner.ts,
// which only the shell loads (at once, here), so a browser carries none of it. The page
// never holds that key, a grant's private half or the grant string: it hands Rust the
// exact command and gets the signed body back.
import type { MachineControl } from "@shared/api";
import { useEffect, useMemo, useState } from "react";
import { type ShellPlatform, shellPlatform } from "../lib/device";
import type { DeviceSignature, SendBody, TrustedKey } from "./api";
import { sha256 } from "./bytes";
import type * as Native from "./nativeSigner";
import { insecureHint, passkeysAvailable, storedPasskeys } from "./webauthn";

export type SignerKind = "passkey" | "device";
export type Signed = Omit<SendBody, "machineId">;

const inApp = (): boolean => !!(globalThis as { sessionpipeShell?: unknown }).sessionpipeShell;
/** The app's device key signs where the shell is; a passkey everywhere else. */
export const signerKind = (): SignerKind => (inApp() ? "device" : "passkey");
/** What the person confirms with: "your passkey", or the app's own ("Touch ID", "Face ID"). */
export const signerLabel = (): string => (inApp() ? deviceWords().auth : "your passkey");

/** The app's words for the device it runs on, by the shell's platform (lib/device.ts):
 *  the Mac app says "this Mac" and "Touch ID", the iPhone app "this iPhone" and "Face ID",
 *  Android "this phone" and "your fingerprint". A desktop browser, and a shell with no
 *  signer of its own (Linux, Windows), read as the Mac app did: a browser never shows
 *  these lines, and the setup they describe is the Mac's. */
export interface DeviceWords {
  /** "this Mac": the device, as the subject of a sentence. */
  this: string;
  /** "Touch ID": what confirms a send here. */
  auth: string;
  /** "this Mac's": the possessive. */
  its: string;
  /** "Mac app": the app itself, the device request's default name. */
  app: string;
}
export function deviceWords(platform: ShellPlatform | null = shellPlatform()): DeviceWords {
  if (platform === "ios") return { this: "this iPhone", auth: "Face ID", its: "this iPhone's", app: "iPhone app" };
  if (platform === "android")
    return { this: "this phone", auth: "your fingerprint", its: "this phone's", app: "Android app" };
  return { this: "this Mac", auth: "Touch ID", its: "this Mac's", app: "Mac app" };
}

// The browser's day key (IndexedDB, a passkey's grant) loads with the first send, the
// first grant read or "Unlock now", not with the page: the entry carries only this switch.
const day = () => import("./daykey");

// The native adapter: loaded at once inside the shell, never in a browser. Until it lands
// the app reads as "can't sign yet", and `useOwnKeys` re-renders when it does.
let dev: typeof Native | null = null;
let loading: Promise<typeof Native> | null = null;
const listeners = new Set<() => void>();
export const notifySigner = (): void => {
  for (const l of listeners) l();
};
export const nativeSigner = (): Promise<typeof Native> => {
  loading ??= import("./nativeSigner").then((m) => {
    dev = m;
    notifySigner();
    return m;
  });
  return loading;
};
if (inApp()) void nativeSigner().catch(() => {});

/** Can a command be signed on this page for `rp`? A browser: passkeys work here. */
export const canSign = (rp?: string | null): boolean => (dev ? dev.canSign(rp) : !inApp() && passkeysAvailable(rp));

/** Why `canSign` is false, as one line. */
export const signHint = (rp?: string | null): string =>
  dev ? dev.signHint(rp) : inApp() ? `reading ${deviceWords().its} key…` : insecureHint();

/** The keys this device holds for `rp` (the passkeys this browser made, or the app's one
 *  device key once Rust reported it). Synchronous. */
export const ownKeys = (rp: string): TrustedKey[] => (dev ? dev.ownKeys(rp) : inApp() ? [] : storedPasskeys(rp));

/** `ownKeys`, the same array until `rp` changes or Rust reports a key. */
export function useOwnKeys(rp: string | null): TrustedKey[] {
  const [version, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the re-read signal
  return useMemo(() => (rp ? ownKeys(rp) : []), [rp, version]);
}

/** Does this machine take the key this page signs with? A passkey: always. The app's
 *  device key: only where the daemon's pairing or hello said `key_types: device`; an
 *  older one would store it as a passkey and refuse every signature (CONTROL.md §2). */
export const machineTakes = (control: Pick<MachineControl, "keyTypes"> | undefined, kind = signerKind()): boolean =>
  kind === "passkey" || !!control?.keyTypes?.includes("device");

/** The one muted line where a machine predates device keys. */
export const updateWords = (machine: string | undefined): string =>
  `Update sessionpipe on ${machine || "that machine"} to send from the app.`;

/** The app's setup, where its device key is made and a trusted device approves it once:
 *  "Approve this Mac" (or this iPhone, this phone). */
export const setupLabel = (): string => `Approve ${deviceWords().this}`;
/** The one line where a machine takes device keys but doesn't trust this device's yet. */
export const setupWords = (machine: string | undefined): string => {
  const w = deviceWords();
  return `${machine || "That machine"} doesn't trust ${w.this} yet. Approve it once, and ${w.auth} signs what you send from here.`;
};

/** Why Approve can't go for a device request on `machine`, or null: a device key (the
 *  request's own, or this app's, which signs the key.add) needs a machine that takes one. */
export function approveBlocker(
  request: { key: Pick<TrustedKey, "type"> },
  machine: { name: string; control?: Pick<MachineControl, "keyTypes"> } | undefined,
  kind = signerKind(),
): string | null {
  if (!machine) return "Pair a machine before adding devices.";
  return (request.key.type || kind === "device") && !machineTakes(machine.control, "device")
    ? updateWords(machine.name)
    : null;
}

/** The machine a device request is approved on when nobody chose one and the request
 *  names none: the first paired machine that can take it. A device key (the request's
 *  own, or this app's, which signs the key.add) needs a daemon that takes device keys,
 *  so with such a one paired it comes before a machine Approve would be blocked on. */
export function approveTarget<M extends { control?: Pick<MachineControl, "keyTypes"> }>(
  request: { key: Pick<TrustedKey, "type"> },
  paired: readonly M[],
  kind = signerKind(),
): M | undefined {
  if (request.key.type || kind === "device") {
    const takes = paired.find((m) => machineTakes(m.control, "device"));
    if (takes) return takes;
  }
  return paired[0];
}

export interface SignOptions {
  /** One fresh confirm over sha256(cmd) instead of the day grant. */
  confirm?: boolean;
  /** Fires right before a prompt (a passkey, Touch ID, Face ID), so the page can say what it is for. */
  onTap?: () => void;
  /** The last grant was refused: ask for a new one (the app allows one such retry). */
  fresh?: boolean;
  /** Sign with the grant already held, or throw NoGrantError: never a prompt. The
   *  workflows runner signs this way, from whatever page the shell is showing. */
  noPrompt?: boolean;
}

/** `sign` with `noPrompt` found no grant good for `rp`: a tap is due, and only a page
 *  the person is on may ask for it (the run view's Unlock now, a composer's send). */
export class NoGrantError extends Error {
  constructor(rp: string) {
    super(`no day grant held for ${rp}`);
  }
}

/** Fired on `window` once a day grant was taken or dropped, so every `useGrant` on the
 *  page re-reads it: the workflows runner (one hook, in the shell) then moves on a grant
 *  that the run view's "Unlock now" or a composer's send took. */
export const GRANT_EVENT = "sessionpipe-gui:grant";
const grantChanged = (): void => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(GRANT_EVENT));
};

/** Sign the exact bytes `cmd` for `rp`. */
export async function sign(rp: string, cmd: string, o: SignOptions = {}): Promise<Signed> {
  // With noPrompt, only a grant good right now signs (a confirm or a fresh grant would ask).
  if (o.noPrompt && (o.confirm || o.fresh || (await grantExpiry(rp)) === null)) throw new NoGrantError(rp);
  if (inApp()) {
    const signed = await (await nativeSigner()).sign(rp, cmd, o);
    // A fresh grant (or a confirm's own tap) stands in for the one a machine refused.
    if (o.fresh || o.confirm) refused.delete(rp);
    grantChanged();
    return signed;
  }
  if (o.confirm) {
    o.onTap?.();
    return {
      cmd,
      confirm: await (await import("./ceremony")).assertPasskey(
        rp,
        await sha256(cmd),
        storedPasskeys(rp).map((k) => k.id),
      ),
    };
  }
  const d = await day();
  const rec = await d.obtainGrant(rp, o.onTap);
  grantChanged();
  return { cmd, csig: await d.signWithDayKey(rec, cmd), grant: rec.grant };
}

/** In the app, the rp ids whose grant a machine refused: Rust still holds it and would sign
 *  with it again, so this page reads it as gone (grantExpiry null: the runner signs
 *  nothing, the run view asks for Touch ID) until a fresh one is taken, by Unlock now or by
 *  a send that asked for one. The browser's day key drops its grant for real instead. */
const refused = new Set<string>();

/** When the day grant for `rp` ends (ms), or null when the next send asks. */
export const grantExpiry = async (rp: string): Promise<number | null> => {
  if (!inApp()) return (await day()).grantExpiry(rp);
  return refused.has(rp) ? null : (await nativeSigner()).grantExpiry(rp);
};

/** Forget the cached grant: dropped in the browser; in the app, read as gone until a fresh
 *  one is taken (SignOptions.fresh asks Rust for it). */
export const dropGrant = async (rp: string): Promise<void> => {
  if (inApp()) refused.add(rp);
  else await (await day()).dropGrant(rp);
  grantChanged();
};

/** Take the day grant ahead of the first send ("Unlock now"). */
export const unlock = async (rp: string): Promise<void> => {
  if (inApp()) {
    await (await nativeSigner()).unlock(rp);
    refused.delete(rp);
  } else await (await day()).obtainGrant(rp);
  grantChanged();
};

/** The app's device key for `rp`, made on first use (no prompt: making one needs none). */
export const deviceKey = async (rp: string): Promise<TrustedKey> => (await nativeSigner()).key(rp);

/** Approve a pairing with the app's device key: Rust reads the pairing itself and shows its
 *  digits and machine in the Touch ID prompt, then hands back the key and its proof. */
export const pairWithDevice = async (code: string): Promise<{ key: TrustedKey; proof: DeviceSignature }> =>
  (await nativeSigner()).pair(code);

/** A refusal from the app's signer in the page's words; null anywhere else. */
export const nativeErrorWords = (e: unknown): string | null => (dev ? dev.errorWords(e) : null);

/** A machine's refusal code in the app's words (it has no passkey); null to use the usual ones. */
export const deviceRefusal = (code: string): string | null => (dev ? dev.refusal(code) : null);
