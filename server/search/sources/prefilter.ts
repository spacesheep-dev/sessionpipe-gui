// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. Byte-level line reading for the history adapters: complete
// lines only, from a byte offset, in reused 1 MB chunks, with an allow-list test on the
// raw bytes before any line is decoded or parsed (sources.md §6). A real key appears
// unescaped in a JSON line (`"type":"user"`); inside a JSON string the same bytes read
// `\"type\":\"user\"`, so these tests never match a person's own text.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Bytes read at a time. */
export const CHUNK = 1 << 20;
/** A line longer than this is skipped and counted as bad (never held whole). */
export const LINE_MAX = 64 << 20;

/** A line handler: `buf[start, end)` is the line without its newline; `at` is the byte
 *  offset of its first byte in the file (append files) or its ordinal (whole files);
 *  `gen` changes whenever `buf` holds new bytes (a Finder's cache key). */
export type OnLine = (buf: Buffer, start: number, end: number, at: number, gen: number) => void;

/**
 * "Does this line contain the pattern?" in amortised linear time. A naive
 * `buf.indexOf(p, start)` per line runs past the line's end to the next hit, which is
 * quadratic on a chunk with few hits; a Finder remembers where the next hit in the
 * current chunk is and only searches again once the lines have passed it.
 */
export class Finder {
  readonly pat: Buffer;
  private gen = -1;
  private next = -1;
  constructor(pattern: string) {
    this.pat = Buffer.from(pattern, "latin1");
  }
  /** The first hit in `[start, end)` of the chunk generation `gen`, or -1. */
  at(buf: Buffer, gen: number, start: number, end: number): number {
    if (gen !== this.gen || (this.next >= 0 && this.next < start)) {
      this.gen = gen;
      this.next = buf.indexOf(this.pat, start);
      // -1 means "none until the chunk ends": no search again in this chunk.
      if (this.next < 0) this.next = Number.MAX_SAFE_INTEGER;
    }
    return this.next < end ? this.next : -1;
  }
  has(buf: Buffer, gen: number, start: number, end: number): boolean {
    return this.at(buf, gen, start, end) >= 0;
  }
}

/** Does `buf[start…]` begin with `prefix`? */
export function startsWith(buf: Buffer, start: number, end: number, prefix: Buffer): boolean {
  if (end - start < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[start + i] !== prefix[i]) return false;
  return true;
}

/**
 * Splits pushed chunks into lines and calls `onLine` for each complete one, straight
 * from the chunk when the line lies inside it (no copy), joined only across a chunk edge.
 * `gen` changes with every chunk so Finders know their cache is stale.
 */
export class LineSplitter {
  gen = 0;
  /** File position of the next pushed byte. */
  private pos: number;
  /** Byte after the last newline seen: the offset a read may return. */
  consumed: number;
  /** Lines seen (complete ones, empty lines included). */
  lines = 0;
  bad = 0;
  private carry: Buffer[] = [];
  private carryLen = 0;
  private skipping = false;
  constructor(
    from: number,
    private readonly onLine: OnLine,
    private readonly ordinal = false,
  ) {
    this.pos = from;
    this.consumed = from;
  }

  push(chunk: Buffer, reused: boolean): void {
    this.gen++;
    const n = chunk.length;
    let from = 0;
    if (this.carryLen || this.skipping) {
      const nl = chunk.indexOf(10);
      if (nl < 0) {
        this.hold(chunk, 0, n, reused);
        this.pos += n;
        return;
      }
      const lineStart = this.consumed;
      if (this.skipping) {
        this.skipping = false;
        this.bad++;
      } else {
        this.carry.push(chunk.subarray(0, nl));
        const line = Buffer.concat(this.carry, this.carryLen + nl);
        this.gen++;
        this.emit(line, 0, line.length, lineStart);
        this.gen++;
      }
      this.carry = [];
      this.carryLen = 0;
      this.lines++;
      from = nl + 1;
      this.consumed = this.pos + from;
    }
    for (;;) {
      const nl = chunk.indexOf(10, from);
      if (nl < 0) break;
      this.emit(chunk, from, nl, this.pos + from);
      this.lines++;
      from = nl + 1;
    }
    this.consumed = this.pos + from;
    if (from < n) this.hold(chunk, from, n, reused);
    this.pos += n;
  }

