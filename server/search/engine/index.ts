// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The engine's public module (SEARCH-SPEC §3.2): the only file the
// service, the CLI and the bench import from engine/.
import { rm } from "node:fs/promises";
import type { ReaderOptions, SearchReader, SearchSource } from "../types.js";
import { indexDir } from "./manifest.js";
import { Reader } from "./reader.js";

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
