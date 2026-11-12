// SPDX-License-Identifier: Apache-2.0
// Owned by: control. The machines and sends of a spacesheep account (docs/rfcs/08): the
// machines paired there as rows from the relay's list, a send carried to spacesheep's jobs
// route and its row, and that row settled by spacesheep's word on its job and by nothing
// else. One definition, two hosts: the receiver's control state (state.ts), whose maps and
// queue files hold these rows beside the machines paired here, and a page that carries its
// own board (MemoryControl below), which has no receiver to keep them. Nothing here is
// Node's (store/browser.test.ts holds it to what a page has).
import type { ControlCommand, SignedCommand } from "sessionpipe-core/control";
import { cleanReason } from "../../shared/reason.js";
import {
  applyFacts,
  EXPIRES_MAX_MS,
  type Hello,
  isFinal,
  isRemoteRow,
  MACHINE_RE,
  type MachineRow,
  type MessageRow,
  nowIso,
  REMOTE_CODE_RE,
  REMOTE_GRACE_MS,
  REMOTE_JUST_SENT_MS,
  type RemoteMachine,
  remoteAccountKey,
  UNTRACKED_CODE,
  type Unfollowed,
} from "./rows.js";

/** One job as spacesheep's jobs door lists it (sources/relay.ts RelayJob, the fields read here). */
export interface RemoteJobWord {
  id: number;
  status: string;
  note: string | null;
  code?: string | null;
  done_at: number | null;
  created_at: number;
}

/** What the slice works on, and what it asks of whoever holds the rows. */
export interface RemoteHost {
  /** Every machine row by id; the slice makes, refreshes and removes those with `remote`. */
  machines: Map<string, MachineRow>;
  /** Every machine's messages by machine id; the slice touches those spacesheep carried. */
  queues: Map<string, MessageRow[]>;
  /** The row of a carried command, on its machine's queue and told (state.enqueue). */
  enqueue(
    m: MachineRow,
    signed: SignedCommand,
    cmd: ControlCommand,
    o: { expiresInMs?: number; via: string; from?: string },
  ): MessageRow;
  /** A machine's queue changed: keep it (trimmed as a queue is). */
  saveQueue(id: string): void;
  /** A row changed. */
  onMessage(row: MessageRow): void;
  /** A machine row changed. */
  onMachines(): void;
  /** The set of machines online may have changed. */
  checkOnline(): void;
  /** A spacesheep job is worth reading now. */
  onRemoteKick(): void;
}

export class RemoteSlice {
  private readonly machinesById: Map<string, MachineRow>;
  private readonly queues: Map<string, MessageRow[]>;

  /** The spacesheep account read through now (remoteAccountKey), or null when none is. */
  private remoteAccount: string | null = null;
  /** The connected account's key was refused (SpacesheepSource unauthorized). */
  private remoteRevoked = false;
  /** Closed rows' job ids to read once more (recheckRemote). */
  private recheck = new Set<number>();

  constructor(private readonly host: RemoteHost) {
    this.machinesById = host.machines;
    this.queues = host.queues;
  }

  private enqueue(
    m: MachineRow,
    signed: SignedCommand,
    cmd: ControlCommand,
    o: { expiresInMs?: number; via: string; from?: string },
  ): MessageRow {
    return this.host.enqueue(m, signed, cmd, o);
  }
  private saveQueue(id: string): void {
    this.host.saveQueue(id);
  }
  private onMessage(row: MessageRow): void {
    this.host.onMessage(row);
  }
  private onMachines(): void {
    this.host.onMachines();
  }
  private checkOnline(): void {
    this.host.checkOnline();
  }
  private onRemoteKick(): void {
    this.host.onRemoteKick();
  }
  private applyFacts(m: MachineRow, h: Hello): void {
    applyFacts(m, h);
  }

