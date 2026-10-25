// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The read side (SearchReader): the committed segments of both indexes
// plus the live tail, one global session table, the in-RAM title index and the query
// evaluation (SEARCH-SPEC §3.2). Lock-free; it never writes the index.
//
// Per query: compile → allow() once per session → negatives over every segment → positives
// per segment into pooled typed arrays (zero allocation per posting) → per-session top 3 →
// rel = top1 + 0.3·top2 + 0.1·top3 (+ title), ×0.6 without co-occurrence, × recency → page →
// snippets for the page only.
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  EngineHit,
  EngineMatch,
  EngineQuery,
  EngineResult,
  IndexedSession,
  ParsedSearch,
  ReaderOptions,
  ReaderStats,
  SearchDocField,
  SearchMark,
  SearchReader,
  SearchSource,
  SessionKey,
  SessionOverlay,
  TranscriptWindow,
} from "../types.js";
import { utf8 } from "./codec.js";
import {
  type Atom,
  atomInto,
  type Clause,
  type Compiled,
  compile,
  type Dict,
  idfOf,
  K1,
  PREFIX_W,
  Scratch,
  TITLE_B,
  TITLE_W,
} from "./evaluate.js";
import { cloneFacts, emptyFacts, type Facts, foldFacts } from "./facts.js";
import { type Committed, LiveTail } from "./live.js";
import { type FileEntry, indexDir, type Manifest, manifestStamp, readDel, readManifest } from "./manifest.js";
import { decodeRef, encodeRef, PROVISIONAL, provisionalId } from "./refs.js";
import { type DocRow, FIELD_CODES, FIELD_NAMES, ROW, rowAt, Segment, trimPools } from "./segment.js";
import { type Matcher, markText, snippet } from "./snippet.js";
import { tokenize } from "./tokenize.js";

const BIT: Record<SearchSource, number> = { history: 1, sessionpipe: 2 };
const DAY = 86_400_000;
const HALF_LIFE_DAYS = 30;
export const TOTAL_EXACT = 200;
const HITS_IN_MAX = 500;

/** One open index (history or events). */
class IndexState {
  stamp = "";
  manifest: Manifest | null = null;
  segs: Segment[] = [];
  byPath = new Map<string, FileEntry>();
  pathById = new Map<number, string>();
  idByProvisional = new Map<number, number>();
  constructor(
    readonly source: SearchSource,
    readonly dir: string,
  ) {}

  /** (Re)open from the MANIFEST; reuses open segments by name. True when it moved. */
  load(): boolean {
    const stamp = manifestStamp(this.dir);
    if (stamp === this.stamp && this.manifest) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const st = manifestStamp(this.dir);
      const m = readManifest(this.dir);
      if (!m) {
        this.closeAll();
        this.manifest = null;
        this.stamp = st;
        this.byPath = new Map();
        this.pathById = new Map();
        this.idByProvisional = new Map();
        return true;
      }
      const old = new Map(this.segs.map((s) => [s.name, s]));
      const next: Segment[] = [];
      let failed = false;
      for (const e of m.segments) {
        let seg = old.get(e.name);
        if (!seg) {
          try {
            seg = new Segment(join(this.dir, e.name), e.name);
          } catch {
            failed = true;
            break;
          }
        }
        const bits = e.del ? readDel(this.dir, e.del, seg.N) : null;
        if (e.del && !bits) {
          // superseded between our read of the manifest and of the tombstone: read again
          failed = true;
          if (!old.has(e.name)) seg.close();
          break;
        }
        seg.setDeleted(bits);
        next.push(seg);
      }
      if (failed) {
        for (const s of next) if (!old.has(s.name)) s.close();
        continue;
      }
      const keep = new Set(next.map((s) => s.name));
      for (const s of this.segs) if (!keep.has(s.name)) s.close();
      this.segs = next;
      this.manifest = m;
      this.stamp = st;
      this.byPath = new Map(Object.entries(m.files));
      this.pathById = new Map();
      this.idByProvisional = new Map();
      for (const [p, f] of this.byPath) {
        this.pathById.set(f.id, p);
        this.idByProvisional.set(provisionalId(p), f.id);
      }
      return true;
    }
    return false;
  }

  bytes(): number {
    let n = 0;
    for (const s of this.manifest?.segments ?? []) n += s.bytes;
    return n;
  }

  closeAll(): void {
    for (const s of this.segs) s.close();
    this.segs = [];
  }
}

/** A segment as the query sees it. */
interface SegRef {
  seg: Segment;
  source: SearchSource;
  bit: number;
  /** Local session ordinal → global ordinal. */
  gs: Uint32Array;
  tail: boolean;
  /** Local session → its first prompt doc (lazy). */
  first?: Int32Array;
  /** Live docs per local session. */
  live: Uint32Array;
}

/** One session across both indexes. */
interface GSession {
  key: string;
  g: number;
  /** Folded committed facts per index (null: none). */
  facts: [Facts | null, Facts | null];
  tailFacts: [Facts | null, Facts | null];
  docs: [number, number];
  tailDocs: [number, number];
  view: IndexedSession;
}

interface TitleTok {
  t: string;
  pos: number;
  s: number;
  e: number;
}

const srcIndex = (s: SearchSource): 0 | 1 => (s === "history" ? 0 : 1);

