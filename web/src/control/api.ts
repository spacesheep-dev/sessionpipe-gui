// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The browser's side of /api/ui/control/* (server/control/README.md):
// pairings and their approval, a WebAuthn challenge, sending a signed command, the
// activity, the paired machines and device requests (a phone's own passkey, or the app's
// device key, waiting for a trusted device's key.add). JSON both ways, errors by code;
// every URL goes through lib/net.ts, which is the receiver itself in a browser and the
// shell's rx: protocol in the app.
import type {
  ControlActivity,
  HarnessAccount,
  Info,
  KeyType,
  MachineControl,
  MachineMode,
  SessionKey,
  StartFile,
  TlsInfo,
  TrustedKey,
} from "@shared/api";
import { ROUTES } from "@shared/api";
import { apiUrl } from "../lib/net";
import { sendingOriginOf, wrongOrigin } from "./origin";

export type { TrustedKey };

const BASE = ROUTES.ui.control;

export interface Pairing {
  code: string;
  check: string;
  status: "pending" | "approved" | "expired" | "done";
  open: boolean;
  fromIp: string;
  startedAt: string;
  expiresAt: string;
  machine: {
    id: string;
    name: string;
    harnesses: string[];
    modes: string[];
    version: string;
    folders?: string[];
    mode?: MachineMode;
    accounts?: HarnessAccount[];
    /** The pairing request's `key_types`: absent, the daemon takes passkeys only. */
    keyTypes?: KeyType[];
    firstPairing: boolean;
    keys: number;
  };
  rpId: string;
  /** base64url(sha256("sessionpipe.pair:" + machine + ":" + code)): the WebAuthn challenge. */
  challenge: string;
}

export interface Assertion {
  cred: string;
  ad: string;
  cd: string;
  sig: string;
}

export interface GrantBundle extends Assertion {
  str: string;
}

/** A device key's signature (CONTROL.md §3.2): its id and raw r‖s over the device message. */
export interface DeviceSignature {
  cred: string;
  sig: string;
}

export interface SendBody {
  machineId: string;
  cmd: string;
  csig?: string;
  grant?: GrantBundle | (DeviceSignature & { str: string });
  confirm?: Assertion | DeviceSignature;
  expires_in_s?: number;
  /** The session whose page sends it: unsigned, the receiver's own note on the activity. */
  from?: SessionKey;
}

export type PairedMachine = MachineControl & { name: string; createdAt: string; pairedAt?: string };

/** A device asking to be trusted (server/control/README.md, "Adding a device"): its own
 *  passkey and the six digits both ends show. `sent` once a trusted device's key.add was
 *  queued; `added` once the machine acked it delivered; `failed` with the machine's word. */
export interface DeviceRequest {
  requestId: string;
  check: string;
  key: TrustedKey;
  name: string;
  device: string;
  fromIp: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "sent" | "added" | "failed" | "expired";
  machineId?: string;
  activityId?: string;
  outcome?: string;
  code?: string;
  detail?: string;
}

/** A refusal from the server: `status` and the body's `reason`; `code` is the verifier's
 *  word on a refused command (`unsigned`, `untrusted_key`, `bad_csig`, `too_old`, …). */
export class ControlError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(detail ?? reason);
    this.name = "ControlError";
  }
}

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // no body
  }
  if (!res.ok) {
    const reason = typeof json.reason === "string" ? json.reason : `http_${res.status}`;
    const code = typeof json.code === "string" ? json.code : undefined;
    const detail =
      typeof json.detail === "string" ? json.detail : typeof json.error === "string" ? json.error : undefined;
    throw new ControlError(res.status, reason, code, detail);
  }
  return json as T;
}

