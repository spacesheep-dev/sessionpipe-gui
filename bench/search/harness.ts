// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. The measuring side of the search gate (bench/search/run.mjs bundles
// this into .tmp/perf/harness.mjs and runs each command in its own process, so a build, the
// queries and the footprint never share a heap). Prints one JSON line on stdout per command.
//
//   harness.mjs build     --home H --state S --dir D            runIndexer once, timed
//   harness.mjs first     --home H --state S --dir D            first results during the first build
//   harness.mjs query     --home H --state S --dir D [--oracle] the 24 shapes, p50/p95
//   harness.mjs tick      --home H --state S --dir D            quiet reader.tick + quiet sweep
//   harness.mjs footprint --home H --state S --dir D [--oracle] phys_footprint before/after 6,000 queries
//   harness.mjs docs      --home H --state S                    the docs the adapters emit (counts)
import { fork, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { compileFilters } from "../../server/search/filters.js";
import { loadOracle } from "../../server/search/oracle.js";
import type {
  EngineQuery,
  IndexerOptions,
  ReaderOptions,
  SearchReader,
  SourceAdapter,
  SourceEnv,
} from "../../server/search/types.js";
import type { SearchSource } from "../../shared/api.js";
import { parseSearch } from "../../shared/searchQuery.js";

interface EngineMod {
  openReader(o: ReaderOptions): Promise<SearchReader>;
  runIndexer(o: IndexerOptions): Promise<void>;
}
interface SourcesMod {
  adapters(): SourceAdapter[];
  env(home: string, stateDir: string): SourceEnv;
}

const args = process.argv.slice(2);
const cmd = args[0] ?? "";
const opt = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (k: string): boolean => args.includes(`--${k}`);
const HOME = opt("home") ?? "";
const STATE = opt("state") ?? "";
const DIR = opt("dir") ?? "";
const NOW = Number(opt("now") ?? Date.now());
const SOURCES: SearchSource[] = ["history", "sessionpipe"];

const here = new URL(".", import.meta.url);
const engine = async (): Promise<EngineMod> => (await import(new URL("./engine.mjs", here).href)) as EngineMod;
const sources = async (): Promise<SourcesMod> => (await import(new URL("./sources.mjs", here).href)) as SourcesMod;

const out = (o: unknown): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};
const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** The 24+ query shapes of the gate (SEARCH-SPEC §8.2). `live` = typed in the page. */
export const SHAPES: { name: string; q: string; live?: boolean; sort?: "best" | "newest" }[] = [
  { name: "common word", q: "error" },
  { name: "two words", q: "test build" },
  { name: "four words", q: "please check the error" },
  { name: "rare word", q: "axolotlcodexask" },
  { name: "phrase common", q: '"the error"' },
  { name: "phrase three", q: '"fix the bug"' },
  { name: "phrase rare", q: '"purple elephant migration"' },
  { name: "prefix 2 live", q: "re", live: true },
  { name: "prefix 3 live", q: "ses", live: true },
  { name: "prefix 4 live", q: "sear", live: true },
  { name: "typing two words", q: "store eve", live: true },
  { name: "prefix typed", q: "migrat*" },
  { name: "camelCase rare", q: "quokkaSerializerFactory" },
  { name: "camelCase common", q: "errorCode" },
  { name: "path", q: "src/store" },
  { name: "file name", q: "review.ts" },
  { name: "exclusion", q: "error -test" },
  { name: "exclusion phrase", q: 'build -"the error"' },
  { name: "filter agent", q: "agent:codex error" },
  { name: "filter since", q: "since:30d test" },
  { name: "filter machine", q: "machine:build-box session" },
  { name: "in prompt", q: "in:prompt deploy" },
  { name: "browse", q: "agent:claude" },
  { name: "newest", q: "error", sort: "newest" },
  { name: "cjk", q: "検索" },
  { name: "diacritics", q: "Größe" },
];

function query(text: string, live: boolean, sort: "best" | "newest" = "best"): EngineQuery {
  const parsed = parseSearch(text, { live });
  const f = compileFilters(parsed, {
    hostname: "bench-host",
    labels: { rev: 0, names: {}, sessions: {} },
    now: NOW,
    tz: 0,
    available: SOURCES,
  });
  const q: EngineQuery = { parsed, sources: f.sources, sort, offset: 0, limit: 30, hits: 3 };
  if (f.allow) q.allow = f.allow;
  if (f.fields) q.fields = f.fields;
  return q;
}

async function env(): Promise<{ env: SourceEnv; adapters: SourceAdapter[] }> {
  const s = await sources();
  return { env: s.env(HOME, STATE), adapters: s.adapters() };
}

async function reader(live = false): Promise<SearchReader> {
  if (flag("oracle")) {
    const e = await env();
    return loadOracle(e.env, e.adapters, { now: () => NOW });
  }
  const e = await env();
  const o: ReaderOptions = { dir: DIR, sources: SOURCES };
  if (live) o.live = e;
  return (await engine()).openReader(o);
}

function footprintBytes(): number {
  if (process.platform === "darwin") {
    const r = spawnSync("footprint", ["-f", "bytes", String(process.pid)], { encoding: "utf8" });
    const m = /Footprint:\s*(\d+)\s*B/.exec(r.stdout ?? "");
    if (m) return Number(m[1]);
  }
  try {
    const m = /VmRSS:\s*(\d+)\s*kB/.exec(readFileSync("/proc/self/status", "utf8"));
    if (m) return Number(m[1]) * 1024;
  } catch {
    // not Linux
  }
  return process.memoryUsage().rss;
}

