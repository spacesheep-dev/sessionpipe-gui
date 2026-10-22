// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The Review page's three readings over the index: a transcript
// search, the files changed grouped by repo and path, and a day's digest. All of them
// are linear scans over the slim records in time order; the search reads a full event
// back from disk only when a cut preview did not already decide the match.
import type {
  Digest,
  DigestCounts,
  DigestGroup,
  DigestQuery,
  DigestSession,
  FilesPage,
  FilesPath,
  FilesQuery,
  FilesRepo,
  FilesSession,
  SearchField,
  SearchPage,
  SearchQuery,
  SessionKey,
  SessionSummary,
  StoredEvent,
} from "../../shared/api.js";
import { changedPaths } from "./paths.js";
import { idleNotice, newRecord } from "./readings.js";
import type { Rec } from "./store.js";

/** What the store lends these readings. */
export interface ReviewIndex {
  /** Every event by (event time, arrival), ascending. */
  byTime: readonly Rec[];
  summary(key: SessionKey): SessionSummary | undefined;
  /** Whether a record is the first one of its session (titles are matched once per session). */
  isFirst(rec: Rec): boolean;
  /** Full events from disk, for records of one session. */
  readFull(key: SessionKey, recs: Rec[]): (StoredEvent | undefined)[];
  cursor: { encode(r: Rec): string; decode(c: string): { t: number; no: number } | null };
}

const SEARCH_DEFAULT = 50;
const SEARCH_MAX = 200;
/** Records looked at between disk reads: the cut previews of a chunk are read back together. */
const CHUNK = 256;
/** Characters kept on each side of a match. */
const CONTEXT = 80;
const DAY_MS = 86_400_000;

const keyOf = (ev: StoredEvent): SessionKey => `${ev.harness.name}:${ev.session.id}`;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The title the UI would show: the session's title, else the last path segment of its cwd, else the id. */
export function titleOf(summary: SessionSummary | undefined, ev: StoredEvent): string {
  const title = summary?.title?.trim() || ev.session.title?.trim();
  if (title) return title;
  const cwd = summary?.cwd ?? ev.session.cwd;
  if (cwd) {
    const clean = cwd.replace(/[\\/]+$/, "");
    const i = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
    return (i >= 0 ? clean.slice(i + 1) : clean) || clean;
  }
  return ev.session.id.slice(0, 8);
}