  /** The relay's machine list, as rows: created or refreshed in memory, with the facts
   *  spacesheep's hellos kept and the keys it trusts (ids only; the signature is the
   *  receiver's check). Rows the list no longer has go. */
  upsertRemoteMachines(list: RemoteMachine[], remote: { via: "spacesheep"; origin: string; rpId: string }): void {
    const seen = new Set<string>();
    let changed = false;
    let kick = false;
    for (const r of list) {
      if (!MACHINE_RE.test(r.id)) continue;
      seen.add(r.id);
      const facts: Hello = {
        name: r.name,
        harnesses: r.agents ?? [],
        modes: r.modes ?? [],
        version: r.cli_version ?? "",
        folders: r.folders ?? undefined,
        mode: r.mode === "auto" || r.mode === "inherit" || r.mode === "safe" ? r.mode : undefined,
        accounts: [],
        // A file a send names lives on this disk (control/files), and spacesheep checks its
        // own store for it: through spacesheep there is no way to carry one yet, whatever
        // the computer takes, so none is offered (the page reads these).
        files: false,
        promptFiles: false,
        keyTypes: r.key_types?.includes("device") ? ["passkey", "device"] : ["passkey"],
        ask: r.ask,
        handoff: !!r.handoff,
        start: r.start,
        pool: r.pool ?? undefined,
      } as unknown as Hello;
      let m = this.machinesById.get(r.id);
      if (!m) {
        m = {
          id: r.id,
          name: r.name,
          createdAt: nowIso(),
          keys: [],
          harnesses: facts.harnesses,
          modes: facts.modes,
          version: facts.version,
          pairings: [],
        };
        this.machinesById.set(r.id, m);
        changed = true;
      }
      this.applyFacts(m, facts);
      m.pairedAt = m.pairedAt ?? nowIso();
      // A computer with a send waiting for it came online: read the jobs now.
      if (r.online && m.remote?.online === false && this.followedFor(m.id)) kick = true;
      m.remote = {
        ...remote,
        online: !!r.online,
        lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : undefined,
      };
      m.lastHelloAt = m.remote.lastSeen;
      const keys = (r.passkey_ids ?? []).map((id) => ({ id, alg: -7, spki: "", addedAt: nowIso() }));
      if (keys.map((k) => k.id).join() !== m.keys.map((k) => k.id).join()) {
        m.keys = keys;
        changed = true;
      }
    }
    for (const m of [...this.machinesById.values()]) {
      if (m.remote?.via === remote.via && !seen.has(m.id)) {
        this.machinesById.delete(m.id);
        changed = true;
      }
    }
    // The rows kept from before a restart that predate their account's name: those whose
    // machine is on this list are this account's, the rest can't be followed any more.
    // A row of this account whose machine left the list stays: spacesheep settles its job
    // (a removed computer's waiting jobs are refused there).
    if (this.remoteAccount)
      this.eachRemoteRow((row) => {
        if (row.remoteAccount !== undefined) return false;
        if (seen.has(row.machineId)) {
          row.remoteAccount = this.remoteAccount!;
          delete row.unfollowed;
          this.onMessage(row);
          return true;
        }
        return this.untracked(row);
      });
    if (changed) this.checkOnline();
    this.onMachines();
    if (kick) this.onRemoteKick();
  }

  /** Whether any send this account follows waits on machine `id`. */
  private followedFor(id: string): boolean {
    return (this.queues.get(id) ?? []).some((row) => this.followed(row));
  }

  /** How soon spacesheep's jobs door is worth reading again (sources/spacesheep.ts):
   *  `fast` while a followed send was just made, was taken, or waits for a computer the
   *  machine list shows online; `slow` while every one waits for a computer shown offline
   *  (nothing can move until it comes back, and its coming back is a kick); `none` when
   *  nothing is followed. */
  remoteJobsCadence(now = Date.now()): "fast" | "slow" | "none" {
    let any = false;
    for (const [id, rows] of this.queues)
      for (const row of rows) {
        if (!this.followed(row)) continue;
        any = true;
        if (row.outcome === "taken" || now - Date.parse(row.at) < REMOTE_JUST_SENT_MS) return "fast";
        if (this.machinesById.get(id)?.remote?.online !== false) return "fast";
      }
    return any ? "slow" : "none";
  }

