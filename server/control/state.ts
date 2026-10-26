// SPDX-License-Identifier: Apache-2.0
// What the receiver side of CONTROL.md holds: the machines that paired (with a hashed
// bearer token each and the passkeys approved for them), the pairings in flight, and
// one queue of carried commands per machine. Persisted as small JSON files under
// <stateDir>/control/ so a restart loses nothing a machine is still polling for:
//
//   control/machines.json          machines, their keys, token hashes, pairings
//   control/queue/<machine id>.json  that machine's messages, queued and settled
//
// Device requests (a phone's own passkey waiting for a trusted device's `key.add`) live in
// memory only: ten minutes, then gone.
//
// A receiver carries commands and never signs them (§1): nothing here can mint a
// signature, only verify one. Tokens are stored hashed; a leaked state file hands
// nobody a machine's queue.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ulid } from "sessionpipe-core";
import type { Assertion, ControlCommand, SignedCommand } from "sessionpipe-core/control";
import type {
  ControlActivity,
  ControlKind,
  ControlOutcome,
  HarnessStartOptions,
  KeyType,
  MachineControl,
  StartFile,
  StartPermission,
  TrustedKey,
} from "../../shared/api.js";
import type { DeviceSignature } from "./devicekeys.js";
import { FileStore } from "./files.js";
import { type AckIn, type HarnessAccount, type Hello, isFinal } from "./parse.js";

/** The longest long-poll we hold (HTTP.md §1 control.wait_max_s). */
export const WAIT_MAX_S = 25;
/** A machine that polled within this is online (HTTP.md §3: 2 × wait_max_s). */
export const ONLINE_WINDOW_MS = 2 * WAIT_MAX_S * 1000;
/** A pairing code lives this long unapproved (CONTROL.md §2 step 3). */
export const PAIR_TTL_MS = 10 * 60_000;
/** A `taken` ack pauses redelivery for this long (CONTROL.md §10). */
export const TAKEN_PAUSE_MS = 35 * 60_000;
/** A carried message lives at most a day (§3.3); an hour when the sender says nothing. */
export const EXPIRES_MAX_MS = 24 * 3600_000;
export const EXPIRES_DEFAULT_MS = 3600_000;
/** Settled messages kept per machine for the activity view. */
const KEEP_SETTLED = 300;
const SETTLED_TTL_MS = 7 * 86_400_000;
/** A pairing row is forgotten this long after it expired or was handed over. */
const PAIRING_TTL_MS = 3600_000;
/** A device request (a phone's own passkey waiting for a trusted device's `key.add`) lives
 *  this long unapproved (CONTROL.md §2), and is remembered an hour past that so the phone's
 *  poll reads `expired` rather than 404. Never persisted: a restart forgets it. */
export const DEVICE_TTL_MS = 10 * 60_000;
const DEVICE_KEEP_MS = 3600_000;

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
  mode?: "safe" | "auto";
  accounts?: HarnessAccount[];
  /** The last hello's word on files and start options: each hello says them again, so a
   *  daemon that stopped advertising one (a downgrade) loses it here at once. */
  files?: boolean;
  promptFiles?: boolean;
  home?: string;
  start?: Record<string, HarnessStartOptions>;
  /** Pairing or hello `key_types`; absent means passkeys only (an older daemon). */
  keyTypes?: KeyType[];
  waiting?: string[];
  lastHelloAt?: string;
  lastPollAt?: string;
  pairings: PairingRow[];
}

/** A device that wants to be trusted: its passkey, made on that device, and the six
 *  digits the person compares on a device the machine already trusts. Nothing here hands
 *  out trust; only a signed `key.add` carried to the machine does (CONTROL.md §2). */
export interface DeviceRequestRow {
  requestId: string;
  check: string;
  key: TrustedKey;
  /** What the person called it on the phone ("Misha's iPhone"). */
  name: string;
  /** A short label from the user agent ("iPhone"), for the approving page. */
  device: string;
  fromIp: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "sent" | "added" | "failed" | "expired";
  /** Set once a trusted device's key.add for this key was queued. */
  machineId?: string;
  activityId?: string;
  /** The machine's final word on the key.add, when it was not `delivered`. */
  outcome?: ControlOutcome;
  code?: string;
  detail?: string;
  doneAt?: string;
}

