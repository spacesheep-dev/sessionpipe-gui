// SPDX-License-Identifier: Apache-2.0
// Owned by: control. The rows the control state keeps (a machine, a carried message, a
// pairing, a trusted key), what a machine says of itself (a hello's facts), and what reads
// a row for the UI. Nothing here is Node's: the machines and sends of a spacesheep account
// (control/remote.ts) are kept in these rows by the receiver and by a page that carries its
// own board, so this file is held to what a page has (store/browser.test.ts). state.ts,
// parse.ts and devicekeys.ts re-export what moved here from them.
import type { Assertion, COMMAND_TYPE, ControlCommand, SignedCommand } from "sessionpipe-core/control";
import type {
  Applied,
  ControlActivity,
  ControlKind,
  ControlOutcome,
  HarnessAccount,
  HarnessStartOptions,
  KeyType,
  MachineControl,
  MachineMode,
  MachinePool,
  MachineSummary,
  POOL_SESSION,
  PoolAction,
  StartFile,
  StartPermission,
  TrustedKey,
} from "../../shared/api.js";
import { cleanNote } from "../../shared/reason.js";

export const MACHINE_RE = /^m_[A-Za-z0-9_-]{16,40}$/;

export interface Hello {
  name: string;
  harnesses: string[];
  modes: string[];
  keys: string[];
  version: string;
  waiting: string[];
  folders: string[] | null;
  /** `inherit` (sessionpipe 0.10): no permission flag; null when not sent or unknown. */
  mode: MachineMode | null;
  accounts: HarnessAccount[];
  /** `files: true`: the machine takes `files` on a `start`. */
  files: boolean;
  /** `prompt_files: true`: and on a `prompt` (sessionpipe 0.10). */
  promptFiles: boolean;
  /** What a `start` may ask for, per harness (sessionpipe 0.10); null when not sent. */
  start: Record<string, HarnessStartOptions> | null;
  /** `key_types` (CONTROL.md §2): the kinds of key it takes; null when not sent (passkeys only). */
  keyTypes: KeyType[] | null;
  /** `pool` (sessionpipe 0.11): the accounts its daemon pools; null when not sent or malformed. */
  pool: MachinePool | null;
  /** `ask`: whether `sessionpipe ask` is on there (CONTROL.md §13); absent when not sent (a
   *  0.10 daemon says nothing about it). */
  ask?: boolean;
  /** `handoff: true`: it takes `reply_to` on a prompt or a start; absent when not sent. */
  handoff?: boolean;
}

export const FINAL_OUTCOMES = new Set<ControlOutcome>([
  "delivered",
  "expired",
  "unsupported",
  "failed",
  "refused",
  "unconfirmed",
]);
export const isFinal = (o: ControlOutcome | undefined): boolean => !!o && FINAL_OUTCOMES.has(o);

/** A device key's signature (CONTROL.md §3.2): its id and 64 bytes r‖s, base64url. */
export interface DeviceSignature {
  cred: string;
  sig: string;
}

/** The longest long-poll we hold (HTTP.md §1 control.wait_max_s). */
export const WAIT_MAX_S = 25;
/** A machine that polled within this is online (HTTP.md §3: 2 × wait_max_s). */
export const ONLINE_WINDOW_MS = 2 * WAIT_MAX_S * 1000;
/** A carried message lives at most a day (§3.3); an hour when the sender says nothing. */
export const EXPIRES_MAX_MS = 24 * 3600_000;
export const EXPIRES_DEFAULT_MS = 3600_000;
/** Settled messages kept per machine for the activity view. */
export const KEEP_SETTLED = 300;
export const SETTLED_TTL_MS = 7 * 86_400_000;
/** A send spacesheep carries is good for spacesheep's day (its CONTROL_EXPIRES_MS, the
 *  protocol's longest, §3.3), and spacesheep never hands one out older than that. Its row
 *  here takes no expiry of its own: it waits for spacesheep's word, and only when that word
 *  is still "queued" (or there is none) this long after the day is it called expired here
 *  (applyRemoteJobs): clocks, a computer's late poll. */
export const REMOTE_GRACE_MS = 3600_000;
/** A send this young is read for at the fast pace, whatever its computer shows. */
export const REMOTE_JUST_SENT_MS = 60_000;
/** The code of a spacesheep-carried row this receiver can no longer follow: the account
 *  that carried it is not the one connected (disconnected, or another account), or its
 *  machine was not on the account's list when it was read again after a restart. */
