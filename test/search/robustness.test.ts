// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. What a disk and other processes can do to the index, and that search
// survives each: a segment with flipped bytes, a truncated segment, a MANIFEST cut in half, a
// LOCK left by a dead process, and a second writer at the same time. After each, a reader opens
// (it may answer less), and the next writer pass brings the index back to what the oracle holds.
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../bench/search/gen.mjs";
import { loadOracle } from "../../server/search/oracle.js";
import { eventsAdapter, historyAdapters, sourceEnv } from "../../server/search/sources/index.js";
import type { SearchReader, SourceEnv } from "../../server/search/types.js";
import { tempDir } from "../events.js";
import { allMessages, BOTH, type EngineModule, engineModule, eq, haveEngine } from "./kit.js";

const NOW = Date.parse("2026-10-25T00:00:00Z");
let tmp: { dir: string; cleanup: () => void };
let env: SourceEnv;
let e: EngineModule;
const adapters = () => [...historyAdapters(), eventsAdapter()];
const dir = (): string => path.join(tmp.dir, "search");
const hist = (): string => path.join(dir(), "history");
const run = () => e.runIndexer({ dir: dir(), env, adapters: adapters(), history: true, mode: "once" });

async function sameAsOracle(r: SearchReader): Promise<string[]> {
  const o = await loadOracle(env, adapters(), { now: () => NOW });
  const diffs: string[] = [];
  for (const s of o.sessions()) {
    if (!s.messages) continue;
    const a = allMessages(r, s.key).length;
    const b = allMessages(o, s.key).length;
    if (a !== b) diffs.push(`${s.key}: ${a} vs ${b}`);
    if (diffs.length > 5) break;
  }
  return diffs;
}

const segments = (): string[] =>
  readdirSync(hist())
    .filter((f) => /^seg-.*\.sps$/.test(f))
    .map((f) => path.join(hist(), f))
    .sort((a, b) => statSync(b).size - statSync(a).size);

describe.skipIf(!haveEngine())("index robustness", () => {
  beforeAll(async () => {
    tmp = tempDir("spgui-robust-");
    generate({ out: path.join(tmp.dir, "gen"), profile: "gate", size: 1_500_000, seed: 31, now: NOW });
    env = sourceEnv({
      home: path.join(tmp.dir, "gen", "home"),
      stateDir: path.join(tmp.dir, "gen", "state"),
      hostname: "rb-host",
    });
    e = await engineModule();
    await run();
  }, 120_000);
  afterAll(() => tmp?.cleanup());

  it("a segment with flipped bytes: the reader opens, the next pass repairs", async () => {
    const seg = segments()[0]!;
    const fd = openSync(seg, "r+");
    const size = statSync(seg).size;
    const junk = Buffer.alloc(64, 0xa5);
    for (const at of [Math.floor(size * 0.3), Math.floor(size * 0.6), size - 200])
      writeSync(fd, junk, 0, junk.length, at);
    closeSync(fd);
    const r = await e.openReader({ dir: dir(), sources: BOTH });
    r.search(eq("error"));
    r.close();
    await run();
    const r2 = await e.openReader({ dir: dir(), sources: BOTH });
    expect(await sameAsOracle(r2)).toEqual([]);
    r2.close();
  }, 120_000);

  it("a truncated segment: the reader opens, the next pass repairs", async () => {
    const seg = segments()[0]!;
    truncateSync(seg, Math.floor(statSync(seg).size / 2));
    const r = await e.openReader({ dir: dir(), sources: BOTH });
    r.search(eq("error"));
    r.close();
    await run();
    const r2 = await e.openReader({ dir: dir(), sources: BOTH });
    expect(await sameAsOracle(r2)).toEqual([]);
    r2.close();
  }, 120_000);

  it("a MANIFEST cut in half: the reader opens, the next pass rebuilds", async () => {
    const m = path.join(hist(), "MANIFEST");
    const body = readFileSync(m);
    writeFileSync(m, body.subarray(0, Math.floor(body.length / 2)));
    const r = await e.openReader({ dir: dir(), sources: BOTH });
    r.search(eq("error"));
    r.close();
    await run();
    const r2 = await e.openReader({ dir: dir(), sources: BOTH });
    expect(await sameAsOracle(r2)).toEqual([]);
    r2.close();
  }, 120_000);

  it("a LOCK left by a process that is gone is taken over", async () => {
    writeFileSync(
      path.join(dir(), "LOCK"),
      JSON.stringify({ pid: 2 ** 22 - 3, host: "rb-host", at: Date.now() - 1000 }),
    );
    await run();
    const r = await e.openReader({ dir: dir(), sources: BOTH });
    expect(await sameAsOracle(r)).toEqual([]);
    r.close();
  }, 120_000);

  it("two writers at once: one writes, the other refuses or waits; the index stays whole", async () => {
    const results = await Promise.allSettled([run(), run()]);
    expect(results.some((x) => x.status === "fulfilled")).toBe(true);
    for (const x of results) if (x.status === "rejected") expect(String(x.reason)).toMatch(/lock|locked|busy|running/i);
    const r = await e.openReader({ dir: dir(), sources: BOTH });
    expect(await sameAsOracle(r)).toEqual([]);
    expect(r.search(eq("purple elephant migration")).total).toBeGreaterThanOrEqual(0);
    r.close();
  }, 120_000);
});
