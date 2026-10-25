// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The engine's public module (SEARCH-SPEC §3.2): the only file the
// service, the CLI and the bench import from engine/.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ReaderOptions, SearchReader, SearchSource } from "../types.js";
import { indexDir, readManifest } from "./manifest.js";
import { Reader } from "./reader.js";
import { Segment } from "./segment.js";

export { indexerChildMain } from "./child.js";
export { type IndexerInternals, runIndexer, startIndexer } from "./indexer.js";
export { Reader } from "./reader.js";

/** Open the read side: committed segments of `o.sources`, plus the live tail when `o.live`
 *  is given (its first pass is awaited, so a fresh CLI sees the last minute too).
 *  `onCommitWanted`: the tail grew past its bound and the writer should commit. */
export async function openReader(o: ReaderOptions & { onCommitWanted?: () => void }): Promise<SearchReader & Reader> {
  const r = new Reader(o);
  await r.warm();
  return r;
}

/** Delete one index from disk (history off, D13). */
export async function removeIndex(dir: string, source: SearchSource): Promise<void> {
  await rm(indexDir(dir, source), { recursive: true, force: true });
}

/** `sessionpipe-gui index --verify`: every named segment of both indexes opens and its crc
 *  holds. Read-only; safe while the writer runs. */
export function verifyIndex(dir: string): { source: SearchSource; segments: number; bad: string[] }[] {
  const out: { source: SearchSource; segments: number; bad: string[] }[] = [];
  for (const source of ["history", "sessionpipe"] as const) {
    const idx = indexDir(dir, source);
    const m = readManifest(idx);
    if (!m) continue;
    const bad: string[] = [];
    for (const e of m.segments) {
      try {
        const s = new Segment(join(idx, e.name), e.name);
        if (!s.verify() || s.crc !== e.crc) bad.push(e.name);
        s.close();
      } catch {
        bad.push(e.name);
      }
    }
    out.push({ source, segments: m.segments.length, bad });
  }
  return out;
}