/** First index of byTime at or past a time (ms). */
function lowerBound(byTime: readonly Rec[], t: number): number {
  let lo = 0;
  let hi = byTime.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byTime[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------- search ----------

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Found {
  field: SearchField;
  snippet: string;
  match: [number, number];
}

/** The first match of `re` in `text` with its surroundings, or null. */
function snip(text: string, re: RegExp, field: SearchField): Found | null {
  re.lastIndex = 0;
  const m = re.exec(text);
  if (!m) return null;
  const i = m.index;
  const start = Math.max(0, i - CONTEXT);
  const end = Math.min(text.length, i + m[0].length + CONTEXT);
  const pre = start > 0 ? "…" : "";
  const post = end < text.length ? "…" : "";
  const body = text.slice(start, end).replace(/[\r\n\t]/g, " ");
  const at = pre.length + (i - start);
  return { field, snippet: pre + body + post, match: [at, at + m[0].length] };
}

/** The fields of an event the search looks at, in the order a hit is attributed. */
function fieldsOf(ev: StoredEvent, summary: SessionSummary | undefined, first: boolean): [SearchField, string][] {
  const d = ev.data;
  const out: [SearchField, string][] = [];
  if (ev.type === "turn.transcript" || ev.type === "turn.progress") {
    const u = str(d.user);
    const a = str(d.assistant);
    if (u) out.push(["user", u]);
    if (a) out.push(["assistant", a]);
  }
  if (ev.type === "tool.ended" || ev.type === "attention.needed") {
    const tool = str(d.tool);
    if (tool) out.push(["tool", tool]);
  }
  if (ev.type === "attention.needed") {
    const message = str(d.message);
    if (message) out.push(["message", message]);
  }
  for (const p of changedPaths(ev, summary?.cwd)) out.push(["path", p]);
  if (first) {
    const title = summary?.title ?? ev.session.title;
    if (title) out.push(["title", title]);
  }
  return out;
}

function matchEvent(ev: StoredEvent, summary: SessionSummary | undefined, first: boolean, re: RegExp): Found | null {
  for (const [field, text] of fieldsOf(ev, summary, first)) {
    const f = snip(text, re, field);
    if (f) return f;
  }
  return null;
}

/** Whether the slim copy may hide a match: a transcript field was cut to its preview. */
const cutText = (ev: StoredEvent): boolean => !!ev.preview && ("user" in ev.preview || "assistant" in ev.preview);

/** Newest first, case-insensitive substring, over transcripts (user and assistant, the
 *  full text when the preview was cut), tool names, attention messages, changed paths
 *  and session titles (once per session). */
export function search(ix: ReviewIndex, q: SearchQuery): SearchPage {
  const t0 = performance.now();
  const needle = (q.q ?? "").trim();
  const limit = Math.max(1, Math.min(SEARCH_MAX, q.limit ?? SEARCH_DEFAULT));
  const page: SearchPage = { q: needle, hits: [], scanned: 0, ms: 0 };
  if (!needle) return page;
  const re = new RegExp(escapeRe(needle), "i");
  const byTime = ix.byTime;
  let i = byTime.length - 1;
  const cursor = q.before ? ix.cursor.decode(q.before) : null;
  if (cursor) {
    // byTime ascends by (t, no); start just before the first record at or past the cursor.
    let lo = 0;
    let hi = byTime.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = byTime[mid]!;
      if (r.t < cursor.t || (r.t === cursor.t && r.no < cursor.no)) lo = mid + 1;
      else hi = mid;
    }
    i = lo - 1;
  }
  let last: { rec: Rec; index: number } | undefined;
  while (i >= 0 && page.hits.length < limit) {
    const slots: { rec: Rec; index: number; summary: SessionSummary | undefined; found: Found | null }[] = [];
    const deep = new Map<SessionKey, typeof slots>();
    for (const end = Math.max(-1, i - CHUNK); i > end; i--) {
      const rec = byTime[i]!;
      const key = keyOf(rec.ev);
      const summary = ix.summary(key);
      const slot = { rec, index: i, summary, found: matchEvent(rec.ev, summary, ix.isFirst(rec), re) };
      slots.push(slot);
      page.scanned++;
      if (!slot.found && cutText(rec.ev)) {
        const list = deep.get(key) ?? [];
        list.push(slot);
        deep.set(key, list);
      }
    }
    for (const [key, list] of deep) {
      const full = ix.readFull(
        key,
        list.map((s) => s.rec),
      );
      list.forEach((s, j) => {
        const ev = full[j];
        if (ev) s.found = matchEvent(ev, s.summary, false, re);
      });
    }
    for (const s of slots) {
      if (!s.found) continue;
      page.hits.push({
        session: s.summary ?? summaryless(s.rec.ev),
        event: s.rec.ev,
        field: s.found.field,
        snippet: s.found.snippet,
        match: s.found.match,
      });
      last = { rec: s.rec, index: s.index };
      if (page.hits.length >= limit) break;
    }
  }
  if (last && page.hits.length >= limit && last.index > 0) page.cursor = ix.cursor.encode(last.rec);
  page.ms = Math.round((performance.now() - t0) * 10) / 10;
  return page;
}

/** A session the index no longer has (forgotten between scan and read): the bare facts. */
function summaryless(ev: StoredEvent): SessionSummary {
  const s = newRecord(ev.harness.name, ev.session.id, ev.time, ev.source).summary;
  s.machine = ev.session.machine;
  s.cwd = ev.session.cwd;
  s.repo = ev.session.repo;
  s.title = ev.session.title;
  s.state = "done";
  s.maxTier = ev.tier;
  return s;
}

// ---------- files changed ----------

const newer = (a: string, b: string): string => (a > b ? a : b);

/** A `files.changed` that follows a write tool's own `tool.ended` within this long names
 *  the same change: it is not counted again. */
const SAME_CHANGE_MS = 10_000;

/** Paths the sessions changed since a time (files.changed events and successful write
 *  tools, paths.ts), grouped by repo then path, newest first at every level, each path
 *  with the sessions that touched it. */
export function filesChanged(ix: ReviewIndex, q: FilesQuery, now = Date.now()): FilesPage {
  const sinceMs = q.since ? Date.parse(q.since) : Number.NaN;
  const since = Number.isFinite(sinceMs) ? sinceMs : now - DAY_MS;
  const repos = new Map<string, { lastAt: string; sessions: Set<SessionKey>; paths: Map<string, PathAcc> }>();
  const byTime = ix.byTime;
  // The window's changes, newest first, each with its paths; the write tools' instants per
  // (session, path) first, so a files.changed that repeats one of them can be skipped.
  const changes: { rec: Rec; key: SessionKey; summary: SessionSummary | undefined; paths: string[] }[] = [];
  const writes = new Map<string, number[]>();
  for (let i = byTime.length - 1; i >= 0; i--) {
    const rec = byTime[i]!;
    if (rec.t < since) break;
    const ev = rec.ev;
    if (ev.type !== "files.changed" && ev.type !== "tool.ended") continue;
    const key = keyOf(ev);
    const summary = ix.summary(key);
    const paths = changedPaths(ev, summary?.cwd ?? ev.session.cwd);
    if (!paths.length) continue;
    changes.push({ rec, key, summary, paths });
    if (ev.type === "tool.ended")
      for (const p of paths) {
        const k = `${key}\0${p}`;
        const list = writes.get(k) ?? [];
        list.push(rec.t);
        writes.set(k, list);
      }
  }
  for (const { rec, key, summary, paths: all } of changes) {
    const ev = rec.ev;
    const paths =
      ev.type === "files.changed"
        ? all.filter((p) => !(writes.get(`${key}\0${p}`) ?? []).some((t) => Math.abs(t - rec.t) <= SAME_CHANGE_MS))
        : all;
    if (!paths.length) continue;
    const repo = summary?.repo ?? ev.session.repo ?? "";
    if (q.repo !== undefined && q.repo !== "" && repo !== q.repo) continue;
    const at = new Date(rec.t).toISOString();
    let r = repos.get(repo);
    if (!r) {
      r = { lastAt: at, sessions: new Set(), paths: new Map() };
      repos.set(repo, r);
    }
    r.lastAt = newer(r.lastAt, at);
    r.sessions.add(key);
    for (const p of paths) {
      let acc = r.paths.get(p);
      if (!acc) {
        acc = { count: 0, lastAt: at, sessions: new Map() };
        r.paths.set(p, acc);
      }
      acc.count++;
      acc.lastAt = newer(acc.lastAt, at);
      const s = acc.sessions.get(key) ?? { key, title: titleOf(summary, ev), count: 0, lastAt: at };
      s.count++;
      s.lastAt = newer(s.lastAt, at);
      acc.sessions.set(key, s);
    }
  }
  const byLast = <T extends { lastAt: string }>(a: T, b: T) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0);
  let total = 0;
  const out: FilesRepo[] = [];
  for (const [repo, r] of repos) {
    const paths: FilesPath[] = [];
    for (const [path, acc] of r.paths) {
      paths.push({ path, count: acc.count, lastAt: acc.lastAt, sessions: [...acc.sessions.values()].sort(byLast) });
    }
    paths.sort(byLast);
    total += paths.length;
    out.push({ repo, lastAt: r.lastAt, sessions: r.sessions.size, paths });
  }
  out.sort(byLast);
  return { since: new Date(since).toISOString(), repos: out, total };
}

