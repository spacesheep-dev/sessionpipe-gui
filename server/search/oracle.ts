// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. The brute-force SearchReader (SEARCH-SPEC.md §3.2): the correctness
// oracle the engine is tested against, and the service's stub until the engine lands (M2).
// Everything lives in memory as plain arrays; every rule is written the obvious way, so
// when the engine and the oracle disagree, the oracle is the one that reads like the spec.
//
// The rules it pins down where the spec leaves a choice (the engine must agree, or say so):
//   tokens     as the engine's tokenize.ts states them (re-implemented here independently, one
//              UTF-16 unit at a time): runs of letters, digits (Nd), marks and `_`; parts cut at
//              `_`, (lower|digit)→Upper and HTTP→Server, never letter→digit; a run over 200 units
//              or a part over 40 takes no position; CJK one character per token; astral
//              characters separate; folded NFKD without marks, lowercase, ß → ss (a CJK
//              character: NFKC, so kana keep their voicing and Hangul stays whole). A word of 2+
//              parts repeats itself whole (outer `_` trimmed) at its first part's position.
//   word       one term: that term, or its plural variants (+s, +es, −s when > 3) at 0.6.
//              Several terms: a phrase of the parts; a single identifier also matches its
//              joined form as one term.
//   phrase     consecutive positions over the parts; a position matches any term emitted there.
//   prefix     the last part is expanded over the read dictionary: the exact term (if present)
//              plus the top k others by df (ties: term order); k = 12/32/64 for 2/3/4+ code
//              points when `live`, else 64. Titles match a prefix directly (no cap).
//   fields     `fields` restricts every clause, negations included; the title answers only when
//              `fields` is absent or names "title".
//   negation   a session is dropped when any of its (field-allowed) docs or its title matches.
//   matched    docs matching at least one positive clause.
//   browse     no positive clause that tokenizes to anything: with a filter or a negation, the
//              allowed sessions newest first, one hit = the first prompt (none if no prompt);
//              with neither, nothing.
//   order      transcript order = (at, file, offset, emission); `at` 0 sorts first.
//   more       another page exists after offset + limit.
//   refs       `<file id base36>-<offset base36>[-<n>]`, n for the n-th doc on one offset.
import type {
  DocSink,
  EngineHit,
  EngineMatch,
  EngineQuery,
  EngineResult,
  IndexedSession,
  ParsedSearch,
  ReaderStats,
  SearchDoc,
  SearchDocField,
  SearchMark,
  SearchReader,
  SearchSource,
  SessionFacts,
  SessionKey,
  SessionOverlay,
  SourceAdapter,
  SourceEnv,
  TranscriptWindow,
} from "./types.js";

// ───────────────────────────── tokenizer (reference) ─────────────────────────────

export interface OracleToken {
  /** Folded term. */
  term: string;
  pos: number;
  /** [start, end) in the original text, UTF-16 units. */
  start: number;
  end: number;
  /** The joined form of a multi-part word, at the first part's position. */
  whole?: boolean;
}

// One UTF-16 unit at a time (astral characters, emoji included, separate words).
type Cls = "other" | "lower" | "upper" | "digit" | "letter" | "cjk" | "mark" | "under";
const clsCache = new Map<number, Cls>();
function cls(code: number): Cls {
  const hit = clsCache.get(code);
  if (hit) return hit;
  let k: Cls = "other";
  if (code === 95) k = "under";
  else if (code >= 0xd800 && code <= 0xdfff) k = "other";
  else {
    const ch = String.fromCharCode(code);
    if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch) &&
      /[\p{L}\p{Nd}\p{M}]/u.test(ch)
    )
      k = "cjk";
    else if (/[\p{Lu}\p{Lt}]/u.test(ch)) k = "upper";
    else if (/\p{Ll}/u.test(ch)) k = "lower";
    else if (/\p{Nd}/u.test(ch)) k = "digit";
    else if (/\p{L}/u.test(ch)) k = "letter";
    else if (/\p{M}/u.test(ch)) k = "mark";
  }
  clsCache.set(code, k);
  return k;
}
const RUN_MAX = 200;
const PART_MAX = 40;

/** Folds one term: when non-ASCII, NFKD without marks, then lowercase, ß → ss. */
export function foldTerm(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: an ASCII range test
  if (!/[^\x00-\x7f]/.test(s)) return s.toLowerCase();
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss");
}

/** The reference tokenizer (arch-engine.md §4, as the engine's tokenize.ts reads it):
 *  a word is a run of letters, digits (Nd), marks and `_` that does not start with a mark;
 *  CJK characters are one token each; parts cut at `_`, (lower|digit)→Upper and
 *  Upper→Upper+lower; a part over 40 or a run over 200 units takes no position; a word of
 *  2+ emitted parts repeats itself whole (outer `_` trimmed, inner kept) at its first
 *  part's position when that is ≤ 40 units. */
