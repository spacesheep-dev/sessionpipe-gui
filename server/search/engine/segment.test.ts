// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Builder → Segment round trip, and merges that keep every posting.
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Builder } from "./builder.js";
import { mergeSegments } from "./merge.js";
import { type DictEntry, Segment } from "./segment.js";
import { randomDocs } from "./testkit.js";
import { tokenize } from "./tokenize.js";

const dir = mkdtempSync(join(tmpdir(), "spe-seg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** term → doc → positions, straight from the tokenizer. */
function truth(texts: string[]): Map<string, Map<number, number[]>> {
  const m = new Map<string, Map<number, number[]>>();
  texts.forEach((t, d) => {
    tokenize(t, (term, pos) => {
      let x = m.get(term);
      if (!x) {
        x = new Map();
        m.set(term, x);
      }
      let p = x.get(d);
      if (!p) {
        p = [];
        x.set(d, p);
      }
      p.push(pos);
    });
  });
  return m;
}

function postings(seg: Segment, term: string): Map<number, number[]> | null {
  const e: DictEntry = { df: 0, po: 0, pl: 0, xo: 0, xl: 0 };
  if (!seg.lookup(term, e)) return null;
  const D = new Uint32Array(e.df);
  const F = new Uint32Array(e.df);
  const PS = new Uint32Array(e.df + 1);
  const POS = new Uint32Array(e.xl + 1);
  const n = seg.decodePos(e, D, F, PS, POS);
  const out = new Map<number, number[]>();
  for (let i = 0; i < n; i++) out.set(D[i]!, [...POS.subarray(PS[i]!, PS[i + 1]!)]);
  return out;
}

describe("Builder → Segment", () => {
  const { docs, facts } = randomDocs(7, 1500, 40);
  const b = new Builder();
  for (const f of facts) b.facts(f);
  for (const d of docs) b.add(d, d.file);
  const r = b.encode();
  const seg = new Segment(r.buffer!);

  it("keeps every term's postings and positions", () => {
    const t = truth(docs.map((d) => d.text));
    expect(seg.termCount).toBe(t.size);
    for (const [term, want] of t) expect(postings(seg, term)).toEqual(want);
    expect(postings(seg, "nope-not-a-term")).toBeNull();
  });

  it("keeps rows, text, sessions and strings", () => {
    expect(seg.N).toBe(docs.length);
    for (const i of [0, 1, 500, 1499]) {
      const row = seg.row(i);
      expect(seg.text(row)).toBe(docs[i]!.text);
      expect(row.at).toBe(docs[i]!.at);
      expect(row.offset).toBe(docs[i]!.offset);
      expect(seg.fileId(row)).toBe(docs[i]!.file);
      expect(seg.str(row.tool)).toBe(docs[i]!.tool);
      expect(seg.str(row.agent)).toBe(docs[i]!.agent);
      expect(seg.meta.sessions[seg.dsess[i]!]!.key).toBe(docs[i]!.key);
    }
    const titled = seg.meta.sessions.filter((s) => s.facts.title);
    expect(titled.length).toBeGreaterThan(0);
  });

  it("enumerates prefixes in order and stops past them", () => {
    const got: string[] = [];
    seg.prefix("re", (bytes, len) => {
      got.push(Buffer.from(bytes.subarray(0, len)).toString("utf8"));
      return true;
    });
    const want = [...truth(docs.map((d) => d.text)).keys()].filter((t) => t.startsWith("re")).sort();
    expect(got).toEqual(want);
  });

  it("writes to a file with a footer crc that verifies", () => {
    const b2 = new Builder();
    for (const d of docs.slice(0, 300)) b2.add(d, d.file);
    const p = join(dir, "seg-1.sps");
    b2.encode(`${p}.tmp`);
    renameSync(`${p}.tmp`, p);
    const s = new Segment(p);
    expect(s.verify()).toBe(true);
    expect(s.text(s.row(299))).toBe(docs[299]!.text);
    s.close();
  });
});

describe("mergeSegments", () => {
  it("equals one segment built from the live docs, tombstones dropped", async () => {
    const { docs, facts } = randomDocs(11, 2400, 50);
    const parts = [docs.slice(0, 700), docs.slice(700, 1500), docs.slice(1500)];
    const segs = parts.map((p, i) => {
      const b = new Builder();
      if (i === 0) for (const f of facts) b.facts(f);
      for (const d of p) b.add(d, d.file);
      const name = join(dir, `m-${i}.sps`);
      b.encode(`${name}.tmp`);
      renameSync(`${name}.tmp`, name);
      return new Segment(name);
    });
    // tombstone every 7th doc of the middle segment
    const bits = new Uint8Array(Math.ceil(segs[1]!.N / 8));
    for (let d = 0; d < segs[1]!.N; d += 7) bits[d >> 3]! |= 1 << (d & 7);
    segs[1]!.setDeleted(bits);
    const liveDocs = docs.filter((_, i) => !(i >= 700 && i < 1500 && (i - 700) % 7 === 0));
    const out = join(dir, "merged.sps");
    const r = await mergeSegments(segs, `${out}.tmp`);
    renameSync(`${out}.tmp`, out);
    const m = new Segment(out);
    expect(m.verify()).toBe(true);
    expect(r.docs).toBe(liveDocs.length);
    expect(m.N).toBe(liveDocs.length);
    const t = truth(liveDocs.map((d) => d.text));
    expect(m.termCount).toBe(t.size);
    for (const [term, want] of t) expect(postings(m, term)).toEqual(want);
    for (const i of [0, 699, 700, liveDocs.length - 1]) {
      const row = m.row(i);
      expect(m.text(row)).toBe(liveDocs[i]!.text);
      expect(m.fileId(row)).toBe(liveDocs[i]!.file);
      expect(m.str(row.agentType)).toBe(liveDocs[i]!.agentType);
      expect(m.meta.sessions[m.dsess[i]!]!.key).toBe(liveDocs[i]!.key);
    }
    const sessDocs = new Map<string, number>();
    for (const d of liveDocs) sessDocs.set(d.key, (sessDocs.get(d.key) ?? 0) + 1);
    for (const s of m.meta.sessions) expect(s.docs).toBe(sessDocs.get(s.key) ?? 0);
    for (const s of segs) s.close();
    m.close();
  });
});
