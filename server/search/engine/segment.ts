// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The immutable segment file (`seg-<n>.sps`) and its reader.
//
//   "SPS2" | postings | positions | dict | dictIndex | norms | docs | store | docSess | ats | meta
//          | section table: (offset f64, length f64) × n | n u32 | crc32 u32 | "SPS2"
//
//   postings   per term, blocks of 128 docs: [lastDoc v, byteLen v, posOff v] then
//              (docDelta v, tf v) pairs; deltas run on across blocks.
//   positions  per term, aligned with its postings: per doc, tf position deltas (v).
//   dict       front-coded blocks of 32 terms in UTF-8 byte order:
//              (shared v, suffixLen v, suffix, df v, postOff v, postLen v, posOff v, posLen v).
//   dictIndex  per dict block: (termLen v, first term, dictOff v). The only dictionary in RAM.
//   norms      N bytes of field code (field + 3 for a subagent) then N bytes of length code
//              round(4·log2(1 + tokens)).
//   docs       fixed 56-byte rows: at f64, offset f64, storeOff f64, storeLen u32,
//              fileOrd u32, seq f64 (−1 none), tool u32, agent u32, agentType u32 (string
//              table index + 1, 0 none), sub u32 (the n-th doc of one record). Read with
//              pread only for what is shown.
//   store      the docs' text, UTF-8, raw (one pread per snippet).
//   docSess    u32 per doc: the local session ordinal.
//   ats        u32 per doc: `at` in seconds (RAM: newest-first hits, transcript order).
//   meta       JSON: N, field length sums, the sessions (key, docs, folded facts), the
//              manifest file ids, the string table.
//
// A reader keeps in RAM: 2 B/doc norms, 4 B/doc session, 4 B/doc seconds, the dictIndex and
// the tombstones. Everything else stays on disk and is read through the OS page cache.
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import type { SearchDocField } from "../types.js";
import { compareBytes, crc32, FileOut, Out, readF64, readU32, readV, type Sink, utf8, utf8d } from "./codec.js";
import type { Facts } from "./facts.js";

export const MAGIC = 0x32535053; // "SPS2"
export const POST_BLOCK = 128;
export const DICT_BLOCK = 32;
export const ROW = 56;

export const S_POST = 0;
export const S_POS = 1;
export const S_DICT = 2;
export const S_DIDX = 3;
export const S_NORMS = 4;
export const S_DOCS = 5;
export const S_STORE = 6;
export const S_DSESS = 7;
export const S_ATS = 8;
export const S_META = 9;
export const SECTIONS = 10;

export const FIELD_NAMES: readonly SearchDocField[] = ["prompt", "reply", "tool"];
export const fieldIndex = (f: SearchDocField): number => (f === "prompt" ? 0 : f === "reply" ? 1 : 2);
/** Field code: the field, plus 3 for a subagent's message. */
export const fieldCode = (f: SearchDocField, sub: boolean): number => fieldIndex(f) + (sub ? 3 : 0);
export const FIELD_CODES = 6;

/** Length code of a doc of `tokens` terms. */
export const lenCode = (tokens: number): number => Math.min(255, Math.round(4 * Math.log2(1 + tokens)));
/** The doc length a code stands for. */
export const LEN = Float64Array.from({ length: 256 }, (_, i) => 2 ** (i / 4) - 1);

export interface SegSession {
  key: string;
  /** Docs of this session in this segment (before tombstones). */
  docs: number;
  /** Everything folded (kept for old readers and as the fallback). */
  facts: Facts;
  /** The same facts per source file (manifest id; −1 unknown), so a replaced or deleted
   *  file's facts go with it: the reader folds only the files still named. */
  ff?: [number, Facts][];
}

export interface SegMeta {
  v: 2;
  N: number;
  terms: number;
  blocks: number;
  /** Per field code: summed length codes' lengths and doc counts (BM25 avgdl). */
  flen: number[];
  fcnt: number[];
  sessions: SegSession[];
  /** fileOrd → manifest file id. */
  files: number[];
  /** String table (tool names, agent ids and types); a row's index is position + 1. */
  strs: string[];
  textBytes: number;
}