export const UNTRACKED_CODE = "untracked";
/** A code as spacesheep's jobs door may carry it: a word, as a computer's ack codes are. */
export const REMOTE_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Why a waiting spacesheep-carried row is not being followed right now. */
export type Unfollowed = "disconnected" | "revoked";
/** The one name of a spacesheep account here: its origin and the email it is signed in as. */
export const remoteAccountKey = (a: { origin: string; email: string }): string => `${a.origin} ${a.email}`;

/** A key a machine trusts, mirrored here whole: a device key keeps its `type`, `store`
 *  and `uv` (CONTROL.md §2), so the early check verifies it the way the machine does. */
export interface KeyRow {
  id: string;
  alg: number;
  spki: string;
  type?: "device";
  store?: "hardware";
  uv?: "each-use";
  name?: string;
  addedAt: string;
}

/** The key's own fields (TrustedKey), without this receiver's bookkeeping. */
export function keyOf(k: TrustedKey): TrustedKey {
  return {
    id: k.id,
    alg: k.alg,
    spki: k.spki,
    ...(k.type === "device" ? { type: k.type, store: k.store, uv: k.uv } : {}),
  };
}

/** A proof or a signature as the receiver carries it: a passkey's assertion, or a device
 *  key's `{cred, sig}` (CONTROL.md §3.2). */
export type Proof = Assertion | DeviceSignature;

export interface PairingRow {
  code: string;
  check: string;
  startedAt: string;
  expiresAt: string;
  fromIp: string;
  /** Started with no sink token (open pairing): the poll_key's hash gates its status. */
  open: boolean;
  pollHash?: string;
  approved?: { key: KeyRow; proof: Proof; by: string; at: string };
  /** The paired answer (and the token) went out once; the code answers 404 from then on. */
  deliveredAt?: string;
}

/** A machine as spacesheep's relay lists it (its publicMachine shape, the fields read here). */
export interface RemoteMachine {
  id: string;
  name: string;
  online?: boolean;
  last_seen?: number | null;
  folders?: string[];
  mode?: string;
  agents?: string[];
  cli_version?: string | null;
  modes?: string[];
  passkey_ids?: string[];
  files?: boolean;
  prompt_files?: boolean;
  key_types?: string[];
  ask?: boolean;
  handoff?: boolean;
  start?: Record<string, HarnessStartOptions>;
  pool?: MachinePool | null;
}

export interface MachineRow {
  id: string;
  name: string;
  createdAt: string;
  pairedAt?: string;
  tokenHash?: string;
  keys: KeyRow[];
  harnesses: string[];
  modes: string[];
  version: string;
  folders?: string[];
  mode?: MachineMode;
  accounts?: HarnessAccount[];
  /** The last hello's word on files and start options: each hello says them again, so a
   *  daemon that stopped advertising one (a downgrade) loses it here at once. */
  files?: boolean;
  promptFiles?: boolean;
  start?: Record<string, HarnessStartOptions>;
  /** Pairing or hello `key_types`; absent means passkeys only (an older daemon). */
  keyTypes?: KeyType[];
  /** The last hello's `pool` (sessionpipe 0.11); said again each time, so absent is absent. */
  pool?: MachinePool;
  /** The last hello's word on agents asking agents (CONTROL.md §13): `ask` on or off there,
   *  `handoff` when it takes `reply_to`. Absent when the hello said nothing (a 0.10 daemon). */
  ask?: boolean;
  handoff?: boolean;
  waiting?: string[];
  lastHelloAt?: string;
  lastPollAt?: string;
  /** A machine paired on a spacesheep account (docs/rfcs/08): held in memory from the
   *  relay's list, never saved, never polled here; its keys are ids only. */
  remote?: { via: "spacesheep"; origin: string; rpId: string; online: boolean; lastSeen?: string };
  pairings: PairingRow[];
}

