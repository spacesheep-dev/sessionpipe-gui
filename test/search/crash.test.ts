// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. Crash torture (SEARCH-SPEC.md §8.4): the writer runs in a child over
// a generated home and is SIGKILLed at a random moment, 20 times, with new bytes appended
// between rounds. After every kill a reader must open clean; after a last full pass the index
// must hold exactly the docs the oracle holds: none lost, none twice.
import { fork } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GenManifest, generate } from "../../bench/search/gen.mjs";
import { loadOracle } from "../../server/search/oracle.js";
import { eventsAdapter, historyAdapters, sourceEnv } from "../../server/search/sources/index.js";
import type { SearchReader } from "../../server/search/types.js";
import { tempDir } from "../events.js";
import { allMessages, BOTH, ENGINE, engineModule, eq, ROOT } from "./kit.js";

const ROUNDS = 20;
const NOW = Date.parse("2026-10-25T00:00:00Z");

let tmp: { dir: string; cleanup: () => void };
let child = "";
let m: GenManifest;
const home = (): string => path.join(tmp.dir, "gen", "home");
const state = (): string => path.join(tmp.dir, "gen", "state");
const dir = (): string => path.join(tmp.dir, "search");

/** The writer as a plain node script (bundled from the TypeScript once). */
async function bundleChild(): Promise<string> {
  const esbuild = await import("esbuild");
  const out = path.join(ROOT, ".tmp", "perf", "crash");
  mkdirSync(out, { recursive: true });
  const entry = path.join(out, "writer.ts");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    entry,
    `import { runIndexer } from ${JSON.stringify(ENGINE)};
import { eventsAdapter, historyAdapters, sourceEnv } from ${JSON.stringify(path.join(ROOT, "server/search/sources/index.ts"))};
const [home, stateDir, dir, how] = process.argv.slice(2);
const env = sourceEnv({ home, stateDir, hostname: "crash-host" });
await runIndexer({ dir, env, adapters: [...historyAdapters(), eventsAdapter()], history: true, mode: "once", rebuild: how === "rebuild" });
`,
  );
  const file = path.join(out, "writer.mjs");
  await esbuild.build({
    entryPoints: [entry],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    logLevel: "error",
  });
  return file;
}

/** Any `*.tmp` under the index: a segment or the MANIFEST being written (a commit in flight). */
function committing(d: string): boolean {
  if (!existsSync(d)) return false;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (committing(path.join(d, e.name))) return true;
    } else if (e.name.endsWith(".tmp")) return true;
  }
  return false;
}

/** Runs the writer; with `kill`, SIGKILLs it `jitter` ms after the first commit in flight is
 *  seen (or at `fallback` ms if none is seen first). */
function runWriter(
  kill: { jitter: number; fallback: number } | null,
  how: "once" | "rebuild" = "once",
): Promise<{ how: "killed" | "done"; inCommit: boolean }> {
  return new Promise((resolve, reject) => {
    const c = fork(child, [home(), state(), dir(), how], { stdio: "ignore" });
    let inCommit = false;
    let fired = false;
    const fire = (): void => {
      if (fired) return;
      fired = true;
      c.kill("SIGKILL");
    };
    const t0 = Date.now();
    const poll = kill
      ? setInterval(() => {
          if (fired) return;
          if (committing(dir())) {
            inCommit = true;
            setTimeout(fire, kill.jitter);
          } else if (Date.now() - t0 > kill.fallback) fire();
        }, 1)
      : undefined;
    c.on("exit", (code, sig) => {
      if (poll) clearInterval(poll);
      if (sig === "SIGKILL") resolve({ how: "killed", inCommit });
      else if (code === 0) resolve({ how: "done", inCommit: false });
      else reject(new Error(`writer exited ${code}`));
    });
  });
}

/** Appends turns to many Claude files (about 1 MB of new text for the next round). */
function grow(round: number): void {
  const projects = path.join(home(), ".claude", "projects");
  const files: string[] = [];
  for (const slug of readdirSync(projects)) {
    for (const f of readdirSync(path.join(projects, slug)))
      if (f.endsWith(".jsonl")) files.push(path.join(projects, slug, f));
  }
  // Not the live file whose last line is still partial: a line appended there joins it.
  const whole = files.filter((f) => readFileSync(f).at(-1) === 10).sort();
  files.length = 0;
  files.push(...whole);
  const filler = "the store event stream receiver control daemon hook outbox sink pair key sign verify ".repeat(20);
  for (let i = 0; i < 400; i++) {
    const f = files[(round * 7 + i * 13) % files.length]!;
    const sid = path.basename(f, ".jsonl");
    const probe = i < 3 ? ` crashprobe${round}x${i}` : "";
    const line = {
      type: "user",
      sessionId: sid,
      uuid: `crash-${round}-${i}`,
      timestamp: new Date(NOW + round * 1000 + i).toISOString(),
      message: { role: "user", content: `round ${round} line ${i}${probe} ${filler}` },
    };
    appendFileSync(f, `${JSON.stringify(line)}\n`);
  }
}