export function oracleTokens(text: string): OracleToken[] {
  const out: OracleToken[] = [];
  let pos = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const k = cls(text.charCodeAt(i));
    if (k === "other" || k === "mark") {
      i++;
      continue;
    }
    if (k === "cjk") {
      // NFKC only: stripping marks after NFKD would turn デ into テ and split Hangul into jamo.
      out.push({ term: text[i]!.normalize("NFKC").toLowerCase(), pos: pos++, start: i, end: i + 1 });
      i++;
      continue;
    }
    const start = i;
    while (i < n) {
      const c = cls(text.charCodeAt(i));
      if (c === "other" || c === "cjk") break;
      i++;
    }
    const end = i;
    if (end - start > RUN_MAX) continue;
    // Cut points.
    const parts: [number, number][] = [];
    let ps = start;
    for (let j = start; j <= end; j++) {
      const c = j < end ? cls(text.charCodeAt(j)) : "other";
      let cut = j === end || c === "under";
      if (!cut && j > ps && c === "upper") {
        const prev = cls(text.charCodeAt(j - 1));
        if (prev === "lower" || prev === "digit") cut = true;
        else if (prev === "upper" && j + 1 < end && cls(text.charCodeAt(j + 1)) === "lower") cut = true;
      }
      if (!cut) continue;
      if (j > ps) parts.push([ps, j]);
      ps = c === "under" ? j + 1 : j;
    }
    const first = pos;
    let emitted = 0;
    for (const [a, b] of parts) {
      if (b - a > PART_MAX) continue;
      out.push({ term: foldTerm(text.slice(a, b)), pos: pos++, start: a, end: b });
      emitted++;
    }
    if (emitted > 1) {
      let ws = start;
      while (ws < end && text.charCodeAt(ws) === 95) ws++;
      let we = end;
      while (we > ws && text.charCodeAt(we - 1) === 95) we--;
      if (we - ws <= PART_MAX)
        out.push({ term: foldTerm(text.slice(ws, we)), pos: first, start: ws, end: we, whole: true });
    }
  }
  return out;
}

// ───────────────────────────── model ─────────────────────────────

/** A doc as the oracle takes it: a SearchDoc, plus which index and file it came from. */
export interface OracleDoc extends SearchDoc {
  /** Default: "sessionpipe" when `seq` is set, else "history". */
  source?: SearchSource;
  /** The file it was read from (refs and transcript order); default `<source>:<key>`. */
  file?: string;
  /** Found by the live tail (not committed yet). */
  live?: boolean;
}

export interface OracleFacts extends SessionFacts {
  source?: SearchSource;
}

export interface OracleOptions {
  /** The opened indexes (default both). */
  sources?: readonly SearchSource[];
  /** The clock for recency (default Date.now). */
  now?: () => number;
}

interface Doc {
  d: OracleDoc;
  source: SearchSource;
  key: SessionKey;
  fileId: number;
  ref: string;
  toks: OracleToken[];
  /** Terms by position. */
  byPos: Map<number, Set<string>>;
  terms: Map<string, number>;
  len: number;
  /** Transcript order within the session. */
  ord: number;
  emit: number;
}

interface Sess {
  key: SessionKey;
  harness: string;
  id: string;
  docs: Record<SearchSource, Doc[]>;
  facts: Record<SearchSource, boolean>;
  /** Facts folded per index, in commit order. */
  ff: Partial<Record<SearchSource, Folded>>;
}

interface Folded {
  title?: { text: string; rank: number };
  cwd?: string;
  branch?: string;
  repo?: string;
  model?: string;
  machine?: string;
  account?: string;
  firstAt?: number;
  lastAt?: number;
  forkOf?: SessionKey;
  resume?: SessionFacts["resume"];
  path?: string;
}

const FOLD_KEYS = ["cwd", "branch", "repo", "model", "machine", "account", "forkOf", "path"] as const;

/** Folds `f` (newer) into `into`: newest value per field (empty strings ignored), the title by
 *  rank (equal: the newer), firstAt min, lastAt max. */
function fold(into: Folded, f: Folded): void {
  if (f.title?.text && (!into.title || f.title.rank >= into.title.rank)) into.title = { ...f.title };
  for (const k of FOLD_KEYS) if (f[k] !== undefined && f[k] !== "") into[k] = f[k];
  if (f.resume !== undefined) into.resume = f.resume;
  if (f.firstAt) into.firstAt = into.firstAt === undefined ? f.firstAt : Math.min(into.firstAt, f.firstAt);
  if (f.lastAt) into.lastAt = into.lastAt === undefined ? f.lastAt : Math.max(into.lastAt, f.lastAt);
}

const W: Record<SearchDocField | "title", number> = { title: 4.0, prompt: 2.0, reply: 1.0, tool: 0.7 };
const B: Record<SearchDocField | "title", number> = { title: 0.3, prompt: 0.75, reply: 0.75, tool: 0.5 };
const K1 = 1.2;
const SUBAGENT = 0.8;
const PLURAL = 0.6;
const EXPANSION = 0.85;
const _TOTAL_EXACT = 200;
const HITS_IN_MAX = 500;
const DAY = 86_400_000;
const SOURCES: readonly SearchSource[] = ["history", "sessionpipe"];

const splitKey = (key: string): { harness: string; id: string } => {
  const i = key.indexOf(":");
  return i < 0 ? { harness: key, id: "" } : { harness: key.slice(0, i), id: key.slice(i + 1) };
};