export interface MessageRow {
  id: string;
  machineId: string;
  /** A send carried by spacesheep (a remote machine): its job id there, whose status the
   *  relay reports (state.applyRemoteJobs). */
  remoteJob?: number;
  /** The spacesheep account that carried it (remoteAccountKey: origin and email). A job id
   *  means something only on its own account; a row from before this field is matched by
   *  its machine on the first read of the relay's machine list. */
  remoteAccount?: string;
  /** Waiting, and not followed right now: no spacesheep account is connected (or the row's
   *  account is not yet known to be the connected one). Cleared when it is followed again. */
  unfollowed?: Unfollowed | true;
  cmd: string;
  csig?: string | null;
  grant?: SignedCommand["grant"];
  confirm?: SignedCommand["confirm"];
  at: string;
  expiresAt: string;
  kind: ControlKind;
  session: string;
  text?: string;
  /** Who queued it: "ui" for the browser, "test-door" for the conformance door. */
  via: string;
  outcome?: ControlOutcome;
  mode?: string;
  code?: string;
  detail?: string;
  reply?: string;
  replySeq?: number;
  takenAt?: string;
  ackedAt?: string;
  /** A fork or a started session the final ack named. */
  ackSession?: string;
  /** The final ack's `copy_of`: the session the command named, when a copy of it answered. */
  copyOf?: string;
  /** A start's signed folder, options and files, for the starting page and a retry. */
  cwd?: string;
  permission?: StartPermission;
  model?: string;
  files?: StartFile[];
  /** What the machine ran the start with (`taken`, `delivered`). */
  applied?: Applied;
  /** A pool command's action and account, as signed (pool.ts read them). */
  poolAction?: PoolAction;
  poolAccount?: string;
  /** A handoff: `reply_to` as signed on a prompt or a start (CONTROL.md §3.1). */
  replyTo?: string;
  /** The UI's unsigned note of which session's page sent it (SendBody.from). */
  from?: string;
}

export const nowIso = () => new Date().toISOString();
/** A send spacesheep carried (enqueueRemote), whichever account. */
export const isRemoteRow = (m: MessageRow): boolean => typeof m.remoteJob === "number";

/** A `pool` command's fields, read from the exact string. */
export interface PoolCommand {
  v: 1;
  t: typeof COMMAND_TYPE;
  machine: string;
  kind: "pool";
  session: typeof POOL_SESSION;
  pool_action: PoolAction;
  pool_account?: string;
  pool_order?: string[];
  pool_code?: string;
  note?: string;
  nonce: string;
  iat: number;
}

/** The receiver's reading of one carried message, for the UI (never the signature). */
export function toActivity(m: MessageRow): ControlActivity {
  const a: ControlActivity = {
    id: m.id,
    machineId: m.machineId,
    kind: m.kind,
    session: m.session,
    at: m.at,
    expiresAt: m.expiresAt,
  };
  if (m.text !== undefined) a.text = m.text;
  if (m.outcome) a.outcome = m.outcome;
  if (m.mode) a.mode = m.mode;
  if (m.code) a.code = m.code;
  // A row spacesheep carried has its job's note as its detail: outside text, kept as it
  // came and handed on as plain visible text (shared/reason.ts), here, where every reader
  // of a row gets it. Whole, up to what a daemon may send: the page reads the sign-in link
  // of a pooled account out of it, so nothing is cut short of that and nothing is added.
  // A row of this receiver's own machines is as it was.
  const detail = isRemoteRow(m) ? cleanNote(m.detail) : m.detail;
  if (detail) a.detail = detail;
  if (m.reply !== undefined) a.reply = m.reply;
  if (m.replySeq !== undefined) a.replySeq = m.replySeq;
  if (m.ackSession) a.ackSession = m.ackSession;
  if (m.copyOf) a.copyOf = m.copyOf;
  if (m.takenAt) a.takenAt = m.takenAt;
  if (m.ackedAt) a.ackedAt = m.ackedAt;
  if (m.cwd) a.cwd = m.cwd;
  if (m.permission) a.permission = m.permission;
  if (m.model) a.model = m.model;
  if (m.files) a.files = m.files;
  if (m.applied) a.applied = m.applied;
  if (m.poolAction) a.poolAction = m.poolAction;
  if (m.poolAccount) a.poolAccount = m.poolAccount;
  if (m.replyTo) a.replyTo = m.replyTo;
  if (m.from) a.from = m.from;
  if (m.unfollowed && !isFinal(m.outcome)) a.unfollowed = m.unfollowed === "revoked" ? "revoked" : "disconnected";
  return a;
}

/** What the UI shows of a command: its text, or a permission answer's decision and note. */
export function describe(cmd: ControlCommand): string | undefined {
  if (typeof cmd.text === "string") return cmd.text;
  if (cmd.kind === "permission.answer") return cmd.note ? `${cmd.decision}: ${cmd.note}` : cmd.decision;
  if (cmd.kind === "key.add") return cmd.name ? `trust ${cmd.name}` : "trust a new device";
  if ((cmd.kind as string) === "pool") return describePool(cmd as unknown as PoolCommand);
  return cmd.note;
}