/** The bytes of everything but the inverted index, handed to `SegWriter.finish`. */
export interface SegRest {
  N: number;
  fc: Uint8Array;
  lc: Uint8Array;
  docs: Uint8Array | ((out: Sink) => void);
  store: Uint8Array | ((out: Sink) => void);
  dsess: Uint32Array;
  ats: Uint32Array;
  meta: Omit<SegMeta, "terms" | "blocks" | "v">;
}

/** Writes postings, positions and the dictionary term by term (in byte order), then the
 *  rest. In RAM (the live tail, small commits) or streaming to temp files (merges). */
export class SegWriter {
  private post: Sink;
  private pos: Sink;
  private dict: Sink;
  private didx = new Out(1 << 12);
  private blk = new Out(1 << 12);
  private prev = new Uint8Array(512);
  private prevLen = 0;
  private term: Uint8Array = new Uint8Array(0);
  private postStart = 0;
  private posStart = 0;
  private blkPos = 0;
  private df = 0;
  private inBlk = 0;
  private lastDoc = -1;
  terms = 0;
  blocks = 0;

  constructor(hint: number, tmpBase: string | null = null) {
    const mk = (name: string, h: number): Sink => (tmpBase ? new FileOut(`${tmpBase}.${name}.tmp`) : new Out(h));
    this.post = mk("post", hint);
    this.pos = mk("pos", hint);
    this.dict = mk("dict", hint >> 2);
  }

  begin(term: Uint8Array): void {
    this.term = term;
    if (this.terms % DICT_BLOCK === 0) {
      this.didx.v(term.length);
      this.didx.bytes(term);
      this.didx.v(this.dict.n);
      this.blocks++;
      this.prevLen = 0;
    }
    this.terms++;
    this.postStart = this.post.n;
    this.posStart = this.pos.n;
    this.blkPos = this.pos.n;
    this.df = 0;
    this.inBlk = 0;
    this.lastDoc = -1;
    this.blk.clear();
  }

  /** One doc of the current term, positions `arr[from..to)` ascending. */
  add(doc: number, arr: ArrayLike<number>, from: number, to: number): void {
    let pp = 0;
    const pos = this.pos;
    for (let j = from; j < to; j++) {
      const x = arr[j]!;
      pos.v(x - pp);
      pp = x;
    }
    this.blk.v(this.lastDoc < 0 ? doc : doc - this.lastDoc);
    this.blk.v(to - from);
    this.lastDoc = doc;
    this.df++;
    if (++this.inBlk === POST_BLOCK) this.flushBlock();
  }

  private flushBlock(): void {
    const p = this.post;
    p.v(this.lastDoc);
    p.v(this.blk.n);
    p.v(this.blkPos - this.posStart);
    p.bytes(this.blk.view);
    this.blk.clear();
    this.inBlk = 0;
    this.blkPos = this.pos.n;
  }

  end(): void {
    if (this.inBlk) this.flushBlock();
    const t = this.term;
    const pv = this.prev;
    let shared = 0;
    const lim = Math.min(this.prevLen, t.length);
    while (shared < lim && pv[shared] === t[shared]) shared++;
    const d = this.dict;
    d.v(shared);
    d.v(t.length - shared);
    d.bytes(t.subarray(shared));
    d.v(this.df);
    d.v(this.postStart);
    d.v(this.post.n - this.postStart);
    d.v(this.posStart);
    d.v(this.pos.n - this.posStart);
    if (pv.length < t.length) this.prev = new Uint8Array(t.length * 2);
    this.prev.set(t);
    this.prevLen = t.length;
  }

