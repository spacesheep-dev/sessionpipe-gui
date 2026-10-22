// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The store: append-only JSONL per session on disk, an index
// of slim events and session summaries in memory, the readings of ARCHITECTURE.md,
// and a subscription stream the SSE route forwards. Contract: ARCHITECTURE.md "Store".
import {
  type AgentRun,
  type Digest,
  type DigestQuery,
  type EventSource,
  type FeedPage,
  type FeedQuery,
  type FilesPage,
  type FilesQuery,
  type MachineSummary,
  type ProtocolEvent,
  type SearchPage,
  type SearchQuery,
  type SessionDetail,
  type SessionKey,
  type SessionSummary,
  type Snapshot,
  type Stats,
  type StoredEvent,
  type StreamMessage,
  sessionKey,
  splitKey,
} from "../../shared/api.js";
import { EventFiles } from "./files.js";
import { applyEvent, newRecord, refreshFlags, refreshState, type SessionRecord, settleAgents } from "./readings.js";
import { digest, filesChanged, type ReviewIndex, search } from "./review.js";
import { type SlimEvent, slimEvent, trimPreview } from "./slim.js";

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: { id: string; reason: string }[];
  /** The stored events, in input order, for those accepted (a `session.forgotten` is
   *  accepted but never stored). */
  stored: StoredEvent[];
}

export type StoreListener = (msg: StreamMessage) => void;

export interface StoreOptions {
  /** How often states are re-evaluated for the timers (default 30 s). */
  tickMs?: number;
  /** How often stats are emitted when changed (default 5 s). */
  statsMs?: number;
  /** Events older than this many days keep a shorter preview of their big `data`
   *  strings in memory (OLD_PREVIEW_CHARS instead of PREVIEW_CHARS); the full event is
   *  on disk either way. Default 14; 0 keeps every preview whole. */
  keepDays?: number;
}

/** Characters of each big `data` string kept for events past `keepDays`: enough for a
 *  feed row and a search hit on the opening of a transcript. */
export const OLD_PREVIEW_CHARS = 280;
export const KEEP_DAYS_DEFAULT = 14;

/** One indexed event: the slim copy, where its full line is on disk, its event time
 *  (ms, clamped to arrival) and its arrival number. The feed orders by (t, no). */
export interface Rec {
  ev: SlimEvent;
  offset: number;
  bytes: number;
  t: number;
  no: number;
}

/** The feed cursor: event time and arrival number, opaque to the client. */
const encodeCursor = (r: Rec): string => Buffer.from(`${r.t}.${r.no}`).toString("base64url");
const decodeCursor = (c: string): { t: number; no: number } | null => {
  const m = /^(\d+)\.(\d+)$/.exec(Buffer.from(c, "base64url").toString());
  return m ? { t: Number(m[1]), no: Number(m[2]) } : null;
};
const before = (a: { t: number; no: number }, b: { t: number; no: number }): boolean =>
  a.t < b.t || (a.t === b.t && a.no < b.no);

/** The record for a seq, by binary search over recs (ordered by seq). */
function findRec(entry: Entry, seq: number): Rec | undefined {
  const recs = entry.recs;
  let lo = 0;
  let hi = recs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const s = recs[mid]!.ev.session.seq;
    if (s < seq) lo = mid + 1;
    else if (s > seq) hi = mid;
    else return recs[mid];
  }
  return undefined;
}

interface Entry extends SessionRecord {
  /** Ordered by seq. */
  recs: Rec[];
  seqs: Set<number>;
  /** Bytes of the session's file. */
  size: number;
}

const FEED_DEFAULT = 50;
const FEED_MAX = 500;
const DETAIL_DEFAULT = 200;
const DETAIL_MAX = 1000;
const LATENCY_WINDOW = 200;
/** How long a machine frame that only moves `lastAt` may wait, so a burst of events is one frame. */
const MACHINE_LASTAT_MS = 1_000;
const withoutLastAt = (json: string): string => json.replace(/"lastAt":"[^"]*",?/, "");

