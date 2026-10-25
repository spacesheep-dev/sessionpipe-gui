// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Bytes: growable output buffers (in RAM, or spilling to a file
// every 256 KB so memory stays flat), varints, little-endian numbers, a table crc32 (Node 20
// has no zlib.crc32) and the atomic, fsynced, 0600 file writes the index is built from.
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import zlib from "node:zlib";

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/** A byte sink: `Out` (RAM) and `FileOut` (spills to a file) share it. */
export interface Sink {
  /** Bytes written so far. */
  readonly n: number;
  v(x: number): void;
  u8(x: number): void;
  u32(x: number): void;
  f64(x: number): void;
  bytes(a: Uint8Array): void;
}

const f64buf = new Float64Array(1);
const f64bytes = new Uint8Array(f64buf.buffer);

/** A growable byte buffer. */
export class Out implements Sink {
  b: Uint8Array;
  n = 0;
  constructor(hint = 1 << 12) {
    this.b = new Uint8Array(Math.max(16, hint));
  }
  grow(k: number): void {
    if (this.n + k <= this.b.length) return;
    let m = this.b.length * 2;
    while (m < this.n + k) m *= 2;
    const nb = new Uint8Array(m);
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  }
  v(x: number): void {
    if (this.n + 10 > this.b.length) this.grow(10);
    const b = this.b;
    while (x >= 128) {
      b[this.n++] = (x & 127) | 128;
      x = x >= 0x80000000 ? Math.floor(x / 128) : x >>> 7;
    }
    b[this.n++] = x;
  }
  u8(x: number): void {
    if (this.n + 1 > this.b.length) this.grow(1);
    this.b[this.n++] = x;
  }
  u32(x: number): void {
    if (this.n + 4 > this.b.length) this.grow(4);
    const b = this.b;
    b[this.n++] = x;
    b[this.n++] = x >>> 8;
    b[this.n++] = x >>> 16;
    b[this.n++] = x >>> 24;
  }
  f64(x: number): void {
    if (this.n + 8 > this.b.length) this.grow(8);
    f64buf[0] = x;
    this.b.set(f64bytes, this.n);
    this.n += 8;
  }
  bytes(a: Uint8Array): void {
    if (this.n + a.length > this.b.length) this.grow(a.length);
    this.b.set(a, this.n);
    this.n += a.length;
  }
  /** Drops the contents, keeps the memory. */
  clear(): void {
    this.n = 0;
  }
  get view(): Uint8Array {
    return this.b.subarray(0, this.n);
  }
}

const SPILL = 1 << 18;

/** A byte sink that writes to `file` every 256 KB: `n` is the total, memory stays flat. */
export class FileOut implements Sink {
  readonly fd: number;
  private b = new Uint8Array(SPILL);
  private k = 0;
  private base = 0;
  private closed = false;
  constructor(readonly file: string) {
    this.fd = openSync(file, "w", FILE_MODE);
  }
  get n(): number {
    return this.base + this.k;
  }
  spill(): void {
    if (this.k) {
      let w = 0;
      while (w < this.k) w += writeSync(this.fd, this.b, w, this.k - w);
      this.base += this.k;
      this.k = 0;
    }
  }
  v(x: number): void {
    if (this.k + 10 > SPILL) this.spill();
    const b = this.b;
    while (x >= 128) {
      b[this.k++] = (x & 127) | 128;
      x = x >= 0x80000000 ? Math.floor(x / 128) : x >>> 7;
    }
    b[this.k++] = x;
  }
  u8(x: number): void {
    if (this.k + 1 > SPILL) this.spill();
    this.b[this.k++] = x;
  }
  u32(x: number): void {
    if (this.k + 4 > SPILL) this.spill();
    const b = this.b;
    b[this.k++] = x;
    b[this.k++] = x >>> 8;
    b[this.k++] = x >>> 16;
    b[this.k++] = x >>> 24;
  }
  f64(x: number): void {
    if (this.k + 8 > SPILL) this.spill();
    f64buf[0] = x;
    this.b.set(f64bytes, this.k);
    this.k += 8;
  }
  bytes(a: Uint8Array): void {
    if (this.k + a.length > SPILL) {
      this.spill();
      if (a.length > SPILL) {
        let w = 0;
        while (w < a.length) w += writeSync(this.fd, a, w, a.length - w);
        this.base += a.length;
        return;
      }
    }
    this.b.set(a, this.k);
    this.k += a.length;
  }
  /** Flush, fsync and close. */
  close(sync = true): void {
    if (this.closed) return;
    this.spill();
    if (sync) fsyncSync(this.fd);
    closeSync(this.fd);
    this.closed = true;
  }
}

/** A read cursor for varints (one per call site; never allocate one per posting). */
export interface Cursor {
  p: number;
}

/** Reads a varint at `c.p` and advances it. */
export function readV(b: Uint8Array, c: Cursor): number {
  let p = c.p;
  let x = b[p++]!;
  if (x < 128) {
    c.p = p;
    return x;
  }
  x &= 127;
  let m = 128;
  for (;;) {
    const k = b[p++]!;
    x += (k & 127) * m;
    if (k < 128) break;
    m *= 128;
  }
  c.p = p;
  return x;
}

export function readU32(b: Uint8Array, p: number): number {
  return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
}

export function readF64(b: Uint8Array, p: number): number {
  for (let i = 0; i < 8; i++) f64bytes[i] = b[p + i]!;
  return f64buf[0]!;
}

// ───────────────────────────── crc32 (IEEE, table-driven) ─────────────────────────────

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const nativeCrc = (zlib as unknown as { crc32?: (b: Uint8Array, prev?: number) => number }).crc32;

/** crc32 of `b`, continuing from `prev` (pass the previous result to chain chunks). Node's
 *  zlib.crc32 when this Node has it (≥ 22.2), else the table. */
export function crc32(b: Uint8Array, prev = 0): number {
  if (nativeCrc && b.length > 64) return nativeCrc(b, prev) >>> 0;
  return crc32Table(b, prev);
}

export function crc32Table(b: Uint8Array, prev = 0): number {
  let c = ~prev >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

// ───────────────────────────── text ─────────────────────────────

export const utf8 = new TextEncoder();
export const utf8d = new TextDecoder();

/** Byte order of two UTF-8 encoded terms (= code point order = the dictionary's order). */
export function compareBytes(a: Uint8Array, al: number, b: Uint8Array, bl: number): number {
  const n = al < bl ? al : bl;
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d) return d;
  }
  return al - bl;
}

// ───────────────────────────── durable files ─────────────────────────────

/** fsync a directory so a rename in it is durable (no-op where directories can't be opened). */
export function fsyncDir(dir: string): void {
  let fd = -1;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Windows cannot open a directory; its renames are durable enough for a rebuildable index.
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** Write `data` to `path` atomically: tmp → fsync → rename → fsync(dir). Mode 0600. */
export function writeFileAtomic(path: string, data: Uint8Array | string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", FILE_MODE);
  try {
    const buf = typeof data === "string" ? utf8.encode(data) : data;
    let w = 0;
    while (w < buf.length) w += writeSync(fd, buf, w, buf.length - w);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}