/** A pool command in words, as the activity shows it: "Turn the pool on", "Move Fiction
 *  first", "Refresh dev@example.com". `names` turns an account id into what the person
 *  calls it (its label, else its email, else the id itself); the activity keeps the id. */
export function describePool(cmd: PoolCommand, names: (id: string) => string = (id) => id): string {
  const who = cmd.pool_account ? names(cmd.pool_account) : "an account";
  if (cmd.pool_action === "refresh" && !cmd.pool_account) return "Refresh usage";
  switch (cmd.pool_action) {
    case "on":
      return "Turn the pool on";
    case "off":
      return "Turn the pool off";
    case "enable":
      return `Turn ${who} on`;
    case "disable":
      return `Turn ${who} off`;
    case "remove":
      return `Remove ${who}`;
    case "refresh":
      return `Refresh ${who}`;
    case "order": {
      const first = cmd.pool_order?.[0];
      return first ? `Move ${names(first)} first` : "Reorder the accounts";
    }
    case "login.begin":
      return "Sign in to Claude";
    case "login.complete":
      return "Finish signing in";
  }
}

/** The pairing request's or hello's facts about the machine (name, harnesses, folders, mode, accounts). */
export function applyFacts(m: MachineRow, h: Hello): void {
  if (h.name) m.name = h.name;
  if (h.harnesses.length) m.harnesses = h.harnesses;
  if (h.modes.length) m.modes = h.modes;
  if (h.version) m.version = h.version;
  if (h.folders) m.folders = h.folders;
  if (h.mode) m.mode = h.mode;
  if (h.accounts.length) m.accounts = h.accounts;
  // Said again in every hello (CONTROL.md §2): absent now means absent.
  if (h.files) m.files = true;
  else delete m.files;
  if (h.promptFiles) m.promptFiles = true;
  else delete m.promptFiles;
  if (h.start) m.start = h.start;
  else delete m.start;
  if (h.keyTypes) m.keyTypes = h.keyTypes;
  else delete m.keyTypes;
  if (h.pool) m.pool = h.pool;
  else delete m.pool;
  if (h.ask !== undefined) m.ask = h.ask;
  else delete m.ask;
  if (h.handoff) m.handoff = true;
  else delete m.handoff;
}

/** A machine as the UI reads it. `queued`: how many of its messages are not finally acked;
 *  `tilde`: whoever verifies its commands takes a start's `~/…` folder, and so does it
 *  (control/tilde.ts). */
export function machineControl(m: MachineRow, o: { queued: number; tilde: boolean }): MachineControl {
  const c: MachineControl = {
    machineId: m.id,
    online: m.remote ? m.remote.online : !!m.lastPollAt && Date.now() - Date.parse(m.lastPollAt) < ONLINE_WINDOW_MS,
    ...(m.remote ? { remote: { via: m.remote.via, origin: m.remote.origin, rpId: m.remote.rpId } } : {}),
    keys: m.keys.map((k) => ({
      id: k.id,
      alg: k.alg,
      ...(k.type === "device" ? { type: k.type } : {}),
      ...(k.name ? { name: k.name } : {}),
      addedAt: k.addedAt,
    })),
    queued: o.queued,
  };
  if (m.lastPollAt) c.lastPollAt = m.lastPollAt;
  if (m.lastHelloAt) c.lastHelloAt = m.lastHelloAt;
  if (m.mode) c.mode = m.mode;
  if (m.folders) c.folders = m.folders;
  if (m.harnesses.length) c.harnesses = m.harnesses;
  if (m.modes.length) c.modes = m.modes;
  if (m.version) c.version = m.version;
  if (m.accounts) c.accounts = m.accounts;
  if (m.files) c.files = true;
  if (m.promptFiles) c.promptFiles = true;
  if (o.tilde) c.tilde = true;
  if (m.start) c.start = m.start;
  if (m.keyTypes) c.keyTypes = m.keyTypes;
  if (m.pool) c.pool = m.pool;
  if (m.ask !== undefined) c.ask = m.ask;
  if (m.handoff) c.handoff = true;
  return c;
}

/** The row of a carried command: what the receiver keeps of it and the UI reads (never
 *  more of the signature than it came with). `id` is the row's own (a ULID at `now`). */