  /** The relay brought events (`harness:id` keys): one for a session a followed send names
   *  means it moved there, so the jobs are read now. */
  remoteEventsSeen(keys: Iterable<string>): void {
    const set = new Set(keys);
    if (!set.size) return;
    const closed: MessageRow[] = [];
    let kick = false;
    for (const [, rows] of this.queues)
      for (const row of rows) {
        if (!set.has(row.session)) continue;
        if (this.followed(row)) kick = true;
        else if (this.reopenable(row)) closed.push(row);
      }
    if (closed.length) this.recheckRemote(closed);
    else if (kick) this.onRemoteKick();
  }

  /** Disconnected: the rows paired there leave the board. */
  dropRemoteMachines(via: "spacesheep"): void {
    for (const m of [...this.machinesById.values()]) if (m.remote?.via === via) this.machinesById.delete(m.id);
    this.onMachines();
  }

  /** The spacesheep account this receiver reads through from now (connected, started with
   *  a link), or null (disconnected, started without one). With none, every waiting row
   *  stays as it is, marked not followed (`unfollowed`): the same account connecting again
   *  picks it up and spacesheep's list settles it. Only another account connecting settles
   *  the rows it can't speak for, as untracked. A row from before the account was named
   *  waits for that account's machine list (upsertRemoteMachines). */
  setRemoteAccount(account: { origin: string; email: string } | null): void {
    this.remoteAccount = account ? remoteAccountKey(account) : null;
    // A connect is a new key: whatever the last one was refused for is over.
    this.remoteRevoked = false;
    if (this.remoteAccount) this.onRemoteKick();
    // Its own rows that were closed for want of an account: an untracked one waits again
    // (spacesheep's list settles it), an unconfirmed one is read once more.
    const again: MessageRow[] = [];
    if (this.remoteAccount)
      for (const [id, rows] of this.queues) {
        let changed = false;
        for (const row of rows) {
          if (!isRemoteRow(row) || row.remoteAccount !== this.remoteAccount) continue;
          if (row.outcome === "failed" && row.code === UNTRACKED_CODE) {
            delete row.outcome;
            delete row.code;
            delete row.ackedAt;
            changed = true;
            this.onMessage(row);
          } else if (row.outcome === "unconfirmed") again.push(row);
        }
        if (changed) this.saveQueue(id);
      }
    this.recheckRemote(again);
    this.eachRemoteRow((row) => {
      if (this.remoteAccount && row.remoteAccount !== undefined && row.remoteAccount !== this.remoteAccount)
        return this.untracked(row);
      return this.markFollowing(row);
    });
  }

  /** spacesheep refused this app's key (the relay's 401, a send's): nothing is read until
   *  the account connects again, so the waiting rows say they are not followed. */
  setRemoteRevoked(on: boolean): void {
    if (this.remoteRevoked === on) return;
    this.remoteRevoked = on;
    this.eachRemoteRow((row) => this.markFollowing(row));
  }

  /** A waiting row's `unfollowed` mark as things stand: no account (or not yet known to be
   *  the connected one's) is `disconnected`; the connected account's key refused, `revoked`. */
  private markFollowing(row: MessageRow): boolean {
    const want: Unfollowed | undefined =
      !this.remoteAccount || row.remoteAccount === undefined
        ? "disconnected"
        : this.remoteRevoked
          ? "revoked"
          : undefined;
    const had = row.unfollowed === true ? "disconnected" : row.unfollowed;
    if (had === want) return false;
    if (want) row.unfollowed = want;
    else delete row.unfollowed;
    this.onMessage(row);
    return true;
  }

