// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The in-RAM inverted index of one segment: docs go in as they are
// read (tokenized once, terms interned), `encode` writes the segment (a counting sort of the
// token stream by term gives every posting list in (doc, position) order with no per-term
// arrays). Token arrays are reused across flushes: allocator churn is most of the RSS
// otherwise (arch-engine.md §12).

import { splitKey } from "../../../shared/api.js";
import type { SearchDoc, SessionFacts } from "../types.js";
import { Out, utf8 } from "./codec.js";
import { emptyFacts, type Facts, foldFacts, foldTimes, headFacts } from "./facts.js";
import { FIELD_CODES, fieldCode, LEN, lenCode, type SegSession, SegWriter, writeRow } from "./segment.js";
import { fold, spans } from "./tokenize.js";

export class GrowU32 {
  a: Uint32Array;
  n = 0;
  constructor(n = 1 << 12) {
    this.a = new Uint32Array(n);
  }
  push(x: number): void {
    if (this.n === this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
  }
  clear(): void {
    this.n = 0;
  }
}

export interface EncodeResult {
  buffer?: Buffer;
  bytes: number;
  crc: number;
  docs: number;
}

export class Builder {
  private termIds = new Map<string, number>();
  private termList: string[] = [];
  /** Open addressing over term ids (+1; 0 empty), keyed by the folded term's chars. */
  private htab = new Int32Array(1 << 16);
  private hmask = (1 << 16) - 1;

  private static hashStr(t: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }

  private grow(): void {
    const cap = this.htab.length * 2;
    const tab = new Int32Array(cap);
    const mask = cap - 1;
    const list = this.termList;
    for (let id = 0; id < list.length; id++) {
      let i = Builder.hashStr(list[id]!) & mask;
      while (tab[i] !== 0) i = (i + 1) & mask;
      tab[i] = id + 1;
    }
    this.htab = tab;
    this.hmask = mask;
  }

  private add1(term: string, slot: number): number {
    const id = this.termList.length;
    this.termList.push(term);
    this.termIds.set(term, id);
    this.htab[slot] = id + 1;
    if (this.termList.length * 2 > this.htab.length) this.grow();
    return id;
  }

  /** The id of text[s, e) lowercased (an ASCII span). */
  private internAscii(text: string, s: number, e: number): number {
    let h = 0x811c9dc5;
    for (let i = s; i < e; i++) {
      let c = text.charCodeAt(i);
      if (c >= 65 && c <= 90) c |= 32;
      h = Math.imul(h ^ c, 0x01000193);
    }
    const mask = this.hmask;
    const tab = this.htab;
    const list = this.termList;
    const len = e - s;
    let i = (h >>> 0) & mask;
    for (;;) {
      const v = tab[i]!;
      if (v === 0) return this.add1(text.slice(s, e).toLowerCase(), i);
      const t = list[v - 1]!;
      if (t.length === len) {
        let k = 0;
        for (; k < len; k++) {
          let c = text.charCodeAt(s + k);
          if (c >= 65 && c <= 90) c |= 32;
          if (c !== t.charCodeAt(k)) break;
        }
        if (k === len) return v - 1;
      }
      i = (i + 1) & mask;
    }
  }

  /** The id of a folded term. */
  private intern(term: string): number {
    const mask = this.hmask;
    const tab = this.htab;
    const list = this.termList;
    let i = Builder.hashStr(term) & mask;
    for (;;) {
      const v = tab[i]!;
      if (v === 0) return this.add1(term, i);
      if (list[v - 1] === term) return v - 1;
      i = (i + 1) & mask;
    }
  }
  private tokTerm = new GrowU32(1 << 16);
  private tokPos = new GrowU32(1 << 16);
  private docTok = new GrowU32(1 << 10);
  private fc = new Out(1 << 10);
  private lc = new Out(1 << 10);
  private rowsOut = new Out(1 << 14);
  private store = Buffer.allocUnsafe(1 << 16);
  private storeN = 0;
  private dsess = new GrowU32(1 << 10);
  private ats = new GrowU32(1 << 10);
  private sessIdx = new Map<string, number>();
  private sessions: SegSession[] = [];
  /** Per session: facts per file. */
  private ff: Map<number, Facts>[] = [];
  private fileOrd = new Map<number, number>();
  private files: number[] = [];
  private strIdx = new Map<string, number>();
  private strs: string[] = [];
  private flen = new Array<number>(FIELD_CODES).fill(0);
  private fcnt = new Array<number>(FIELD_CODES).fill(0);
  private oDoc = new Uint32Array(0);
  private oPos = new Uint32Array(0);
  /** UTF-16 units of text added (the commit thresholds read it). */
  textChars = 0;
  /** Date.now() of the first add since the last reset. */
  since = 0;
  /** Per file: the last record offset and how many docs it gave (files may interleave). */
  private lastBy = new Map<number, { offset: number; sub: number }>();

