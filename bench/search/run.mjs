#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. The search gate (`npm run bench:search`, SEARCH-SPEC.md §8.2): it
// generates a 60 MB synthetic history home (bench/search/gen.mjs) in the OS temp dir, builds
// the engine with esbuild into .tmp/perf/, measures every S5 budget in its own process, prints
// a table, and exits 1 when a budget is missed. The corpus is deleted afterwards.
//
//   npm run bench:search [-- --oracle] [--size 60MB] [--reps 40] [--keep] [--json FILE] [--only a,b]
//
// --oracle runs the harness over the brute-force reader (no engine needed); it proves the
// harness and reports numbers, but gates nothing.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./gen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, ".tmp", "perf");
const MIN_FREE = 6e9;

/** S5 budgets as the gate asserts them. */
export const BUDGETS = {
  buildMBps: 50, // ≥, gate corpus and real-density corpus
  queryP50: 10, // ms, <
  queryP95: 50, // ms, <
  indexPct: 15, // ≤ % of source, real-density corpus
  tickMs: 50, // quiet reader.tick p95 and the quiet sweep, <
  footprintMB: 60, // ≤ delta after 6,000 queries
  firstMs: 2000, // ≤ first results during the first build
  entryGz: 141_000, // ≤ bytes, the web entry chunk gzipped as vite reports it (level 6)
};

/** The server as the release ships it (esbuild of server/cli.ts into .tmp/perf/dist/cli.js, so
 *  it forks its own indexer child like dist/cli.js does). */
export async function buildServer() {
  const esbuild = await import("esbuild");
  const out = path.join(OUT, "dist", "cli.js");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "server/cli.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "error",
    absWorkingDir: ROOT,
  });
  return out;
}

function footprintOf(pid) {
  if (process.platform === "darwin") {
    const r = spawnSync("footprint", ["-f", "bytes", String(pid)], { encoding: "utf8" });
    const m = /Footprint:\s*(\d+)\s*B/.exec(r.stdout ?? "");
    if (m) return Number(m[1]);
  }
  try {
    const m = /VmRSS:\s*(\d+)\s*kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (m) return Number(m[1]) * 1024;
  } catch {}
  return Number.NaN;
}

/** The search's footprint in a real server: two servers on the same build, one over the gate
 *  home and its events, one over an empty home and state; each answers the same 6,000 page
 *  queries over HTTP; the impact is the difference of their footprints (S5: server RSS impact). */
