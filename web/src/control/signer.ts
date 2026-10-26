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
import type { DeviceSignature, SendBody, TrustedKey } from "./api";
import { sha256 } from "./bytes";
import type * as Native from "./nativeSigner";
import { insecureHint, passkeysAvailable, storedPasskeys } from "./webauthn";

export type SignerKind = "passkey" | "device";
export type Signed = Omit<SendBody, "machineId">;

const inApp = (): boolean => !!(globalThis as { sessionpipeShell?: unknown }).sessionpipeShell;
/** The app's device key signs where the shell is; a passkey everywhere else. */
export const signerKind = (): SignerKind => (inApp() ? "device" : "passkey");
/** What the person confirms with: "your passkey", or "Touch ID" in the app. */
export const signerLabel = (): string => (inApp() ? "Touch ID" : "your passkey");

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
  dev ? dev.signHint(rp) : inApp() ? "reading this Mac's key…" : insecureHint();

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

export interface SignOptions {
  /** One fresh confirm over sha256(cmd) instead of the day grant. */
  confirm?: boolean;
  /** Fires right before a prompt (passkey or Touch ID), so the page can say what it is for. */
  onTap?: () => void;
  /** The last grant was refused: ask for a new one (the app allows one such retry). */
  fresh?: boolean;
}

/** Sign the exact bytes `cmd` for `rp`. */
export async function sign(rp: string, cmd: string, o: SignOptions = {}): Promise<Signed> {
  if (inApp()) return (await nativeSigner()).sign(rp, cmd, o);
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
  return { cmd, csig: await d.signWithDayKey(rec, cmd), grant: rec.grant };
}

/** When the day grant for `rp` ends (ms), or null when the next send asks. */
export const grantExpiry = async (rp: string): Promise<number | null> =>
  inApp() ? (await nativeSigner()).grantExpiry(rp) : (await day()).grantExpiry(rp);

/** Forget the cached grant (the app instead asks Rust for a fresh one, SignOptions.fresh). */
export const dropGrant = async (rp: string): Promise<void> => {
  if (!inApp()) await (await day()).dropGrant(rp);
};

/** Take the day grant ahead of the first send ("Unlock now"). */
export const unlock = async (rp: string): Promise<void> => {
  if (inApp()) await (await nativeSigner()).unlock(rp);
  else await (await day()).obtainGrant(rp);
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