  constructor() {
    this.docTok.push(0);
  }

  get docs(): number {
    return this.dsess.n;
  }

  get tokens(): number {
    return this.tokTerm.n;
  }

  /** Nothing to write: no doc and no fact. */
  get empty(): boolean {
    return this.dsess.n === 0 && this.sessions.length === 0;
  }

  /** Session keys this builder holds (docs or facts). */
  keys(): Iterable<string> {
    return this.sessIdx.keys();
  }

  private session(key: string, harness?: string, id?: string): SegSession {
    let s = this.sessIdx.get(key);
    if (s === undefined) {
      s = this.sessions.length;
      const k = harness && id ? { harness, id } : splitKey(key);
      this.sessions.push({ key, docs: 0, facts: emptyFacts(k.harness, k.id) });
      this.ff.push(new Map());
      this.sessIdx.set(key, s);
    }
    return this.sessions[s]!;
  }

  private str(s: string | undefined): number {
    if (!s) return 0;
    let i = this.strIdx.get(s);
    if (i === undefined) {
      this.strs.push(s);
      i = this.strs.length;
      this.strIdx.set(s, i);
    }
    return i;
  }

  add(d: SearchDoc, fileId: number): void {
    if (!this.since) this.since = Date.now();
    const sess = this.session(d.key);
    const s = this.sessIdx.get(d.key)!;
    sess.docs++;
    if (d.at > 0) {
      foldTimes(sess.facts, d.at, d.at);
      foldTimes(this.fileFacts(s, sess, fileId), d.at, d.at);
    }
    const tt = this.tokTerm;
    const tp = this.tokPos;
    const ids = this.termIds;
    const list = this.termList;
    const text = d.text;
    let parts = 0;
    void ids;
    void list;
    // spans, not strings: an ASCII token is hashed and compared in place, a string is made
    // only for a term seen for the first time (most tokens repeat)
    spans(text, (pos, s0, e0, ascii) => {
      if (pos >= parts) parts = pos + 1;
      tt.push(ascii ? this.internAscii(text, s0, e0) : this.intern(fold(text.slice(s0, e0))));
      tp.push(pos);
    });
    // the length counts parts (a whole identifier repeats its parts)
    const len = parts;
    this.docTok.push(tt.n);
    this.dsess.push(s);
    this.ats.push(d.at > 0 ? Math.floor(d.at / 1000) : 0);
    const code = fieldCode(d.field, !!d.agent);
    const lcode = lenCode(len);
    this.fc.u8(code);
    this.lc.u8(lcode);
    this.flen[code]! += LEN[lcode]!;
    this.fcnt[code]!++;
    let fo = this.fileOrd.get(fileId);
    if (fo === undefined) {
      fo = this.files.length;
      this.files.push(fileId);
      this.fileOrd.set(fileId, fo);
    }
    const storeOff = this.storeN;
    if (this.storeN + text.length * 3 > this.store.length) {
      let m = this.store.length * 2;
      while (m < this.storeN + text.length * 3) m *= 2;
      const nb = Buffer.allocUnsafe(m);
      this.store.copy(nb, 0, 0, this.storeN);
      this.store = nb;
    }
    const w = this.store.write(text, this.storeN, "utf8");
    this.storeN += w;
    let lb = this.lastBy.get(fileId);
    if (!lb) {
      lb = { offset: d.offset, sub: 0 };
      this.lastBy.set(fileId, lb);
    } else if (lb.offset === d.offset) lb.sub++;
    else {
      lb.offset = d.offset;
      lb.sub = 0;
    }
    writeRow(this.rowsOut, {
      at: d.at,
      offset: d.offset,
      storeOff,
      storeLen: w,
      fileOrd: fo,
      seq: d.seq ?? -1,
      tool: this.str(d.tool),
      agent: this.str(d.agent),
      agentType: this.str(d.agentType),
      sub: lb.sub,
    });
    this.textChars += text.length;
  }

  /** Facts learned from file `fileId` (−1: no file). */
  facts(f: SessionFacts, fileId = -1): void {
    if (!this.since) this.since = Date.now();
    const sess = this.session(f.key, f.harness, f.id);
    foldFacts(sess.facts, f);
    foldFacts(this.fileFacts(this.sessIdx.get(f.key)!, sess, fileId), f);
  }

