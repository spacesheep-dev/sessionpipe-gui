#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. The real-data smoke (SEARCH-SPEC.md §8.8, S7): this machine's own
// agent history, read-only, into a scratch index, then deleted. It prints COUNTS, SIZES AND
// TIMINGS ONLY: never a title, a path below the home, a snippet or an error's text (an error
// is reported by its class name). Nothing it reads is written anywhere but the scratch index.
//
//   node bench/search/smoke.mjs --index DIR [--home ~] [--keep]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildHarness, du } from "./run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, ".tmp", "perf");

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const INDEX = opt("index", "");
const HOME = opt("home", os.homedir());
if (!INDEX) {
  console.error("--index DIR is required (a scratch folder, deleted afterwards)");
  process.exit(2);
}
const free =
  Number(
    spawnSync("df", ["-k", path.dirname(INDEX)], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .pop()
      .split(/\s+/)[3],
  ) * 1024;
if (free < 7e9) {
  console.error(`only ${(free / 1e9).toFixed(1)} GB free; refusing (keep ≥ 6 GB)`);
  process.exit(2);
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};
const safe = (e) => (e && typeof e === "object" && "name" in e ? String(e.name) : "Error");

await buildHarness();
const sources = await import(pathToFileURL(path.join(OUT, "sources.mjs")).href);
const engine = await import(pathToFileURL(path.join(OUT, "engine.mjs")).href);
const stateDir = path.join(INDEX, "state");
mkdirSync(stateDir, { recursive: true });
const env = sources.env(HOME, stateDir);
const history = sources.adapters().filter((a) => a.source === "history");
const report = { node: process.version, home: HOME === os.homedir() ? "~" : "(custom)", adapters: {} };

try {
  // 1. discovery and the doc census (through the adapters, counts only)
  let srcBytes = 0;
  for (const a of history) {
    const t = performance.now();
    const files = await a.discover(env);
    const discoverMs = performance.now() - t;
    let docs = 0;
    let chars = 0;
    let bad = 0;
    let skipped = 0;
    let errors = 0;
    const keys = new Set();
    const subagentDocs = { n: 0 };
    const bytes = files.reduce((n, f) => n + f.size, 0);
    srcBytes += bytes;
    const t2 = performance.now();
    for (const f of files) {
      try {
        const r = await a.read(
          f,
          { offset: 0 },
          {
            doc: (d) => {
              docs++;
              chars += d.text.length;
              keys.add(d.key);
              if (d.agent) subagentDocs.n++;
            },
            facts: (x) => keys.add(x.key),
          },
        );
        bad += r.bad ?? 0;
        if (r.skipped) skipped++;
      } catch (e) {
        errors++;
        report.lastError = safe(e);
      }
    }
    report.adapters[a.id] = {
      files: files.length,
      zst: files.filter((f) => f.path.endsWith(".zst")).length,
      diskMB: r1(bytes / 1e6),
      sessions: keys.size,
      docs,
      subagentDocs: subagentDocs.n,
      textMB: r2(chars / 1e6),
      badLines: bad,
      skippedFiles: skipped,
      readErrors: errors,
      discoverMs: r1(discoverMs),
      readMs: Math.round(performance.now() - t2),
    };
  }
  // 2. the build (history only; the events of this state dir are empty)
  const dir = path.join(INDEX, "search");
  const t = performance.now();
  await engine.runIndexer({ dir, env, adapters: history, history: true, mode: "once" });
  const buildMs = performance.now() - t;
  const idxBytes = du(dir);
  report.build = {
    ms: Math.round(buildMs),
    diskMBps: r1(srcBytes / 1e6 / (buildMs / 1000)),
    indexMB: r1(idxBytes / 1e6),
    indexPctOfDisk: r2((100 * idxBytes) / srcBytes),
  };
  // 3. a second pass with nothing new (the quiet sweep)
  const t3 = performance.now();
  await engine.runIndexer({ dir, env, adapters: history, history: true, mode: "once" });
  report.build.quietSweepMs = r1(performance.now() - t3);
  // 4. queries: shapes from the harness, timings and counts only
  const reader = await engine.openReader({ dir, sources: ["history"] });
  const st = reader.stats();
  report.index = {
    sessions: st.sessions,
    messages: st.messages,
    bySource: st.bySource.map((b) => ({ harness: b.harness, sessions: b.sessions, homes: b.homes.length })),
  };
  const words = [
    "error",
    "test",
    "fix the",
    "build",
    "re",
    "ses",
    "sear",
    "src/",
    "review.ts",
    "deploy -test",
    "getUserName",
    "migrat*",
  ];
  const parse = sources.parseSearch;
  const times = [];
  if (parse) {
    for (const w of words)
      reader.search({
        parsed: parse(w, { live: true }),
        sources: ["history"],
        sort: "best",
        offset: 0,
        limit: 30,
        hits: 3,
      });
    for (let k = 0; k < 20; k++)
      for (const w of words) {
        const q = {
          parsed: parse(w, { live: true }),
          sources: ["history"],
          sort: "best",
          offset: 0,
          limit: 30,
          hits: 3,
        };
        const t4 = performance.now();
        reader.search(q);
        times.push(performance.now() - t4);
      }
    report.query = { n: times.length, p50: r2(pct(times, 50)), p95: r2(pct(times, 95)), max: r2(Math.max(...times)) };
  }
  reader.close();
} catch (e) {
  report.failed = safe(e);
} finally {
  if (!args.includes("--keep") && existsSync(INDEX)) rmSync(INDEX, { recursive: true, force: true });
  report.indexDeleted = !existsSync(INDEX);
}
console.log(JSON.stringify(report, null, 1));