export class Reader implements SearchReader {
  private states = new Map<SearchSource, IndexState>();
  private tail: LiveTail | null = null;
  private tailVersion = 0;
  private seenTailVersion = -1;
  private refs: SegRef[] = [];
  private S: GSession[] = [];
  private byKey = new Map<string, number>();
  private overlays = new Map<string, SessionOverlay>();
  private hidden = new Set<string>();
  private N = 0;
  private avg = new Float64Array(FIELD_CODES).fill(1);
  private dfCache = new Map<string, number>();
  private expandCache = new Map<string, string[]>();
  private version = 0;
  private P = new Scratch();
  // per global session, pooled
  private sMask = new Uint32Array(0);
  private sFull = new Uint8Array(0);
  private sMatched = new Uint32Array(0);
  private sN = new Uint8Array(0);
  private tRef = new Int32Array(0);
  private tDoc = new Uint32Array(0);
  private tKey = new Float64Array(0);
  private tScore = new Float64Array(0);
  private touchedS = new Uint32Array(0);
  private dropped = new Uint8Array(0);
  private allowed = new Uint8Array(0);
  private tMask = new Uint32Array(0);
  private tScoreT = new Float64Array(0);
  // title index
  private titlePost = new Map<string, Set<number>>();
  private titleToks: (TitleTok[] | null)[] = [];
  private titleOf: (string | undefined)[] = [];
  private titleLen = 0;
  private titleCount = 0;
  private transcriptCache = new Map<string, { v: number; list: TDoc[] }>();
  private home: string;
  private wantCommit?: () => void;

  constructor(o: ReaderOptions & { onCommitWanted?: () => void }) {
    this.home = o.live?.env.home ?? homedir();
    this.wantCommit = o.onCommitWanted;
    for (const s of o.sources) this.states.set(s, new IndexState(s, indexDir(o.dir, s)));
    if (o.live) {
      const committed: Committed = {
        entry: (source, path) => this.states.get(source)?.byPath.get(path),
        each: (fn) => {
          for (const st of this.states.values()) for (const [p, e] of st.byPath) fn(st.source, p, e);
        },
      };
      this.tail = new LiveTail(o.live.env, o.live.adapters, o.sources, committed, () => {
        this.tailVersion++;
      });
    }
    for (const st of this.states.values()) st.load();
    this.rebuild();
  }

  /** The first live pass (openReader awaits it, so the CLI sees the last minute). */
  async warm(): Promise<void> {
    if (this.tail) await this.tail.tick();
  }

  // ───────────────────────────── tables ─────────────────────────────

  /** Rebuild the global session table from the committed segments plus the tail. */
  private rebuild(): void {
    this.version++;
    const refs: SegRef[] = [];
    const S: GSession[] = [];
    const byKey = new Map<string, number>();
    const ensure = (key: string, harness: string, id: string): GSession => {
      let g = byKey.get(key);
      if (g === undefined) {
        g = S.length;
        byKey.set(key, g);
        S.push({
          key,
          g,
          facts: [null, null],
          tailFacts: [null, null],
          docs: [0, 0],
          tailDocs: [0, 0],
          view: undefined as unknown as IndexedSession,
        });
        void harness;
        void id;
      }
      return S[g]!;
    };
    const add = (seg: Segment, source: SearchSource, tail: boolean) => {
      const si = srcIndex(source);
      const ss = seg.meta.sessions;
      const gs = new Uint32Array(ss.length);
      const live = new Uint32Array(ss.length);
      if (seg.delCount) {
        for (let d = 0; d < seg.N; d++) if (!seg.isDeleted(d)) live[seg.dsess[d]!]!++;
      } else for (let i = 0; i < ss.length; i++) live[i] = ss[i]!.docs;
      for (let i = 0; i < ss.length; i++) {
        const s = ss[i]!;
        const G = ensure(s.key, s.facts.harness, s.facts.id);
        gs[i] = G.g;
        const slot = tail ? G.tailFacts : G.facts;
        if (!slot[si]) slot[si] = cloneFacts(s.facts);
        else foldFacts(slot[si]!, s.facts);
        if (tail) G.tailDocs[si] += live[i]!;
        else G.docs[si] += live[i]!;
      }
      refs.push({ seg, source, bit: BIT[source], gs, tail, live });
    };
    for (const st of this.states.values()) for (const seg of st.segs) add(seg, st.source, false);
    if (this.tail) for (const t of this.tail.segments()) if (this.states.has(t.source)) add(t.seg, t.source, true);
    this.seenTailVersion = this.tailVersion;
    this.refs = refs;
    this.S = S;
    this.byKey = byKey;
    // global statistics
    let N = 0;
    const flen = new Float64Array(FIELD_CODES);
    const fcnt = new Float64Array(FIELD_CODES);
    for (const r of refs) {
      N += r.seg.N;
      for (let f = 0; f < FIELD_CODES; f++) {
        flen[f]! += r.seg.meta.flen[f] ?? 0;
        fcnt[f]! += r.seg.meta.fcnt[f] ?? 0;
      }
    }
    this.N = N;
    for (let f = 0; f < FIELD_CODES; f++) this.avg[f] = fcnt[f]! > 0 ? Math.max(1, flen[f]! / fcnt[f]!) : 1;
    this.dfCache.clear();
    this.expandCache.clear();
    this.transcriptCache.clear();
    // pools
    const n = S.length;
    if (this.sMask.length < n) {
      const m = Math.max(n, Math.ceil(this.sMask.length * 1.5), 64);
      this.sMask = new Uint32Array(m);
      this.sFull = new Uint8Array(m);
      this.sMatched = new Uint32Array(m);
      this.sN = new Uint8Array(m);
      this.tRef = new Int32Array(m * 3);
      this.tDoc = new Uint32Array(m * 3);
      this.tKey = new Float64Array(m * 3);
      this.tScore = new Float64Array(m * 3);
      this.touchedS = new Uint32Array(m);
      this.dropped = new Uint8Array(m);
      this.allowed = new Uint8Array(m);
      this.tMask = new Uint32Array(m);
      this.tScoreT = new Float64Array(m);
    }
    let maxN = 0;
    for (const r of refs) maxN = Math.max(maxN, r.seg.N);
    this.P.shrink(maxN);
    this.P.ensure(maxN);
    // views + titles
    this.titlePost = new Map();
    this.titleToks = new Array(n).fill(null);
    this.titleOf = new Array(n).fill(undefined);
    this.titleLen = 0;
    this.titleCount = 0;
    for (const G of S) {
      G.view = this.makeView(G);
      this.setTitle(G.g, G.view.title);
    }
  }

