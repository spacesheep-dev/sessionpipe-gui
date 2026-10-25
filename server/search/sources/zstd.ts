// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. Codex compresses finished rollouts in place (`.jsonl.zst`; 88
// of 98 sessions on the census Mac exist only that way). SEARCH-SPEC.md D9: Node's own
// zstd when this Node has it, else the `zstd` command, else the file is skipped and
// counted in the index status. Decompression streams, so a large rollout is never whole
// in memory.
import { spawn } from "node:child_process";
import { accessSync, constants, createReadStream } from "node:fs";
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