/** One clause as alternatives; each alternative is a sequence of slots (term sets). */
interface Atom {
  slots: Set<string>[];
  /** Score multiplier. */
  weight: number;
}
interface Clause {
  not: boolean;
  atoms: Atom[];
  /** For titles: the prefix of the last slot, matched directly. */
  titlePrefix?: { head: Set<string>[]; prefix: string }[];
  word?: string;
  single?: string;
}

// ───────────────────────────── the reader ─────────────────────────────

export class OracleReader implements SearchReader {
  private docs: Doc[] = [];
  private sess = new Map<SessionKey, Sess>();
  private overlays = new Map<SessionKey, SessionOverlay>();
  private forgotten = new Set<SessionKey>();
  private files = new Map<string, number>();
  private fileNames: string[] = [];
  private dfCache = new Map<string, Map<string, number>>();
  private refs = new Map<string, Doc>();
  private emitted = 0;
  private gen = 0;
  private readonly opened: readonly SearchSource[];
  private readonly now: () => number;
  /** Calls of `allow` in the last search, per key (tests check "at most once"). */
  allowCalls = new Map<SessionKey, number>();

  constructor(opts: OracleOptions = {}) {
    this.opened = opts.sources ?? SOURCES;
    this.now = opts.now ?? Date.now;
  }

  /** Adds docs and facts (a commit, or the live tail). Docs of a forgotten key revive it. */
  add(docs: readonly OracleDoc[], facts: readonly OracleFacts[] = []): this {
    for (const f of facts) this.addFacts(f);
    const touched = new Set<SessionKey>();
    for (const d of docs) {
      const source = d.source ?? (d.seq !== undefined ? "sessionpipe" : "history");
      if (!this.opened.includes(source)) continue;
      const file = d.file ?? `${source}:${d.key}`;
      let fileId = this.files.get(file);
      if (fileId === undefined) {
        fileId = this.files.size;
        this.files.set(file, fileId);
        this.fileNames.push(file);
      }
      let ref = `${fileId.toString(36)}-${Math.max(0, Math.floor(d.offset)).toString(36)}`;
      for (let n = 1; this.refs.has(ref); n++) ref = `${fileId.toString(36)}-${d.offset.toString(36)}-${n}`;
      const toks = oracleTokens(d.text);
      const byPos = new Map<number, Set<string>>();
      const terms = new Map<string, number>();
      let len = 0;
      for (const t of toks) {
        const s = byPos.get(t.pos) ?? new Set<string>();
        byPos.set(t.pos, s);
        s.add(t.term);
        terms.set(t.term, (terms.get(t.term) ?? 0) + 1);
        if (!t.whole) len++;
      }
      const doc: Doc = { d, source, key: d.key, fileId, ref, toks, byPos, terms, len, ord: 0, emit: this.emitted++ };
      this.refs.set(ref, doc);
      this.docs.push(doc);
      const s = this.ensure(d.key);
      s.docs[source].push(doc);
      touched.add(d.key);
    }
    for (const k of touched) {
      this.forgotten.delete(k);
      const s = this.sess.get(k)!;
      for (const src of SOURCES) {
        const fn = this.fileNames;
        s.docs[src].sort(
          (a, b) =>
            a.d.at - b.d.at ||
            (fn[a.fileId]! < fn[b.fileId]! ? -1 : fn[a.fileId]! > fn[b.fileId]! ? 1 : 0) ||
            a.d.offset - b.d.offset ||
            a.emit - b.emit,
        );
        s.docs[src].forEach((x, i) => {
          x.ord = i;
        });
      }
    }
    this.gen++;
    return this;
  }

  /** Drops docs (a tombstone: a replaced file, a forgotten session). */
  remove(pred: (d: OracleDoc) => boolean): this {
    const gone = new Set<Doc>();
    for (const doc of this.docs) if (pred(doc.d)) gone.add(doc);
    if (!gone.size) return this;
    this.docs = this.docs.filter((x) => !gone.has(x));
    for (const doc of gone) this.refs.delete(doc.ref);
    for (const s of this.sess.values())
      for (const src of SOURCES) {
        s.docs[src] = s.docs[src].filter((x) => !gone.has(x));
        s.docs[src].forEach((x, i) => {
          x.ord = i;
        });
      }
    this.gen++;
    return this;
  }

  private ensure(key: SessionKey): Sess {
    let s = this.sess.get(key);
    if (!s) {
      const { harness, id } = splitKey(key);
      s = {
        key,
        harness,
        id,
        docs: { history: [], sessionpipe: [] },
        facts: { history: false, sessionpipe: false },
        ff: {},
      };
      this.sess.set(key, s);
    }
    return s;
  }

  private addFacts(f: OracleFacts): void {
    const source = f.source ?? (f.machine !== undefined ? "sessionpipe" : "history");
    if (!this.opened.includes(source)) return;
    const s = this.ensure(f.key);
    s.facts[source] = true;
    if (f.harness) s.harness = f.harness;
    if (f.id) s.id = f.id;
    const into = s.ff[source] ?? {};
    s.ff[source] = into;
    fold(into, f);
  }

