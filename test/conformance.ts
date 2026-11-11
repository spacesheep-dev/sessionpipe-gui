// SPDX-License-Identifier: Apache-2.0
// Where the sessionpipe conformance fixtures are read from: the copy in test/conformance/,
// which scripts/sync-conformance.mjs keeps at the pinned sessionpipe-core's version, so a
// contributor's machine and CI run the same files. `SESSIONPIPE_REPO=<checkout>` reads that
// checkout's `conformance/` instead, for work on a protocol change that is not released.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The vendored copy, laid out as sessionpipe's own `conformance/` folder. */
export const VENDORED = path.join(path.dirname(fileURLToPath(import.meta.url)), "conformance");

/** The fixture folders this receiver runs (CONTROL.md §11). */
export const FIXTURE_FOLDERS = ["control-vectors", "delivery"] as const;
export type FixtureFolder = (typeof FIXTURE_FOLDERS)[number];

/** One fixture folder and its `.json` files, sorted. A folder that is missing or empty
 *  throws: a suite with no fixtures fails where it is collected, it is never skipped. */
export function fixtures(
  folder: FixtureFolder,
  env: Record<string, string | undefined> = process.env,
): { dir: string; files: string[] } {
  const dir = path.join(env.SESSIONPIPE_REPO ? path.join(env.SESSIONPIPE_REPO, "conformance") : VENDORED, folder);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error(`no conformance fixtures in ${dir}`);
  return { dir, files };
}