  /** Finish into one buffer (RAM), or into `dest` (tmp → fsync → rename is the caller's;
   *  this writes `dest` directly and fsyncs). Returns the bytes written and the crc. */
  finish(rest: SegRest, dest?: string): { buffer?: Buffer; bytes: number; crc: number } {
    const meta: SegMeta = { v: 2, terms: this.terms, blocks: this.blocks, ...rest.meta };
    const metaBytes = utf8.encode(JSON.stringify(meta));
    const norms = new Uint8Array(rest.N * 2);
    norms.set(rest.fc.subarray(0, rest.N), 0);
    norms.set(rest.lc.subarray(0, rest.N), rest.N);
    const dsess = new Uint8Array(rest.dsess.buffer, rest.dsess.byteOffset, rest.N * 4);
    const ats = new Uint8Array(rest.ats.buffer, rest.ats.byteOffset, rest.N * 4);
    const out: Sink & { crcAcc?: number } = dest ? new CrcFileOut(dest) : new CrcOut(1 << 16);
    out.u32(MAGIC);
    const offs: number[] = [];
    const putSink = (s: Sink): void => {
      const at = out.n;
      if (s instanceof Out) out.bytes(s.view);
      else copyFileInto((s as FileOut).file, out, true);
      offs.push(at, out.n - at);
    };
    const put = (x: Uint8Array | ((o: Sink) => void)): void => {
      const at = out.n;
      if (typeof x === "function") x(out);
      else out.bytes(x);
      offs.push(at, out.n - at);
    };
    if (this.post instanceof FileOut) this.post.close(false);
    if (this.pos instanceof FileOut) this.pos.close(false);
    if (this.dict instanceof FileOut) this.dict.close(false);
    putSink(this.post);
    putSink(this.pos);
    putSink(this.dict);
    put(this.didx.view);
    put(norms);
    put(rest.docs);
    put(rest.store);
    put(dsess);
    put(ats);
    put(metaBytes);
    for (const o of offs) out.f64(o);
    out.u32(offs.length / 2);
    const crc = (out as CrcOut | CrcFileOut).crc();
    out.u32(crc);
    out.u32(MAGIC);
    if (out instanceof CrcFileOut) {
      out.close(true);
      return { bytes: out.n, crc };
    }
    const o = out as CrcOut;
    return { buffer: Buffer.from(o.b.buffer, o.b.byteOffset, o.n), bytes: o.n, crc };
  }

  /** Remove the temp files of an abandoned writer. */
  abandon(): void {
    for (const s of [this.post, this.pos, this.dict]) {
      if (s instanceof FileOut) {
        try {
          s.close(false);
        } catch {}
        try {
          unlinkSync(s.file);
        } catch {}
      }
    }
  }
}

/** An Out that computes the crc32 of everything written (for the footer). */
class CrcOut extends Out {
  crc(): number {
    return crc32(this.view);
  }
}

/** A FileOut that keeps a running crc32. */
class CrcFileOut extends FileOut {
  private acc = 0;
  private pending = new Out(1 << 16);
  override v(x: number): void {
    this.pending.clear();
    this.pending.v(x);
    this.feed(this.pending.view);
  }
  override u8(x: number): void {
    this.pending.clear();
    this.pending.u8(x);
    this.feed(this.pending.view);
  }
  override u32(x: number): void {
    this.pending.clear();
    this.pending.u32(x);
    this.feed(this.pending.view);
  }
  override f64(x: number): void {
    this.pending.clear();
    this.pending.f64(x);
    this.feed(this.pending.view);
  }
  override bytes(a: Uint8Array): void {
    this.feed(a);
  }
  private feed(a: Uint8Array): void {
    this.acc = crc32(a, this.acc);
    super.bytes(a);
  }
  crc(): number {
    return this.acc;
  }
}

const COPY = Buffer.allocUnsafe(1 << 18);
/** Append a whole file to `out` (and unlink it when asked). */
export function copyFileInto(file: string, out: Sink, unlink: boolean): void {
  const fd = openSync(file, "r");
  try {
    let n: number;
    let p = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: a read loop
    while ((n = readSync(fd, COPY, 0, COPY.length, p)) > 0) {
      out.bytes(COPY.subarray(0, n));
      p += n;
    }
  } finally {
    closeSync(fd);
  }
  if (unlink) {
    try {
      unlinkSync(file);
    } catch {}
  }
}

// ───────────────────────────── reader ─────────────────────────────

/** A dictionary entry (one per lookup; not per posting). */
export interface DictEntry {
  df: number;
  po: number;
  pl: number;
  xo: number;
  xl: number;
}

