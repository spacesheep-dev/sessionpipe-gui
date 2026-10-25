// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Crash safety (SEARCH-SPEC §3.2): the writer is SIGKILLed at random
// moments while it commits; every time, the next writer recovers a clean index — the MANIFEST
// parses, every named segment opens and verifies, no temp file is left — and after catching up
// every complete line on disk is indexed exactly once (nothing lost, nothing duplicated).
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSearch } from "../../../shared/searchQuery.js";
import { fakeAdapter, fakeEnv } from "./fake.js";
import { openReader, runIndexer } from "./index.js";
import { readManifest } from "./manifest.js";
import { Segment } from "./segment.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "spe-crash-"));
const child = join(root, "crash-child.mjs");
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeAll(async () => {
  await build({
    entryPoints: [join(here, "crash-child.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: child,
    logLevel: "error",
  });
});

const ROUNDS = Number(process.env.SPE_CRASH_ROUNDS ?? 20);

describe("SIGKILL during commits", () => {
  it(`recovers clean after ${ROUNDS} kills, with no lost or duplicated line`, { timeout: 240_000 }, async () => {
    const home = join(root, "home");
    const state = join(root, "state");
    mkdirSync(join(home, "fake"), { recursive: true });
    const env = fakeEnv(home, state);
    const idx = join(state, "search", "history");
    for (let round = 0; round < ROUNDS; round++) {
      const c = fork(child, [home, state, String(round + 1)], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 380));
      c.kill("SIGKILL");
      await new Promise((r) => c.once("exit", r));
      // the next writer recovers and catches up
      await runIndexer({
        dir: join(state, "search"),
        env,
        adapters: [fakeAdapter("history")],
        history: true,
        mode: "once",
      });
      const m = readManifest(idx);
      expect(m).not.toBeNull();
      const names = new Set(readdirSync(idx));
      expect([...names].some((n) => n.endsWith(".tmp"))).toBe(false);
      for (const s of m!.segments) {
        expect(names.has(s.name)).toBe(true);
        const seg = new Segment(join(idx, s.name), s.name);
        expect(seg.verify()).toBe(true);
        seg.close();
      }
    }
    // every complete line, exactly once
    let lines = 0;
    const sample: string[] = [];
    for (const f of readdirSync(join(home, "fake"))) {
      const body = readFileSync(join(home, "fake", f), "utf8");
      const complete = body
        .slice(0, body.lastIndexOf("\n") + 1)
        .split("\n")
        .filter(Boolean);
      lines += complete.length;
      for (const l of complete.slice(0, 3)) sample.push((JSON.parse(l) as { text: string }).text.split(" ")[0]!);
      const last = complete.at(-1);
      if (last) sample.push((JSON.parse(last) as { text: string }).text.split(" ")[0]!);
    }
    const r = await openReader({ dir: join(state, "search"), sources: ["history"] });
    expect(r.stats().messages).toBe(lines);
    for (const w of sample) {
      const res = r.search({
        parsed: parseSearch(w),
        sources: ["history"],
        sort: "best",
        offset: 0,
        limit: 5,
        hits: 1,
      });
      expect([w, res.total, res.matches[0]?.matched]).toEqual([w, 1, 1]);
    }
    r.close();
  });
});