  /** The source ended: a whole file's last line without a newline still counts. */
  end(): void {
    if (this.carryLen && !this.skipping) {
      const line = Buffer.concat(this.carry, this.carryLen);
      this.gen++;
      this.emit(line, 0, line.length, this.consumed);
      this.lines++;
    } else if (this.skipping) this.bad++;
    this.carry = [];
    this.carryLen = 0;
    this.skipping = false;
    this.consumed = this.pos;
  }

  private emit(buf: Buffer, s: number, e: number, at: number): void {
    if (e > s) this.onLine(buf, s, e, this.ordinal ? this.lines : at, this.gen);
  }

  private hold(chunk: Buffer, s: number, e: number, reused: boolean): void {
    if (this.skipping) return;
    if (this.carryLen + (e - s) > LINE_MAX) {
      this.carry = [];
      this.carryLen = 0;
      this.skipping = true;
      return;
    }
    // A reused read buffer is overwritten by the next read: keep a copy.
    this.carry.push(reused ? Buffer.from(chunk.subarray(s, e)) : chunk.subarray(s, e));
    this.carryLen += e - s;
  }
}

let shared: Buffer | undefined;

export interface AppendRead {
  /** The byte after the last complete line consumed. */
  offset: number;
  bad: number;
  /** Bytes the file held when the read began (or the end offset asked for). */
  limit: number;
}

/**
 * Reads complete lines of an append-only file from `from` up to its current size (or
 * `endOffset`), stopping once about `maxBytes` were read. A last line without a newline
 * is left for the next read. Synchronous: every line has been handed to `onLine` when it
 * returns, which the live tail relies on.
 */
export function readAppend(
  file: string,
  from: number,
  onLine: OnLine,
  opts: { endOffset?: number; maxBytes?: number; signal?: AbortSignal } = {},
): AppendRead {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const limit = Math.min(size, opts.endOffset ?? size);
    if (from >= limit) return { offset: Math.min(from, size), bad: 0, limit };
    const split = new LineSplitter(from, onLine);
    const buf = shared ?? Buffer.allocUnsafe(CHUNK);
    shared = undefined; // re-entrancy: a nested read gets its own buffer
    try {
      let pos = from;
      const stopAt = opts.maxBytes ? from + Math.max(opts.maxBytes, 1) : Number.POSITIVE_INFINITY;
      while (pos < limit) {
        if (opts.signal?.aborted) break;
        const want = Math.min(CHUNK, limit - pos);
        const n = readSync(fd, buf, 0, want, pos);
        if (n <= 0) break;
        split.push(n === buf.length ? buf : buf.subarray(0, n), true);
        pos += n;
        if (pos >= stopAt && split.consumed > from) break;
      }
    } finally {
      shared = buf;
    }
    return { offset: split.consumed, bad: split.bad, limit };
  } finally {
    closeSync(fd);
  }
}

/** Reads a whole stream (a decompressed `.zst`) line by line; `at` is the line ordinal. */
export async function readStreamLines(
  stream: AsyncIterable<Buffer | string>,
  onLine: OnLine,
  signal?: AbortSignal,
): Promise<{ records: number; bad: number }> {
  const split = new LineSplitter(0, onLine, true);
  for await (const chunk of stream) {
    if (signal?.aborted) break;
    split.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk, false);
  }
  split.end();
  return { records: split.lines, bad: split.bad };
}

/** Parse one line as a JSON object, or null (counted by the caller as bad). */
export function parseLine(buf: Buffer, s: number, e: number): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(buf.toString("utf8", s, e));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