export class Store {
  private readonly files: EventFiles;
  private readonly sessions = new Map<SessionKey, Entry>();
  /** Every event by event time, then arrival (ascending). */
  private byTime: Rec[] = [];
  private nextNo = 1;
  /** While an initial load runs (boot, the outbox's first drain) arrivals are not live traffic. */
  private loading = false;
  private readonly childrenOf = new Map<SessionKey, Set<SessionKey>>();
  private readonly listeners = new Set<StoreListener>();
  private latencies: number[] = [];
  private arrivals: number[] = [];
  private storageBytes = 0;
  private readonly machinesSent = new Map<string, string>();
  /** Machines whose lastAt moved since their last frame; sent together by flushMachines. */
  private readonly machinesDue = new Set<string>();
  private machineFlush: NodeJS.Timeout | undefined;
  private statsSent = "";
  private readonly startedAt = Date.now();
  private readonly timers: NodeJS.Timeout[] = [];
  private closed = false;
  private readonly keepDays: number;

  constructor(
    readonly dir: string,
    opts: StoreOptions = {},
  ) {
    this.files = new EventFiles(dir);
    this.keepDays = opts.keepDays ?? KEEP_DAYS_DEFAULT;
    this.boot();
    const tick = setInterval(() => this.tick(), opts.tickMs ?? 30_000);
    const stats = setInterval(() => this.emitStats(), opts.statsMs ?? 5_000);
    tick.unref();
    stats.unref();
    this.timers.push(tick, stats);
  }

  // ---------- boot ----------

  private boot(): void {
    // Each line is slimmed the moment it is read (files.scanEach never holds a file whole),
    // so boot holds the index and nothing more; the full event is read back from disk.
    const all: { key: SessionKey; ev: SlimEvent; offset: number; bytes: number }[] = [];
    const files = this.files.scanEach((f, line) => {
      all.push({ key: sessionKey(f.harness, f.id), ev: slimEvent(line.event), offset: line.offset, bytes: line.bytes });
    });
    for (const f of files) {
      this.storageBytes += f.size;
      if (!f.lines) continue;
      const entry = this.entry(f.harness, f.id, f.firstArrivedAt ?? new Date().toISOString(), "outbox");
      entry.size = f.size;
    }
    // Arrival order across files is the feed's order; within a file it is append order.
    all.sort((a, b) => (a.ev.arrivedAt < b.ev.arrivedAt ? -1 : a.ev.arrivedAt > b.ev.arrivedAt ? 1 : 0));
    // A seq stored twice (a tier-0 copy over HTTP and the tier-3 copy from the outbox,
    // see ingest) keeps its richest line: the highest tier, the later one on a tie.
    const best = new Map<string, number>();
    all.forEach(({ key, ev }, i) => {
      const k = `${key}#${ev.session.seq}`;
      const prev = best.get(k);
      if (prev === undefined || all[prev]!.ev.tier <= ev.tier) best.set(k, i);
    });
    const now = Date.now();
    const keepAfter = this.keepDays > 0 ? now - this.keepDays * 86_400_000 : Number.NEGATIVE_INFINITY;
    all.forEach(({ key, ev, offset, bytes }, i) => {
      if (best.get(`${key}#${ev.session.seq}`) !== i) return;
      const entry = this.sessions.get(key)!;
      // The readings come from the slim copy, as they do in rebuild(): readings.ts cuts
      // and hashes within PREVIEW_CHARS, so they read the same as from the full event.
      applyEvent(entry, ev, ev.arrivedAt, ev.source ?? "http");
      const rec = this.index(entry, ev, offset, bytes, true);
      if (rec.t < keepAfter) rec.ev = trimPreview(ev, OLD_PREVIEW_CHARS);
    });
    for (const entry of this.sessions.values()) this.refresh(entry, now);
    for (const entry of this.sessions.values()) this.syncChildren(entry);
  }