  /** Each unsettled row spacesheep carried; `f` says whether it changed the row. */
  private eachRemoteRow(f: (row: MessageRow) => boolean): void {
    for (const [id, rows] of this.queues) {
      let changed = false;
      for (const row of rows) if (isRemoteRow(row) && !isFinal(row.outcome) && f(row)) changed = true;
      if (changed) this.saveQueue(id);
    }
  }

  /** A spacesheep-carried row nothing here can follow: settled, saying so by its code, so
   *  the page stops waiting for it. Whether it ran is spacesheep's to tell, not ours. */
  private untracked(row: MessageRow): true {
    delete row.unfollowed;
    row.outcome = "failed";
    row.code = UNTRACKED_CODE;
    row.ackedAt = nowIso();
    this.onMessage(row);
    return true;
  }

  /** A send spacesheep carried for a remote machine: its row here, settled by the relay's
   *  job status (applyRemoteJobs), never by a poll of this receiver. */
  enqueueRemote(
    m: MachineRow,
    signed: SignedCommand,
    cmd: ControlCommand,
    o: { via: string; from?: string },
    remoteJob: number,
  ): MessageRow {
    // spacesheep's day, not the receiver's default hour: the row says when spacesheep drops it.
    const row = this.enqueue(m, signed, cmd, {
      via: o.via,
      expiresInMs: EXPIRES_MAX_MS,
      ...(o.from ? { from: o.from } : {}),
    });
    row.remoteJob = remoteJob;
    if (this.remoteAccount) row.remoteAccount = this.remoteAccount;
    this.saveQueue(m.id);
    this.onRemoteKick();
    return row;
  }

  /** The spacesheep job ids still unsettled here, lowest first, for the relay's `since`:
   *  only the connected account's (a job id means nothing on another). */
  pendingRemoteJobs(): number[] {
    const ids: number[] = [...this.recheck];
    for (const [, rows] of this.queues) for (const row of rows) if (this.followed(row)) ids.push(row.remoteJob!);
    return [...new Set(ids)].sort((a, b) => a - b);
  }

  /** The lowest of them, or null. */
  pendingRemoteJobsFrom(): number | null {
    return this.pendingRemoteJobs()[0] ?? null;
  }

  /** An unsettled row the connected account's jobs speak for. */
  private followed(row: MessageRow): boolean {
    return (
      isRemoteRow(row) && !isFinal(row.outcome) && !!this.remoteAccount && row.remoteAccount === this.remoteAccount
    );
  }