interface PathAcc {
  count: number;
  lastAt: string;
  sessions: Map<SessionKey, FilesSession>;
}

// ---------- daily digest ----------

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The YYYY-MM-DD of an instant in a place `tz` minutes behind UTC (getTimezoneOffset's sign). */
export const localDay = (ms: number, tz: number): string => new Date(ms - tz * 60_000).toISOString().slice(0, 10);

/** The UTC bounds of a local day, or null when `day` is not a date. */
export function dayBounds(day: string, tz: number): { from: number; to: number } | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + tz * 60_000;
  if (!Number.isFinite(from)) return null;
  return { from, to: from + DAY_MS };
}

interface SessionAcc extends DigestCounts {
  key: SessionKey;
  summary: SessionSummary | undefined;
  ev: StoredEvent;
  first: number;
  last: number;
  files: Set<string>;
}

const zeroCounts = (): DigestCounts => ({
  events: 0,
  turns: 0,
  tools: 0,
  errors: 0,
  attentions: 0,
  compactions: 0,
  filesTouched: 0,
});

/** Every session with an event inside the local day, its counts over that day only, and
 *  the same counts summed per machine, per repo and in all. */
export function digest(ix: ReviewIndex, q: DigestQuery, now = Date.now()): Digest {
  const tz = typeof q.tz === "number" && Number.isFinite(q.tz) ? q.tz : 0;
  const day = q.day ?? localDay(now, tz);
  const bounds = dayBounds(day, tz);
  if (!bounds) throw new RangeError("bad_day");
  const { from, to } = bounds;
  const byTime = ix.byTime;
  const acc = new Map<SessionKey, SessionAcc>();
  for (let i = lowerBound(byTime, from); i < byTime.length && byTime[i]!.t < to; i++) {
    const rec = byTime[i]!;
    const ev = rec.ev;
    const key = keyOf(ev);
    let a = acc.get(key);
    if (!a) {
      a = { ...zeroCounts(), key, summary: ix.summary(key), ev, first: rec.t, last: rec.t, files: new Set() };
      acc.set(key, a);
    }
    a.events++;
    a.last = rec.t;
    const d = ev.data;
    switch (ev.type) {
      case "turn.started":
        a.turns++;
        break;
      case "tool.ended":
        a.tools++;
        if (d.ok === false) a.errors++;
        break;
      case "attention.needed":
        // The idle notice asked for nothing (readings.ts idleNotice).
        if (!idleNotice(ev)) a.attentions++;
        break;
      case "context.compacted":
        a.compactions++;
        break;
      default:
        break;
    }
    for (const p of changedPaths(ev, a.summary?.cwd ?? ev.session.cwd)) a.files.add(p);
  }
  const sessions: DigestSession[] = [];
  const machines = new Map<string, GroupAcc>();
  const repos = new Map<string, GroupAcc>();
  const all: GroupAcc = { ...zeroCounts(), name: "all", sessions: 0, activeMs: 0, files: new Set() };
  for (const a of acc.values()) {
    const machine = a.summary?.machine ?? a.ev.session.machine;
    const repo = a.summary?.repo ?? a.ev.session.repo;
    const s: DigestSession = {
      key: a.key,
      title: titleOf(a.summary, a.ev),
      harness: a.ev.harness.name,
      startedAt: new Date(a.first).toISOString(),
      endedAt: new Date(a.last).toISOString(),
      activeMs: a.last - a.first,
      events: a.events,
      turns: a.turns,
      tools: a.tools,
      errors: a.errors,
      attentions: a.attentions,
      compactions: a.compactions,
      filesTouched: a.files.size,
    };
    if (machine) s.machine = machine;
    if (repo) s.repo = repo;
    sessions.push(s);
    add(all, a);
    add(group(machines, machine ?? ""), a);
    add(group(repos, repo ?? ""), a);
  }
  sessions.sort((x, y) => (x.startedAt < y.startedAt ? -1 : x.startedAt > y.startedAt ? 1 : 0));
  return {
    day,
    tz,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    sessions,
    byMachine: finish(machines),
    byRepo: finish(repos),
    totals: finishOne(all),
  };
}

interface GroupAcc extends DigestGroup {
  files: Set<string>;
}

function group(map: Map<string, GroupAcc>, name: string): GroupAcc {
  let g = map.get(name);
  if (!g) {
    g = { ...zeroCounts(), name, sessions: 0, activeMs: 0, files: new Set() };
    map.set(name, g);
  }
  return g;
}

function add(g: GroupAcc, a: SessionAcc): void {
  g.sessions++;
  g.activeMs += a.last - a.first;
  g.events += a.events;
  g.turns += a.turns;
  g.tools += a.tools;
  g.errors += a.errors;
  g.attentions += a.attentions;
  g.compactions += a.compactions;
  for (const f of a.files) g.files.add(f);
}

function finishOne(g: GroupAcc): DigestGroup {
  const { files, ...rest } = g;
  return { ...rest, filesTouched: files.size };
}

function finish(map: Map<string, GroupAcc>): DigestGroup[] {
  return [...map.values()].map(finishOne).sort((a, b) => b.events - a.events || a.name.localeCompare(b.name));
}
