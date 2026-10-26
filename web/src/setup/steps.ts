// SPDX-License-Identifier: Apache-2.0
// Owned by: onboarding. What makes each of the five steps green (and the optional sixth,
// the GUI from anywhere), from the server's facts and this page's own (its origin, whether
// passkeys can work here). Shared by the page, the rail's dot and the first-run redirect so
// they never disagree.
import type { SetupStatus } from "@shared/api";
import { signerKind } from "../control/signer";
import { passkeysAvailable } from "../control/webauthn";

export type StepKey = "sessions" | "secure" | "pair" | "phone" | "try" | "remote";
export const STEP_ORDER: StepKey[] = ["sessions", "secure", "pair", "phone", "try", "remote"];
/** The steps that are never "needs you", never count for the rail's dot or the first-run
 *  redirect, and are not needed for "You're set": step 6 only. */
export const OPTIONAL_STEPS: ReadonlySet<StepKey> = new Set<StepKey>(["remote"]);
export const REQUIRED_STEPS: StepKey[] = STEP_ORDER.filter((k) => !OPTIONAL_STEPS.has(k));

/** The public https url a trusted reverse proxy serves (`--public-url`), when set. `remote`
 *  is absent on an older server. */
export function publicUrl(s: SetupStatus): string | undefined {
  return s.remote?.publicUrl || undefined;
}

/** Whether this page is on the https origin TLS mode serves. */
export function onHttpsOrigin(s: SetupStatus): boolean {
  if (typeof location === "undefined") return false;
  try {
    return location.origin === new URL(s.tls.httpsUrl).origin;
  } catch {
    return false;
  }
}

/** A secure origin exists: TLS on with a CA the system trusts (or cannot judge), or a public
 *  https url, whose certificate browsers already trust. */
function secureOrigin(s: SetupStatus): boolean {
  return (s.tls.on && s.tls.caTrusted !== false) || !!publicUrl(s);
}

/** Step 2: a secure origin exists, and this page can sign: passkeys work right here, or
 *  (the Mac app) Touch ID signs, so the https address is only the phone's. */
export function secureHere(s: SetupStatus): boolean {
  return secureOrigin(s) && (signerKind() === "device" || passkeysAvailable(s.tls.rpId));
}

/** `macTrusted`: in the Mac app, whether this machine trusts the app's key (false until
 *  "Approve this Mac"); undefined in a browser, where the passkey that paired signs. */
export function stepsDone(s: SetupStatus, tried: boolean, macTrusted?: boolean): Record<StepKey, boolean> {
  return {
    sessions: s.events.total > 0,
    secure: secureHere(s),
    pair: s.daemon.pairedHere && s.daemon.online && macTrusted !== false,
    phone: (s.tls.on || !!publicUrl(s)) && s.viewers.phones > 0,
    try: s.tried.delivered > 0 || tried,
    remote: !!publicUrl(s),
  };
}

/** The three facts a brand-new machine lacks: what sends `/` to `/setup` once. */
export function needsSetup(s: SetupStatus): boolean {
  return s.events.total === 0 || !(s.tls.on || publicUrl(s)) || !s.daemon.pairedHere;
}

/** What the rail's "Setup" entry waits for: the durable facts (a phone on the stream
 *  comes and goes, so it is not one of them; step 6 is optional, so neither is it). */
export function setupComplete(s: SetupStatus): boolean {
  return s.events.total > 0 && secureOrigin(s) && s.daemon.pairedHere && s.tried.delivered > 0;
}

/** Does a session's machine name mean this machine? */
export function sameMachineName(name: string | undefined, s: SetupStatus): boolean {
  if (!name) return false;
  const norm = (x: string) =>
    x
      .trim()
      .toLowerCase()
      .replace(/\.local\.?$/, "");
  const mine = [s.daemon.name, s.tls.hostname].filter((x): x is string => !!x).map(norm);
  return mine.includes(norm(name));
}