export async function serverImpact(G, tmp, queries = 6000) {
  const { SHAPES } = await import("./shapes.mjs");
  const cli = await buildServer();
  const empty = path.join(tmp, "empty-home");
  mkdirSync(empty, { recursive: true });
  const { spawn } = await import("node:child_process");
  const { cpSync } = await import("node:fs");
  const stateA = path.join(tmp, "srv-a");
  cpSync(G.state, stateA, { recursive: true });
  const servers = [
    { name: "search", port: 7927, state: stateA, home: G.home },
    { name: "empty", port: 7928, state: path.join(tmp, "srv-b"), home: empty },
  ];
  for (const s of servers) {
    mkdirSync(s.state, { recursive: true });
    s.proc = spawn(
      process.execPath,
      [cli, "--port", String(s.port), "--state", s.state, "--no-outbox", "--quiet", "--search-home", s.home],
      { stdio: "ignore" },
    );
  }
  const base = (s) => `http://127.0.0.1:${s.port}`;
  try {
    for (const s of servers) {
      for (let i = 0; ; i++) {
        if (i > 900) throw new Error(`${s.name} server never became ready`);
        try {
          const st = await (await fetch(`${base(s)}/api/ui/search/status`)).json();
          if (st.state === "ready" || (s.name === "empty" && st.state !== "first-run")) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // At rest before any query: right after "ready", and after 30 s (V8 shrinks an idle heap).
    const MBr = 1024 * 1024;
    const rest = () => Object.fromEntries(servers.map((s) => [s.name, r2(footprintOf(s.proc.pid) / MBr)]));
    const ready = { now: rest() };
    await new Promise((r) => setTimeout(r, 30_000));
    ready.after30s = rest();
    const urls = SHAPES.map(
      (x) =>
        `/api/ui/search/sessions?q=${encodeURIComponent(x.q)}&limit=30&hits=3&tz=0${x.live ? "&live=1" : ""}${x.sort ? `&sort=${x.sort}` : ""}`,
    );
    const t0 = performance.now();
    const ms = {};
    for (const s of servers) {
      const t = performance.now();
      for (let i = 0; i < queries; i++) {
        const r = await fetch(`${base(s)}${urls[i % urls.length]}`);
        if (r.status !== 200) throw new Error(`${s.name}: ${r.status}`);
        await r.arrayBuffer();
      }
      ms[s.name] = Math.round(performance.now() - t);
    }
    // Sampled over the minute after the burst (V8's memory reducer, the indexer's sweeps and
    // the reader's refreshes all land in it); the gate takes the worst sample.
    const MB = 1024 * 1024;
    const samples = [];
    let waited = 0;
    for (const at of [5, 30, 60]) {
      await new Promise((r) => setTimeout(r, (at - waited) * 1000));
      waited = at;
      const fp = Object.fromEntries(servers.map((s) => [s.name, footprintOf(s.proc.pid)]));
      samples.push({
        at,
        searchMB: r2(fp.search / MB),
        emptyMB: r2(fp.empty / MB),
        impactMB: r2((fp.search - fp.empty) / MB),
      });
    }
    return {
      impactMB: Math.max(...samples.map((x) => x.impactMB)),
      samples,
      ready,
      queries,
      httpMs: ms,
      totalMs: Math.round(performance.now() - t0),
    };
  } finally {
    for (const s of servers) s.proc?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** vite build into .tmp/perf/dist/web; the entry chunk's gzip size and whether search code
 *  stayed out of it (only the route stub may be there). */
export async function bundle() {
  const { gzipSync } = await import("node:zlib");
  const { readFileSync } = await import("node:fs");
  const outDir = path.join(OUT, "dist", "web");
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules/vite/bin/vite.js"),
      "build",
      "--config",
      "web/vite.config.ts",
      "--outDir",
      outDir,
      "--emptyOutDir",
      "--logLevel",
      "error",
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000 },
  );
  if (r.status !== 0) throw new Error(`vite build failed:\n${(r.stderr || r.stdout).slice(-2000)}`);
  const html = readFileSync(path.join(outDir, "index.html"), "utf8");
  const entry = /<script[^>]+src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
  if (!entry) throw new Error("no entry script in index.html");
  const code = readFileSync(path.join(outDir, "assets", entry));
  const map = JSON.parse(readFileSync(path.join(outDir, "assets", `${entry}.map`), "utf8"));
  const searchInEntry = map.sources.filter((x) => /search/i.test(x) && !/pages\/Search\.tsx$/.test(x));
  const lazy = readdirSync(path.join(outDir, "assets")).filter((f) => /^SearchPage-.*\.js$/.test(f));
  return { entry, bytes: code.length, gz: gzipSync(code).length, searchInEntry, lazyChunk: lazy[0] ?? null };
}

function parse(argv) {
  const o = { oracle: false, size: "60MB", realSize: "60MB", reps: 40, keep: false, json: "", only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--oracle") o.oracle = true;
    else if (a === "--size") o.size = argv[++i];
    else if (a === "--real-size") o.realSize = argv[++i];
    else if (a === "--reps") o.reps = Number(argv[++i]);
    else if (a === "--keep") o.keep = true;
    else if (a === "--json") o.json = argv[++i];
    else if (a === "--only") o.only = new Set(argv[++i].split(","));
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

function freeBytes(dir) {
  try {
    const out = execFileSync("df", ["-k", dir], { encoding: "utf8" }).trim().split("\n").pop().split(/\s+/);
    return Number(out[3]) * 1024;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function du(dir) {
  let n = 0;
  if (!existsSync(dir)) return 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? du(p) : statSync(p).size;
  }
  return n;
}

/** Bundles the harness and the engine/sources entries into .tmp/perf/. */
export async function buildHarness({ oracle = false } = {}) {
  const esbuild = await import("esbuild");
  const src = path.join(OUT, "src");
  mkdirSync(src, { recursive: true });
  const engineIndex = path.join(ROOT, "server/search/engine/index.ts");
  const sourcesIndex = path.join(ROOT, "server/search/sources/index.ts");
  if (!existsSync(sourcesIndex)) throw new Error("server/search/sources/index.ts is missing");
  writeFileSync(
    path.join(src, "sources.ts"),
    `import { historyAdapters, eventsAdapter, sourceEnv } from ${JSON.stringify(sourcesIndex)};
export const adapters = () => [...historyAdapters(), eventsAdapter()];
export const env = (home: string, stateDir: string) => sourceEnv({ home, stateDir, hostname: "bench-host" });
export { parseSearch } from ${JSON.stringify(path.join(ROOT, "shared/searchQuery.ts"))};
`,
  );
  const entries = { harness: path.join(ROOT, "bench/search/harness.ts"), sources: path.join(src, "sources.ts") };
  const haveEngine = existsSync(engineIndex);
  if (haveEngine) {
    writeFileSync(
      path.join(src, "engine.ts"),
      `export { openReader, runIndexer } from ${JSON.stringify(engineIndex)};\n`,
    );
    entries.engine = path.join(src, "engine.ts");
  } else if (!oracle) throw new Error("server/search/engine/index.ts is missing (use --oracle to prove the harness)");
  const t = performance.now();
  await esbuild.build({
    entryPoints: entries,
    outdir: OUT,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    external: ["./engine.mjs", "./sources.mjs"],
    sourcemap: "inline",
    logLevel: "error",
    absWorkingDir: ROOT,
  });
  return { ms: Math.round(performance.now() - t), haveEngine };
}

/** Runs one harness command in its own process; returns its last JSON line. */
export function harness(cmd, a, { oracle = false, gc = false } = {}) {
  const argv = [
    ...(gc ? ["--expose-gc"] : []),
    path.join(OUT, "harness.mjs"),
    cmd,
    "--home",
    a.home,
    "--state",
    a.state,
    "--now",
    String(a.now),
  ];
  if (a.dir) argv.push("--dir", a.dir);
  if (oracle) argv.push("--oracle");
  for (const [k, v] of Object.entries(a.extra ?? {})) argv.push(`--${k}`, String(v));
  const r = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, timeout: 600_000 });
  if (r.status !== 0) throw new Error(`harness ${cmd} failed (${r.status}):\n${(r.stderr || r.stdout).slice(-4000)}`);
  const line = r.stdout.trim().split("\n").pop();
  return JSON.parse(line);
}

/** Two builds into fresh directories; the faster one is kept (as `dir`). */
function bestBuild(a, dir) {
  const one = harness("build", { ...a, dir });
  const other = `${dir}-2`;
  const two = harness("build", { ...a, dir: other });
  if (two.ms < one.ms) {
    rmSync(dir, { recursive: true, force: true });
    renameSync(other, dir);
    return { ...two, runs: [one.ms, two.ms] };
  }
  rmSync(other, { recursive: true, force: true });
  return { ...one, runs: [one.ms, two.ms] };
}

function row(name, value, budget, ok, gated) {
  return { name, value, budget, ok: gated ? ok : null };
}

export async function runGate(o) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "spgui-search-bench-"));
  const free = freeBytes(tmp);
  if (free < MIN_FREE + 400e6) throw new Error(`only ${(free / 1e9).toFixed(1)} GB free; the gate keeps ≥ 6 GB`);
  const rows = [];
  const report = {
    started: new Date().toISOString(),
    engine: o.oracle ? "oracle" : "engine",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: os.cpus().length,
    load: os.loadavg().map((x) => Math.round(x * 10) / 10),
  };
  const want = (k) => !o.only || o.only.has(k);
  const gated = !o.oracle;
  try {
    const hb = await buildHarness({ oracle: o.oracle });
    report.harnessBuildMs = hb.ms;
    const now = Date.parse("2026-10-25T00:00:00Z");
    // 1. the corpora
    const t = performance.now();
    const gate = generate({ out: path.join(tmp, "gate"), profile: "gate", size: parseSize(o.size), seed: 42, now });
    const real =
      want("size") || want("build")
        ? generate({ out: path.join(tmp, "real"), profile: "real", size: parseSize(o.realSize), seed: 7, now })
        : null;
    report.genMs = Math.round(performance.now() - t);
    report.corpus = { gate: summary(gate), real: real ? summary(real) : null };
    const G = { home: path.join(tmp, "gate", "home"), state: path.join(tmp, "gate", "state"), now };
    const R = { home: path.join(tmp, "real", "home"), state: path.join(tmp, "real", "state"), now };
    // the docs the adapters emit (a sanity line: ≥ 100k messages)
    const docs = harness("docs", G);
    report.docs = docs;
    rows.push(row("messages in the gate corpus", docs.docs, "≥ 100,000", docs.docs >= 100_000, gated));

    if (!o.oracle) {
      // 2. build throughput, gate corpus and real-density corpus
      if (want("build")) {
        // Best of two (a fresh index each time): throughput is the machine's best, not its load.
        const b = bestBuild(G, path.join(tmp, "idx-gate"));
        const mbps = gate.bytes / 1e6 / (b.ms / 1000);
        report.buildGate = { ...b, MBps: r1(mbps) };
        rows.push(
          row("build, gate corpus (MB/s)", r1(mbps), `≥ ${BUDGETS.buildMBps}`, mbps >= BUDGETS.buildMBps, gated),
        );
        if (real) {
          const br = bestBuild(R, path.join(tmp, "idx-real"));
          const mbpsR = real.bytes / 1e6 / (br.ms / 1000);
          report.buildReal = { ...br, MBps: r1(mbpsR) };
          rows.push(
            row(
              "build, real-density corpus (MB/s)",
              r1(mbpsR),
              `≥ ${BUDGETS.buildMBps}`,
              mbpsR >= BUDGETS.buildMBps,
              gated,
            ),
          );
        }
      }
      // 3. index size (real density)
      if (want("size") && real) {
        if (!existsSync(path.join(tmp, "idx-real"))) harness("build", { ...R, dir: path.join(tmp, "idx-real") });
        const bytes = du(path.join(tmp, "idx-real"));
        const pctv = (100 * bytes) / real.bytes;
        report.indexReal = { bytes, pct: r2(pctv) };
        const bytesG = du(path.join(tmp, "idx-gate"));
        report.indexGate = { bytes: bytesG, pct: r2((100 * bytesG) / gate.bytes) };
        rows.push(
          row(
            "index size, real density (% of source)",
            r2(pctv),
            `≤ ${BUDGETS.indexPct}`,
            pctv <= BUDGETS.indexPct,
            gated,
          ),
        );
      }
      // 4. first results during the first build
      if (want("first")) {
        const f = harness("first", { ...G, dir: path.join(tmp, "idx-first") });
        report.first = f;
        rows.push(
          row(
            "first results during the first build (ms)",
            f.firstMs,
            `≤ ${BUDGETS.firstMs}`,
            f.firstMs >= 0 && f.firstMs <= BUDGETS.firstMs,
            gated,
          ),
        );
      }
    }
    const dir = path.join(tmp, "idx-gate");
    if (!o.oracle && !existsSync(dir)) harness("build", { ...G, dir });
    // 5. queries
    if (want("query")) {
      const q = harness("query", { ...G, dir, extra: { reps: o.reps } }, { oracle: o.oracle });
      report.query = q;
      rows.push(
        row(
          `query p50 over ${q.n} (${Object.keys(q.shapes).length} shapes, ms)`,
          q.p50,
          `< ${BUDGETS.queryP50}`,
          q.p50 < BUDGETS.queryP50,
          gated,
        ),
      );
      rows.push(row("query p95 (ms)", q.p95, `< ${BUDGETS.queryP95}`, q.p95 < BUDGETS.queryP95, gated));
    }
    // 6. quiet tick
    if (want("tick")) {
      const k = harness("tick", { ...G, dir }, { oracle: o.oracle });
      report.tick = k;
      rows.push(row("quiet reader.tick p95 (ms)", k.tickP95, `< ${BUDGETS.tickMs}`, k.tickP95 < BUDGETS.tickMs, gated));
      if (!o.oracle)
        rows.push(
          row(
            "quiet indexer pass, median of 5 (ms)",
            k.sweepP50,
            `< ${BUDGETS.tickMs}`,
            k.sweepP50 < BUDGETS.tickMs,
            gated,
          ),
        );
    }
    // 8. the web entry bundle (S5: the Search page is a lazy route)
    if (want("bundle") && !o.oracle) {
      const bu = await bundle();
      report.bundle = bu;
      rows.push(row("web entry chunk (bytes gz)", bu.gz, `≤ ${BUDGETS.entryGz}`, bu.gz <= BUDGETS.entryGz, gated));
      rows.push(
        row(
          "search code in the entry (modules)",
          bu.searchInEntry.length,
          "0, and SearchPage lazy",
          bu.searchInEntry.length === 0 && !!bu.lazyChunk,
          gated,
        ),
      );
    }
    // 9. the search's footprint inside a real server (the gated number), next to the reader
    //    alone in a fresh process (a diagnostic: a fresh V8 heap grows its young generation)
    if (want("server") && !o.oracle) {
      const si = await serverImpact(G, tmp);
      report.server = si;
      rows.push(
        row(
          `server footprint impact, 6,000 page queries (MB)`,
          si.impactMB,
          `≤ ${BUDGETS.footprintMB}`,
          si.impactMB <= BUDGETS.footprintMB,
          gated,
        ),
      );
    }
    // 7. footprint
    if (want("footprint")) {
      const fp = harness(
        "footprint",
        { ...G, dir, extra: { queries: o.oracle ? 300 : 6000 } },
        { oracle: o.oracle, gc: true },
      );
      report.footprint = fp;
      rows.push(
        row(
          `reader alone, fresh process, after ${fp.queries} queries (MB, ${fp.how})`,
          fp.deltaMB,
          `≤ ${BUDGETS.footprintMB} (diagnostic)`,
          fp.deltaMB <= BUDGETS.footprintMB,
          false,
        ),
      );
    }
  } finally {
    report.tmp = tmp;
    if (!o.keep) rmSync(tmp, { recursive: true, force: true });
  }
  report.rows = rows;
  report.ok = gated && rows.every((r) => r.ok !== false);
  return report;
}

function summary(m) {
  return {
    MB: r1(m.bytes / 1e6),
    diskMB: r1(m.diskBytes / 1e6),
    files: m.files,
    zst: m.zstFiles,
    zstd: m.zstd,
    sessions: m.sessions,
    messages: m.messages,
    textPct: r2((100 * m.textBytes) / m.bytes),
  };
}
function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(k|m|g)?b?$/i.exec(String(s));
  return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, g: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1));
}
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const o = parse(process.argv.slice(2));
  const rep = await runGate(o);
  const w = Math.max(...rep.rows.map((r) => r.name.length));
  console.log(
    `\nsession search gate · ${rep.engine} · node ${rep.node} · ${rep.platform} · load ${rep.load.join(" ")}`,
  );
  console.log(`corpus: ${JSON.stringify(rep.corpus.gate)}\n`);
  for (const r of rep.rows)
    console.log(
      `${r.ok === null ? "  ·" : r.ok ? "  ✓" : "  ✗"} ${r.name.padEnd(w)}  ${String(r.value).padStart(9)}  ${r.budget}`,
    );
  if (rep.query) {
    console.log("\nper shape (p50 / p95 ms, sessions):");
    for (const [k, v] of Object.entries(rep.query.shapes))
      console.log(
        `    ${k.padEnd(20)} ${String(v.p50).padStart(7)} ${String(v.p95).padStart(7)} ${String(v.total).padStart(6)}`,
      );
  }
  if (o.json) writeFileSync(o.json, `${JSON.stringify(rep, null, 1)}\n`);
  console.log(
    rep.engine === "oracle"
      ? "\noracle run: the harness works; nothing is gated"
      : rep.ok
        ? "\ngate: green"
        : "\ngate: RED",
  );
  process.exit(rep.engine === "oracle" || rep.ok ? 0 : 1);
}