export interface DocRow {
  at: number;
  offset: number;
  storeOff: number;
  storeLen: number;
  fileOrd: number;
  seq: number;
  tool: number;
  agent: number;
  agentType: number;
  /** The n-th doc emitted from one record (same file and offset). */
  sub: number;
}

// Read pools: postings, positions, dict, rows/text. A caller never keeps a pooled view.
const POOL: Buffer[] = [
  Buffer.allocUnsafe(1 << 16),
  Buffer.allocUnsafe(1 << 16),
  Buffer.allocUnsafe(1 << 13),
  Buffer.allocUnsafe(1 << 16),
];
export const SLOT_POST = 0;
export const SLOT_POS = 1;
export const SLOT_DICT = 2;
export const SLOT_ROW = 3;

/** Shrink the read pools back after an unusually large read (keeps the footprint flat). */
export function trimPools(): void {
  for (let i = 0; i < POOL.length; i++) if (POOL[i]!.length > 1 << 22) POOL[i] = Buffer.allocUnsafe(1 << 16);
}

const cur = { p: 0 };
const VERIFY_BUF = Buffer.allocUnsafe(1 << 20);

export class SegmentError extends Error {}

export class Segment {
  readonly name: string;
  readonly meta: SegMeta;
  readonly N: number;
  /** Field code and length code per doc. */
  readonly fc: Uint8Array;
  readonly lc: Uint8Array;
  readonly dsess: Uint32Array;
  readonly ats: Uint32Array;
  readonly size: number;
  readonly crc: number;
  private fd = -1;
  private buf: Buffer | null = null;
  private sec: Float64Array;
  private blockFirst: string[] = [];
  private blockOff: number[] = [];
  /** Tombstones: one bit per doc. */
  del: Uint8Array | null = null;
  delCount = 0;
  private scratch = new Uint8Array(512);
  private qb = new Uint8Array(512);

  /** `src`: a path (pread) or a Buffer (a segment in RAM: the live tail, tests). */
  constructor(src: string | Buffer, name = typeof src === "string" ? src : "ram") {
    this.name = name;
    let size: number;
    let tail: Uint8Array;
    if (typeof src === "string") {
      this.fd = openSync(src, "r");
      try {
        size = fstatSync(this.fd).size;
        if (size < 16) throw new SegmentError(`segment too short: ${name}`);
        const t = Buffer.allocUnsafe(12);
        readSync(this.fd, t, 0, 12, size - 12);
        tail = t;
      } catch (e) {
        closeSync(this.fd);
        throw e;
      }
    } else {
      this.buf = src;
      size = src.length;
      if (size < 16) throw new SegmentError(`segment too short: ${name}`);
      tail = src.subarray(size - 12);
    }
    this.size = size;
    try {
      if (readU32(tail, 8) !== MAGIC) throw new SegmentError(`bad footer: ${name}`);
      this.crc = readU32(tail, 4);
      const ns = readU32(tail, 0);
      if (ns !== SECTIONS) throw new SegmentError(`bad section count: ${name}`);
      const tbl = this.raw(size - 12 - ns * 16, ns * 16);
      this.sec = new Float64Array(ns * 2);
      for (let i = 0; i < ns * 2; i++) this.sec[i] = readF64(tbl, i * 8);
      for (let i = 0; i < ns; i++) {
        if (this.sec[i * 2]! + this.sec[i * 2 + 1]! > size) throw new SegmentError(`bad section ${i}: ${name}`);
      }
      this.meta = JSON.parse(utf8d.decode(this.section(S_META))) as SegMeta;
      const N = this.meta.N;
      this.N = N;
      const norms = copy(this.section(S_NORMS));
      if (norms.length !== N * 2) throw new SegmentError(`bad norms: ${name}`);
      this.fc = norms.subarray(0, N);
      this.lc = norms.subarray(N, N * 2);
      this.dsess = u32s(this.section(S_DSESS), N);
      this.ats = u32s(this.section(S_ATS), N);
      const di = this.section(S_DIDX);
      cur.p = 0;
      while (cur.p < di.length) {
        const l = readV(di, cur);
        this.blockFirst.push(utf8d.decode(di.subarray(cur.p, cur.p + l)));
        cur.p += l;
        this.blockOff.push(readV(di, cur));
      }
    } catch (e) {
      this.close();
      if (e instanceof SegmentError) throw e;
      throw new SegmentError(`unreadable segment ${name}: ${(e as Error).message}`);
    }
  }