  // ---------- helpers ----------

  /** A child session (`parent_id`) is also its parent's agent: one AgentRun by the
   *  child's id (the parent's own subagent.started may have made it already) with
   *  `session` set and the child's state and tools. True when the parent's agents changed. */
  private syncChildAgent(parent: Entry, child: Entry): boolean {
    const c = child.summary;
    const s = parent.summary;
    const have = s.agents.find((a) => a.id === c.id);
    // An end already read (the parent's subagent.ended) holds unless the child spoke since;
    // otherwise the child's own state is the agent's.
    const ended = have?.state === "done" && (have.endedAt ?? "") >= c.lastAt;
    const state: AgentRun["state"] = ended || c.state === "done" ? "done" : c.state === "stale" ? "stale" : "running";
    const next: AgentRun = {
      ...(have ?? {}),
      id: c.id,
      session: c.key,
      state,
      startedAt: have?.startedAt ?? c.startedAt,
      lastAt: c.lastAt > (have?.lastAt ?? "") ? c.lastAt : (have?.lastAt ?? c.lastAt),
      tools: c.counts.tools,
      toolErrors: c.counts.toolErrors,
      attributed: true,
      recentTools: c.recentTools.slice(-4),
      ...(c.currentTool
        ? { currentTool: { tool: c.currentTool.tool, callId: c.currentTool.callId, since: c.currentTool.since } }
        : {}),
      ...(state === "done" ? { endedAt: have?.endedAt ?? c.endedAt ?? c.lastAt } : {}),
    };
    if (!c.currentTool) delete next.currentTool;
    if (state !== "done") delete next.endedAt;
    if (have && JSON.stringify(have) === JSON.stringify(next)) return false;
    s.agents = have ? s.agents.map((a) => (a.id === c.id ? next : a)) : [...s.agents, next];
    settleAgents(s);
    return true;
  }

  /** Every child of `entry` synced into its agents; true when any changed. */
  private syncChildren(entry: Entry): boolean {
    let changed = false;
    for (const k of entry.childKeys) {
      const child = this.sessions.get(k);
      if (child && this.syncChildAgent(entry, child)) changed = true;
    }
    if (changed) this.refresh(entry, Date.now());
    return changed;
  }

  /** The parent of a child session, when both are known. */
  private parentOf(entry: Entry): Entry | undefined {
    const pid = entry.summary.parentId;
    return pid ? this.sessions.get(sessionKey(entry.summary.harness, pid)) : undefined;
  }

  /** The state machine, then the flags over it; true when either changed. */
  private refresh(entry: Entry, now: number): boolean {
    const state = refreshState(entry, now);
    return refreshFlags(entry, now) || state;
  }

  private entry(harness: string, id: string, at: string, source: EventSource): Entry {
    const key = sessionKey(harness, id);
    let e = this.sessions.get(key);
    if (!e) {
      e = { ...newRecord(harness, id, at, source), recs: [], seqs: new Set(), size: 0 };
      const kids = this.childrenOf.get(key);
      if (kids) {
        e.childKeys = kids;
        e.summary.children = kids.size;
      }
      this.sessions.set(key, e);
    }
    return e;
  }

  /** Recompute a session's readings from its (slim) records, after one of them changed. */
  private rebuild(entry: Entry, now: number): void {
    const first = entry.recs[0];
    const fresh = newRecord(
      entry.summary.harness,
      entry.summary.id,
      first?.ev.arrivedAt ?? entry.summary.startedAt,
      entry.summary.source,
    );
    fresh.childKeys = entry.childKeys;
    fresh.summary.children = entry.summary.children;
    for (const r of entry.recs) applyEvent(fresh, r.ev, r.ev.arrivedAt, r.ev.source ?? "http");
    entry.summary = fresh.summary;
    entry.ended = fresh.ended;
    entry.live = fresh.live;
    entry.files = fresh.files;
    entry.track = fresh.track;
    this.refresh(entry, now);
    this.syncChildren(entry);
  }