  /** The relay's word on the jobs spacesheep carried (its status column, worded there):
   *  queued keeps waiting, taken/running is taken, done is delivered, refused and failed
   *  are themselves, with the note as the detail. Only spacesheep's word settles such a
   *  row, with one exception: `through` is the highest job id the read covered (Infinity
   *  when it reached the end of the list), and a row in that span still queued there, or
   *  not listed at all, past spacesheep's day and REMOTE_GRACE_MS is expired here, since
   *  spacesheep can no longer hand it out; one the computer took (taken/running there,
   *  which spacesheep never ends by itself) is `unconfirmed`: nothing was heard since.
   *  The age is spacesheep's: the job's own `created_at` against `serverNow` (the answer's
   *  Date), so a clock here that jumps ends nothing early; the row's own time and this
   *  clock only where spacesheep gave none. */
  applyRemoteJobs(
    jobs: Array<{
      id: number;
      status: string;
      note: string | null;
      code?: string | null;
      done_at: number | null;
      created_at: number;
    }>,
    through = 0,
    serverNow?: number,
  ): number {
    let n = 0;
    const byJob = new Map(jobs.map((j) => [j.id, j]));
    // spacesheep's time when it said one; else this clock, and then the row's own time on
    // this clock too (never spacesheep's created_at against this clock: two clocks).
    const known = Number.isFinite(serverNow);
    const now = known ? serverNow! : Date.now();
    for (const [id, rows] of this.queues) {
      let changed = false;
      for (const row of rows) {
        const j = byJob.get(row.remoteJob!);
        if (!this.followed(row)) {
          // Closed here as `unconfirmed` (or reopened untracked, now waiting again): a later
          // read that lists its job as settled there says how it really went.
          if (!this.reopenable(row) || !j || !(j.status === "done" || j.status === "refused" || j.status === "failed"))
            continue;
          delete row.code;
          delete row.detail;
        }
        const born =
          known && j && Number.isFinite(j.created_at) && j.created_at > 0 ? j.created_at : Date.parse(row.at);
        const over = row.remoteJob! <= through && now - born >= EXPIRES_MAX_MS + REMOTE_GRACE_MS;
        const taken = j ? j.status === "taken" || j.status === "running" : row.outcome === "taken";
        if (over && (taken || !j || j.status === "queued")) {
          // Past spacesheep's day: waiting there, it can't be handed out any more; taken,
          // nothing will be heard of it. Either way the row stops being read.
          row.outcome = taken ? "unconfirmed" : "expired";
          row.ackedAt = new Date().toISOString();
          if (!taken) row.detail = "expired before the machine took it";
          changed = true;
          n++;
          this.onMessage(row);
          continue;
        }
        if (!j || j.status === "queued") continue;
        if (taken) {
          if (row.outcome === "taken") continue;
          row.outcome = "taken";
          row.takenAt = nowIso();
        } else {
          // spacesheep ≥ the `code` field: the computer's refusal code as it acked it,
          // `cancelled` for a start called off before it was taken, `expired` for one that ran
          // out. Without it (an older spacesheep) the status alone, and no code is guessed.
          const code = typeof j.code === "string" && REMOTE_CODE_RE.test(j.code) ? j.code : undefined;
          row.outcome =
            j.status === "done"
              ? "delivered"
              : code === "expired"
                ? "expired"
                : j.status === "refused"
                  ? "refused"
                  : "failed";
          row.ackedAt = j.done_at ? new Date(j.done_at).toISOString() : nowIso();
          if (code && row.outcome !== "delivered" && row.outcome !== "expired") row.code = code;
          if (j.note) row.detail = j.note;
        }
        changed = true;
        n++;
        this.onMessage(row);
      }
      if (changed) this.saveQueue(id);
    }
    // The once-over reads asked for (recheckRemote) are done where this read reached.
    for (const job of [...this.recheck]) if (byJob.has(job) || job <= through) this.recheck.delete(job);
    return n;
  }

  /** A row this app closed for want of word, not by spacesheep's (`unconfirmed`): of the
   *  connected account, so a read of its job may still settle it. */
  private reopenable(row: MessageRow): boolean {
    return (
      isRemoteRow(row) &&
      row.outcome === "unconfirmed" &&
      !!this.remoteAccount &&
      row.remoteAccount === this.remoteAccount
    );
  }

  /** Read these closed rows' jobs once more, now (their account connected, events for their
   *  session): job ids added to the next read's pending list, and a kick. */
  private recheckRemote(rows: MessageRow[]): void {
    if (!rows.length) return;
    for (const row of rows) this.recheck.add(row.remoteJob!);
    this.onRemoteKick();
  }
}

/** The code of a send spacesheep refused because it no longer takes this app's key. */
export const SPACESHEEP_UNAUTHORIZED = "spacesheep_unauthorized";
/** The code of a send for a spacesheep computer that names files: none can be carried there. */
export const RELAY_FILES = "relay_files";

/** A send for a machine paired on spacesheep: the signed body goes to spacesheep's jobs
 *  route as this account; the answer is its job id, or why not. The receiver asks with the
 *  account's key; a page asks through the native hub, which holds it. */
export type RemoteSend = (
  m: MachineRow,
  body: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;

/** A send that was not carried: the status and the body a page reads from /send. */
export class SendRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: { reason: string; error?: string; code?: string; detail?: string },
  ) {
    super(`HTTP ${status}`);
  }
}

