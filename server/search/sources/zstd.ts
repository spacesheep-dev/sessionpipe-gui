// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. Codex compresses finished rollouts in place (`.jsonl.zst`; 88
// of 98 sessions on the census Mac exist only that way). SEARCH-SPEC.md D9: Node's own
// zstd when this Node has it, else the `zstd` command, else the file is skipped and
// counted in the index status. Decompression streams, so a large rollout is never whole
// in memory.
import { spawn } from "node:child_process";
import { accessSync, constants, createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { SourceEnv } from "../types.js";

export type ZstdWay = { kind: "zlib" } | { kind: "cli"; bin: string } | { kind: "none" };

/** Folders a launchd/systemd service PATH often lacks. */
const EXTRA_BIN = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

const cache = new Map<string, ZstdWay>();

/** How this process can read `.zst`. `SPGUI_SEARCH_ZSTD=zlib|cli|none` forces a way (tests). */
export function zstdWay(env: SourceEnv): ZstdWay {
  const force = env.env.SPGUI_SEARCH_ZSTD;
  const k = `${force ?? ""}\n${env.env.PATH ?? ""}`;
  const have = cache.get(k);
  if (have) return have;
  let way: ZstdWay = { kind: "none" };
  const z = zlib as unknown as { createZstdDecompress?: unknown };
  if ((force === undefined || force === "zlib") && typeof z.createZstdDecompress === "function") way = { kind: "zlib" };
  else if (force !== "none" && force !== "zlib") {
    const exe = env.platform === "win32" ? "zstd.exe" : "zstd";
    const dirs = [...(env.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...EXTRA_BIN];
    for (const d of dirs) {
      const p = path.join(d, exe);
      try {
        accessSync(p, constants.X_OK);
        way = { kind: "cli", bin: p };
        break;
      } catch {}
    }
  }
  cache.set(k, way);
  return way;
}

/** The decompressed bytes of `file`; throws (async) when the file cannot be decompressed. */
export async function* zstdChunks(file: string, way: ZstdWay, signal?: AbortSignal): AsyncGenerator<Buffer> {
  if (way.kind === "zlib") {
    const make = (zlib as unknown as { createZstdDecompress: () => NodeJS.ReadWriteStream }).createZstdDecompress;
    const src = createReadStream(file);
    const out = src.pipe(make());
    src.on("error", (e) => (out as unknown as { destroy: (e: Error) => void }).destroy(e));
    for await (const c of out as AsyncIterable<Buffer>) {
      if (signal?.aborted) break;
      yield c;
    }
    return;
  }
  if (way.kind !== "cli") throw new Error("no zstd");
  const child = spawn(way.bin, ["-dcq", "--", file], { stdio: ["ignore", "pipe", "ignore"] });
  const exit = new Promise<number>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
  let drained = false;
  try {
    for await (const c of child.stdout as AsyncIterable<Buffer>) {
      if (signal?.aborted) break;
      yield c;
    }
    drained = !signal?.aborted;
  } finally {
    // Only a reader that stopped early stops the command; a drained one exits on its own.
    if (!drained && child.exitCode === null) child.kill();
  }
  const code = await exit;
  if (code !== 0 && !signal?.aborted) throw new Error(`zstd exited ${code}`);
}

// ───────────── batching small files through one `zstd` process ─────────────
// Spawning the command costs ~3 ms a file; a home with a thousand small archived rollouts
// would spend seconds just starting processes. Small files are piped together through one
// `zstd -dc` (concatenated frames decode to concatenated output) and split again by the
// content size every zstd frame header declares (all 197 real rollouts and every file the
// `zstd` command writes carry it). A file whose size is not declared is read on its own.

/** Decompressed size of a zstd file from its frame headers, or undefined when any frame
 *  does not declare it (or the bytes are not zstd). Walks block headers only; decodes nothing. */
export function zstdContentSize(b: Buffer): number | undefined {
  let p = 0;
  let total = 0;
  while (p < b.length) {
    if (p + 4 > b.length) return undefined;
    const magic = b.readUInt32LE(p);
    if (magic >>> 4 === 0x184d2a5) {
      // A skippable frame: 4-byte magic, 4-byte size, data.
      if (p + 8 > b.length) return undefined;
      p += 8 + b.readUInt32LE(p + 4);
      continue;
    }
    if (magic !== 0xfd2fb528) return undefined;
    p += 4;
    const fhd = b[p++];
    if (fhd === undefined) return undefined;
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    if (!single) p += 1; // window descriptor
    p += [0, 1, 2, 4][fhd & 3] ?? 0; // dictionary id
    const fcsSize = fcsFlag === 0 ? (single ? 1 : 0) : ([0, 2, 4, 8][fcsFlag] ?? 0);
    if (fcsSize === 0 || p + fcsSize > b.length) return undefined;
    total +=
      fcsSize === 1
        ? (b[p] ?? 0)
        : fcsSize === 2
          ? b.readUInt16LE(p) + 256
          : fcsSize === 4
            ? b.readUInt32LE(p)
            : Number(b.readBigUInt64LE(p));
    p += fcsSize;
    for (;;) {
      if (p + 3 > b.length) return undefined;
      const bh = (b[p] ?? 0) | ((b[p + 1] ?? 0) << 8) | ((b[p + 2] ?? 0) << 16);
      p += 3;
      const type = (bh >> 1) & 3;
      if (type === 3) return undefined;
      p += type === 1 ? 1 : bh >>> 3; // an RLE block stores one byte
      if (bh & 1) break;
    }
    if (checksum) p += 4;
  }
  return p === b.length ? total : undefined;
}

/** Decompress concatenated frames in one process; undefined unless exactly `sizes` came out. */
function runBatch(bin: string, inputs: Buffer[], sizes: number[]): Promise<Buffer[] | undefined> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-dcq"], { stdio: ["pipe", "pipe", "ignore"] });
    const out: Buffer[] = [];
    let got = 0;
    const want = sizes.reduce((a, b) => a + b, 0);
    child.stdout.on("data", (c: Buffer) => {
      out.push(c);
      got += c.length;
      if (got > want) child.kill();
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0 || got !== want) return resolve(undefined);
      const all = Buffer.concat(out, got);
      const parts: Buffer[] = [];
      let at = 0;
      for (const n of sizes) {
        parts.push(all.subarray(at, at + n));
        at += n;
      }
      resolve(parts);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.concat(inputs));
  });
}

