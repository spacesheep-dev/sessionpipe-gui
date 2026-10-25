// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. Shared helpers of the cross-module search tests.
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  EngineQuery,
  IndexerOptions,
  ReaderOptions,
  SearchReader,
  SearchSource,
} from "../../server/search/types.js";
import { parseSearch } from "../../shared/searchQuery.js";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const ENGINE = path.join(ROOT, "server/search/engine/index.ts");
export const BOTH: SearchSource[] = ["history", "sessionpipe"];
export const haveEngine = (): boolean => existsSync(ENGINE);

/** The engine's public module (SEARCH-SPEC §3.2), loaded by path so these tests compile
 *  before the engine lands. */
export interface EngineModule {
  openReader(o: ReaderOptions): Promise<SearchReader>;
  runIndexer(o: IndexerOptions): Promise<void>;
}
export const engineModule = async (): Promise<EngineModule> =>
  (await import(/* @vite-ignore */ ENGINE)) as EngineModule;

export function eq(
  text: string,
  sources: readonly SearchSource[] = BOTH,
  extra: Partial<EngineQuery> = {},
): EngineQuery {
  return { parsed: parseSearch(text), sources, sort: "best", offset: 0, limit: 100, hits: 3, ...extra };
}
