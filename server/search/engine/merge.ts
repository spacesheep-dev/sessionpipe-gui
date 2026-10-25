// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The streaming k-way merge of segments (arch-engine.md §7): walk the
// sorted dictionaries together, re-encode each term's postings with remapped doc ids (deleted
// docs dropped), copy positions, rows and stored text, fold the session facts in segment
// order. Memory is one term's postings plus 256 KB write buffers; the big streams go through
// temp files. It yields every few ms so the in-process indexer never blocks the server.
import { unlinkSync } from "node:fs";
import { FileOut, readF64, readU32, readV, type Sink } from "./codec.js";
import { cloneFacts, type Facts, foldFacts, headFacts } from "./facts.js";
import {
  copyFileInto,
  FIELD_CODES,
  LEN,
  ROW,
  S_DICT,
  type Segment,
  type SegSession,
  SegWriter,
  writeRow,
} from "./segment.js";

/** A cursor over one segment's dictionary. */
class DictIter {
  private dict: Uint8Array;
  private c = { p: 0 };
  term = new Uint8Array(512);
  len = 0;
  df = 0;
  po = 0;
  pl = 0;
  xo = 0;
  xl = 0;
  done = false;
  constructor(seg: Segment) {
    this.dict = seg.section(S_DICT);
    this.next();
  }
  next(): void {
    const d = this.dict;
    const c = this.c;
    if (c.p >= d.length) {
      this.done = true;
      return;
    }
    const shared = readV(d, c);
    const suf = readV(d, c);
    if (this.term.length < shared + suf) {
      const t = new Uint8Array((shared + suf) * 2);
      t.set(this.term.subarray(0, this.len));
      this.term = t;
    }
    this.term.set(d.subarray(c.p, c.p + suf), shared);
    c.p += suf;
    this.len = shared + suf;
    this.df = readV(d, c);
    this.po = readV(d, c);
    this.pl = readV(d, c);
    this.xo = readV(d, c);
    this.xl = readV(d, c);
  }
}

function cmp(a: DictIter, b: DictIter): number {
  const n = Math.min(a.len, b.len);
  for (let i = 0; i < n; i++) {
    const d = a.term[i]! - b.term[i]!;
    if (d) return d;
  }
  return a.len - b.len;
}

export interface MergeResult {
  bytes: number;
  crc: number;
  docs: number;
}

const grow = (a: Uint32Array, n: number): Uint32Array<ArrayBuffer> =>
  a.length >= n ? (a as Uint32Array<ArrayBuffer>) : new Uint32Array(Math.max(n, a.length * 2));