const gc = (): void => {
  const g = (globalThis as { gc?: () => void }).gc;
  if (g) for (let i = 0; i < 3; i++) g();
};

async function main(): Promise<void> {
  switch (cmd) {
    case "build": {
      const e = await env();
      const t0 = performance.now();
      await (await engine()).runIndexer({ dir: DIR, env: e.env, adapters: e.adapters, history: true, mode: "once" });
      const ms = performance.now() - t0;
      out({ ms: r2(ms), maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024) });
      return;
    }
    case "build-child": {
      // The writer half of `first`: a plain once-build in its own process.
      const e = await env();
      await (await engine()).runIndexer({ dir: DIR, env: e.env, adapters: e.adapters, history: true, mode: "once" });
      return;
    }
    case "first": {
      const self = new URL(import.meta.url).pathname;
      const t0 = performance.now();
      const child = fork(self, ["build-child", "--home", HOME, "--state", STATE, "--dir", DIR], { stdio: "ignore" });
      const done = new Promise<number>((res) => child.on("exit", () => res(performance.now() - t0)));
      const r = await reader();
      const q = query("error", false);
      let first = -1;
      let exited = -1;
      void done.then((ms) => {
        exited = ms;
      });
      while (first < 0) {
        r.refresh();
        if (r.search(q).total > 0) first = performance.now() - t0;
        else if (exited >= 0) {
          r.refresh();
          if (r.search(q).total > 0) first = performance.now() - t0;
          break;
        } else await new Promise((res) => setTimeout(res, 25));
      }
      const buildMs = await done;
      r.close();
      out({ firstMs: r2(first), buildMs: r2(buildMs) });
      return;
    }
    case "query": {
      const r = await reader();
      const reps = Number(opt("reps") ?? 40);
      const qs = SHAPES.map((s) => ({ ...s, eq: query(s.q, !!s.live, s.sort) }));
      for (const s of qs) for (let i = 0; i < 3; i++) r.search(s.eq); // warm the JIT and the caches
      const all: number[] = [];
      const shapes: Record<string, { p50: number; p95: number; total: number; hits: number }> = {};
      for (const s of qs) {
        const times: number[] = [];
        let total = 0;
        let hits = 0;
        for (let i = 0; i < reps; i++) {
          const t = performance.now();
          const res = r.search(s.eq);
          times.push(performance.now() - t);
          total = res.total;
          hits = res.matches.reduce((n, m) => n + m.hits.length, 0);
        }
        all.push(...times);
        shapes[s.name] = { p50: r2(pct(times, 50)), p95: r2(pct(times, 95)), total, hits };
      }
      const st = r.stats();
      r.close();
      out({
        p50: r2(pct(all, 50)),
        p95: r2(pct(all, 95)),
        max: r2(Math.max(...all)),
        n: all.length,
        sessions: st.sessions,
        messages: st.messages,
        bytes: st.bytes,
        shapes,
      });
      return;
    }
    case "tick": {
      const r = await reader(true);
      r.tick();
      const ticks: number[] = [];
      for (let i = 0; i < 50; i++) {
        const t = performance.now();
        r.tick();
        ticks.push(performance.now() - t);
      }
      r.close();
      const sweeps: number[] = [];
      if (!flag("oracle")) {
        const e = await env();
        const eng = await engine();
        for (let i = 0; i < 5; i++) {
          const t = performance.now();
          await eng.runIndexer({ dir: DIR, env: e.env, adapters: e.adapters, history: true, mode: "once" });
          sweeps.push(performance.now() - t);
        }
      }
      out({
        tickP50: r2(pct(ticks, 50)),
        tickP95: r2(pct(ticks, 95)),
        sweepP50: r2(pct(sweeps, 50)),
        sweepMax: r2(Math.max(0, ...sweeps)),
      });
      return;
    }
    case "footprint": {
      gc();
      const base = footprintBytes();
      const r = await reader();
      gc();
      const opened = footprintBytes();
      const qs = SHAPES.map((s) => query(s.q, !!s.live, s.sort));
      const n = Number(opt("queries") ?? 6000);
      for (let i = 0; i < n; i++) r.search(qs[i % qs.length]!);
      gc();
      const after = footprintBytes();
      r.close();
      const MB = 1024 * 1024;
      out({
        baseMB: r2(base / MB),
        openedMB: r2(opened / MB),
        afterMB: r2(after / MB),
        deltaMB: r2((after - base) / MB),
        queries: n,
        how: process.platform === "darwin" ? "footprint" : "VmRSS",
      });
      return;
    }
    case "docs": {
      const e = await env();
      const by: Record<string, number> = {};
      let docs = 0;
      let text = 0;
      const t0 = performance.now();
      for (const a of e.adapters) {
        for (const f of await a.discover(e.env)) {
          await a.read(
            f,
            { offset: 0 },
            {
              doc: (d) => {
                docs++;
                text += d.text.length;
                const h = d.key.slice(0, d.key.indexOf(":"));
                by[h] = (by[h] ?? 0) + 1;
              },
              facts: () => {},
            },
          );
        }
      }
      out({ docs, textChars: text, byHarness: by, ms: r2(performance.now() - t0) });
      return;
    }
    default:
      process.stderr.write(`unknown command ${cmd}\n`);
      process.exit(2);
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