  /** One session's facts: the events index folded first, history on top (it is newer and
   *  fuller, so it wins a tie), as the engine reads them. */
  private merged(s: Sess): Folded {
    const out: Folded = {};
    for (const src of ["sessionpipe", "history"] as const) {
      const f = s.ff[src];
      if (f && this.opened.includes(src)) fold(out, f);
    }
    return out;
  }

  // ── what a query may read ──

  /** The docs of a session that count for these indexes, after history-over-events (D6). */
  private docsOf(s: Sess, read: readonly SearchSource[]): Doc[] {
    const h = read.includes("history") ? s.docs.history : [];
    if (h.length) return h;
    return read.includes("sessionpipe") ? s.docs.sessionpipe : [];
  }

  private inRead(s: Sess, read: readonly SearchSource[]): boolean {
    return read.some((src) => s.docs[src].length > 0 || s.facts[src]);
  }

  private indexed(s: Sess, read: readonly SearchSource[] = this.opened): IndexedSession {
    const docs = this.docsOf(s, read);
    const o = this.overlays.get(s.key);
    const f = this.merged(s);
    let title = f.title?.text;
    let titleRank = f.title?.rank ?? 0;
    if (o?.title && (o.titleRank ?? 0) >= titleRank) {
      title = o.title;
      titleRank = o.titleRank ?? 0;
    }
    let firstAt = f.firstAt ?? 0;
    let lastAt = f.lastAt ?? 0;
    for (const d of docs) {
      if (!d.d.at) continue;
      if (!firstAt || d.d.at < firstAt) firstAt = d.d.at;
      if (d.d.at > lastAt) lastAt = d.d.at;
    }
    if (o?.lastAt && o.lastAt > lastAt) lastAt = o.lastAt;
    const holding = SOURCES.filter((src) => this.opened.includes(src) && s.docs[src].length > 0);
    const out: IndexedSession = {
      key: s.key,
      harness: s.harness,
      id: s.id,
      sources: holding.length ? holding : SOURCES.filter((src) => s.facts[src]),
      titleRank,
      firstAt,
      lastAt,
      messages: docs.length,
    };
    if (title !== undefined) out.title = title;
    const cwd = o?.cwd ?? f.cwd;
    if (cwd !== undefined) out.cwd = cwd;
    if (f.branch !== undefined) out.branch = f.branch;
    const repo = o?.repo ?? f.repo;
    if (repo !== undefined) out.repo = repo;
    const machine = o?.machine ?? f.machine;
    if (machine !== undefined) out.machine = machine;
    if (f.account !== undefined) out.account = f.account;
    if (f.forkOf !== undefined) out.forkOf = f.forkOf;
    if (f.resume !== undefined) out.resume = f.resume;
    if (f.path !== undefined) out.path = f.path;
    return out;
  }

  // ── clauses ──

