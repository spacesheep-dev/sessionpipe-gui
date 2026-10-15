// SPDX-License-Identifier: Apache-2.0
// Owned by: onboarding. The browser's side of /api/ui/setup: one shared poller for the
// status (fast while the setup page is open, slow for the rail's dot), the six actions,
// and the per-device "seen" flag that keeps the first-run redirect to once.
import type { RemoteInfo, SetupStatus } from "@shared/api";
import { ROUTES } from "@shared/api";
import { useEffect, useSyncExternalStore } from "react";

const BASE = ROUTES.ui.setup;
const FAST_MS = 2000;
const SLOW_MS = 30_000;
/** Off this machine the server answers 403; asking again later costs nothing. */
const AWAY_MS = 60_000;

export interface SetupState {
  /** null until the first answer; false when the server said this page is not on the machine. */
  local: boolean | null;
  status: SetupStatus | null;
  error: string | null;
  /** When `status` was read (ms). */
  at: number;
}

export class SetupError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string" && body.error !== body.reason
          ? body.error
          : typeof body.reason === "string"
            ? body.reason
            : `HTTP ${status}`,
    );
    this.name = "SetupError";
  }
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // no body
  }
  if (!res.ok) throw new SetupError(res.status, json);
  return json as T;
}

export interface TlsOnResult {
  ok: true;
  restartRequired: boolean;
  tls?: { on: boolean; hostname: string; httpsUrl: string; caFingerprint: string };
  rpId: string;
  command?: string;
}
export interface TrustResult {
  trusted: boolean;
  settingPresent?: boolean;
  added?: boolean;
  caCertPath: string;
  platform?: string;
  steps?: string[];
  manual?: string;
  error?: string;
}

/** POST /remote: the public url is set and remembered, and the rp id switches to its host now. */
export interface RemoteOnResult {
  ok: true;
  remote: RemoteInfo;
  rpId: string;
}

export const setupApi = {
  tlsOn: () => post<TlsOnResult>("/tls/on"),
  tlsTrust: () => post<TrustResult>("/tls/trust"),
  pair: (folders: string[]) => post<{ started: boolean; active?: boolean }>("/pair", { folders }),
  pairCancel: () => post<{ cancelled: boolean }>("/pair/cancel"),
  remoteOn: (url: string) => post<RemoteOnResult>("/remote", { url }),
  remoteOff: () => post<{ ok: true }>("/remote/off"),
};

// ---------- the shared poller ----------

let state: SetupState = { local: null, status: null, error: null, at: 0 };
const listeners = new Set<() => void>();
let fast = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

const set = (patch: Partial<SetupState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

async function read(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/status`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (res.status === 403) {
      set({ local: false, error: null });
      return;
    }
    if (!res.ok) {
      set({ error: `status ${res.status}` });
      return;
    }
    set({ local: true, status: (await res.json()) as SetupStatus, error: null, at: Date.now() });
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** Read the status now (after an action) and keep the schedule going. */
export function refreshSetup(): Promise<void> {
  if (!inflight)
    inflight = read().finally(() => {
      inflight = null;
      schedule();
    });
  return inflight;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (listeners.size === 0) return;
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  const ms = state.local === false ? AWAY_MS : fast > 0 ? (hidden ? FAST_MS * 4 : FAST_MS) : SLOW_MS;
  timer = setTimeout(() => void refreshSetup(), ms);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  if (listeners.size === 1) void refreshSetup();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
};
const get = () => state;

/** The setup status, live. `fast` (the setup page) polls every two seconds; the rest of
 *  the app every thirty. */
export function useSetupStatus(fastPoll = false): SetupState {
  const s = useSyncExternalStore(subscribe, get, get);
  useEffect(() => {
    if (!fastPoll) return;
    fast++;
    if (fast === 1) void refreshSetup();
    return () => {
      fast--;
      schedule();
    };
  }, [fastPoll]);
  return s;
}

// ---------- the per-device flag ----------

const SEEN_KEY = "sessionpipe-gui.setup.seen";

export function setupSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}
export function markSetupSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // private mode: the redirect simply happens again next time
  }
}