export interface MessageRow {
  id: string;
  machineId: string;
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
  /** A start's signed folder, options and files, for the starting page and a retry. */
  cwd?: string;
  permission?: StartPermission;
  model?: string;
  files?: StartFile[];
  /** What the machine ran the start with (`taken`, `delivered`). */
  applied?: { permission?: StartPermission; model?: string };
}

interface MachinesFile {
  v: 1;
  machines: MachineRow[];
}
interface QueueFile {
  v: 1;
  messages: MessageRow[];
}

const nowIso = () => new Date().toISOString();
const b64 = (n: number) => randomBytes(n).toString("base64url");
export const hashToken = (t: string): string => createHash("sha256").update(`sessionpipe-gui.token:${t}`).digest("hex");
export const hashPollKey = (k: string): string => createHash("sha256").update(`sessionpipe.poll:${k}`).digest("hex");
const sameHash = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  } catch {
    return null;
  }
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
  if (m.detail) a.detail = m.detail;
  if (m.reply !== undefined) a.reply = m.reply;
  if (m.replySeq !== undefined) a.replySeq = m.replySeq;
  if (m.ackSession) a.ackSession = m.ackSession;
  if (m.takenAt) a.takenAt = m.takenAt;
  if (m.ackedAt) a.ackedAt = m.ackedAt;
  if (m.cwd) a.cwd = m.cwd;
  if (m.permission) a.permission = m.permission;
  if (m.model) a.model = m.model;
  if (m.files) a.files = m.files;
  if (m.applied) a.applied = m.applied;
  return a;
}

/** What the UI shows of a command: its text, or a permission answer's decision and note. */
function describe(cmd: ControlCommand): string | undefined {
  if (typeof cmd.text === "string") return cmd.text;
  if (cmd.kind === "permission.answer") return cmd.note ? `${cmd.decision}: ${cmd.note}` : cmd.decision;
  if (cmd.kind === "key.add") return cmd.name ? `trust ${cmd.name}` : "trust a new device";
  return cmd.note;
}

type Waiter = { resolve: (messages: MessageRow[]) => void; timer: NodeJS.Timeout };

export class ControlState {
  private machinesById = new Map<string, MachineRow>();
  private queues = new Map<string, MessageRow[]>();
  private waiters = new Map<string, Set<Waiter>>();
  /** Device requests in flight, in memory only. */
  private devices = new Map<string, DeviceRequestRow>();
  private sweeper: NodeJS.Timeout | null = null;
  private filesSweptAt = 0;
  /** The bytes of the files starts carry (files.ts), under <dir>/files. */
  readonly files: FileStore;
  /** Called with every message whose state changed (queued, acked, expired). */
  onMessage: (m: MessageRow) => void = () => {};
  /** Called when any machine row changed (pairing, hello, poll, removal) or a machine's
   *  online reading flipped, so the UI can refresh its machine list without an event. */
  onMachines: () => void = () => {};
  private onlineSig = "";