  close(): void {
    if (this.fd >= 0) {
      try {
        closeSync(this.fd);
      } catch {}
      this.fd = -1;
    }
  }

  /** Bytes [off, off+len) of the file (a fresh buffer; small, at open). */
  private raw(off: number, len: number): Uint8Array {
    if (this.buf) return this.buf.subarray(off, off + len);
    const b = Buffer.allocUnsafe(len);
    let r = 0;
    while (r < len) {
      const n = readSync(this.fd, b, r, len - r, off + r);
      if (n <= 0) throw new SegmentError(`short read: ${this.name}`);
      r += n;
    }
    return b;
  }

  /** A whole section (fresh buffer). */
  section(i: number): Uint8Array {
    return this.raw(this.sec[i * 2]!, this.sec[i * 2 + 1]!);
  }

  sectionLength(i: number): number {
    return this.sec[i * 2 + 1]!;
  }

  /** Where the bytes of the last `read` start in the buffer it returned. */
  rp = 0;

  /** Bytes [off, off+len) of a section: the returned buffer holds them from `this.rp` on (a
   *  pooled buffer per `slot`, valid until the next read of that slot; no view is made). */
  read(i: number, off: number, len: number, slot: number): Buffer {
    const at = this.sec[i * 2]! + off;
    if (this.buf) {
      this.rp = at;
      return this.buf;
    }
    this.rp = 0;
    let pb = POOL[slot]!;
    if (pb.length < len) {
      pb = Buffer.allocUnsafe(Math.max(len, pb.length * 2));
      POOL[slot] = pb;
    }
    let r = 0;
    while (r < len) {
      const n = readSync(this.fd, pb, r, len - r, at + r);
      if (n <= 0) throw new SegmentError(`short read: ${this.name}`);
      r += n;
    }
    return pb;
  }

  isDeleted(d: number): boolean {
    const del = this.del;
    return del !== null && (del[d >> 3]! & (1 << (d & 7))) !== 0;
  }

  setDeleted(bits: Uint8Array | null): void {
    this.del = bits;
    let c = 0;
    if (bits) for (let d = 0; d < this.N; d++) if (bits[d >> 3]! & (1 << (d & 7))) c++;
    this.delCount = c;
  }

  // ── dictionary ──

  get termCount(): number {
    return this.meta.terms;
  }