const transcripts = (r: SearchReader): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const s of r.sessions())
    out.set(
      s.key,
      allMessages(r, s.key).map((x) => `${x.field}|${x.at}|${x.text}`),
    );
  return out;
};

describe.skipIf(!existsSync(ENGINE))("crash torture: SIGKILL during commit", () => {
  beforeAll(async () => {
    tmp = tempDir("spgui-crash-");
    m = generate({ out: path.join(tmp.dir, "gen"), profile: "dense", size: 8_000_000, seed: 21, now: NOW });
    child = await bundleChild();
  }, 120_000);
  afterAll(() => tmp?.cleanup());

  it(`${ROUNDS} kills, each recovering clean; then nothing lost and nothing twice`, async () => {
    const e = await engineModule();
    // The first build, whole; then each round has real work in flight when it is killed.
    let t0 = Date.now();
    await runWriter(null);
    const full = Date.now() - t0;
    grow(100);
    t0 = Date.now();
    await runWriter(null);
    const inc = Date.now() - t0;
    let killed = 0;
    let inCommit = 0;
    let rounds = 0;
    const opens: string[] = [];
    const probes: number[] = [];
    // A commit can finish between two polls (a fast disk), and that kill lands outside one:
    // keep going until enough kills hit a commit in flight, up to three times the rounds.
    const wantInCommit = Math.ceil(ROUNDS * 0.6);
    for (let round = 0; round < ROUNDS * 3 && (round < ROUNDS || inCommit < wantInCommit); round++) {
      rounds++;
      // Even rounds: a rebuild beside the live generation. Odd: new bytes appended, then a pass.
      const rebuild = round % 2 === 0;
      if (!rebuild) {
        grow(round);
        probes.push(round);
      }
      const jitter = (round * 7) % 6;
      const r = await runWriter({ jitter, fallback: 0.6 * (rebuild ? full : inc) }, rebuild ? "rebuild" : "once");
      if (r.how === "killed") killed++;
      if (r.inCommit) inCommit++;
      try {
        const rd = await e.openReader({ dir: dir(), sources: BOTH });
        rd.search(eq("error"));
        rd.close();
      } catch (err) {
        opens.push(`round ${round}: ${(err as Error).message}`);
      }
    }
    console.log(
      `crash torture: first build ${full} ms, append pass ${inc} ms, ${killed}/${rounds} kills, ${inCommit} with a commit in flight`,
    );
    expect(opens).toEqual([]);
    expect(killed).toBe(rounds);
    expect(inCommit).toBeGreaterThanOrEqual(wantInCommit);
    // A last, uninterrupted pass; then the index equals the oracle over the same files.
    expect((await runWriter(null)).how).toBe("done");
    const engine = await e.openReader({ dir: dir(), sources: BOTH });
    const env = sourceEnv({ home: home(), stateDir: state(), hostname: "crash-host" });
    const oracle = await loadOracle(env, [...historyAdapters(), eventsAdapter()], { now: () => NOW });
    const te = transcripts(engine);
    const to = transcripts(oracle);
    const diffs: string[] = [];
    for (const [k, v] of to) {
      const w = te.get(k);
      if (!w) diffs.push(`${k}: missing`);
      else if (w.length !== v.length) diffs.push(`${k}: ${w.length} docs, want ${v.length}`);
      else if (new Set(w).size !== w.length && new Set(v).size === v.length) diffs.push(`${k}: a doc twice`);
    }
    for (const k of te.keys()) if (!to.has(k)) diffs.push(`${k}: extra`);
    expect(diffs.slice(0, 10)).toEqual([]);
    const missing: string[] = [];
    for (const round of [100, ...probes])
      for (let i = 0; i < 3; i++) {
        const q = `crashprobe${round}x${i}`;
        const a = engine.search(eq(q)).total;
        const b = oracle.search(eq(q)).total;
        if (a !== 1 || b !== 1)
          missing.push(
            `${q}: engine ${a}, oracle ${b}, engine prefix ${engine.search(eq(`${q.slice(0, 12)}*`)).total}`,
          );
      }
    expect(missing).toEqual([]);
    expect(engine.stats().messages).toBe(oracle.stats().messages);
    // No temp files or unnamed segments survive a writer's recovery.
    const stray: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tmp$/.test(f)) stray.push(path.relative(dir(), p));
      }
    };
    walk(dir());
    expect(stray).toEqual([]);
    engine.close();
    void m;
  }, 300_000);
});