  /** `slim`: `ev` is already the slim copy (boot), so it is kept as it is. */
  private index(entry: Entry, ev: StoredEvent, offset: number, bytes: number, slim = false): Rec {
    const arrived = Date.parse(ev.arrivedAt);
    const time = Date.parse(ev.time);
    const t = Number.isFinite(time) ? Math.min(time, arrived) : arrived;
    const rec: Rec = { ev: slim ? ev : slimEvent(ev), offset, bytes, t, no: this.nextNo++ };
    const seq = ev.session.seq;
    entry.seqs.add(seq);
    // Insert by seq; appends are the common case.
    const recs = entry.recs;
    if (!recs.length || recs[recs.length - 1]!.ev.session.seq <= seq) recs.push(rec);
    else {
      let lo = 0;
      let hi = recs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (recs[mid]!.ev.session.seq < seq) lo = mid + 1;
        else hi = mid;
      }
      recs.splice(lo, 0, rec);
    }
    const all = this.byTime;
    if (!all.length || !before(rec, all[all.length - 1]!)) all.push(rec);
    else {
      let lo = 0;
      let hi = all.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (before(all[mid]!, rec)) lo = mid + 1;
        else hi = mid;
      }
      all.splice(lo, 0, rec);
    }
    return rec;
  }

  /** Live traffic only: events that arrive during an initial load are not counted in
   *  eventsLastMinute or the latency window. */
  setLoading(on: boolean): void {
    this.loading = on;
  }

  private noteArrival(ev: StoredEvent): void {
    if (this.loading) return;
    const arrived = Date.parse(ev.arrivedAt);
    this.arrivals.push(arrived);
    if (ev.source === "http") {
      const t = Date.parse(ev.time);
      if (Number.isFinite(t)) {
        this.latencies.push(Math.max(0, arrived - t));
        if (this.latencies.length > LATENCY_WINDOW) this.latencies.splice(0, this.latencies.length - LATENCY_WINDOW);
      }
    }
  }

  /** A subagent's event names its parent; the parent counts it once. Returns the
   *  parent entry when it exists and its count changed. */
  private noteChild(entry: Entry, ev: ProtocolEvent): Entry | undefined {
    const parentId = ev.session.parent_id;
    if (typeof parentId !== "string" || !parentId) return undefined;
    const parentKey = sessionKey(ev.harness.name, parentId);
    let kids = this.childrenOf.get(parentKey);
    if (!kids) {
      kids = new Set();
      this.childrenOf.set(parentKey, kids);
    }
    if (kids.has(entry.summary.key)) return undefined;
    kids.add(entry.summary.key);
    const parent = this.sessions.get(parentKey);
    if (!parent) return undefined;
    parent.childKeys = kids;
    parent.summary.children = kids.size;
    return parent;
  }

  private emit(msg: StreamMessage): void {
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch (e) {
        process.stderr.write(`[store] listener: ${(e as Error).message}\n`);
      }
    }
  }

  private emitMachines(names: Iterable<string>): void {
    if (!this.listeners.size) return;
    const all = this.machines();
    for (const name of new Set(names)) {
      const m = all.find((x) => x.name === name);
      if (!m) continue;
      const json = JSON.stringify(m);
      const prev = this.machinesSent.get(name);
      if (prev === json) continue;
      // Every event moves the machine's lastAt; that alone is not worth a frame per
      // event to every client (it doubled their work). It rides a flush a second later;
      // anything else about the machine goes out at once.
      if (prev !== undefined && withoutLastAt(prev) === withoutLastAt(json)) {
        this.machinesDue.add(name);
        this.machineFlush ??= setTimeout(() => this.flushMachines(), MACHINE_LASTAT_MS).unref();
        continue;
      }
      this.machinesSent.set(name, json);
      this.emit({ kind: "machine", machine: m });
    }
  }

  private flushMachines(): void {
    this.machineFlush = undefined;
    if (this.closed || !this.listeners.size) return;
    const due = [...this.machinesDue];
    this.machinesDue.clear();
    const all = this.machines();
    for (const name of due) {
      const m = all.find((x) => x.name === name);
      if (!m) continue;
      const json = JSON.stringify(m);
      if (this.machinesSent.get(name) === json) continue;
      this.machinesSent.set(name, json);
      this.emit({ kind: "machine", machine: m });
    }
  }

  private emitStats(): void {
    if (this.closed || !this.listeners.size) return;
    const stats = this.stats();
    const json = JSON.stringify({ ...stats, uptimeS: 0 });
    if (json === this.statsSent) return;
    this.statsSent = json;
    this.emit({ kind: "stats", stats });
  }

  /** The timers: a working session goes stale, a silent one done. */
  tick(now = Date.now()): void {
    if (this.closed) return;
    for (const entry of this.sessions.values()) {
      if (entry.summary.state === "done" && (entry.ended || !entry.live)) continue;
      if (!this.refresh(entry, now)) continue;
      this.emit({ kind: "session", session: entry.summary });
      const parent = this.parentOf(entry);
      if (parent && this.syncChildAgent(parent, entry)) {
        this.refresh(parent, now);
        this.emit({ kind: "session", session: parent.summary });
      }
    }
  }

  // ---------- API ----------

  ingest(events: ProtocolEvent[], source: EventSource): IngestResult {
    const now = Date.now();
    const arrivedAt = new Date(now).toISOString();
    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: [], stored: [] };
    const groups = new Map<SessionKey, { harness: string; id: string; events: StoredEvent[] }>();
    const upgrades: { key: SessionKey; harness: string; id: string; ev: StoredEvent; rec: Rec }[] = [];
    const forgotten: SessionKey[] = [];
    for (const ev of events) {
      const id = ev && typeof ev.id === "string" ? ev.id : "";
      const problem = minimalProblem(ev);
      if (problem) {
        result.rejected.push({ id, reason: problem });
        continue;
      }
      const harness = ev.harness.name;
      const sid = ev.session.id;
      const key = sessionKey(harness, sid);
      if (ev.type === "session.forgotten") {
        result.accepted++;
        forgotten.push(key);
        groups.delete(key);
        continue;
      }
      const seq = ev.session.seq;
      const entry = this.sessions.get(key);
      let group = groups.get(key);
      if (entry?.seqs.has(seq) || group?.events.some((e) => e.session.seq === seq)) {
        // A duplicate for the sender (HTTP.md §2), but when the same event arrives again
        // at a higher tier (the outbox's tier-3 copy after a tier-0 sink copy, or the
        // other way round) the richer one replaces what we keep.
        result.duplicates++;
        const have = entry ? findRec(entry, seq) : undefined;
        if (have && ev.tier > have.ev.tier)
          upgrades.push({ key, harness, id: sid, ev: { ...ev, arrivedAt, source }, rec: have });
        continue;
      }
      if (!group) {
        group = { harness, id: sid, events: [] };
        groups.set(key, group);
      }
      const stored: StoredEvent = { ...ev, arrivedAt, source };
      group.events.push(stored);
      result.stored.push(stored);
      result.accepted++;
    }
    for (const key of forgotten) this.forget(key);
    const machines = new Set<string>();
    for (const [key, g] of groups) {
      if (forgotten.includes(key)) continue;
      const entry = this.entry(g.harness, g.id, arrivedAt, source);
      const { lines, size } = this.files.append(g.harness, g.id, g.events, entry.size);
      this.storageBytes += size - entry.size;
      entry.size = size;
      const parents = new Set<Entry>();
      for (const line of lines) {
        const ev = line.event;
        this.index(entry, ev, line.offset, line.bytes);
        applyEvent(entry, ev, arrivedAt, source);
        this.noteArrival(ev);
        const parent = this.noteChild(entry, ev);
        if (parent) parents.add(parent);
        this.refresh(entry, now);
        this.emit({ kind: "event", event: ev, session: entry.summary });
      }
      // A child's agent entry on its parent follows the child; a parent that arrives after
      // its children picks them up.
      const parent = this.parentOf(entry);
      if (parent && this.syncChildAgent(parent, entry)) {
        this.refresh(parent, now);
        parents.add(parent);
      }
      if (entry.childKeys.size && this.syncChildren(entry)) this.emit({ kind: "session", session: entry.summary });
      for (const p of parents) this.emit({ kind: "session", session: p.summary });
      if (entry.summary.machine) machines.add(entry.summary.machine);
    }
    for (const u of upgrades) {
      if (forgotten.includes(u.key)) continue;
      const entry = this.sessions.get(u.key);
      if (!entry) continue;
      const { lines, size } = this.files.append(u.harness, u.id, [u.ev], entry.size);
      this.storageBytes += size - entry.size;
      entry.size = size;
      const line = lines[0];
      if (!line) continue;
      // Same place in every order (seq, time, arrival); only the content is richer.
      u.rec.ev = slimEvent(line.event);
      u.rec.offset = line.offset;
      u.rec.bytes = line.bytes;
      this.rebuild(entry, now);
      this.emit({ kind: "session", session: entry.summary });
      if (entry.summary.machine) machines.add(entry.summary.machine);
    }
    this.emitMachines(machines);
    this.pruneArrivals(now);
    return result;
  }

  private pruneArrivals(now: number): void {
    const cutoff = now - 60_000;
    let i = 0;
    while (i < this.arrivals.length && this.arrivals[i]! < cutoff) i++;
    if (i) this.arrivals.splice(0, i);
  }

  snapshot(): Snapshot {
    const now = Date.now();
    const sessions: SessionSummary[] = [];
    for (const entry of this.sessions.values()) {
      this.refresh(entry, now);
      sessions.push(entry.summary);
    }
    sessions.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    return { at: new Date(now).toISOString(), sessions, machines: this.machines(), stats: this.stats() };
  }

  session(key: SessionKey): SessionSummary | undefined {
    const entry = this.sessions.get(key);
    if (!entry) return undefined;
    this.refresh(entry, Date.now());
    return entry.summary;
  }

  sessionExists(key: SessionKey): boolean {
    return this.sessions.has(key);
  }

  keys(): SessionKey[] {
    return [...this.sessions.keys()];
  }

  /** A page of a session's events in seq order, at most `limit`: forwards after `after`
   *  (a seq; -1 or undefined for the start), or backwards with `opts.before` (the newest
   *  events with seq below it) or `opts.tail` (the newest events). Full lines are read
   *  from disk unless `opts.slim`, which returns the index's slim copies. */
  sessionDetail(
    key: SessionKey,
    after?: number,
    limit?: number,
    opts: { before?: number; tail?: boolean; slim?: boolean; agent?: string } = {},
  ): SessionDetail | undefined {
    const entry = this.sessions.get(key);
    if (!entry) return undefined;
    this.refresh(entry, Date.now());
    const n = Math.max(1, Math.min(DETAIL_MAX, limit ?? DETAIL_DEFAULT));
    const page: Rec[] = [];
    // One subagent's events: those stamped with its agent_id (its subagent.* too) and the
    // call that launched it.
    const run = opts.agent ? entry.summary.agents.find((a) => a.id === opts.agent) : undefined;
    const all = opts.agent
      ? entry.recs.filter(
          (r) =>
            r.ev.data.agent_id === opts.agent ||
            (!!run?.callId && r.ev.type.startsWith("tool.") && r.ev.data.call_id === run.callId),
        )
      : entry.recs;
    const backwards = opts.tail || (typeof opts.before === "number" && Number.isFinite(opts.before));
    if (backwards) {
      const below = opts.tail ? Number.POSITIVE_INFINITY : (opts.before as number);
      for (let i = all.length - 1; i >= 0 && page.length < n; i--) {
        const rec = all[i]!;
        if (rec.ev.session.seq < below) page.push(rec);
      }
      page.reverse();
    } else {
      const from = typeof after === "number" && Number.isFinite(after) ? after : -1;
      for (const rec of all) {
        if (rec.ev.session.seq <= from) continue;
        page.push(rec);
        if (page.length >= n) break;
      }
    }
    const { harness, id } = splitKey(key);
    const full = opts.slim ? [] : this.files.readAt(harness, id, page);
    const events = page.map((rec, i) => full[i] ?? rec.ev);
    const children: SessionSummary[] = [];
    for (const k of entry.childKeys) {
      const c = this.sessions.get(k);
      if (c) children.push(c.summary);
    }
    const firstSeq = page[0]?.ev.session.seq;
    const hasOlder = firstSeq !== undefined && all.some((r) => r.ev.session.seq < firstSeq);
    return { session: entry.summary, events, total: all.length, children, firstSeq, hasOlder };
  }

  /** Newest event time first (arrival breaks ties). `before` is the cursor of a previous page. */
  feed(q: FeedQuery = {}): FeedPage {
    const limit = Math.max(1, Math.min(FEED_MAX, q.limit ?? FEED_DEFAULT));
    const cursor = q.before ? decodeCursor(q.before) : null;
    const needle = q.q?.trim().toLowerCase();
    const events: StoredEvent[] = [];
    let i = this.byTime.length - 1;
    if (cursor) {
      // First index at or past the cursor (byTime ascends by (t, no)); start just before it.
      let lo = 0;
      let hi = this.byTime.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (before(this.byTime[mid]!, cursor)) lo = mid + 1;
        else hi = mid;
      }
      i = lo - 1;
    }
    let last: Rec | undefined;
    for (; i >= 0 && events.length < limit; i--) {
      const rec = this.byTime[i]!;
      const ev = rec.ev;
      if (q.harness && ev.harness.name !== q.harness) continue;
      if (q.type && ev.type !== q.type) continue;
      const key = sessionKey(ev.harness.name, ev.session.id);
      if (q.session && key !== q.session) continue;
      const summary = this.sessions.get(key)?.summary;
      if (q.machine && (summary?.machine ?? ev.session.machine) !== q.machine) continue;
      if (needle && !matches(ev, summary, needle)) continue;
      events.push(ev);
      last = rec;
    }
    const page: FeedPage = { events };
    if (last && i >= 0) page.cursor = encodeCursor(last);
    return page;
  }

  // ---------- review (store/review.ts) ----------

  private review(): ReviewIndex {
    return {
      byTime: this.byTime,
      summary: (key) => this.sessions.get(key)?.summary,
      isFirst: (rec) => this.sessions.get(sessionKey(rec.ev.harness.name, rec.ev.session.id))?.recs[0] === rec,
      readFull: (key, recs) => {
        const { harness, id } = splitKey(key);
        return this.files.readAt(harness, id, recs);
      },
      cursor: { encode: encodeCursor, decode: decodeCursor },
    };
  }

  /** Transcripts, tool names, attention messages, changed paths and titles; newest first. */
  search(q: SearchQuery): SearchPage {
    return search(this.review(), q);
  }

  /** Paths from files.changed since a time, by repo then path, with the sessions that touched each. */
  filesChanged(q: FilesQuery = {}): FilesPage {
    return filesChanged(this.review(), q);
  }

  /** A local day's sessions and their counts, with totals per machine and per repo. Throws
   *  RangeError("bad_day") when `day` is not a date. */
  digest(q: DigestQuery = {}): Digest {
    return digest(this.review(), q);
  }

  /** Delete a session's file and index entry (a `session.forgotten`, or the UI). */
  forget(key: SessionKey): boolean {
    const entry = this.sessions.get(key);
    if (!entry) return false;
    const { harness, id } = splitKey(key);
    this.files.remove(harness, id);
    this.sessions.delete(key);
    this.storageBytes -= entry.size;
    this.byTime = this.byTime.filter((r) => !(r.ev.session.id === id && r.ev.harness.name === harness));
    if (entry.summary.parentId) {
      const parentKey = sessionKey(harness, entry.summary.parentId);
      const kids = this.childrenOf.get(parentKey);
      if (kids?.delete(key)) {
        const parent = this.sessions.get(parentKey);
        if (parent) {
          parent.summary.children = kids.size;
          // The agent ran; only the link to its forgotten session goes.
          parent.summary.agents = parent.summary.agents.map((a) => {
            if (a.session !== key) return a;
            const { session: _gone, ...rest } = a;
            return rest;
          });
          this.emit({ kind: "session", session: parent.summary });
        }
      }
    }
    this.emit({ kind: "forgotten", key });
    if (entry.summary.machine) this.emitMachines([entry.summary.machine]);
    return true;
  }

  machines(): MachineSummary[] {
    const out = new Map<string, MachineSummary>();
    for (const entry of this.sessions.values()) {
      const s = entry.summary;
      if (!s.machine) continue;
      let m = out.get(s.machine);
      if (!m) {
        m = { name: s.machine, lastAt: s.lastAt, harnesses: {}, sessions: 0, working: 0, needsYou: 0 };
        out.set(s.machine, m);
      }
      m.sessions++;
      if (s.lastAt > m.lastAt) m.lastAt = s.lastAt;
      if (s.state === "working") m.working++;
      if (s.state === "needs_you") m.needsYou++;
      if (!(s.harness in m.harnesses) || (s.harnessVersion && s.lastAt >= m.lastAt))
        m.harnesses[s.harness] = s.harnessVersion;
    }
    return [...out.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  }

  stats(): Stats {
    const now = Date.now();
    this.pruneArrivals(now);
    const machines = new Set<string>();
    for (const e of this.sessions.values()) if (e.summary.machine) machines.add(e.summary.machine);
    const stats: Stats = {
      events: this.byTime.length,
      sessions: this.sessions.size,
      machines: machines.size,
      eventsLastMinute: this.arrivals.length,
      storageBytes: this.storageBytes,
      uptimeS: Math.round((now - this.startedAt) / 1000),
    };
    if (this.latencies.length) {
      const sorted = [...this.latencies].sort((a, b) => a - b);
      stats.latencyP50Ms = sorted[Math.floor((sorted.length - 1) / 2)]!;
    }
    return stats;
  }

  subscribe(l: StoreListener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    if (this.machineFlush) clearTimeout(this.machineFlush);
    this.listeners.clear();
  }
}

/** What the store needs of an event before it will file it; the receiver validates
 *  the whole envelope (receiver/validate.ts) before this. */
function minimalProblem(ev: ProtocolEvent): string | null {
  if (!ev || typeof ev !== "object") return "malformed";
  if (typeof ev.type !== "string" || !ev.type) return "bad_type";
  if (!ev.harness || typeof ev.harness.name !== "string" || !ev.harness.name) return "bad_harness";
  if (!ev.session || typeof ev.session.id !== "string" || !ev.session.id) return "bad_session";
  if (!Number.isInteger(ev.session.seq) || ev.session.seq < 0) return "bad_seq";
  if (!ev.data || typeof ev.data !== "object") return "bad_data";
  return null;
}

function matches(ev: SlimEvent, summary: SessionSummary | undefined, needle: string): boolean {
  const d = ev.data;
  const parts: unknown[] = [ev.type, d.tool, summary?.title ?? ev.session.title, d.user, d.assistant, d.message];
  if (Array.isArray(d.paths)) parts.push(d.paths.join(" "));
  for (const p of parts) if (typeof p === "string" && p.toLowerCase().includes(needle)) return true;
  return false;
}
