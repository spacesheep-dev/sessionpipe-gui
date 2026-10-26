// SPDX-License-Identifier: Apache-2.0
// Owned by: phone-web. The browser's side of /api/ui/phone (shared/api.ts PhoneInfo): one
// read every two seconds while the page is open, the Tailscale action, the device poll
// the phone runs while it waits, and the trust check the phone taps after installing the CA.
import type { PhoneDeviceState, PhoneInfo, PhoneTrustCheck } from "@shared/api";
import { ROUTES } from "@shared/api";
import { useEffect, useState } from "react";
import { ControlError, type DeviceRequest } from "../control/api";
import { apiUrl } from "../lib/net";

const BASE = ROUTES.ui.phone;
const POLL_MS = 2000;

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // no body
  }
  if (!res.ok) {
    const reason = typeof json.reason === "string" ? json.reason : `http_${res.status}`;
    const detail =
      typeof json.error === "string" ? json.error : typeof json.detail === "string" ? json.detail : undefined;
    throw new ControlError(res.status, reason, undefined, detail);
  }
  return json as T;
}

export const phoneApi = {
  info: () => call<PhoneInfo>("GET", BASE),
  /** Loopback only: `tailscale serve` this port and make its name the public url. */
  tailscale: () => call<PhoneInfo>("POST", `${BASE}/tailscale`),
  device: (id: string) => call<PhoneDeviceState>("GET", `${BASE}/device/${encodeURIComponent(id)}`),
  trustCheck: () => call<PhoneTrustCheck>("POST", `${BASE}/trust-check`),
};

/** The phone route's answer in the shape the shared device-request hook polls
 *  (control/useDeviceRequest.ts): `trusted` is `added`, `refused` is `failed`. */
export async function pollPhoneDevice(d: DeviceRequest): Promise<DeviceRequest> {
  const s = await phoneApi.device(d.requestId);
  const status: DeviceRequest["status"] =
    s.state === "trusted" ? "added" : s.state === "refused" ? "failed" : s.state === "expired" ? "expired" : "pending";
  return {
    ...d,
    check: s.digits || d.check,
    status,
    code: s.state === "refused" ? "refused" : d.code,
    // The machine that trusts it now, for the "Trusted" line.
    detail: s.machine ?? d.detail,
  };
}

export interface PhoneState {
  info: PhoneInfo | null;
  /** The server has no phone route (older, or the other branch not merged yet). */
  missing: boolean;
  error: string | null;
  /** Read again now (after an action). */
  refresh: () => Promise<void>;
  /** Take a fresh PhoneInfo an action returned (the Tailscale click). */
  apply: (info: PhoneInfo) => void;
}

/** GET /api/ui/phone every two seconds while mounted (every eight in a hidden tab). */
export function usePhoneInfo(): PhoneState {
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let on = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const i = await phoneApi.info();
        if (!on) return;
        setInfo(i);
        setError(null);
        setMissing(false);
      } catch (e) {
        if (!on) return;
        if (e instanceof ControlError && e.status === 404) setMissing(true);
        else setError(e instanceof Error ? e.message : String(e));
      }
      if (on) timer = setTimeout(read, document.visibilityState === "hidden" ? POLL_MS * 4 : POLL_MS);
    };
    void read();
    return () => {
      on = false;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);
  const refresh = async () => {
    try {
      setInfo(await phoneApi.info());
      setError(null);
    } catch {
      setTick((t) => t + 1);
    }
  };
  const apply = (i: PhoneInfo) => {
    setInfo(i);
    setError(null);
  };
  return { info, missing, error, refresh, apply };
}