  private findBlock(term: string): number {
    const bf = this.blockFirst;
    let lo = 0;
    let hi = bf.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (bf[m]! <= term) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /** A dict block; it spans [this.rp, this.rp + this.rl) of the returned buffer. */
  private rl = 0;
  private block(bi: number): Buffer {
    const start = this.blockOff[bi]!;
    const end = bi + 1 < this.blockOff.length ? this.blockOff[bi + 1]! : this.sectionLength(S_DICT);
    this.rl = end - start;
    return this.read(S_DICT, start, end - start, SLOT_DICT);
  }

  /** Exact lookup; fills `out` and returns true when the term is here. */
  lookup(term: string, out: DictEntry): boolean {
    if (!this.blockFirst.length) return false;
    let q = this.qb;
    if (q.length < term.length * 3) q = this.qb = new Uint8Array(term.length * 3 + 16);
    const ql = utf8.encodeInto(term, q).written;
    const b = this.block(this.findBlock(term));
    let s = this.scratch;
    let sl = 0;
    cur.p = this.rp;
    const bend = this.rp + this.rl;
    while (cur.p < bend) {
      const shared = readV(b, cur);
      const suf = readV(b, cur);
      if (s.length < shared + suf) {
        const ns = new Uint8Array((shared + suf) * 2);
        ns.set(s.subarray(0, sl));
        s = this.scratch = ns;
      }
      for (let k = 0; k < suf; k++) s[shared + k] = b[cur.p + k]!;
      cur.p += suf;
      sl = shared + suf;
      const df = readV(b, cur);
      const po = readV(b, cur);
      const pl = readV(b, cur);
      const xo = readV(b, cur);
      const xl = readV(b, cur);
      const c = compareBytes(s, sl, q, ql);
      if (c === 0) {
        out.df = df;
        out.po = po;
        out.pl = pl;
        out.xo = xo;
        out.xl = xl;
        return true;
      }
      if (c > 0) return false;
    }
    return false;
  }

  /** Every term starting with `prefix`, in order: `fn(termBytes, len, df, entry)` — the bytes
   *  are scratch, valid only during the call. Return false from `fn` to stop. */
  prefix(prefix: string, fn: (bytes: Uint8Array, len: number, e: DictEntry) => boolean | undefined): void {
    if (!this.blockFirst.length) return;
    const pb = utf8.encode(prefix);
    const e: DictEntry = { df: 0, po: 0, pl: 0, xo: 0, xl: 0 };
    let s = this.scratch;
    for (let bi = this.findBlock(prefix); bi < this.blockFirst.length; bi++) {
      const b = this.block(bi);
      let sl = 0;
      cur.p = this.rp;
      const bend = this.rp + this.rl;
      while (cur.p < bend) {
        const shared = readV(b, cur);
        const suf = readV(b, cur);
        if (s.length < shared + suf) {
          const ns = new Uint8Array((shared + suf) * 2);
          ns.set(s.subarray(0, sl));
          s = this.scratch = ns;
        }
        for (let k = 0; k < suf; k++) s[shared + k] = b[cur.p + k]!;
        cur.p += suf;
        sl = shared + suf;
        e.df = readV(b, cur);
        e.po = readV(b, cur);
        e.pl = readV(b, cur);
        e.xo = readV(b, cur);
        e.xl = readV(b, cur);
        let starts = sl >= pb.length;
        for (let k = 0; starts && k < pb.length; k++) if (s[k] !== pb[k]) starts = false;
        if (starts) {
          const p = cur.p;
          const go = fn(s, sl, e);
          cur.p = p;
          if (go === false) return;
        } else if (compareBytes(s, sl, pb, pb.length) > 0) return;
      }
    }
  }

  /** Every term in order (merges): `fn(termBytes, len, entry)`; the bytes are scratch. */
  eachTerm(fn: (bytes: Uint8Array, len: number, e: DictEntry) => void): void {
    const dict = this.section(S_DICT);
    const e: DictEntry = { df: 0, po: 0, pl: 0, xo: 0, xl: 0 };
    let s = new Uint8Array(512);
    const c = { p: 0 };
    let sl = 0;
    while (c.p < dict.length) {
      const shared = readV(dict, c);
      const suf = readV(dict, c);
      if (s.length < shared + suf) {
        const ns = new Uint8Array((shared + suf) * 2);
        ns.set(s.subarray(0, sl));
        s = ns;
      }
      s.set(dict.subarray(c.p, c.p + suf), shared);
      c.p += suf;
      sl = shared + suf;
      e.df = readV(dict, c);
      e.po = readV(dict, c);
      e.pl = readV(dict, c);
      e.xo = readV(dict, c);
      e.xl = readV(dict, c);
      fn(s, sl, e);
    }
  }

  // ── postings ──

  /** Decode a term's postings into D (docs) and F (tf). Returns the count. */
  decode(e: DictEntry, D: Uint32Array, F: Uint32Array): number {
    const r = this.read(S_POST, e.po, e.pl, SLOT_POST);
    let p = this.rp;
    const L = p + e.pl;
    let d = 0;
    let n = 0;
    let first = true;
    while (p < L) {
      let c: number;
      do c = r[p++]!;
      while (c & 128);
      let x = 0;
      let m = 1;
      do {
        c = r[p++]!;
        x += (c & 127) * m;
        m *= 128;
      } while (c & 128);
      do c = r[p++]!;
      while (c & 128);
      const end = p + x;
      while (p < end) {
        x = 0;
        m = 1;
        do {
          c = r[p++]!;
          x += (c & 127) * m;
          m *= 128;
        } while (c & 128);
        d = first ? x : d + x;
        first = false;
        D[n] = d;
        x = 0;
        m = 1;
        do {
          c = r[p++]!;
          x += (c & 127) * m;
          m *= 128;
        } while (c & 128);
        F[n++] = x;
      }
    }
    return n;
  }

  /** Postings plus positions: PS[i]..PS[i+1] index into POS. Returns the count. */
  decodePos(e: DictEntry, D: Uint32Array, F: Uint32Array, PS: Uint32Array, POS: Uint32Array): number {
    const n = this.decode(e, D, F);
    const r = this.read(S_POS, e.xo, e.xl, SLOT_POS);
    let p = this.rp;
    let k = 0;
    for (let i = 0; i < n; i++) {
      PS[i] = k;
      let q = 0;
      const tf = F[i]!;
      for (let j = 0; j < tf; j++) {
        let x = 0;
        let m = 1;
        let c: number;
        do {
          c = r[p++]!;
          x += (c & 127) * m;
          m *= 128;
        } while (c & 128);
        q += x;
        POS[k++] = q;
      }
    }
    PS[n] = k;
    return n;
  }

  // ── docs ──

  /** One doc's row (a fresh object; for the hits shown only). */
  row(d: number): DocRow {
    const r = this.read(S_DOCS, d * ROW, ROW, SLOT_ROW);
    return rowAt(r, this.rp);
  }

  /** Rows [from, to) in one read (a fresh buffer). */
  rows(from: number, to: number): Uint8Array {
    return this.raw(this.sec[S_DOCS * 2]! + from * ROW, (to - from) * ROW);
  }

  text(row: DocRow): string {
    if (!row.storeLen) return "";
    const r = this.read(S_STORE, row.storeOff, row.storeLen, SLOT_ROW);
    return r.toString("utf8", this.rp, this.rp + row.storeLen);
  }

  str(i: number): string | undefined {
    return i > 0 ? this.meta.strs[i - 1] : undefined;
  }

  fileId(row: DocRow): number {
    return this.meta.files[row.fileOrd] ?? -1;
  }

  /** The store bytes of a doc into `out` (merges). */
  storeBytes(off: number, len: number): Uint8Array {
    const r = this.read(S_STORE, off, len, SLOT_ROW);
    return r.subarray(this.rp, this.rp + len);
  }

  /** Verify the footer crc over the whole file (at first open, `index --verify`). */
  verify(): boolean {
    const total = this.size - 8; // the crc covers everything before the crc itself
    if (this.buf) return crc32(this.buf.subarray(0, total)) === this.crc;
    let acc = 0;
    for (let off = 0; off < total; ) {
      const len = Math.min(VERIFY_BUF.length, total - off);
      const n = readSync(this.fd, VERIFY_BUF, 0, len, off);
      if (n <= 0) return false;
      acc = crc32(VERIFY_BUF.subarray(0, n), acc);
      off += n;
    }
    return acc === this.crc;
  }
}

export function rowAt(r: Uint8Array, p: number): DocRow {
  return {
    at: readF64(r, p),
    offset: readF64(r, p + 8),
    storeOff: readF64(r, p + 16),
    storeLen: readU32(r, p + 24),
    fileOrd: readU32(r, p + 28),
    seq: readF64(r, p + 32),
    tool: readU32(r, p + 40),
    agent: readU32(r, p + 44),
    agentType: readU32(r, p + 48),
    sub: readU32(r, p + 52),
  };
}

export function writeRow(o: Sink, x: DocRow): void {
  o.f64(x.at);
  o.f64(x.offset);
  o.f64(x.storeOff);
  o.u32(x.storeLen);
  o.u32(x.fileOrd);
  o.f64(x.seq);
  o.u32(x.tool);
  o.u32(x.agent);
  o.u32(x.agentType);
  o.u32(x.sub);
}

function copy(b: Uint8Array): Uint8Array {
  const c = new Uint8Array(b.length);
  c.set(b);
  return c;
}

function u32s(b: Uint8Array, n: number): Uint32Array {
  if (b.length !== n * 4) throw new SegmentError("bad u32 section");
  const a = new Uint32Array(n);
  new Uint8Array(a.buffer).set(b);
  return a;
}