/** Merge `inputs` (in commit order) into the file `dest` (fsynced; the caller renames it). */
export async function mergeSegments(
  inputs: Segment[],
  dest: string,
  pause: () => Promise<void> = async () => {},
  /** File ids still named in the manifest: facts of other files are dropped. */
  liveFiles?: ReadonlySet<number>,
): Promise<MergeResult> {
  // doc remap, session remap, file and string tables
  const remap: Int32Array[] = [];
  let N = 0;
  const sessIdx = new Map<string, number>();
  const sessions: SegSession[] = [];
  const sessRemap: Int32Array[] = [];
  const ffs: Map<number, Facts>[] = [];
  const fileIdx = new Map<number, number>();
  const files: number[] = [];
  const strIdx = new Map<string, number>();
  const strs: string[] = [];
  const fileRemap: Int32Array[] = [];
  const strRemap: Int32Array[] = [];
  for (const s of inputs) {
    const m = new Int32Array(s.N);
    const liveBySess = new Uint32Array(s.meta.sessions.length);
    for (let d = 0; d < s.N; d++) {
      if (s.isDeleted(d)) m[d] = -1;
      else {
        m[d] = N++;
        liveBySess[s.dsess[d]!]!++;
      }
    }
    remap.push(m);
    const sm = new Int32Array(s.meta.sessions.length).fill(-1);
    s.meta.sessions.forEach((ss, i) => {
      // keep a session with live docs, or one that only ever had facts
      if (liveBySess[i] === 0 && ss.docs > 0) return;
      let j = sessIdx.get(ss.key);
      if (j === undefined) {
        j = sessions.length;
        sessions.push({ key: ss.key, docs: 0, facts: cloneFacts(ss.facts) });
        ffs.push(new Map());
        sessIdx.set(ss.key, j);
      } else foldFacts(sessions[j]!.facts as Facts, ss.facts);
      const fm = ffs[j]!;
      for (const [fid, f] of ss.ff ?? [[-1, ss.facts] as [number, Facts]]) {
        if (fid >= 0 && liveFiles && !liveFiles.has(fid)) continue;
        const cur = fm.get(fid);
        if (cur) foldFacts(cur, f);
        else fm.set(fid, cloneFacts(f));
      }
      sessions[j]!.docs += liveBySess[i]!;
      sm[i] = j;
    });
    sessRemap.push(sm);
    const fm = new Int32Array(s.meta.files.length);
    s.meta.files.forEach((id, i) => {
      let j = fileIdx.get(id);
      if (j === undefined) {
        j = files.length;
        files.push(id);
        fileIdx.set(id, j);
      }
      fm[i] = j;
    });
    fileRemap.push(fm);
    const tm = new Int32Array(s.meta.strs.length + 1);
    s.meta.strs.forEach((str, i) => {
      let j = strIdx.get(str);
      if (j === undefined) {
        strs.push(str);
        j = strs.length;
        strIdx.set(str, j);
      }
      tm[i + 1] = j;
    });
    strRemap.push(tm);
  }

  const w = new SegWriter(1 << 20, `${dest}.w`);
  const rowsOut = new FileOut(`${dest}.rows.tmp`);
  const storeOut = new FileOut(`${dest}.store.tmp`);
  try {
    // ── terms ──
    const its = inputs.map((s) => new DictIter(s));
    let D = new Uint32Array(1 << 12);
    let F = new Uint32Array(1 << 12);
    let PS = new Uint32Array(1 << 12);
    let POS = new Uint32Array(1 << 12);
    let lastPause = performance.now();
    let steps = 0;
    for (;;) {
      let min: DictIter | null = null;
      for (const it of its) if (!it.done && (!min || cmp(it, min) < 0)) min = it;
      if (!min) break;
      const term = min.term.slice(0, min.len);
      let started = false;
      for (let k = 0; k < its.length; k++) {
        const it = its[k]!;
        if (it.done || it.len !== term.length) continue;
        let same = true;
        for (let i = 0; i < term.length && same; i++) if (it.term[i] !== term[i]) same = false;
        if (!same) continue;
        const e = { df: it.df, po: it.po, pl: it.pl, xo: it.xo, xl: it.xl };
        D = grow(D, e.df);
        F = grow(F, e.df);
        PS = grow(PS, e.df + 1);
        POS = grow(POS, e.xl + 1);
        const n = inputs[k]!.decodePos(e, D, F, PS, POS);
        const m = remap[k]!;
        for (let i = 0; i < n; i++) {
          const nd = m[D[i]!]!;
          if (nd < 0) continue;
          if (!started) {
            w.begin(term);
            started = true;
          }
          w.add(nd, POS, PS[i]!, PS[i + 1]!);
        }
        it.next();
      }
      if (started) w.end();
      if (++steps % 256 === 0 && performance.now() - lastPause > 8) {
        await pause();
        lastPause = performance.now();
      }
    }

    // ── docs, norms, sessions, text ──
    const fc = new Uint8Array(N);
    const lc = new Uint8Array(N);
    const dsess = new Uint32Array(N);
    const ats = new Uint32Array(N);
    const flen = new Array<number>(FIELD_CODES).fill(0);
    const fcnt = new Array<number>(FIELD_CODES).fill(0);
    let textBytes = 0;
    for (let k = 0; k < inputs.length; k++) {
      const s = inputs[k]!;
      const m = remap[k]!;
      const chunk = 4096;
      for (let from = 0; from < s.N; from += chunk) {
        const to = Math.min(s.N, from + chunk);
        const rows = s.rows(from, to);
        for (let d = from; d < to; d++) {
          const nd = m[d]!;
          if (nd < 0) continue;
          const p = (d - from) * ROW;
          const storeOff = readF64(rows, p + 16);
          const storeLen = readU32(rows, p + 24);
          const off = storeOut.n;
          if (storeLen) storeOut.bytes(s.storeBytes(storeOff, storeLen));
          textBytes += storeLen;
          writeRow(rowsOut, {
            at: readF64(rows, p),
            offset: readF64(rows, p + 8),
            storeOff: off,
            storeLen,
            fileOrd: fileRemap[k]![readU32(rows, p + 28)]!,
            seq: readF64(rows, p + 32),
            tool: strRemap[k]![readU32(rows, p + 40)] ?? 0,
            agent: strRemap[k]![readU32(rows, p + 44)] ?? 0,
            agentType: strRemap[k]![readU32(rows, p + 48)] ?? 0,
            sub: readU32(rows, p + 52),
          });
          fc[nd] = s.fc[d]!;
          lc[nd] = s.lc[d]!;
          dsess[nd] = sessRemap[k]![s.dsess[d]!]!;
          ats[nd] = s.ats[d]!;
          flen[s.fc[d]!]! += LEN[s.lc[d]!]!;
          fcnt[s.fc[d]!]!++;
        }
        if (performance.now() - lastPause > 8) {
          await pause();
          lastPause = performance.now();
        }
      }
    }
    rowsOut.close(false);
    storeOut.close(false);
    const r = w.finish(
      {
        N,
        fc,
        lc,
        docs: (o: Sink) => copyFileInto(rowsOut.file, o, true),
        store: (o: Sink) => copyFileInto(storeOut.file, o, true),
        dsess,
        ats,
        meta: {
          N,
          flen,
          fcnt,
          sessions: sessions.map((x, i) => ({ key: x.key, docs: x.docs, facts: headFacts(x.facts), ff: [...ffs[i]!] })),
          files,
          strs,
          textBytes,
        },
      },
      dest,
    );
    return { bytes: r.bytes, crc: r.crc, docs: N };
  } catch (e) {
    w.abandon();
    for (const f of [rowsOut, storeOut]) {
      try {
        f.close(false);
      } catch {}
      try {
        unlinkSync(f.file);
      } catch {}
    }
    throw e;
  }
}