/** A send for a machine paired on spacesheep: not verified here (its keys are ids only,
 *  its rp id is spacesheep's), carried to spacesheep's jobs route, which verifies it
 *  against the machine's keys and queues it; the row here follows the job's status.
 *  spacesheep's refusals are thrown as SendRefused, in the shape the page already reads
 *  (422 + code). */
export async function forwardRemoteSend(
  state: Pick<RemoteSlice, "enqueueRemote">,
  m: MachineRow,
  body: Record<string, unknown>,
  remoteSend: RemoteSend | undefined,
): Promise<MessageRow> {
  if (!remoteSend) throw new SendRefused(503, { reason: "no_relay", error: "Not connected to spacesheep any more." });
  if (typeof body.cmd !== "string")
    throw new SendRefused(400, { reason: "bad_request", error: "cmd is the signed command string." });
  let cmd: ControlCommand;
  try {
    cmd = JSON.parse(body.cmd) as ControlCommand;
  } catch {
    throw new SendRefused(400, { reason: "bad_request", error: "cmd is not JSON." });
  }
  // A file a send names is held on this disk, and spacesheep looks for it in its own store:
  // none can be carried there yet (the pages offer none), so a page that sends one is told
  // here, before spacesheep answers that it "didn't finish uploading".
  const files = (cmd as ControlCommand & { files?: unknown }).files;
  if (Array.isArray(files) && files.length)
    throw new SendRefused(422, {
      reason: `Files can't be sent to ${m.name} through spacesheep yet.`,
      code: RELAY_FILES,
    });
  const signed: SignedCommand = { cmd: body.cmd };
  if (typeof body.csig === "string") signed.csig = body.csig;
  if (body.grant && typeof body.grant === "object") signed.grant = body.grant as SignedCommand["grant"];
  if (body.confirm && typeof body.confirm === "object") signed.confirm = body.confirm as SignedCommand["confirm"];
  const r = await remoteSend(m, {
    cmd: signed.cmd,
    csig: signed.csig ?? null,
    grant: signed.grant ?? null,
    confirm: signed.confirm ?? null,
  });
  if (r.status === 202) {
    const job = Number(r.json.job);
    const row = state.enqueueRemote(
      m,
      signed,
      cmd,
      { via: "ui", ...(typeof body.from === "string" ? { from: body.from } : {}) },
      job,
    );
    return row;
  }
  const code = String(r.json.code ?? "");
  // spacesheep's words, passed on as text the page can show (shared/reason.ts).
  const error = cleanReason(r.json.error) || "spacesheep did not take it";
  // The second look there wants a fresh tap: the same word the page knows from a machine,
  // and spacesheep's reason (`why`) as the detail the page's held notice shows.
  if (r.status === 409 && code === "confirm")
    throw new SendRefused(422, { reason: error, code: "confirm_required", ...whyOf(r.json) });
  if (r.status === 401 && code === "unlock") throw new SendRefused(422, { reason: error, code: "bad_grant" });
  // Any other 401 is spacesheep refusing this app's key (revoked there), not the page's own
  // key: its own code, never the 401 a page reads as "this page lost its key".
  if (r.status === 401) throw new SendRefused(502, { reason: error, code: SPACESHEEP_UNAUTHORIZED });
  if (r.status === 400 && (code === "bad" || code === "unlock"))
    throw new SendRefused(422, { reason: error, code: String(r.json.refusal ?? "untrusted_key") });
  throw new SendRefused(r.status >= 500 ? 502 : r.status, { reason: error, code: code || "refused" });
}

/** spacesheep's reason for a hold, cleaned, when it gave one. */
const whyOf = (j: Record<string, unknown>): { detail?: string } => {
  const why = cleanReason(j.why);
  return why ? { detail: why } : {};
};