interface Planned {
  path: string;
  size: number;
  mtimeMs: number;
}

/** A file read as a whole is at most this big (compressed) to be batched or held decoded. */
const SMALL = 1 << 20;
const BATCH_MAX = 128;
const BATCH_IN = 8 << 20;
const HOLD_MAX = 48 << 20;
const HOLD_MS = 60_000;

/**
 * Hands out whole small `.zst` files decoded, prefetching the next files of the plan (the
 * discover list, newest first, the order a first build reads in) in one `zstd` process.
 * The batch grows only while reads follow the plan (×2 per sequential read, up to 128) and
 * falls back to one file on a miss, so an incremental pass that reads one new archive
 * never decodes files nobody asked for.
 */
export class ZstdBatcher {
  /** The orders a build may read in: newest first (the engine's first build), and the
   *  discover order (a plain loop over the list). */
  private orders: Planned[][] = [];
  private index: Map<string, number>[] = [];
  private held = new Map<string, { data: Buffer; size: number; mtimeMs: number; at: number }>();
  private heldBytes = 0;
  private batch = 1;
  private lastPath = "";
  private mode = 0;
  private dir = 1;
  /** Files served from a prefetch, and processes started (for tests and the bench). */
  stats = { hits: 0, runs: 0 };

  setPlan(files: Planned[]): void {
    const small = files.filter((f) => f.size <= SMALL);
    const newest = [...small].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
    this.orders = [newest, small];
    this.index = this.orders.map((o) => new Map(o.map((f, i) => [f.path, i])));
  }

  /** The decoded bytes, or undefined: read this one by streaming instead. */
  async whole(file: Planned, way: ZstdWay): Promise<Buffer | undefined> {
    if (way.kind !== "cli" || file.size > SMALL) return undefined;
    this.expire();
    const prev = this.lastPath;
    this.lastPath = file.path;
    const h = this.held.get(file.path);
    if (h) {
      this.held.delete(file.path);
      this.heldBytes -= h.data.length;
      if (h.size === file.size && h.mtimeMs === file.mtimeMs) {
        this.stats.hits++;
        this.batch = Math.min(this.batch * 2, BATCH_MAX);
        return h.data;
      }
    }
    // A miss: keep growing only while the reads walk one of the orders.
    let walking = false;
    for (let m = 0; m < this.orders.length && prev; m++) {
      const i = this.index[m]!.get(file.path);
      const j = this.index[m]!.get(prev);
      if (i !== undefined && j !== undefined && Math.abs(i - j) === 1) {
        this.mode = m;
        this.dir = i > j ? 1 : -1;
        walking = true;
        break;
      }
    }
    this.batch = walking ? Math.min(this.batch * 2, BATCH_MAX) : 1;
    const order = this.orders[this.mode] ?? [];
    const i = this.index[this.mode]?.get(file.path) ?? -1;
    const group: { f: Planned; bytes: Buffer; size: number }[] = [];
    let inBytes = 0;
    let outBytes = 0;
    const take = (f: Planned): boolean => {
      let bytes: Buffer;
      try {
        bytes = readFileSync(f.path);
      } catch {
        return false;
      }
      const size = zstdContentSize(bytes);
      if (size === undefined || (group.length && outBytes + size > HOLD_MAX)) return false;
      group.push({ f, bytes, size });
      inBytes += bytes.length;
      outBytes += size;
      return true;
    };
    if (!take(file)) return undefined;
    for (let k = 1; i >= 0 && group.length < this.batch && inBytes < BATCH_IN; k++) {
      const next = order[i + this.dir * k];
      if (!next) break;
      if (this.held.has(next.path)) continue;
      take(next);
    }
    this.stats.runs++;
    const parts = await runBatch(
      way.bin,
      group.map((g) => g.bytes),
      group.map((g) => g.size),
    );
    if (!parts) return undefined; // the caller reads it alone and reports what went wrong
    const now = Date.now();
    for (let k = 1; k < group.length; k++) {
      const g = group[k]!;
      const data = parts[k]!;
      this.held.set(g.f.path, { data, size: g.f.size, mtimeMs: g.f.mtimeMs, at: now });
      this.heldBytes += data.length;
    }
    return parts[0];
  }

  private expire(): void {
    if (!this.held.size) return;
    const now = Date.now();
    for (const [p, h] of this.held)
      if (now - h.at > HOLD_MS || this.heldBytes > HOLD_MAX) {
        this.held.delete(p);
        this.heldBytes -= h.data.length;
      }
  }
}