export const controlApi = {
  pairings: () => call<{ pairings: Pairing[] }>("GET", `${BASE}/pairings`).then((r) => r.pairings),
  pairing: (code: string) => call<Pairing>("GET", `${BASE}/pair/${encodeURIComponent(code)}`),
  approve: (code: string, body: { key: TrustedKey; proof: Assertion | DeviceSignature; name?: string; by?: string }) =>
    call<{ ok: true; machineId: string; keyId: string; firstPairing: boolean }>(
      "POST",
      `${BASE}/pair/${encodeURIComponent(code)}/approve`,
      body,
    ),
  reject: (code: string) => call<void>("POST", `${BASE}/pair/${encodeURIComponent(code)}/reject`),
  challenge: () =>
    call<{ challenge: string; rpId: string; origin: string; expiresAt: string }>("GET", `${BASE}/challenge`),
  send: (body: SendBody) => call<ControlActivity>("POST", `${BASE}/send`, body),
  activity: (limit = 100) =>
    call<{ activity: ControlActivity[] }>("GET", `${BASE}/activity?limit=${limit}`).then((r) => r.activity),
  machines: () => call<{ machines: PairedMachine[] }>("GET", `${BASE}/machines`).then((r) => r.machines),
  /** One file a start will carry: held here under its hash, named in the signed `files`. */
  uploadFile: async (file: File): Promise<StartFile> => {
    const res = await fetch(apiUrl(`${BASE}/files?name=${encodeURIComponent(file.name)}`), {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", accept: "application/json" },
      body: file,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const reason = typeof json.reason === "string" ? json.reason : `http_${res.status}`;
      throw new ControlError(res.status, reason, undefined, typeof json.error === "string" ? json.error : undefined);
    }
    return json as unknown as StartFile;
  },
  deviceRequest: (body: { key: TrustedKey; name?: string }) => call<DeviceRequest>("POST", `${BASE}/devices`, body),
  devices: () => call<{ devices: DeviceRequest[] }>("GET", `${BASE}/devices`).then((r) => r.devices),
  device: (requestId: string) => call<DeviceRequest>("GET", `${BASE}/devices/${encodeURIComponent(requestId)}`),
  rejectDevice: (requestId: string) => call<void>("POST", `${BASE}/devices/${encodeURIComponent(requestId)}/reject`),
};

let rpIdPromise: Promise<string> | null = null;
let rpCache: string | undefined;
let tlsCache: TlsInfo | null | undefined;
let uiKeyCache: string | undefined;
let originCache: string | null | undefined;
let originsCache: string[] | undefined;
let infoCache: Info | undefined;
/** The receiver's Info as last read by `rpId()` (the app's signer reads its key types). */
export const lastInfo = (): Info | undefined => infoCache;

/** The rp id this receiver makes passkeys for (Info.control.rpId), fetched once. The
 *  same read remembers Info.tls for `tlsInfo()`. */
export function rpId(): Promise<string> {
  if (!rpIdPromise) {
    rpIdPromise = fetch(apiUrl(ROUTES.ui.info), { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<Info>)
      .then((i) => {
        infoCache = i;
        tlsCache = i.tls ?? null;
        uiKeyCache = i.uiKey || undefined;
        originCache = sendingOriginOf(i);
        originsCache = i.control?.origins;
        rpCache = i.control?.rpId ?? "localhost";
        return rpCache;
      })
      .catch((e) => {
        rpIdPromise = null;
        throw e;
      });
  }
  return rpIdPromise;
}

/** Forget the cached Info: the setup page turned TLS mode on, so the rp id and
 *  Info.tls changed under us. The next `rpId()` / `tlsInfo()` reads again. */
export function resetInfoCache(): void {
  rpIdPromise = null;
  rpCache = undefined;
  tlsCache = undefined;
  originCache = undefined;
  originsCache = undefined;
  infoCache = undefined;
}

/** The wrong-origin guard for this very page (control/origin.ts): the https origin
 *  sending works at when `location.hostname` is not under the rp id, else null.
 *  Synchronous from the cached Info, like `tlsInfo()`; null before the first read lands. */
export function wrongOriginHere(): string | null {
  // The guard is about passkeys, which are bound to an origin. The app signs with its
  // device key instead, and its page's origin is its own, never a WebAuthn one.
  if (inShell()) return null;
  if (originCache === undefined) void rpId().catch(() => {});
  if (typeof location === "undefined") return null;
  return wrongOrigin(location, rpCache, originsCache, originCache ?? null);
}

/** Inside the native app (its shell set the flag before any script ran). */
export const inShell = (): boolean => !!(globalThis as { sessionpipeShell?: unknown }).sessionpipeShell;

/** Info.tls as last read (by `rpId()`): null when the server has no TLS mode on,
 *  undefined before the first read lands. Synchronous, for hint text. */
export function tlsInfo(): TlsInfo | null | undefined {
  if (tlsCache === undefined) void rpId().catch(() => {});
  return tlsCache;
}

/** `pathWithSearch` on the https origin passkeys work at (TLS mode), with the UI key so
 *  the Mac's own browser is let in when the `.local` name resolves to its LAN address.
 *  Null when TLS is off or we are already on that origin. */
export function httpsPath(pathWithSearch: string): string | null {
  const tls = tlsInfo();
  if (!tls?.on) return null;
  return originPath(tls.httpsUrl, pathWithSearch);
}

/** `pathWithSearch` on `origin`, with the UI key so the page is let in; null when this
 *  page is already there. */
export function originPath(origin: string, pathWithSearch: string): string | null {
  if (typeof location === "undefined") return null;
  const base = new URL(origin);
  if (location.host === base.host && location.protocol === base.protocol) return null;
  const u = new URL(pathWithSearch, base);
  if (uiKeyCache && !u.searchParams.has("k")) u.searchParams.set("k", uiKeyCache);
  return u.toString();
}

/** This very page where sending works, when this is the wrong address (`wrongOriginHere`). */
export function wrongOriginHref(): string | null {
  const wrong = wrongOriginHere();
  if (!wrong || typeof location === "undefined") return null;
  return originPath(wrong, location.pathname + location.search + location.hash);
}

/** This very page on the https origin (see `httpsPath`). */
export function httpsHere(): string | null {
  if (typeof location === "undefined") return null;
  return httpsPath(location.pathname + location.search + location.hash);
}