  private makeView(G: GSession): IndexedSession {
    const parts = [G.facts[1], G.tailFacts[1], G.facts[0], G.tailFacts[0]];
    let f: Facts | null = null;
    for (const p of parts) {
      if (!p) continue;
      if (!f) f = cloneFacts(p);
      else foldFacts(f, p);
    }
    if (!f) {
      const i = G.key.indexOf(":");
      f = emptyFacts(G.key.slice(0, i), G.key.slice(i + 1));
    }
    const hasH = G.docs[0] + G.tailDocs[0] > 0;
    const hasE = G.docs[1] + G.tailDocs[1] > 0;
    const sources: SearchSource[] = [];
    if (hasH) sources.push("history");
    if (hasE) sources.push("sessionpipe");
    const ov = this.overlays.get(G.key);
    let title = f.title;
    let titleRank = f.titleRank;
    let machine = f.machine;
    let repo = f.repo;
    let cwd = f.cwd;
    let lastAt = f.lastAt;
    if (ov) {
      if (ov.title && (ov.titleRank ?? 0) >= titleRank) {
        title = ov.title;
        titleRank = ov.titleRank ?? 0;
      }
      if (ov.machine) machine = ov.machine;
      if (ov.repo) repo = ov.repo;
      if (ov.cwd) cwd = ov.cwd;
      if (ov.lastAt && ov.lastAt > lastAt) lastAt = ov.lastAt;
    }
    const v: IndexedSession = {
      key: G.key,
      harness: f.harness,
      id: f.id,
      sources,
      titleRank,
      firstAt: f.firstAt || lastAt,
      lastAt: lastAt || f.firstAt,
      messages: hasH ? G.docs[0] + G.tailDocs[0] : G.docs[1] + G.tailDocs[1],
    };
    if (title) v.title = title;
    if (cwd) v.cwd = cwd;
    if (f.branch) v.branch = f.branch;
    if (repo) v.repo = repo;
    if (machine) v.machine = machine;
    if (f.account) v.account = f.account;
    if (f.forkOf) v.forkOf = f.forkOf;
    if (f.resume) v.resume = f.resume;
    if (f.path) v.path = f.path;
    return v;
  }

  private setTitle(g: number, title: string | undefined): void {
    if (this.titleOf[g] === title) return;
    const old = this.titleToks[g];
    if (old) {
      for (const t of old) this.titlePost.get(t.t)?.delete(g);
      this.titleLen -= old.length;
      this.titleCount--;
    }
    this.titleOf[g] = title;
    if (!title) {
      this.titleToks[g] = null;
      return;
    }
    const toks: TitleTok[] = [];
    tokenize(title, (t, pos, s, e) => {
      toks.push({ t, pos, s, e });
      let set = this.titlePost.get(t);
      if (!set) {
        set = new Set();
        this.titlePost.set(t, set);
      }
      set.add(g);
    });
    this.titleToks[g] = toks;
    this.titleLen += toks.length;
    this.titleCount++;
  }

  /** The tail changed since the tables were built: fold it in. */
  private sync(): void {
    if (this.tail && this.tailVersion !== this.seenTailVersion) this.rebuild();
  }

  // ───────────────────────────── dictionary ─────────────────────────────

