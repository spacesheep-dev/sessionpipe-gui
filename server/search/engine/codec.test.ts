// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Codec vectors: varints, numbers, crc32, spilling and atomic writes.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareBytes, crc32, FileOut, Out, readF64, readU32, readV, utf8, writeFileAtomic } from "./codec.js";

describe("varint", () => {
  it("round-trips small and large integers up to 2^53", () => {
    const xs = [
      0,
      1,
      127,
      128,
      255,
      300,
      16383,
      16384,
      2 ** 31 - 1,
      2 ** 31,
      2 ** 32 - 1,
      2 ** 32,
      2 ** 40 + 7,
      Number.MAX_SAFE_INTEGER,
    ];
    const o = new Out(4);
    for (const x of xs) o.v(x);
    const c = { p: 0 };
    expect(xs.map(() => readV(o.view, c))).toEqual(xs);
    expect(c.p).toBe(o.n);
  });

  it("uses the expected byte lengths", () => {
    const len = (x: number) => {
      const o = new Out();
      o.v(x);
      return o.n;
    };
    expect([len(0), len(127), len(128), len(16383), len(16384), len(2 ** 32)]).toEqual([1, 1, 2, 2, 3, 5]);
  });
});

describe("numbers", () => {
  it("round-trips u32 and f64", () => {
    const o = new Out();
    o.u32(0xdeadbeef);
    o.f64(1730000000123.5);
    o.f64(Number.NaN);
    expect(readU32(o.view, 0)).toBe(0xdeadbeef);
    expect(readF64(o.view, 4)).toBe(1730000000123.5);
    expect(readF64(o.view, 12)).toBeNaN();
  });
});

describe("crc32", () => {
  it("matches the IEEE check value and chains", () => {
    expect(crc32(utf8.encode("123456789"))).toBe(0xcbf43926);
    const a = utf8.encode("hello ");
    const b = utf8.encode("world");
    expect(crc32(b, crc32(a))).toBe(crc32(utf8.encode("hello world")));
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("compareBytes", () => {
  it("orders like code points for BMP text", () => {
    const words = ["z", "a", "ab", "é", "検", "Z", "aa"];
    const byBytes = [...words].sort((x, y) => {
      const a = utf8.encode(x);
      const b = utf8.encode(y);
      return compareBytes(a, a.length, b, b.length);
    });
    expect(byBytes).toEqual([...words].sort());
  });
});

describe("FileOut and atomic writes", () => {
  it("spills to disk and keeps the total", () => {
    const dir = mkdtempSync(join(tmpdir(), "spe-codec-"));
    try {
      const f = new FileOut(join(dir, "x.bin"));
      const big = new Uint8Array(300_000).fill(7);
      for (let i = 0; i < 70_000; i++) f.v(i);
      f.bytes(big);
      f.u32(42);
      const n = f.n;
      f.close();
      const buf = readFileSync(join(dir, "x.bin"));
      expect(buf.length).toBe(n);
      const c = { p: 0 };
      for (let i = 0; i < 70_000; i++) expect(readV(buf, c)).toBe(i);
      expect(buf[c.p]).toBe(7);
      expect(readU32(buf, n - 4)).toBe(42);
      expect(statSync(join(dir, "x.bin")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes atomically with mode 0600 and leaves no temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "spe-codec-"));
    try {
      const p = join(dir, "MANIFEST");
      writeFileAtomic(p, "one");
      writeFileAtomic(p, "two");
      expect(readFileSync(p, "utf8")).toBe("two");
      expect(readdirSync(dir)).toEqual(["MANIFEST"]);
      expect(statSync(p).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