  constructor(readonly dir: string) {
    this.files = new FileStore(path.join(dir, "files"));
    const mf = readJson<MachinesFile>(this.machinesFile);
    for (const m of mf?.machines ?? []) if (m && typeof m.id === "string") this.machinesById.set(m.id, m);
    const qdir = path.join(dir, "queue");
    if (existsSync(qdir))
      for (const f of readdirSync(qdir)) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        const q = readJson<QueueFile>(path.join(qdir, f));
        if (q?.messages && this.machinesById.has(id)) this.queues.set(id, q.messages);
        else rmSync(path.join(qdir, f), { force: true });
      }
    this.sweeper = setInterval(() => this.sweep(), 5000);
    this.sweeper.unref();
  }

  private get machinesFile(): string {
    return path.join(this.dir, "machines.json");
  }
  private queueFile(id: string): string {
    return path.join(this.dir, "queue", `${id}.json`);
  }
  private saveMachines(): void {
    const now = Date.now();
    for (const m of this.machinesById.values())
      m.pairings = m.pairings.filter((p) => {
        const dead = p.deliveredAt ? Date.parse(p.deliveredAt) : Date.parse(p.expiresAt);
        return now - dead < PAIRING_TTL_MS;
      });
    writeAtomic(this.machinesFile, { v: 1, machines: [...this.machinesById.values()] } satisfies MachinesFile);
    this.checkOnline();
    this.onMachines();
  }
  private saveQueue(id: string): void {
    const q = this.queues.get(id);
    if (!q) {
      rmSync(this.queueFile(id), { force: true });
      return;
    }
    const now = Date.now();
    const live = q.filter((m) => !isFinal(m.outcome));
    const settled = q
      .filter((m) => isFinal(m.outcome) && now - Date.parse(m.ackedAt ?? m.at) < SETTLED_TTL_MS)
      .slice(-KEEP_SETTLED);
    const kept = [...live, ...settled].sort((a, b) => (a.id < b.id ? -1 : 1));
    this.queues.set(id, kept);
    writeAtomic(this.queueFile(id), { v: 1, messages: kept } satisfies QueueFile);
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const [id, set] of this.waiters) {
      for (const w of set) {
        clearTimeout(w.timer);
        w.resolve([]);
      }
      this.waiters.delete(id);
    }
  }

  // --- machines -------------------------------------------------------------------

  machine(id: string): MachineRow | undefined {
    return this.machinesById.get(id);
  }
  allMachines(): MachineRow[] {
    return [...this.machinesById.values()];
  }

  /** The machine a bearer token belongs to, by its hash; undefined for any other bearer. */
  machineByToken(bearer: string | undefined): MachineRow | undefined {
    if (!bearer) return undefined;
    const h = hashToken(bearer);
    for (const m of this.machinesById.values()) if (m.tokenHash && sameHash(m.tokenHash, h)) return m;
    return undefined;
  }

  newMachineId(): string {
    let id: string;
    do id = `m_${b64(16)}`;
    while (this.machinesById.has(id));
    return id;
  }

  /** A new machine row, unpaired until a pairing it owns is approved. */
  createMachine(id: string, facts: Hello): MachineRow {
    const m: MachineRow = {
      id,
      name: facts.name,
      createdAt: nowIso(),
      keys: [],
      harnesses: facts.harnesses,
      modes: facts.modes,
      version: facts.version,
      pairings: [],
    };
    this.applyFacts(m, facts);
    this.machinesById.set(id, m);
    this.saveMachines();
    return m;
  }

  /** The pairing request's or hello's facts about the machine (name, harnesses, folders, mode, accounts). */
  applyFacts(m: MachineRow, h: Hello): void {
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
    if (h.home) m.home = h.home;
    else delete m.home;
    if (h.start) m.start = h.start;
    else delete m.start;
    if (h.keyTypes) m.keyTypes = h.keyTypes;
    else delete m.keyTypes;
  }

  /** Mint the machine's own bearer token (once, at its first pairing). Returned in clear
   *  exactly here; only its hash is kept. */
  mintToken(m: MachineRow): string {
    const token = `mt_${b64(32)}`;
    m.tokenHash = hashToken(token);
    m.pairedAt ??= nowIso();
    this.saveMachines();
    return token;
  }

  /** A key the machine will trust (the approval page's passkey or the app's device key,
   *  or the test door's), kept whole. */
  addKey(m: MachineRow, key: TrustedKey, name?: string): KeyRow {
    let row = m.keys.find((k) => k.id === key.id);
    if (!row) {
      row = { ...keyOf(key), addedAt: nowIso() };
      m.keys.push(row);
    }
    if (name) row.name = name;
    this.saveMachines();
    return row;
  }

  hello(m: MachineRow, h: Hello): void {
    this.applyFacts(m, h);
    m.waiting = h.waiting;
    m.lastHelloAt = nowIso();
    this.saveMachines();
  }

  /** `control off`, or the UI's forget: the row, its token and its queue are gone. */
  removeMachine(id: string): boolean {
    if (!this.machinesById.delete(id)) return false;
    this.queues.delete(id);
    this.saveMachines();
    this.saveQueue(id);
    this.wake(id);
    return true;
  }

  machineControl(m: MachineRow): MachineControl {
    const c: MachineControl = {
      machineId: m.id,
      online: !!m.lastPollAt && Date.now() - Date.parse(m.lastPollAt) < ONLINE_WINDOW_MS,
      keys: m.keys.map((k) => ({
        id: k.id,
        alg: k.alg,
        ...(k.type === "device" ? { type: k.type } : {}),
        ...(k.name ? { name: k.name } : {}),
        addedAt: k.addedAt,
      })),
      queued: this.queued(m.id).length,
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
    if (m.home) c.home = m.home;
    if (m.start) c.start = m.start;
    if (m.keyTypes) c.keyTypes = m.keyTypes;
    return c;
  }

  // --- pairings -------------------------------------------------------------------

  findPairing(code: string): { machine: MachineRow; pairing: PairingRow } | undefined {
    for (const machine of this.machinesById.values()) {
      const pairing = machine.pairings.find((p) => p.code === code);
      if (pairing) return { machine, pairing };
    }
    return undefined;
  }

  /** A fresh code for a machine. Any earlier code of the machine still pending dies now
   *  (a renewal, CONTROL.md §2 step 3): one row, one live code. */
  startPairing(m: MachineRow, o: { fromIp: string; pollKey?: string }): PairingRow {
    const now = Date.now();
    for (const p of m.pairings)
      if (!p.approved && Date.parse(p.expiresAt) > now) p.expiresAt = new Date(now).toISOString();
    let code: string;
    do code = b64(12);
    while (this.findPairing(code));
    const p: PairingRow = {
      code,
      check: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PAIR_TTL_MS).toISOString(),
      fromIp: o.fromIp,
      open: !!o.pollKey,
    };
    if (o.pollKey) p.pollHash = hashPollKey(o.pollKey);
    m.pairings.push(p);
    this.saveMachines();
    return p;
  }

  pairingPending(p: PairingRow): boolean {
    return !p.approved && !p.deliveredAt && Date.parse(p.expiresAt) > Date.now();
  }

  pollKeyMatches(p: PairingRow, bearer: string | undefined): boolean {
    return !!p.pollHash && !!bearer && sameHash(p.pollHash, hashPollKey(bearer));
  }

  /** Every pairing a person could still approve. */
  pendingPairings(): { machine: MachineRow; pairing: PairingRow }[] {
    const out: { machine: MachineRow; pairing: PairingRow }[] = [];
    for (const machine of this.machinesById.values())
      for (const pairing of machine.pairings) if (this.pairingPending(pairing)) out.push({ machine, pairing });
    return out.sort((a, b) => (a.pairing.startedAt < b.pairing.startedAt ? 1 : -1));
  }

  /** The proof verified (the caller's job): the key is trusted for the machine and the
   *  daemon's next status poll collects it. */
  approvePairing(m: MachineRow, p: PairingRow, key: KeyRow, proof: Proof, by: string): void {
    const row = this.addKey(m, key, key.name);
    p.approved = { key: row, proof, by, at: nowIso() };
    this.saveMachines();
  }

  /** The status poll handed the paired answer over: the code is spent. */
  markDelivered(p: PairingRow): void {
    p.deliveredAt = nowIso();
    this.saveMachines();
  }

  dropPairing(m: MachineRow, p: PairingRow): void {
    m.pairings = m.pairings.filter((x) => x !== p);
    this.saveMachines();
  }

  // --- the queue ------------------------------------------------------------------

  private queue(id: string): MessageRow[] {
    let q = this.queues.get(id);
    if (!q) {
      q = [];
      this.queues.set(id, q);
    }
    return q;
  }

  /** Queued and not finally acked (expiry included). */
  queued(id: string): MessageRow[] {
    return (this.queues.get(id) ?? []).filter((m) => !isFinal(m.outcome));
  }

  /** What a poll hands out right now: queued, unexpired, and not paused by a `taken`. */
  deliverable(id: string): MessageRow[] {
    this.expireQueue(id);
    const now = Date.now();
    return this.queued(id).filter((m) => !(m.takenAt && now - Date.parse(m.takenAt) < TAKEN_PAUSE_MS));
  }

  /** Carry a verified command (the caller verified it, §5 as an early word). */
  enqueue(
    m: MachineRow,
    signed: SignedCommand,
    cmd: ControlCommand,
    o: { expiresInMs?: number; via: string },
  ): MessageRow {
    const now = Date.now();
    const ttl = Math.min(EXPIRES_MAX_MS, Math.max(1000, o.expiresInMs ?? EXPIRES_DEFAULT_MS));
    const row: MessageRow = {
      id: ulid(now),
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
    const text = describe(cmd);
    if (text !== undefined) row.text = text;
    if (cmd.kind === "start") {
      // The fields a start may carry beyond core 0.7's type (CONTROL.md §3.1); the caller's
      // pre-check (ui.ts) already held them to the machine's hello.
      const c = cmd as ControlCommand & { files?: StartFile[]; permission?: StartPermission; model?: string };
      if (typeof c.cwd === "string") row.cwd = c.cwd;
      if (c.permission) row.permission = c.permission;
      if (c.model) row.model = c.model;
      if (Array.isArray(c.files) && c.files.length) {
        row.files = c.files.map((f) => ({ name: f.name, type: f.type, size: f.size, sha256: f.sha256 }));
        for (const f of row.files) this.files.keepUntil(f.sha256, row.expiresAt);
      }
    }
    this.queue(m.id).push(row);
    this.saveQueue(m.id);
    if (cmd.kind === "key.add" && cmd.key) this.deviceSent(cmd.key.id, m.id, row.id);
    this.onMessage(row);
    this.wake(m.id);
    return row;
  }

  message(machineId: string, id: string): MessageRow | undefined {
    return this.queues.get(machineId)?.find((m) => m.id === id);
  }

  /** The machine's acks (CONTROL.md §10). A duplicate final ack changes nothing and is
   *  still applied; an unknown id is counted and still 202 (the message may have expired
   *  here before the machine answered). */
  ack(m: MachineRow, acks: AckIn[]): { applied: number; unknown: number } {
    let applied = 0;
    let unknown = 0;
    let changed = false;
    for (const a of acks) {
      const row = this.message(m.id, a.id);
      if (!row) {
        unknown++;
        continue;
      }
      applied++;
      if (isFinal(row.outcome)) continue;
      if (a.outcome === "progress") {
        if (a.seq !== undefined && row.replySeq !== undefined && a.seq <= row.replySeq) continue;
        if (a.reply !== undefined) row.reply = a.reply;
        if (a.seq !== undefined) row.replySeq = a.seq;
        if (!row.outcome) row.outcome = "progress";
      } else if (a.outcome === "taken") {
        row.outcome = "taken";
        row.takenAt = a.at;
        if (a.mode) row.mode = a.mode;
        if (a.applied && row.kind === "start") row.applied = a.applied;
      } else {
        row.outcome = a.outcome;
        row.ackedAt = a.at;
        if (a.mode) row.mode = a.mode;
        if (a.code) row.code = a.code;
        if (a.detail) row.detail = a.detail;
        if (a.reply !== undefined) row.reply = a.reply;
        if (a.session) row.ackSession = a.session;
        if (a.applied && row.kind === "start") row.applied = a.applied;
        if (row.kind === "key.add") this.keyAddSettled(m, row);
      }
      changed = true;
      this.onMessage(row);
    }
    if (changed) this.saveQueue(m.id);
    return { applied, unknown };
  }

  /** The machine's final word on a key.add. `delivered` means the machine's store grew
   *  (CONTROL.md §2), so ours mirrors it: the receiver's early check now trusts the key
   *  too, before the daemon's next hello. Anything else settles the device request as
   *  failed, with the machine's code. */
  private keyAddSettled(m: MachineRow, row: MessageRow): void {
    let cmd: ControlCommand | undefined;
    try {
      cmd = JSON.parse(row.cmd) as ControlCommand;
    } catch {
      return;
    }
    if (!cmd?.key || typeof cmd.key.id !== "string") return;
    if (row.outcome === "delivered") this.addKey(m, cmd.key, cmd.name);
    const d = [...this.devices.values()].find((x) => x.activityId === row.id);
    if (!d || d.status === "added" || d.status === "failed") return;
    d.doneAt = nowIso();
    if (row.outcome === "delivered") {
      d.status = "added";
      return;
    }
    d.status = "failed";
    if (row.outcome) d.outcome = row.outcome;
    if (row.code) d.code = row.code;
    if (row.detail) d.detail = row.detail;
  }

  private expireQueue(id: string): void {
    const now = Date.now();
    let changed = false;
    for (const row of this.queues.get(id) ?? []) {
      if (isFinal(row.outcome) || Date.parse(row.expiresAt) > now) continue;
      row.outcome = "expired";
      row.ackedAt = new Date(now).toISOString();
      row.detail = "expired before the machine took it";
      const m = this.machinesById.get(id);
      if (m && row.kind === "key.add") this.keyAddSettled(m, row);
      changed = true;
      this.onMessage(row);
    }
    if (changed) this.saveQueue(id);
  }

  sweep(): void {
    for (const id of this.queues.keys()) this.expireQueue(id);
    if (Date.now() - this.filesSweptAt > 60_000) {
      this.filesSweptAt = Date.now();
      this.files.sweep();
    }
    this.sweepDevices();
    this.checkOnline();
  }

  // --- device requests (CONTROL.md §2, "a trusted device vouches for a new one") -----

  /** A device made its own passkey and asks to be trusted. The six digits are shown on
   *  both ends; the request waits DEVICE_TTL_MS for a trusted device's `key.add`. */
  createDeviceRequest(o: {
    key: DeviceRequestRow["key"];
    name: string;
    device: string;
    fromIp: string;
  }): DeviceRequestRow {
    this.sweepDevices();
    // One live request per key: asking again from the same phone renews the digits.
    for (const d of this.devices.values())
      if (d.key.id === o.key.id && (d.status === "pending" || d.status === "sent")) this.devices.delete(d.requestId);
    const now = Date.now();
    let requestId: string;
    do requestId = `d_${b64(12)}`;
    while (this.devices.has(requestId));
    const row: DeviceRequestRow = {
      requestId,
      check: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      key: o.key,
      name: o.name,
      device: o.device,
      fromIp: o.fromIp,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DEVICE_TTL_MS).toISOString(),
      status: "pending",
    };
    this.devices.set(requestId, row);
    return row;
  }

  deviceRequest(requestId: string): DeviceRequestRow | undefined {
    this.sweepDevices();
    return this.devices.get(requestId);
  }

  /** Requests a person at a trusted device could still approve (or has just approved and
   *  the machine has not answered), newest first. */
  pendingDeviceRequests(): DeviceRequestRow[] {
    this.sweepDevices();
    return [...this.devices.values()]
      .filter((d) => d.status === "pending" || d.status === "sent")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Rejected on a trusted device: gone at once; the phone's next poll reads 404. */
  dropDeviceRequest(requestId: string): boolean {
    return this.devices.delete(requestId);
  }

  /** A trusted device's key.add carrying this key was queued for `machineId`. */
  private deviceSent(keyId: string, machineId: string, activityId: string): void {
    for (const d of this.devices.values()) {
      if (d.key.id !== keyId || d.status !== "pending") continue;
      d.status = "sent";
      d.machineId = machineId;
      d.activityId = activityId;
    }
  }

  private sweepDevices(): void {
    const now = Date.now();
    for (const d of this.devices.values()) {
      if ((d.status === "pending" || d.status === "sent") && Date.parse(d.expiresAt) <= now) {
        d.status = "expired";
        d.doneAt = new Date(now).toISOString();
      }
      const dead = d.doneAt ? Date.parse(d.doneAt) : Date.parse(d.expiresAt);
      if (d.status !== "pending" && d.status !== "sent" && now - dead > DEVICE_KEEP_MS)
        this.devices.delete(d.requestId);
    }
  }

  /** Fires onMachines when the set of online machines changed since the last look. */
  private checkOnline(): void {
    const now = Date.now();
    const sig = [...this.machinesById.values()]
      .filter((m) => !!m.lastPollAt && now - Date.parse(m.lastPollAt) < ONLINE_WINDOW_MS)
      .map((m) => m.id)
      .sort()
      .join(",");
    if (sig === this.onlineSig) return;
    this.onlineSig = sig;
    this.onMachines();
  }

  /** The long-poll: what is deliverable now, or what arrives within `waitMs`, or []. */
  poll(m: MachineRow, waitMs: number, signal?: AbortSignal): Promise<MessageRow[]> {
    m.lastPollAt = nowIso();
    this.saveMachines();
    const now = this.deliverable(m.id);
    if (now.length || waitMs <= 0) return Promise.resolve(now);
    return new Promise<MessageRow[]>((resolve) => {
      let set = this.waiters.get(m.id);
      if (!set) {
        set = new Set();
        this.waiters.set(m.id, set);
      }
      const w: Waiter = {
        resolve: (msgs) => {
          set?.delete(w);
          clearTimeout(w.timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(msgs);
        },
        timer: setTimeout(() => w.resolve([]), waitMs),
      };
      const onAbort = () => w.resolve([]);
      signal?.addEventListener("abort", onAbort, { once: true });
      set.add(w);
    });
  }

  /** Something changed for a machine: every parked poll answers now. */
  private wake(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    const m = this.machinesById.get(id);
    const msgs = m ? this.deliverable(id) : [];
    for (const w of [...set]) w.resolve(msgs);
  }

  activity(limit = 100): ControlActivity[] {
    const all: MessageRow[] = [];
    for (const q of this.queues.values()) all.push(...q);
    all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return all.slice(0, Math.max(0, limit)).map(toActivity);
  }
}