  private fileFacts(s: number, sess: SegSession, fileId: number): Facts {
    const m = this.ff[s]!;
    let x = m.get(fileId);
    if (!x) {
      x = emptyFacts(sess.facts.harness, sess.facts.id);
      m.set(fileId, x);
    }
    return x;
  }

  /** Write the segment: into RAM (no `dest`) or to the file `dest` (fsynced; the caller
   *  renames it into place). */
  encode(dest?: string): EncodeResult {
    const T = this.termList.length;
    const N = this.dsess.n;
    const tt = this.tokTerm.a;
    const tp = this.tokPos.a;
    const dt = this.docTok.a;
    const ntok = this.tokTerm.n;
    const start = new Uint32Array(T + 1);
    for (let i = 0; i < ntok; i++) start[tt[i]! + 1]!++;
    for (let t = 0; t < T; t++) start[t + 1]! += start[t]!;
    const next = start.slice(0, T);
    if (this.oDoc.length < ntok) {
      this.oDoc = new Uint32Array(this.tokTerm.a.length);
      this.oPos = new Uint32Array(this.tokTerm.a.length);
    }
    const oDoc = this.oDoc;
    const oPos = this.oPos;
    for (let d = 0; d < N; d++) {
      for (let i = dt[d]!, e = dt[d + 1]!; i < e; i++) {
        const s = next[tt[i]!]!++;
        oDoc[s] = d;
        oPos[s] = tp[i]!;
      }
    }
    const terms = this.termList;
    // the native string sort is UTF-16 order = code point order (terms hold no surrogates)
    const sorted = terms.slice().sort();
    const order = new Uint32Array(T);
    for (let i = 0; i < T; i++) order[i] = this.termIds.get(sorted[i]!)!;
    // in RAM (a builder is bounded by the flush thresholds); one write of the final file
    const w = new SegWriter(Math.max(1 << 12, ntok * 2), null);
    try {
      for (let oi = 0; oi < T; oi++) {
        const t = order[oi]!;
        w.begin(utf8.encode(terms[t]!));
        let i = start[t]!;
        const e = start[t + 1]!;
        while (i < e) {
          const d = oDoc[i]!;
          let j = i + 1;
          while (j < e && oDoc[j] === d) {
            // a term repeated at the same position (never from tokenize; be safe)
            j++;
          }
          w.add(d, oPos, i, j);
          i = j;
        }
        w.end();
      }
      const rows = this.rowsOut;
      const store = this.store.subarray(0, this.storeN);
      const r = w.finish(
        {
          N,
          fc: this.fc.view,
          lc: this.lc.view,
          docs: rows.view,
          store,
          dsess: this.dsess.a.subarray(0, N),
          ats: this.ats.a.subarray(0, N),
          meta: {
            N,
            flen: this.flen,
            fcnt: this.fcnt,
            // on disk the facts live per file only (the reader folds the files still named);
            // a RAM segment (the live tail) keeps the folded facts too
            sessions: this.sessions.map((x, i) => ({
              key: x.key,
              docs: x.docs,
              facts: dest ? headFacts(x.facts) : x.facts,
              ff: [...this.ff[i]!],
            })),
            files: this.files,
            strs: this.strs,
            textBytes: this.storeN,
          },
        },
        dest,
      );
      return { ...r, docs: N };
    } catch (e) {
      w.abandon();
      throw e;
    }
  }

  /** Empty it for the next segment, keeping the big arrays. */
  reset(): void {
    this.termIds = new Map();
    this.termList = [];
    if (this.htab.length > 1 << 20) {
      this.htab = new Int32Array(1 << 16);
      this.hmask = (1 << 16) - 1;
    } else this.htab.fill(0);
    this.tokTerm.clear();
    this.tokPos.clear();
    this.docTok.clear();
    this.docTok.push(0);
    this.fc.clear();
    this.lc.clear();
    this.rowsOut.clear();
    this.storeN = 0;
    this.dsess.clear();
    this.ats.clear();
    this.sessIdx = new Map();
    this.sessions = [];
    this.ff = [];
    this.fileOrd = new Map();
    this.files = [];
    this.strIdx = new Map();
    this.strs = [];
    this.flen.fill(0);
    this.fcnt.fill(0);
    this.textChars = 0;
    this.since = 0;
    this.lastBy.clear();
    // Big token arrays shrink back after an unusually large flush (bounded RSS).
    if (this.tokTerm.a.length > 1 << 23) {
      this.tokTerm = new GrowU32(1 << 16);
      this.tokPos = new GrowU32(1 << 16);
      this.oDoc = new Uint32Array(0);
      this.oPos = new Uint32Array(0);
    }
    if (this.store.length > 1 << 26) this.store = Buffer.allocUnsafe(1 << 16);
  }
}

export type { Facts };