  private dict(read: readonly SearchSource[]): Map<string, number> {
    const ck = `${this.gen}|${[...read].sort().join(",")}`;
    const hit = this.dfCache.get(ck);
    if (hit) return hit;
    const df = new Map<string, number>();
    for (const doc of this.docs) {
      if (!read.includes(doc.source)) continue;
      for (const t of doc.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    this.dfCache.clear();
    this.dfCache.set(ck, df);
    return df;
  }

  private expand(prefix: string, df: Map<string, number>, cap: number): Set<string> {
    const all: [string, number][] = [];
    for (const [t, n] of df) if (t.startsWith(prefix) && t !== prefix) all.push([t, n]);
    all.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const out = new Set(all.slice(0, cap).map((x) => x[0]));
    if (df.has(prefix)) out.add(prefix);
    return out;
  }

  private compile(parsed: ParsedSearch, df: Map<string, number>): Clause[] {
    const out: Clause[] = [];
    for (const c of parsed.clauses) {
      const toks = oracleTokens(c.text);
      const parts = toks.filter((t) => !t.whole);
      if (!parts.length) continue;
      const wholes = toks.filter((t) => t.whole);
      const clause: Clause = { not: c.not, atoms: [] };
      if (c.kind === "prefix") {
        const cps = [...parts[parts.length - 1]!.term].length;
        const cap = c.live ? (cps <= 2 ? 12 : cps === 3 ? 32 : 64) : 64;
        const last = parts[parts.length - 1]!.term;
        const head = parts.slice(0, -1).map((t) => new Set([t.term]));
        const ex = this.expand(last, df, cap);
        clause.atoms.push({ slots: [...head, ex], weight: EXPANSION });
        clause.titlePrefix = [{ head, prefix: last }];
        // A single identifier: its joined form is a prefix too (`getUs*` → getus…).
        if (wholes.length === 1 && wholes[0]!.start === parts[0]!.start && wholes[0]!.end === parts.at(-1)!.end) {
          const w = wholes[0]!.term;
          clause.atoms.push({ slots: [this.expand(w, df, cap)], weight: EXPANSION });
          clause.titlePrefix.push({ head: [], prefix: w });
        }
      } else if (parts.length === 1) {
        const t = parts[0]!.term;
        clause.atoms.push({ slots: [new Set([t])], weight: 1 });
        if (c.kind === "word") {
          const pl = new Set([`${t}s`, `${t}es`]);
          if (t.length > 3 && t.endsWith("s")) pl.add(t.slice(0, -1));
          pl.delete(t);
          clause.atoms.push({ slots: [pl], weight: PLURAL });
          clause.word = c.text;
          clause.single = t;
        }
      } else {
        clause.atoms.push({ slots: parts.map((t) => new Set([t.term])), weight: 1 });
        if (wholes.length === 1 && wholes[0]!.start === parts[0]!.start && wholes[0]!.end === parts.at(-1)!.end)
          clause.atoms.push({ slots: [new Set([wholes[0]!.term])], weight: 1 });
        if (c.kind === "word") clause.word = c.text;
      }
      out.push(clause);
    }
    return out;
  }

  /** Occurrences of an atom in a token list: [startPos, firstTok, lastTok] spans. */
  private occurrences(atom: Atom, byPos: Map<number, Set<string>>, toks: OracleToken[]): [number, number][] {
    const out: [number, number][] = [];
    const n = atom.slots.length;
    // Cheap reject: every slot needs one of its terms somewhere.
    for (const sl of atom.slots) {
      let any = false;
      for (const set of byPos.values()) {
        for (const t of sl)
          if (set.has(t)) {
            any = true;
            break;
          }
        if (any) break;
      }
      if (!any) return out;
    }
    for (const [p, set] of byPos) {
      let ok = false;
      for (const t of atom.slots[0]!) if (set.has(t)) ok = true;
      if (!ok) continue;
      let all = true;
      for (let k = 1; k < n && all; k++) {
        const at = byPos.get(p + k);
        all = false;
        if (at) for (const t of atom.slots[k]!) if (at.has(t)) all = true;
      }
      if (!all) continue;
      // The char span: from the first slot's token to the last slot's token.
      let s = Number.POSITIVE_INFINITY;
      let e = -1;
      for (const t of toks) {
        if (t.pos < p || t.pos >= p + n) continue;
        if (!atom.slots[t.pos - p]!.has(t.term)) continue;
        if (t.start < s) s = t.start;
        if (t.end > e) e = t.end;
      }
      if (e >= 0) out.push([s, e]);
    }
    return out;
  }

  private titleTokens(title: string | undefined): { byPos: Map<number, Set<string>>; toks: OracleToken[] } {
    const toks = title ? oracleTokens(title) : [];
    const byPos = new Map<number, Set<string>>();
    for (const t of toks) {
      const s = byPos.get(t.pos) ?? new Set<string>();
      byPos.set(t.pos, s);
      s.add(t.term);
    }
    return { byPos, toks };
  }

  /** Spans of a clause in a title (prefixes matched directly, uncapped). */
  private titleSpans(c: Clause, title: string | undefined): [number, number][] {
    if (!title) return [];
    const { byPos, toks } = this.titleTokens(title);
    const spans: [number, number][] = [];
    if (c.titlePrefix) {
      for (const tp of c.titlePrefix) {
        const lastTerms = new Set<string>();
        for (const t of toks) if (t.term.startsWith(tp.prefix)) lastTerms.add(t.term);
        if (!lastTerms.size) continue;
        spans.push(...this.occurrences({ slots: [...tp.head, lastTerms], weight: 1 }, byPos, toks));
      }
    } else for (const a of c.atoms) spans.push(...this.occurrences(a, byPos, toks));
    return spans;
  }

  // ── search ──

  search(q: EngineQuery): EngineResult {
    const t0 = performance.now();
    const read = q.sources.filter((s) => this.opened.includes(s));
    const df = this.dict(read);
    const clauses = this.compile(q.parsed, df);
    const pos = clauses.filter((c) => !c.not);
    const neg = clauses.filter((c) => c.not);
    const fields = q.fields;
    const docFieldOk = (f: SearchDocField): boolean => !fields || fields.includes(f);
    const titleOk = !fields || fields.includes("title");
    const unknownWords: string[] = [];
    for (const c of pos)
      if (c.word && c.single !== undefined) {
        const t = c.single;
        const variants = [t, `${t}s`, `${t}es`, ...(t.length > 3 && t.endsWith("s") ? [t.slice(0, -1)] : [])];
        if (!variants.some((v) => df.has(v))) unknownWords.push(c.word);
      } else if (c.word) {
        const parts = oracleTokens(c.word).filter((t) => !t.whole);
        if (parts.some((p) => !df.has(p.term))) unknownWords.push(c.word);
      }

    const hasFilter =
      Object.keys(q.parsed.filters).length > 0 || Object.keys(q.parsed.notFilters).length > 0 || neg.length > 0;
    const browse = pos.length === 0;
    if (browse && !hasFilter) return { matches: [], total: 0, more: false, unknownWords, ms: performance.now() - t0 };

    // Global BM25 stats over the read indexes.
    const N = Math.max(1, this.docs.filter((d) => read.includes(d.source)).length);
    const lenSum: Record<string, [number, number]> = {};
    for (const d of this.docs) {
      if (!read.includes(d.source)) continue;
      const a = lenSum[d.d.field] ?? [0, 0];
      lenSum[d.d.field] = a;
      a[0] += d.len;
      a[1]++;
    }
    const avg = (f: string): number => {
      const a = lenSum[f];
      return a?.[1] ? a[0] / a[1] : 1;
    };
    const idf = (t: string): number => {
      const n = df.get(t) ?? 0;
      return Math.log(1 + (N - n + 0.5) / (n + 0.5));
    };
    // The idf of a slot is the highest over its terms that exist (a variant nobody wrote
    // must not lend its df-0 idf to the ones that did; the engine reads it the same way).
    // A slot no doc has (a title-only word) still weighs: it takes the df-0 idf.
    const slotIdf = (sl: Set<string>): number => {
      let m = -1;
      for (const t of sl) if ((df.get(t) ?? 0) > 0) m = Math.max(m, idf(t));
      return m < 0 ? idf("\u0000") : m;
    };
    const atomIdf = (a: Atom): number => {
      if (a.slots.length === 1) return slotIdf(a.slots[0]!);
      let s = 0;
      for (const sl of a.slots) s += slotIdf(sl);
      return 0.7 * s;
    };
    const bm25 = (tf: number, idfv: number, len: number, f: SearchDocField | "title", mult: number): number => {
      const tfw = W[f] * mult * tf;
      const bf = B[f];
      return (idfv * (tfw * (K1 + 1))) / (tfw + K1 * (1 - bf + (bf * len) / avg(f)));
    };
    let titleLen = 0;
    let titleN = 0;

    this.allowCalls = new Map();
    const allowed = (s: IndexedSession): boolean => {
      if (!q.allow) return true;
      this.allowCalls.set(s.key, (this.allowCalls.get(s.key) ?? 0) + 1);
      return q.allow(s);
    };

    interface Cand {
      s: Sess;
      is: IndexedSession;
      docs: Doc[];
      score: number;
      matched: { doc: Doc; score: number; spans: [number, number][]; mask: number }[];
      titleMarks: [number, number][];
    }
    const cands: Cand[] = [];
    const now = this.now();
    for (const s of this.sess.values()) {
      if (this.forgotten.has(s.key) || !this.inRead(s, read)) continue;
      const docs = this.docsOf(s, read).filter((d) => docFieldOk(d.d.field));
      const is = this.indexed(s, read);
      if (is.title) {
        titleLen += this.titleTokens(is.title).toks.filter((t) => !t.whole).length;
        titleN++;
      }
      cands.push({ s, is, docs, score: 0, matched: [], titleMarks: [] });
    }
    const avgTitle = titleN ? titleLen / titleN : 1;
    lenSum.title = [avgTitle, 1];

    const results: Cand[] = [];
    for (const c of cands) {
      // allow first (once), before any text is looked at.
      if (!allowed(c.is)) continue;
      // Negations: any field-allowed doc or the title.
      let dropped = false;
      for (const n of neg) {
        if (titleOk && this.titleSpans(n, c.is.title).length) dropped = true;
        for (const d of c.docs) {
          if (dropped) break;
          for (const a of n.atoms) if (this.occurrences(a, d.byPos, d.toks).length) dropped = true;
        }
        if (dropped) break;
      }
      if (dropped) continue;
      if (browse) {
        results.push(c);
        continue;
      }
      let sessionMask = 0;
      const ALL = (1 << pos.length) - 1;
      let titleScore = 0;
      if (titleOk) {
        const tt = this.titleTokens(c.is.title);
        const tlen = tt.toks.filter((t) => !t.whole).length;
        pos.forEach((p, i) => {
          const spans = this.titleSpans(p, c.is.title);
          if (!spans.length) return;
          sessionMask |= 1 << i;
          c.titleMarks.push(...spans);
          let best = 0;
          for (const a of p.atoms) best = Math.max(best, a.weight * bm25(spans.length, atomIdf(a), tlen, "title", 1));
          titleScore += best;
        });
      }
      for (const d of c.docs) {
        let mask = 0;
        let sc = 0;
        const spans: [number, number][] = [];
        const mult = d.d.agent ? SUBAGENT : 1;
        pos.forEach((p, i) => {
          let best = 0;
          let hit = false;
          for (const a of p.atoms) {
            const occ = this.occurrences(a, d.byPos, d.toks);
            if (!occ.length) continue;
            hit = true;
            spans.push(...occ);
            best = Math.max(best, a.weight * bm25(occ.length, atomIdf(a), d.len, d.d.field, mult));
          }
          if (hit) {
            mask |= 1 << i;
            sc += best;
          }
        });
        if (!mask) continue;
        sessionMask |= mask;
        c.matched.push({ doc: d, score: sc * (mask === ALL ? 1 : 0.5), spans, mask });
      }
      if (sessionMask !== ALL) continue;
      const single = c.matched.some((m) => m.mask === ALL);
      const top = c.matched.map((m) => m.score).sort((a, b) => b - a);
      let rel = (top[0] ?? 0) + 0.3 * (top[1] ?? 0) + 0.1 * (top[2] ?? 0) + titleScore;
      if (!single) rel *= 0.6;
      const ageDays = Math.max(0, (now - c.is.lastAt) / DAY);
      c.score = rel * (0.7 + 0.3 * 2 ** (-ageDays / 30));
      results.push(c);
    }

    const newest = browse || q.sort === "newest";
    results.sort((a, b) =>
      newest
        ? b.is.lastAt - a.is.lastAt || (a.s.key < b.s.key ? -1 : 1)
        : b.score - a.score || b.is.lastAt - a.is.lastAt || (a.s.key < b.s.key ? -1 : 1),
    );
    const page = results.slice(q.offset, q.offset + q.limit);
    const width = Math.min(240, Math.max(40, q.snippetChars ?? 160));
    const matches: EngineMatch[] = page.map((c) => {
      let hits: EngineHit[] = [];
      if (browse) {
        const first = c.docs.find((d) => d.d.field === "prompt");
        if (first && q.hits > 0) hits = [this.hit(first, [], width)];
      } else {
        const chosen = [...c.matched]
          .sort((a, b) => (newest ? b.doc.d.at - a.doc.d.at || b.doc.ord - a.doc.ord : b.score - a.score))
          .slice(0, q.hits)
          .sort((a, b) => a.doc.ord - b.doc.ord);
        hits = chosen.map((m) => this.hit(m.doc, m.spans, width));
      }
      const m: EngineMatch = { session: c.is, score: c.score, hits, matched: browse ? 0 : c.matched.length };
      if (c.titleMarks.length) m.titleMarks = mergeMarks(c.titleMarks);
      return m;
    });
    return {
      matches,
      total: results.length,
      more: q.offset + page.length < results.length,
      unknownWords,
      ms: performance.now() - t0,
    };
  }

  private hit(doc: Doc, spans: [number, number][], width: number): EngineHit {
    const { text, marks } = snippet(doc.d.text, mergeMarks(spans), width);
    return this.shape(doc, text, marks);
  }

  private shape(doc: Doc, text: string, marks: SearchMark[]): EngineHit {
    const h: EngineHit = { field: doc.d.field, at: doc.d.at, text, marks, ref: doc.ref };
    if (doc.d.tool !== undefined) h.tool = doc.d.tool;
    if (doc.d.agent !== undefined) h.agent = doc.d.agent;
    if (doc.d.agentType !== undefined) h.agentType = doc.d.agentType;
    if (doc.d.seq !== undefined) h.seq = doc.d.seq;
    if (doc.d.live) h.live = true;
    return h;
  }

  transcript(
    key: SessionKey,
    opts: { around?: string; before?: string; after?: string; limit: number },
  ): TranscriptWindow | undefined {
    const s = this.sess.get(key);
    if (!s || this.forgotten.has(key)) return undefined;
    const docs = this.docsOf(s, this.opened);
    if (!docs.length && !this.inRead(s, this.opened)) return undefined;
    const limit = Math.max(1, opts.limit);
    const at = (ref: string | undefined): number => (ref ? docs.findIndex((d) => d.ref === ref) : -1);
    let start = 0;
    let end = Math.min(docs.length, limit);
    if (opts.after !== undefined) {
      const i = at(opts.after);
      start = i + 1;
      end = Math.min(docs.length, start + limit);
    } else if (opts.before !== undefined) {
      const i = at(opts.before);
      end = i < 0 ? 0 : i;
      start = Math.max(0, end - limit);
    } else if (opts.around !== undefined) {
      const i = at(opts.around);
      if (i >= 0) {
        start = Math.max(0, Math.min(i - Math.floor(limit / 2), docs.length - limit));
        end = Math.min(docs.length, start + limit);
      }
    }
    const win = docs.slice(start, end);
    const out: TranscriptWindow = { messages: win.map((d) => this.shape(d, d.d.text, [])) };
    if (start > 0 && win.length) out.before = win[0]!.ref;
    if (end < docs.length && win.length) out.after = win[win.length - 1]!.ref;
    return out;
  }

  hitsIn(key: SessionKey, parsed: ParsedSearch): { ref: string; marks: SearchMark[] }[] {
    const s = this.sess.get(key);
    if (!s || this.forgotten.has(key)) return [];
    const df = this.dict(this.opened);
    const pos = this.compile(parsed, df).filter((c) => !c.not);
    const fields = parsed.filters.in?.filter(
      (f): f is SearchDocField => f === "prompt" || f === "reply" || f === "tool",
    );
    const out: { ref: string; marks: SearchMark[] }[] = [];
    for (const d of this.docsOf(s, this.opened)) {
      if (fields?.length && !fields.includes(d.d.field)) continue;
      const spans: [number, number][] = [];
      for (const p of pos) for (const a of p.atoms) spans.push(...this.occurrences(a, d.byPos, d.toks));
      if (spans.length) out.push({ ref: d.ref, marks: mergeMarks(spans) });
      if (out.length >= HITS_IN_MAX) break;
    }
    return out;
  }

  session(key: SessionKey): IndexedSession | undefined {
    const s = this.sess.get(key);
    if (!s || this.forgotten.has(key) || !this.inRead(s, this.opened)) return undefined;
    return this.indexed(s);
  }

  *sessions(): Iterable<IndexedSession> {
    for (const s of this.sess.values())
      if (!this.forgotten.has(s.key) && this.inRead(s, this.opened)) yield this.indexed(s);
  }

  setOverlay(key: SessionKey, overlay: SessionOverlay | null): void {
    if (overlay) this.overlays.set(key, { ...overlay });
    else this.overlays.delete(key);
  }

  forget(key: SessionKey): void {
    this.forgotten.add(key);
  }

  stats(): ReaderStats {
    const by = new Map<string, { harness: string; source: SearchSource; homes: string[]; sessions: number }>();
    let sessions = 0;
    let messages = 0;
    let bytes = 0;
    for (const s of this.sess.values()) {
      if (this.forgotten.has(s.key) || !this.inRead(s, this.opened)) continue;
      sessions++;
      const docs = this.docsOf(s, this.opened);
      messages += docs.length;
      const src: SearchSource = docs[0]?.source ?? (s.facts.history ? "history" : "sessionpipe");
      const k = `${s.harness}\u0000${src}`;
      const row = by.get(k) ?? { harness: s.harness, source: src, homes: [], sessions: 0 };
      row.sessions++;
      by.set(k, row);
    }
    for (const d of this.docs) bytes += Buffer.byteLength(d.d.text);
    const gen: ReaderStats["gen"] = {};
    for (const s of this.opened) gen[s] = this.gen;
    return { gen, sessions, messages, bytes, bySource: [...by.values()] };
  }

  refresh(): boolean {
    return false;
  }
  tick(): void {}
  hint(_path: string): void {}
  close(): void {}
}

/** Sorted, merged, non-overlapping marks. */
export function mergeMarks(spans: readonly [number, number][]): SearchMark[] {
  const s = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: SearchMark[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const isWs = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/** A window of at most `width` characters around the marks: cut at word boundaries, `…` at
 *  each cut, whitespace folded; marks re-based into the window. */
export function snippet(
  text: string,
  marks: readonly SearchMark[],
  width: number,
): { text: string; marks: SearchMark[] } {
  let ws = 0;
  if (marks.length) {
    // The window holding the most marks, starting a little before a mark.
    let best = -1;
    for (const m of marks) {
      const s = Math.max(0, m[0] - Math.floor(width / 4));
      let n = 0;
      for (const k of marks) if (k[0] >= s && k[1] <= s + width - 2) n++;
      if (n > best) {
        best = n;
        ws = s;
      }
    }
  }
  let we = Math.min(text.length, ws + width - 2);
  // Word boundaries: start after a space, end before one.
  if (ws > 0) {
    const sp = text.lastIndexOf(" ", ws);
    if (sp >= 0 && ws - sp < 20) ws = sp + 1;
    while (ws < we && isWs(text[ws])) ws++;
  }
  if (we < text.length) {
    let e = we;
    while (e > ws && !isWs(text[e])) e--;
    if (e > ws + width / 2) we = e;
  }
  // Fold whitespace in [ws, we), mapping offsets.
  const map: number[] = [];
  let out = "";
  let prevWs = false;
  for (let i = ws; i < we; i++) {
    const c = text[i]!;
    map[i - ws] = out.length;
    if (/\s/.test(c)) {
      if (!prevWs && out.length) out += " ";
      prevWs = true;
    } else {
      out += c;
      prevWs = false;
    }
  }
  map[we - ws] = out.length;
  out = out.replace(/ $/, "");
  const pre = ws > 0 ? "…" : "";
  const post = we < text.length ? "…" : "";
  const shift = pre.length;
  const re: SearchMark[] = [];
  for (const [a, b] of marks) {
    if (a < ws || b > we) continue;
    const s = map[a - ws]! + shift;
    const e = Math.min(map[b - ws]!, out.length) + shift;
    if (e > s) re.push([s, e]);
  }
  return { text: pre + out + post, marks: re };
}

// ───────────────────────────── constructors ─────────────────────────────

/** A reader over these docs and facts (in commit order). */
export function fromDocs(
  docs: readonly OracleDoc[],
  facts: readonly OracleFacts[] = [],
  opts: OracleOptions = {},
): OracleReader {
  return new OracleReader(opts).add(docs, facts);
}

/** Reads every file the adapters discover into an oracle (the service's stub until M2).
 *  Small homes only: everything is held in memory. */
export async function loadOracle(
  env: SourceEnv,
  adapters: readonly SourceAdapter[],
  opts: OracleOptions = {},
): Promise<OracleReader> {
  const docs: OracleDoc[] = [];
  const facts: OracleFacts[] = [];
  for (const a of adapters) {
    if (opts.sources && !opts.sources.includes(a.source)) continue;
    const files = await a.discover(env);
    for (const file of files) {
      const sink: DocSink = {
        doc: (d) => docs.push({ ...d, source: a.source, file: file.path }),
        facts: (f) => facts.push({ ...f, source: a.source }),
      };
      try {
        await a.read(file, { offset: 0 }, sink);
      } catch {
        // An IO error on one file never stops the rest.
      }
    }
  }
  return fromDocs(docs, facts, opts);
}
