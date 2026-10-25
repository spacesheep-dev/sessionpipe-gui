// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The in-RAM inverted index of one segment: docs go in as they are
// read (tokenized once, terms interned), `encode` writes the segment (a counting sort of the
// token stream by term gives every posting list in (doc, position) order with no per-term
// arrays). Token arrays are reused across flushes: allocator churn is most of the RSS
// otherwise (arch-engine.md §12).

import { splitKey } from "../../../shared/api.js";
import type { SearchDoc, SessionFacts } from "../types.js";
import { Out, type Sink, utf8 } from "./codec.js";
import { emptyFacts, type Facts, foldFacts, foldTimes } from "./facts.js";
import { FIELD_CODES, fieldCode, LEN, lenCode, type SegSession, SegWriter, writeRow } from "./segment.js";
import { tokenize } from "./tokenize.js";

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
  private tokTerm = new GrowU32(1 << 16);
  private tokPos = new GrowU32(1 << 16);
  private docTok = new GrowU32(1 << 10);
  private fc = new Out(1 << 10);
  private lc = new Out(1 << 10);
  private rowsOut = new Out(1 << 14);
  private store = new Out(1 << 16);
  private dsess = new GrowU32(1 << 10);
  private ats = new GrowU32(1 << 10);
  private sessIdx = new Map<string, number>();
  private sessions: SegSession[] = [];
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
  private lastFile = -1;
  private lastOffset = -1;
  private sub = 0;

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
    if (d.at > 0) foldTimes(sess.facts, d.at, d.at);
    const tt = this.tokTerm;
    const tp = this.tokPos;
    const ids = this.termIds;
    const list = this.termList;
    const text = d.text;
    let parts = 0;
    tokenize(text, (term, pos) => {
      if (pos >= parts) parts = pos + 1;
      let id = ids.get(term);
      if (id === undefined) {
        id = list.length;
        list.push(term);
        ids.set(term, id);
      }
      tt.push(id);
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
    const st = this.store;
    const storeOff = st.n;
    st.grow(text.length * 3);
    const w = utf8.encodeInto(text, st.b.subarray(st.n)).written;
    st.n += w;
    if (fileId === this.lastFile && d.offset === this.lastOffset) this.sub++;
    else {
      this.sub = 0;
      this.lastFile = fileId;
      this.lastOffset = d.offset;
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
      sub: this.sub,
    });
    this.textChars += text.length;
  }

  facts(f: SessionFacts): void {
    if (!this.since) this.since = Date.now();
    foldFacts(this.session(f.key, f.harness, f.id).facts, f);
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
    const order = Uint32Array.from({ length: T }, (_, i) => i).sort((a, b) => {
      const x = terms[a]!;
      const y = terms[b]!;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const w = new SegWriter(Math.max(1 << 12, ntok * 2), dest ? `${dest}.w` : null);
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
      const store = this.store;
      const r = w.finish(
        {
          N,
          fc: this.fc.view,
          lc: this.lc.view,
          docs: rows.view,
          store: (o: Sink) => o.bytes(store.view),
          dsess: this.dsess.a.subarray(0, N),
          ats: this.ats.a.subarray(0, N),
          meta: {
            N,
            flen: this.flen,
            fcnt: this.fcnt,
            sessions: this.sessions,
            files: this.files,
            strs: this.strs,
            textBytes: store.n,
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
    this.tokTerm.clear();
    this.tokPos.clear();
    this.docTok.clear();
    this.docTok.push(0);
    this.fc.clear();
    this.lc.clear();
    this.rowsOut.clear();
    this.store.clear();
    this.dsess.clear();
    this.ats.clear();
    this.sessIdx = new Map();
    this.sessions = [];
    this.fileOrd = new Map();
    this.files = [];
    this.strIdx = new Map();
    this.strs = [];
    this.flen.fill(0);
    this.fcnt.fill(0);
    this.textChars = 0;
    this.since = 0;
    this.lastFile = -1;
    this.lastOffset = -1;
    this.sub = 0;
    // Big token arrays shrink back after an unusually large flush (bounded RSS).
    if (this.tokTerm.a.length > 1 << 23) {
      this.tokTerm = new GrowU32(1 << 16);
      this.tokPos = new GrowU32(1 << 16);
      this.oDoc = new Uint32Array(0);
      this.oPos = new Uint32Array(0);
    }
    if (this.store.b.length > 1 << 26) this.store = new Out(1 << 16);
  }
}

export type { Facts };
