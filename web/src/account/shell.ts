// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The page's side of the contract with the native hub for a spacesheep
// account (docs/rfcs/08, "The phone on an account"): what the shell says of the account
// this window shows, and the commands the hub answers for it. The hub holds the account's
// key; nothing here takes or returns it. The commands are handed to the backend as one
// object (`ShellCalls`), so a test hands it a hub of its own.
import { invoke, listen } from "../native/bridge";

/** The account this window shows, as `window.sessionpipeShell` says it. */
export interface AccountShell {
  /** The receiver id of the account: 52 characters, its origin's and email's own. */
  id: string;
  origin: string;
  email: string;
  /** As the window opened; `acct_status` and the `account` event say how it is now. */
  state: AccountState;
  /** Where the five doors are asked: `${rxBase}<path>`. */
  rxBase: string;
  appVersion: string;
  platform: string;
  features: readonly string[];
}

/** `ok`; `unauthorized`: spacesheep answered 401 to the key and nothing has succeeded
 *  since; `no_key`: the entry is here and its key is not. */
export type AccountState = "ok" | "unauthorized" | "no_key";

const str = (v: unknown): v is string => typeof v === "string" && v !== "";
const stateOf = (v: unknown): AccountState => (v === "unauthorized" || v === "no_key" ? v : "ok");

/** The shell's contract read for an account: null when this window shows a receiver, no
 *  receiver, or is not the app at all. */
export function accountShell(
  raw: unknown = (globalThis as { sessionpipeShell?: unknown }).sessionpipeShell,
): AccountShell | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const r = s.receiver as Record<string, unknown> | null | undefined;
  if (s.v !== 1 || !r || typeof r !== "object" || r.kind !== "spacesheep") return null;
  if (!str(r.id) || !str(r.origin) || !str(s.rxBase)) return null;
  return {
    id: r.id,
    origin: r.origin,
    email: str(r.email) ? r.email : "",
    state: stateOf(r.state),
    rxBase: s.rxBase,
    appVersion: str(s.appVersion) ? s.appVersion : "",
    platform: str(s.platform) ? s.platform : "",
    features: Array.isArray(s.features) ? s.features.filter(str) : [],
  };
}

/** One account in `acct_status`. */
export interface AccountRow {
  id: string;
  origin: string;
  email: string;
  state: AccountState;
  connectedAt?: string;
  active?: boolean;
  /** This phone's device key, once `acct_device_ask` succeeded. */
  deviceKeyId?: string;
}

/** `acct_status`'s answer, and the `account` event's payload. */
export interface AccountStatus {
  enabled: boolean;
  accounts: AccountRow[];
  connect?: unknown;
}

/** An error of the hub's commands. */
export interface HubError {
  code: string;
  message: string;
  retryAfterS?: number;
  upstream?: string;
}

export const hubError = (e: unknown): HubError => {
  const x = (e ?? {}) as Partial<HubError>;
  return {
    code: str(x.code) ? x.code : "failed",
    message: str(x.message) ? x.message : typeof e === "string" ? e : "failed",
    ...(typeof x.retryAfterS === "number" ? { retryAfterS: x.retryAfterS } : {}),
    ...(str(x.upstream) ? { upstream: x.upstream } : {}),
  };
};

/** `acct_device_ask`'s answer: the number spacesheep's Devices page shows beside the
 *  request, the key's id, the machines that trust it already. */
export interface DeviceAsked {
  code: string;
  keyId: string;
  trustedOn: string[];
  devicesUrl?: string;
}

/** `acct_disconnect`'s answer. The key is forgotten here and never revoked there. */
export interface Disconnected {
  id: string;
  origin: string;
  email: string;
  forgotten: true;
  revoked: false;
  revokeUrl: string;
  note: string;
}

/** A session that needs the person, as the page hands it over (`acct_needs`). */
export interface NeedsSession {
  key: string;
  harness: string;
  id: string;
  title?: string;
  machine?: string;
  cwd?: string;
  state: "needs_you";
  stateSince: string;
  openAttentions: {
    attentionId: string;
    kind: string;
    tool?: string;
    message?: string;
    at: string;
    answerable: boolean;
  }[];
}

/** The feature the shell lists once it takes `acct_needs` (NOTES "For the hub"). */
export const NEEDS_FEATURE = "account-needs";

/** The hub's commands for an account, by the names the contract gives them. */
export interface ShellCalls {
  status(): Promise<AccountStatus>;
  disconnect(id: string): Promise<Disconnected>;
  deviceAsk(id: string): Promise<DeviceAsked>;
  docGet(id: string, name: string): Promise<unknown>;
  docSet(id: string, name: string, value: unknown): Promise<number>;
  docDelete(id: string, name: string): Promise<boolean>;
  /** The `account` event: `acct_status`'s value whenever it changes. */
  onAccount(fn: (s: AccountStatus) => void): Promise<() => void>;
  /** The sessions that need the person. Only where the shell lists NEEDS_FEATURE. */
  needs(id: string, sessions: NeedsSession[]): Promise<unknown>;
}

/** The commands over the app's own IPC. */
export const tauriCalls: ShellCalls = {
  status: () => invoke<AccountStatus>("acct_status"),
  disconnect: (id) => invoke<Disconnected>("acct_disconnect", { id }),
  deviceAsk: (id) => invoke<DeviceAsked>("acct_device_ask", { id }),
  docGet: (id, name) => invoke<unknown>("acct_doc_get", { id, name }),
  docSet: (id, name, value) => invoke<number>("acct_doc_set", { id, name, value }),
  docDelete: (id, name) => invoke<boolean>("acct_doc_delete", { id, name }),
  onAccount: (fn) => listen<AccountStatus>("account", (s) => s && Array.isArray(s.accounts) && fn(s)),
  needs: (id, sessions) => invoke<unknown>("acct_needs", { id, sessions }),
};