  private dict: Dict = {
    df: (term: string): number => {
      let v = this.dfCache.get(term);
      if (v !== undefined) return v;
      v = 0;
      const e = { df: 0, po: 0, pl: 0, xo: 0, xl: 0 };
      for (const r of this.refs) if (r.seg.lookup(term, e)) v += e.df;
      if (this.dfCache.size > 20_000) this.dfCache.clear();
      this.dfCache.set(term, v);
      return v;
    },
    expand: (p: string, cap: number): string[] => {
      const ck = `${cap}\u0000${p}`;
      const hit = this.expandCache.get(ck);
      if (hit) return hit;
      const by = new Map<string, number>();
      for (const r of this.refs) {
        // per segment: the `cap` most frequent (a small sorted array; strings only for those)
        const top: { df: number; t: string }[] = [];
        let minDf = -1;
        r.seg.prefix(p, (bytes, len, e) => {
          if (top.length >= cap && e.df <= minDf) return true;
          const t = utf8d.decode(bytes.subarray(0, len));
          top.push({ df: e.df, t });
          if (top.length > cap) {
            top.sort((a, b) => b.df - a.df);
            top.length = cap;
          }
          minDf = top.length >= cap ? Math.min(...top.map((x) => x.df)) : -1;
          return true;
        });
        for (const x of top) by.set(x.t, (by.get(x.t) ?? 0) + x.df);
      }
      const out = [...by]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, cap)
        .map((x) => x[0]);
      if (by.has(p) && !out.includes(p)) out[out.length - 1] = p;
      if (this.expandCache.size > 512) this.expandCache.clear();
      this.expandCache.set(ck, out);
      return out;
    },
  };

  // ───────────────────────────── search ─────────────────────────────

  private computeAllowed(q: { sources: readonly SearchSource[]; allow?: (s: IndexedSession) => boolean }): void {
    const readH = q.sources.includes("history") && this.states.has("history");
    const readE = q.sources.includes("sessionpipe") && this.states.has("sessionpipe");
    const A = this.allowed;
    for (const G of this.S) {
      let bits = 0;
      const hasH = G.docs[0] + G.tailDocs[0] > 0;
      const hasE = G.docs[1] + G.tailDocs[1] > 0;
      if (readH && hasH) bits |= 1;
      // D6: history beats events for the same key
      if (readE && hasE && !(readH && hasH)) bits |= 2;
      if (bits && this.hidden.has(G.key)) bits = 0;
      if (bits && q.allow && !q.allow(G.view)) bits = 0;
      A[G.g] = bits;
    }
  }

  private fieldMask(fields: EngineQuery["fields"]): { docs: number; title: boolean } {
    if (!fields?.length) return { docs: 0x3f, title: true };
    let m = 0;
    let title = false;
    for (const f of fields) {
      if (f === "title") title = true;
      else {
        const i = FIELD_NAMES.indexOf(f as SearchDocField);
        if (i >= 0) m |= (1 << i) | (1 << (i + 3));
      }
    }
    return { docs: m, title };
  }

  search(q: EngineQuery): EngineResult {
    const t0 = performance.now();
    this.sync();
    const now = Date.now();
    const compiled = compile(q.parsed, this.dict);
    const { pos, neg } = compiled;
    this.computeAllowed(q);
    const fm = this.fieldMask(q.fields);
    const hitsWanted = Math.max(0, Math.min(3, q.hits));
    const width = Math.max(40, Math.min(240, q.snippetChars ?? 160));
    const unknownWords: string[] = [];
    for (const c of pos)
      if (c.word && c.need.some((t) => this.dict.df(t) === 0 && !this.titlePost.has(t))) unknownWords.push(c.word);

    // negatives: a session that has it anywhere is dropped
    const dropped = this.dropped;
    const droppedList: number[] = [];
    if (neg.length) {
      for (const r of this.refs)
        this.clauseDocs(r, neg, 0x3f, (g) => {
          if (!dropped[g]) {
            dropped[g] = 1;
            droppedList.push(g);
          }
        });
      for (const c of neg) {
        this.titleMatch(c, (g) => {
          if (!dropped[g]) {
            dropped[g] = 1;
            droppedList.push(g);
          }
        });
      }
    }

    let result: EngineResult;
    try {
      if (!pos.length) result = this.browse(q, hitsWanted, width, t0);
      else result = this.rank(q, compiled, fm, hitsWanted, width, now, t0);
    } finally {
      for (const g of droppedList) dropped[g] = 0;
    }
    result.unknownWords = unknownWords;
    result.ms = performance.now() - t0;
    trimPools();
    return result;
  }

  /** Every doc of `r` matching any of `clauses` (allowed, live): fn(global session). */
  private clauseDocs(r: SegRef, clauses: Clause[], fmask: number, fn: (g: number, d: number) => void): void {
    const P = this.P.ensure(r.seg.N);
    const A = this.allowed;
    for (const c of clauses) {
      P.nt = 0;
      for (const a of c.atoms) atomInto(r.seg, a, P, fmask, this.avg, this.N, this.dict);
      for (let i = 0; i < P.nt; i++) {
        const d = P.tmpT[i]!;
        P.tmp[d] = 0;
        if (r.seg.isDeleted(d)) continue;
        const g = r.gs[r.seg.dsess[d]!]!;
        if (A[g]! & r.bit) fn(g, d);
      }
    }
  }

  /** Sessions whose title matches clause `c`: fn(g, score). */
  private titleMatch(c: Clause, fn: (g: number, score: number) => void): void {
    const avg = this.titleCount ? Math.max(1, this.titleLen / this.titleCount) : 1;
    const N = this.N + this.titleCount;
    const score = (g: number, tf: number, idf: number): number => {
      const len = this.titleToks[g]?.length ?? 1;
      const tfw = TITLE_W * tf;
      return (idf * (tfw * (K1 + 1))) / (tfw + K1 * (1 - TITLE_B + (TITLE_B * len) / avg));
    };
    const best = new Map<number, number>();
    const put = (g: number, s: number) => {
      if (s > (best.get(g) ?? 0)) best.set(g, s);
    };
    const termOnce = (t: string, w: number) => {
      const set = this.titlePost.get(t);
      if (!set) return;
      const idf = idfOf(N, this.dict.df(t)) * w;
      for (const g of set) {
        let tf = 0;
        for (const x of this.titleToks[g]!) if (x.t === t) tf++;
        put(g, score(g, tf, idf));
      }
    };
    for (const a of c.atoms) {
      if (a.kind === "terms") for (const alt of a.alts) termOnce(alt.term, alt.w);
      else this.titlePhrase(a, (g, idf) => put(g, score(g, 1, idf)), N);
    }
    if (c.prefix) {
      const p = c.prefix;
      for (const [t, set] of this.titlePost) {
        if (!set.size || !t.startsWith(p)) continue;
        const idf = idfOf(N, this.dict.df(t)) * (t === p ? 1 : PREFIX_W);
        for (const g of set) put(g, score(g, 1, idf));
      }
    }
    for (const [g, s] of best) fn(g, s);
  }

  private titlePhrase(a: Extract<Atom, { kind: "phrase" }>, fn: (g: number, idf: number) => void, N: number): void {
    const parts = a.parts;
    const first = this.titlePost.get(parts[0]!);
    if (!first) return;
    let idf = 0;
    for (const t of parts) idf += idfOf(N, this.dict.df(t));
    idf *= 0.7;
    const lastAlt = a.last;
    for (const g of first) {
      const toks = this.titleToks[g]!;
      let ok = false;
      for (let i = 0; i < toks.length && !ok; i++) {
        if (toks[i]!.t !== parts[0]) continue;
        const p0 = toks[i]!.pos;
        let good = true;
        for (let k = 1; k < parts.length && good; k++) good = toks.some((x) => x.pos === p0 + k && x.t === parts[k]);
        if (good && lastAlt) {
          const at = p0 + parts.length;
          good = toks.some((x) => x.pos === at && lastAlt.some((l) => x.t.startsWith(l.term)));
        }
        ok = good;
      }
      if (ok) fn(g, idf);
    }
  }

  private rank(
    q: EngineQuery,
    compiled: Compiled,
    fm: { docs: number; title: boolean },
    hitsWanted: number,
    width: number,
    now: number,
    t0: number,
  ): EngineResult {
    const { pos, matcher } = compiled;
    const ALL = pos.length >= 32 ? 0xffffffff : (1 << pos.length) - 1;
    const newest = q.sort === "newest";
    const A = this.allowed;
    const dropped = this.dropped;
    const sMask = this.sMask;
    const sFull = this.sFull;
    const sMatched = this.sMatched;
    const sN = this.sN;
    const tRef = this.tRef;
    const tDoc = this.tDoc;
    const tKey = this.tKey;
    const tScore = this.tScore;
    const touchedS = this.touchedS;
    let nts = 0;
    const tMask = this.tMask;
    const tScoreT = this.tScoreT;
    const titleTouched: number[] = [];

    // titles
    if (fm.title) {
      pos.forEach((c, ci) => {
        this.titleMatch(c, (g, s) => {
          if (!A[g] || dropped[g]) return;
          if (tMask[g] === 0) titleTouched.push(g);
          tMask[g]! |= 1 << ci;
          tScoreT[g]! += s;
        });
      });
    }

    // docs
    if (fm.docs) {
      const P = this.P;
      for (let ri = 0; ri < this.refs.length; ri++) {
        const r = this.refs[ri]!;
        const seg = r.seg;
        P.ensure(seg.N);
        let touched = 0;
        const mask = P.mask;
        const score = P.score;
        const tmp = P.tmp;
        for (let ci = 0; ci < pos.length; ci++) {
          P.nt = 0;
          for (const a of pos[ci]!.atoms) atomInto(seg, a, P, fm.docs, this.avg, this.N, this.dict);
          const bit = 1 << ci;
          for (let i = 0; i < P.nt; i++) {
            const d = P.tmpT[i]!;
            if (mask[d] === 0) P.touched[touched++] = d;
            mask[d]! |= bit;
            score[d]! += tmp[d]!;
            tmp[d] = 0;
          }
        }
        const dsess = seg.dsess;
        const ats = seg.ats;
        const gsm = r.gs;
        const rb = r.bit;
        for (let i = 0; i < touched; i++) {
          const d = P.touched[i]!;
          const m = mask[d]!;
          let sc = score[d]!;
          mask[d] = 0;
          score[d] = 0;
          if (seg.isDeleted(d)) continue;
          const g = gsm[dsess[d]!]!;
          if (!(A[g]! & rb) || dropped[g]) continue;
          const full = m === ALL;
          if (!full) sc *= 0.5;
          if (sMask[g] === 0 && sMatched[g] === 0) touchedS[nts++] = g;
          sMask[g]! |= m;
          if (full) sFull[g] = 1;
          sMatched[g]!++;
          const key = newest ? ats[d]! + sc * 1e-6 : sc;
          // a fixed 3-slot insertion, by key descending
          const base = g * 3;
          let n = sN[g]!;
          if (n < 3 || key > tKey[base + 2]!) {
            let j = n < 3 ? n : 2;
            while (j > 0 && tKey[base + j - 1]! < key) {
              tKey[base + j] = tKey[base + j - 1]!;
              tScore[base + j] = tScore[base + j - 1]!;
              tRef[base + j] = tRef[base + j - 1]!;
              tDoc[base + j] = tDoc[base + j - 1]!;
              j--;
            }
            tKey[base + j] = key;
            tScore[base + j] = sc;
            tRef[base + j] = ri;
            tDoc[base + j] = d;
            if (n < 3) sN[g] = ++n;
          }
        }
      }
    }

    // qualify
    const ranked: { g: number; score: number; last: number }[] = [];
    const consider = (g: number) => {
      const m = sMask[g]! | tMask[g]!;
      if (m !== ALL || dropped[g]) return;
      const base = g * 3;
      const n = sN[g]!;
      let top: number[];
      if (newest) {
        top = [];
        for (let j = 0; j < n; j++) top.push(tScore[base + j]!);
        top.sort((a, b) => b - a);
      } else top = [tScore[base]!, tScore[base + 1]!, tScore[base + 2]!].slice(0, n);
      let rel = (top[0] ?? 0) + 0.3 * (top[1] ?? 0) + 0.1 * (top[2] ?? 0) + tScoreT[g]!;
      if (!sFull[g] && tMask[g] !== ALL) rel *= 0.6;
      const v = this.S[g]!.view;
      const last = v.lastAt || now;
      const age = Math.max(0, (now - last) / DAY);
      const score = rel * (0.7 + 0.3 * 2 ** (-age / HALF_LIFE_DAYS));
      ranked.push({ g, score, last });
    };
    for (let i = 0; i < nts; i++) consider(touchedS[i]!);
    for (const g of titleTouched) if (sMatched[g] === 0 && sMask[g] === 0) consider(g);

    if (newest) ranked.sort((a, b) => b.last - a.last || b.score - a.score);
    else ranked.sort((a, b) => b.score - a.score || b.last - a.last);
    const total = ranked.length;
    const page = ranked.slice(q.offset, q.offset + q.limit);
    const matches: EngineMatch[] = page.map((x) => {
      const G = this.S[x.g]!;
      const hits: (EngineHit & { _o: [number, number, number] })[] = [];
      const n = Math.min(sN[x.g]!, hitsWanted);
      for (let j = 0; j < n; j++) {
        const r = this.refs[tRef[x.g * 3 + j]!]!;
        hits.push(this.hit(r, tDoc[x.g * 3 + j]!, matcher, width));
      }
      if (!hits.length && hitsWanted > 0 && sMatched[x.g] === 0) {
        const fp = this.firstPrompt(x.g);
        if (fp) hits.push(this.hit(fp.r, fp.d, null, width));
      }
      hits.sort(transcriptOrder);
      const m: EngineMatch = {
        session: G.view,
        score: Math.round(x.score * 1000) / 1000,
        hits: hits.map(stripOrder),
        matched: sMatched[x.g]!,
      };
      if (G.view.title && tMask[x.g]) {
        const tm = markText(G.view.title, matcher).marks;
        if (tm.length) m.titleMarks = tm;
      }
      return m;
    });

    // reset the per-session pools
    for (let i = 0; i < nts; i++) {
      const g = touchedS[i]!;
      sMask[g] = 0;
      sFull[g] = 0;
      sMatched[g] = 0;
      sN[g] = 0;
    }
    for (const g of titleTouched) {
      tMask[g] = 0;
      tScoreT[g] = 0;
    }
    return { matches, total, more: q.offset + q.limit < total, unknownWords: [], ms: performance.now() - t0 };
  }

  private browse(q: EngineQuery, hitsWanted: number, width: number, t0: number): EngineResult {
    const A = this.allowed;
    const dropped = this.dropped;
    const list: GSession[] = [];
    for (const G of this.S) if (A[G.g] && !dropped[G.g] && G.view.messages > 0) list.push(G);
    list.sort((a, b) => b.view.lastAt - a.view.lastAt || (a.key < b.key ? -1 : 1));
    const total = list.length;
    const page = list.slice(q.offset, q.offset + q.limit);
    const matches: EngineMatch[] = page.map((G) => {
      const hits: EngineHit[] = [];
      if (hitsWanted > 0) {
        const fp = this.firstPrompt(G.g);
        if (fp) hits.push(stripOrder(this.hit(fp.r, fp.d, null, width)));
      }
      return { session: G.view, score: 0, hits, matched: 0 };
    });
    return { matches, total, more: q.offset + q.limit < total, unknownWords: [], ms: performance.now() - t0 };
  }

  /** The first prompt of a session (else its first doc) in the index that answers for it. */
  private firstPrompt(g: number): { r: SegRef; d: number } | null {
    const bits = this.allowed[g]! || this.answerBit(g);
    let best: { r: SegRef; d: number; at: number; any: boolean } | null = null;
    for (const r of this.refs) {
      if (!(bits & r.bit)) continue;
      if (!r.first) r.first = firstDocs(r);
      for (let l = 0; l < r.gs.length; l++) {
        if (r.gs[l] !== g) continue;
        const enc = r.first[l]!;
        if (enc < 0) continue;
        const d = enc >> 1;
        const isPrompt = (enc & 1) === 1;
        const at = r.seg.ats[d]!;
        if (!best || (isPrompt && !best.any) || (isPrompt === best.any && at < best.at))
          best = { r, d, at, any: isPrompt };
      }
    }
    return best ? { r: best.r, d: best.d } : null;
  }

  /** Which index answers for a session: history when it has docs there (D6). */
  private answerBit(g: number): number {
    const G = this.S[g]!;
    if (G.docs[0] + G.tailDocs[0] > 0 && this.states.has("history")) return 1;
    return 2;
  }

  private hit(
    r: SegRef,
    d: number,
    matcher: Matcher | null,
    width: number,
  ): EngineHit & { _o: [number, number, number] } {
    const row = r.seg.row(d);
    const text = r.seg.text(row);
    const sn = matcher ? snippet(text, matcher, width) : snippet(text, NO_MARKS, width);
    const fileId = this.fileIdOf(r, row);
    const h: EngineHit & { _o: [number, number, number] } = {
      field: FIELD_NAMES[r.seg.fc[d]! % 3]!,
      at: row.at,
      text: sn.text,
      marks: sn.marks,
      ref: encodeRef(r.source, fileId, row.offset, row.seq >= 0 ? row.seq : undefined),
      _o: [row.at, fileId, row.offset],
    };
    const tool = r.seg.str(row.tool);
    if (tool) h.tool = tool;
    const agent = r.seg.str(row.agent);
    if (agent) h.agent = agent;
    const agentType = r.seg.str(row.agentType);
    if (agentType) h.agentType = agentType;
    if (row.seq >= 0) h.seq = row.seq;
    if (r.tail) h.live = true;
    return h;
  }

  private fileIdOf(r: SegRef, row: DocRow): number {
    const id = r.seg.meta.files[row.fileOrd] ?? 0;
    if (id >= PROVISIONAL) return this.states.get(r.source)?.idByProvisional.get(id) ?? id;
    return id;
  }

  // ───────────────────────────── transcript ─────────────────────────────

  private sessionDocs(g: number): TDoc[] {
    const G = this.S[g]!;
    const c = this.transcriptCache.get(G.key);
    if (c && c.v === this.version) return c.list;
    const bit = this.answerBit(g);
    const list: TDoc[] = [];
    for (const r of this.refs) {
      if (!(r.bit & bit)) continue;
      const locals: number[] = [];
      for (let l = 0; l < r.gs.length; l++) if (r.gs[l] === g) locals.push(l);
      if (!locals.length) continue;
      const seg = r.seg;
      const want = new Uint8Array(r.gs.length);
      for (const l of locals) want[l] = 1;
      // contiguous runs of the session's docs: one read each
      let d = 0;
      while (d < seg.N) {
        if (!want[seg.dsess[d]!] || seg.isDeleted(d)) {
          d++;
          continue;
        }
        let e = d + 1;
        while (e < seg.N && want[seg.dsess[e]!] && !seg.isDeleted(e)) e++;
        const buf = seg.rows(d, e);
        for (let k = d; k < e; k++) {
          const row = rowAt(buf, (k - d) * ROW);
          list.push({ r, d: k, row, file: this.fileIdOf(r, row) });
        }
        d = e;
      }
    }
    list.sort((a, b) => a.row.at - b.row.at || a.file - b.file || a.row.offset - b.row.offset);
    if (this.transcriptCache.size >= 4) this.transcriptCache.delete(this.transcriptCache.keys().next().value!);
    this.transcriptCache.set(G.key, { v: this.version, list });
    return list;
  }

  private refIndex(list: TDoc[], ref: string | undefined): number {
    const p = decodeRef(ref);
    if (!p) return -1;
    let file = p.file;
    if (file >= PROVISIONAL) file = this.states.get(p.source)?.idByProvisional.get(file) ?? file;
    let near = -1;
    for (let i = 0; i < list.length; i++) {
      const x = list[i]!;
      if (x.file !== file || x.r.source !== p.source) continue;
      if (x.row.offset === p.offset) return i;
      if (x.row.offset < p.offset) near = i;
    }
    return near;
  }

  private message(x: TDoc): EngineHit {
    const text = x.r.seg.text(x.row);
    const h: EngineHit = {
      field: FIELD_NAMES[x.r.seg.fc[x.d]! % 3]!,
      at: x.row.at,
      text,
      marks: [],
      ref: encodeRef(x.r.source, x.file, x.row.offset, x.row.seq >= 0 ? x.row.seq : undefined),
    };
    const tool = x.r.seg.str(x.row.tool);
    if (tool) h.tool = tool;
    const agent = x.r.seg.str(x.row.agent);
    if (agent) h.agent = agent;
    const agentType = x.r.seg.str(x.row.agentType);
    if (agentType) h.agentType = agentType;
    if (x.row.seq >= 0) h.seq = x.row.seq;
    if (x.r.tail) h.live = true;
    return h;
  }

  transcript(
    key: SessionKey,
    opts: { around?: string; before?: string; after?: string; limit: number },
  ): TranscriptWindow | undefined {
    this.sync();
    const g = this.byKey.get(key);
    if (g === undefined || this.hidden.has(key)) return undefined;
    const list = this.sessionDocs(g);
    if (!list.length) return undefined;
    const limit = Math.max(1, Math.min(200, opts.limit || 60));
    let start = 0;
    let end = Math.min(list.length, limit);
    if (opts.after) {
      const i = this.refIndex(list, opts.after);
      start = i + 1;
      end = Math.min(list.length, start + limit);
    } else if (opts.before) {
      const i = this.refIndex(list, opts.before);
      end = i < 0 ? 0 : i;
      start = Math.max(0, end - limit);
    } else if (opts.around) {
      const i = Math.max(0, this.refIndex(list, opts.around));
      start = Math.max(0, Math.min(i - Math.floor(limit / 2), list.length - limit));
      end = Math.min(list.length, start + limit);
    }
    const w: TranscriptWindow = { messages: list.slice(start, end).map((x) => this.message(x)) };
    if (start > 0 && end > start) w.before = w.messages[0]!.ref;
    if (end < list.length && end > start) w.after = w.messages[w.messages.length - 1]!.ref;
    return w;
  }

  hitsIn(key: SessionKey, parsed: ParsedSearch): { ref: string; marks: SearchMark[] }[] {
    this.sync();
    const g = this.byKey.get(key);
    if (g === undefined || this.hidden.has(key)) return [];
    const compiled = compile(parsed, this.dict);
    if (!compiled.pos.length) return [];
    const bit = this.answerBit(g);
    const A = this.allowed;
    const prev = A[g]!;
    A[g] = bit;
    const found: TDoc[] = [];
    try {
      for (const r of this.refs) {
        if (!(r.bit & bit)) continue;
        let has = false;
        for (let l = 0; l < r.gs.length; l++) if (r.gs[l] === g) has = true;
        if (!has) continue;
        const seen = new Set<number>();
        this.clauseDocs(r, compiled.pos, 0x3f, (gg, d) => {
          if (gg !== g || seen.has(d)) return;
          seen.add(d);
          const row = r.seg.row(d);
          found.push({ r, d, row, file: this.fileIdOf(r, row) });
        });
      }
    } finally {
      A[g] = prev;
    }
    found.sort((a, b) => a.row.at - b.row.at || a.file - b.file || a.row.offset - b.row.offset);
    const out: { ref: string; marks: SearchMark[] }[] = [];
    for (const x of found) {
      if (out.length >= HITS_IN_MAX) break;
      const marks = markText(x.r.seg.text(x.row), compiled.matcher).marks;
      if (!marks.length) continue;
      out.push({ ref: encodeRef(x.r.source, x.file, x.row.offset, x.row.seq >= 0 ? x.row.seq : undefined), marks });
    }
    return out;
  }

  // ───────────────────────────── sessions, overlay, forget ─────────────────────────────

  session(key: SessionKey): IndexedSession | undefined {
    this.sync();
    const g = this.byKey.get(key);
    if (g === undefined || this.hidden.has(key)) return undefined;
    const v = this.S[g]!.view;
    return v.messages > 0 ? v : undefined;
  }

  *sessions(): Iterable<IndexedSession> {
    this.sync();
    for (const G of this.S) if (!this.hidden.has(G.key) && G.view.messages > 0) yield G.view;
  }

  setOverlay(key: SessionKey, overlay: SessionOverlay | null): void {
    if (overlay) this.overlays.set(key, overlay);
    else this.overlays.delete(key);
    const g = this.byKey.get(key);
    if (g === undefined) return;
    const G = this.S[g]!;
    G.view = this.makeView(G);
    this.setTitle(g, G.view.title);
    this.transcriptCache.delete(key);
  }

  forget(key: SessionKey): void {
    this.hidden.add(key);
  }

  stats(): ReaderStats {
    this.sync();
    const gen: ReaderStats["gen"] = {};
    let bytes = 0;
    let updatedAt = 0;
    for (const st of this.states.values()) {
      gen[st.source] = st.manifest?.gen ?? 0;
      bytes += st.bytes();
      if (st.manifest && st.manifest.updatedAt > updatedAt) updatedAt = st.manifest.updatedAt;
    }
    let sessions = 0;
    let messages = 0;
    const by = new Map<string, { harness: string; source: SearchSource; homes: Set<string>; sessions: number }>();
    for (const G of this.S) {
      if (this.hidden.has(G.key) || G.view.messages <= 0) continue;
      sessions++;
      messages += G.view.messages;
      for (const source of G.view.sources) {
        const k = `${G.view.harness}\u0000${source}`;
        let b = by.get(k);
        if (!b) {
          b = { harness: G.view.harness, source, homes: new Set(), sessions: 0 };
          by.set(k, b);
        }
        b.sessions++;
        if (source === "history" && G.view.path) {
          const h = homeOf(G.view.path, this.home);
          if (h) b.homes.add(h);
        }
      }
    }
    const out: ReaderStats = {
      gen,
      sessions,
      messages,
      bytes,
      bySource: [...by.values()]
        .filter((b) => b.sessions > 0)
        .map((b) => ({ harness: b.harness, source: b.source, homes: [...b.homes].sort(), sessions: b.sessions })),
    };
    if (updatedAt) out.updatedAt = updatedAt;
    return out;
  }

  refresh(): boolean {
    let moved = false;
    for (const st of this.states.values()) if (st.load()) moved = true;
    if (moved) {
      this.tail?.reset();
      this.tailVersion++;
      this.rebuild();
      this.tail?.tick();
    }
    return moved;
  }

  tick(): void {
    if (!this.tail) return;
    void this.tail.tick().then(() => {
      if (this.tail?.wantsCommit) this.wantCommit?.();
    });
  }

  /** The live pass as a promise (tests, the bench, the CLI). */
  tickNow(): Promise<void> {
    return this.tail ? this.tail.tick() : Promise.resolve();
  }

  hint(path: string): void {
    this.tail?.hint(path);
  }

  /** ms of the last live pass. */
  get lastTickMs(): number {
    return this.tail?.lastPassMs ?? 0;
  }

  close(): void {
    this.tail?.close();
    for (const st of this.states.values()) st.closeAll();
    this.refs = [];
  }
}

