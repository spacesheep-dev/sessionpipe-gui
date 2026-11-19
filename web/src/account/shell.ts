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

/** Where a connect stands. `asking`: spacesheep approved it and the hub holds the key until
 *  the person answers its question on this phone. */
export type ConnectState = "pending" | "asking" | "approved" | "denied" | "declined" | "expired" | "failed";

/** A connect, as `acct_connect_start` answers it and `acct_status.connect` says it after.
 *  Never the link, the code or the key: the hub opens the link itself. */
export interface ConnectView {
  origin: string;
  /** Four digits, shown here and on spacesheep's confirm page. */
  digits: string;
  expiresAt: string;
  state: ConnectState;
  /** On `approved`: the account's receiver id, for `rx_select`, and whose it is. */
  receiver?: string;
  email?: string;
  /** On `failed`: `bad_answer`, `conflict`, `keystore`, `io`. */
  error?: string;
  /** A key was made on spacesheep and is not kept here: where to revoke it, in the hub's words. */
  revokeUrl?: string;
  note?: string;
}

const CONNECT_STATES: readonly string[] = ["pending", "asking", "approved", "denied", "declined", "expired", "failed"];

/** A connect read from what the hub said, or null (none under way, none just ended). */
export function connectView(raw: unknown): ConnectView | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (!str(c.origin) || !str(c.state) || !CONNECT_STATES.includes(c.state)) return null;
  return {
    origin: c.origin,
    digits: str(c.digits) ? c.digits : "",
    expiresAt: str(c.expiresAt) ? c.expiresAt : "",
    state: c.state as ConnectState,
    ...(str(c.receiver) ? { receiver: c.receiver } : {}),
    ...(str(c.email) ? { email: c.email } : {}),
    ...(str(c.error) ? { error: c.error } : {}),
    ...(str(c.revokeUrl) ? { revokeUrl: c.revokeUrl } : {}),
    ...(str(c.note) ? { note: c.note } : {}),
  };
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

/** The hub's commands for connecting an account, and the one that shows it. They need no
 *  account in this window: the first run uses them with no receiver at all. */
export interface ConnectCalls {
  status(): Promise<AccountStatus>;
  /** `origin` absent: spacesheep.dev. */
  start(origin?: string): Promise<ConnectView>;
  /** The hub opens the pending connect's page in the system browser. */
  open(): Promise<void>;
  /** True when a pending connect was stopped; false when it only cleared an outcome. */
  cancel(): Promise<boolean>;
  /** Shows the receiver (the account) in this window: the shell reopens the window on it. */
  select(id: string): Promise<void>;
  onAccount(fn: (s: AccountStatus) => void): Promise<() => void>;
}

export const tauriConnect: ConnectCalls = {
  status: () => invoke<AccountStatus>("acct_status"),
  start: async (origin) => {
    const c = connectView(await invoke<unknown>("acct_connect_start", origin ? { origin } : {}));
    if (!c) throw { code: "bad_answer", message: "The app's answer was not a connect." };
    return c;
  },
  open: () => invoke<void>("acct_connect_open"),
  cancel: () => invoke<boolean>("acct_connect_cancel"),
  select: (id) => invoke<void>("rx_select", { id }),
  onAccount: (fn) => listen<AccountStatus>("account", (s) => s && Array.isArray(s.accounts) && fn(s)),
};

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
