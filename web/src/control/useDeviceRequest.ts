// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The device-request flow /add-device and /phone share (CONTROL.md
// §2, "a trusted device vouches for a new one"): this browser makes its own passkey for the
// rp id, files the request, then asks every two seconds how it stands until the machine
// adds the key, refuses it, or the request expires. `poll` is the status read: the control
// route by default, the phone page's own (GET /api/ui/phone/device/:id) when it says so.
// A request in flight is remembered for this tab, so a reload mid-wait keeps its digits.
// In the native app the key is the app's device key for the rp id (made by the shell in
// the Secure Enclave on first use, no prompt), never a passkey.
import { useCallback, useEffect, useState } from "react";
import { ControlError, controlApi, type DeviceRequest } from "./api";
import { registerPasskey } from "./ceremony";
import { deviceKey, nativeErrorWords, signerKind } from "./signer";
import { guessDeviceName, type StoredPasskey, storedPasskeys, webauthnError } from "./webauthn";

const POLL_MS = 2000;
export const NAME_MAX = 40;
const REMEMBER_KEY = "sessionpipe.device-request";

export type DevicePhase =
  | { k: "idle" }
  | { k: "busy"; what: string }
  | { k: "waiting"; d: DeviceRequest }
  | { k: "added"; d: DeviceRequest }
  | { k: "failed"; d: DeviceRequest }
  | { k: "expired"; d: DeviceRequest }
  | { k: "rejected"; d: DeviceRequest };

export function requestErrorWords(e: unknown): string {
  if (e instanceof ControlError) {
    if (e.reason === "bad_key") return "This passkey is in a shape the machine cannot use; make a new one.";
    if (e.status === 401) return "This page lost its key. Open the GUI again from the link or QR on the Mac.";
    return e.detail ?? e.reason;
  }
  return nativeErrorWords(e) ?? webauthnError(e);
}

function remembered(): DeviceRequest | null {
  try {
    const raw = sessionStorage.getItem(REMEMBER_KEY);
    const d = raw ? (JSON.parse(raw) as DeviceRequest) : null;
    return d && typeof d.requestId === "string" && typeof d.check === "string" ? d : null;
  } catch {
    return null;
  }
}
function remember(d: DeviceRequest | null): void {
  try {
    if (d) sessionStorage.setItem(REMEMBER_KEY, JSON.stringify(d));
    else sessionStorage.removeItem(REMEMBER_KEY);
  } catch {
    // private mode: the wait simply does not survive a reload
  }
}

export interface DeviceRequestFlow {
  phase: DevicePhase;
  error: string | null;
  /** Passkeys this browser made for the rp id, newest first. */
  known: StoredPasskey[];
  /** Make (or reuse) the passkey and file the request. `fresh` forces a new passkey. */
  ask: (name: string, fresh?: boolean) => Promise<void>;
  /** Back to idle (after a refusal, to try again). */
  reset: () => void;
}

export function useDeviceRequest(
  rp: string | null,
  opts: { poll?: (requestId: string) => Promise<DeviceRequest> } = {},
): DeviceRequestFlow {
  const poll = opts.poll ?? controlApi.device;
  const [known, setKnown] = useState<StoredPasskey[]>([]);
  const [phase, setPhase] = useState<DevicePhase>(() => {
    const d = remembered();
    return d ? { k: "waiting", d } : { k: "idle" };
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (rp) setKnown(storedPasskeys(rp));
  }, [rp]);

  // While waiting, ask every two seconds how the request stands.
  const waitingId = phase.k === "waiting" ? phase.d.requestId : null;
  useEffect(() => {
    if (!waitingId) return;
    let on = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (p: DevicePhase) => {
      remember(null);
      setPhase(p);
    };
    const tick = async () => {
      try {
        const d = await poll(waitingId);
        if (!on) return;
        if (d.status === "added") settle({ k: "added", d });
        else if (d.status === "failed") settle({ k: "failed", d });
        else if (d.status === "expired") settle({ k: "expired", d });
        else setPhase({ k: "waiting", d });
      } catch (e) {
        if (!on) return;
        if (e instanceof ControlError && e.status === 404) {
          setPhase((p) => {
            if (p.k !== "waiting") return p;
            remember(null);
            return { k: "rejected", d: p.d };
          });
          return;
        }
        // a dropped connection: the next tick tries again
      }
      if (on) timer = setTimeout(tick, document.visibilityState === "hidden" ? POLL_MS * 3 : POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      on = false;
      if (timer) clearTimeout(timer);
    };
  }, [waitingId, poll]);

  const ask = useCallback(
    async (name: string, fresh = false) => {
      if (!rp) return;
      setError(null);
      const deviceName = name.trim().slice(0, NAME_MAX) || guessDeviceName();
      if (signerKind() === "device") {
        try {
          setPhase({ k: "busy", what: "Reading this Mac's key…" });
          const key = await deviceKey(rp);
          setPhase({ k: "busy", what: "Asking to be trusted…" });
          const d = await controlApi.deviceRequest({ key, name: name.trim().slice(0, NAME_MAX) || "Mac app" });
          remember(d);
          setPhase({ k: "waiting", d });
        } catch (e) {
          setError(requestErrorWords(e));
          setPhase({ k: "idle" });
        }
        return;
      }
      try {
        let key: StoredPasskey | undefined = fresh ? undefined : storedPasskeys(rp)[0];
        if (!key) {
          setPhase({ k: "busy", what: "Making a passkey on this device…" });
          key = await registerPasskey(rp, deviceName);
          setKnown(storedPasskeys(rp));
        }
        setPhase({ k: "busy", what: "Asking to be trusted…" });
        const d = await controlApi.deviceRequest({
          key: { id: key.id, alg: key.alg, spki: key.spki },
          name: deviceName,
        });
        remember(d);
        setPhase({ k: "waiting", d });
      } catch (e) {
        setError(requestErrorWords(e));
        setPhase({ k: "idle" });
      }
    },
    [rp],
  );

  const reset = useCallback(() => {
    remember(null);
    setError(null);
    setPhase({ k: "idle" });
  }, []);

  return { phase, error, known, ask, reset };
}