export function messageRow(
  m: MachineRow,
  signed: SignedCommand,
  cmd: ControlCommand,
  o: { expiresInMs?: number; via: string; from?: string; id: string; now: number },
): MessageRow {
  const now = o.now;
  const ttl = Math.min(EXPIRES_MAX_MS, Math.max(1000, o.expiresInMs ?? EXPIRES_DEFAULT_MS));
  const row: MessageRow = {
    id: o.id,
    machineId: m.id,
    cmd: signed.cmd,
    at: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    kind: cmd.kind,
    session: cmd.session,
    via: o.via,
  };
  if (signed.csig) row.csig = signed.csig;
  if (signed.grant) row.grant = signed.grant;
  if (signed.confirm) row.confirm = signed.confirm;
  const text =
    (cmd.kind as string) === "pool"
      ? describePool(cmd as unknown as PoolCommand, (id) => accountName(m, id))
      : describe(cmd);
  if (text !== undefined) row.text = text;
  if ((cmd.kind as string) === "pool") {
    const c = cmd as unknown as PoolCommand;
    row.poolAction = c.pool_action;
    if (c.pool_account) row.poolAccount = c.pool_account;
  }
  if (o.from) row.from = o.from;
  // A handoff (CONTROL.md §3.1): the session the daemon relays the answer into. Inside the
  // signed bytes; the caller's second look (ui.ts) held it to the machine's hello.
  const replyTo = (cmd as ControlCommand & { reply_to?: unknown }).reply_to;
  if ((cmd.kind === "prompt" || cmd.kind === "start") && typeof replyTo === "string") row.replyTo = replyTo;
  if (cmd.kind === "start") {
    // The fields a start may carry beyond core 0.7's type (CONTROL.md §3.1); the caller's
    // pre-check (ui.ts) already held them to the machine's hello.
    const c = cmd as ControlCommand & { files?: StartFile[]; permission?: StartPermission; model?: string };
    if (typeof c.cwd === "string") row.cwd = c.cwd;
    if (c.permission) row.permission = c.permission;
    if (c.model) row.model = c.model;
    if (Array.isArray(c.files) && c.files.length) {
      row.files = c.files.map((f) => ({ name: f.name, type: f.type, size: f.size, sha256: f.sha256 }));
    }
  }
  return row;
}

/** What the person calls a pooled account on this machine: its pool label, else its
 *  email (from the pool or the hello's accounts), else the id as it is. */
export function accountName(m: MachineRow, id: string): string {
  const pooled = m.pool?.accounts.find((a) => a.id === id);
  if (pooled?.label) return pooled.label;
  if (pooled?.email) return pooled.email;
  const named = m.accounts?.find((a) => a.id === id);
  return named?.email ?? named?.name ?? id;
}

/** What a queue keeps: every message not finally acked, and those that are for a week,
 *  KEEP_SETTLED at most, in id order. */
export function keptQueue(q: MessageRow[], now: number): MessageRow[] {
  const live = q.filter((m) => !isFinal(m.outcome));
  const settled = q
    .filter((m) => isFinal(m.outcome) && now - Date.parse(m.ackedAt ?? m.at) < SETTLED_TTL_MS)
    .slice(-KEEP_SETTLED);
  return [...live, ...settled].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The carried commands of every queue as the UI reads them, newest first. */
export function activity(queues: Map<string, MessageRow[]>, limit = 100): ControlActivity[] {
  const all: MessageRow[] = [];
  for (const q of queues.values()) all.push(...q);
  all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return all.slice(0, Math.max(0, limit)).map(toActivity);
}

/** One carried command by its id, whichever machine's queue holds it. */
export function activityById(queues: Map<string, MessageRow[]>, id: string): ControlActivity | undefined {
  for (const q of queues.values()) {
    const row = q.find((m) => m.id === id);
    if (row) return toActivity(row);
  }
  return undefined;
}

/** A machine the UI lists: it paired (it holds a token here, or a key is trusted for it). */
export const isPaired = (m: MachineRow): boolean => !!m.tokenHash || m.keys.length > 0;

/** A paired machine as GET /machines lists it. */
export function pairedMachine(
  m: MachineRow,
  control: MachineControl,
): MachineControl & { name: string; createdAt: string; pairedAt?: string } {
  return { name: m.name, createdAt: m.createdAt, ...(m.pairedAt ? { pairedAt: m.pairedAt } : {}), ...control };
}

/** A machine's stream frame from its control reading alone: the board merges its own
 *  counts in (web/src/data/store.ts). */
export function machineFrame(name: string, control: MachineControl): MachineSummary {
  return {
    name,
    lastAt: control.lastPollAt ?? control.lastHelloAt ?? new Date().toISOString(),
    harnesses: Object.fromEntries((control.harnesses ?? []).map((h) => [h, undefined])),
    sessions: 0,
    working: 0,
    needsYou: 0,
    control,
  };
}