interface TDoc {
  r: SegRef;
  d: number;
  row: DocRow;
  file: number;
}

const NO_MARKS: Matcher = { terms: new Map(), prefixes: [], phrases: [], needles: [] };

const transcriptOrder = (a: { _o: [number, number, number] }, b: { _o: [number, number, number] }): number =>
  a._o[0] - b._o[0] || a._o[1] - b._o[1] || a._o[2] - b._o[2];

function stripOrder(h: EngineHit & { _o?: unknown }): EngineHit {
  delete h._o;
  return h;
}

/** Per local session: (its first prompt doc << 1 | 1), else (its first doc << 1), else −1. */
function firstDocs(r: SegRef): Int32Array {
  const seg = r.seg;
  const n = r.gs.length;
  const out = new Int32Array(n).fill(-1);
  const at = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  for (let d = 0; d < seg.N; d++) {
    if (seg.isDeleted(d)) continue;
    const l = seg.dsess[d]!;
    const prompt = seg.fc[d]! % 3 === 0;
    const cur = out[l]!;
    const curPrompt = cur >= 0 && (cur & 1) === 1;
    const t = seg.ats[d]!;
    if (cur < 0 || (prompt && !curPrompt) || (prompt === curPrompt && t < at[l]!)) {
      out[l] = (d << 1) | (prompt ? 1 : 0);
      at[l] = t;
    }
  }
  return out;
}

/** `~/.claude` for `/Users/x/.claude/projects/…` (the home a history file came from). */
function homeOf(path: string, home: string): string | undefined {
  const h = home.endsWith("/") ? home : `${home}/`;
  if (!path.startsWith(h)) return undefined;
  const seg = path.slice(h.length).split(/[\\/]/)[0];
  return seg ? `~/${seg}` : undefined;
}

const utf8d = new TextDecoder();
void utf8;
