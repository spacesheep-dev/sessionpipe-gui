// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. Crash torture (SEARCH-SPEC.md §8.4): the writer runs in a child over
// a generated home and is SIGKILLed 20 times at the first segment or MANIFEST commit of a pass,
// at a point it reports: its .tmp cut to half its bytes, or just before or after its rename.
// Kills at random moments are server/search/engine/crash.test.ts's. New bytes are appended
// between rounds. After every kill a reader must open clean and serve no fewer docs than it
// did before; after a last full pass the index must hold exactly the docs the oracle holds:
// none lost, none twice.
import { type ChildProcess, fork } from "node:child_process";
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
const writers = new Set<ChildProcess>();
let stopped = false;
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
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { runIndexer } from ${JSON.stringify(ENGINE)};
import { eventsAdapter, historyAdapters, sourceEnv } from ${JSON.stringify(path.join(ROOT, "server/search/sources/index.ts"))};
const [home, stateDir, dir, how, checkpoint] = process.argv.slice(2);
// Only this test's killed writers pause. Normal passes use the real fs unchanged.
if (checkpoint) {
  const [kind, side] = checkpoint.split(":");
  const { renameSync: rename, openSync: open, fsyncSync: fsync } = fs;
  const { writeSync: write, readSync: read } = fs;
  const target = (p) => {
    const name = basename(p);
    return kind === "manifest" ? name === "MANIFEST" : /^seg-\\d+\\.sps$/.test(name);
  };
  const pause = (at) => {
    // A synchronous pipe write works even while the indexer owns the event loop.
    write(4, "commit " + at + "\\n");
    // The parent never releases this pipe. EOF also ends the child if its parent dies.
    read(5, Buffer.alloc(1), 0, 1, null);
    throw new Error("commit barrier closed without SIGKILL");
  };
  // "torn": the target's .tmp, fully written, is cut to half its bytes at its fsync, then parks.
  const torn = new Map();
  fs.openSync = (p, ...rest) => {
    const fd = open(p, ...rest);
    const s = String(p);
    if (side === "torn" && s.endsWith(".tmp") && target(s.slice(0, -4))) torn.set(fd, s);
    return fd;
  };
  // codec.ts fsyncs both kinds once, after their last write and before the rename.
  fs.fsyncSync = (fd) => {
    if (!torn.has(fd)) return fsync(fd);
    fs.ftruncateSync(fd, fs.fstatSync(fd).size >> 1);
    pause(torn.get(fd));
  };
  fs.renameSync = (from, to) => {
    const match = String(from) === String(to) + ".tmp" && target(String(to));
    if (match && side === "before") pause(String(to));
    rename(from, to);
    if (match && side === "after") pause(String(to));
  };
  syncBuiltinESMExports();
}
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

/** Runs the writer; with `checkpoint`, the child parks at that commit point and names the file
 *  on fd 4, and the parent SIGKILLs it there. `at` is that file, or "" if none was reached. */
function runWriter(
  checkpoint: string | null,
  how: "once" | "rebuild" = "once",
): Promise<{ how: "killed" | "done"; at: string }> {
  return new Promise((resolve, reject) => {
    if (stopped) return reject(new Error("crash test has finished"));
    const c = fork(child, [home(), state(), dir(), how, checkpoint ?? ""], {
      stdio: ["ignore", "ignore", "pipe", "ipc", "pipe", "pipe"],
    });
    writers.add(c);
    let at = "";
    let signal = "";
    let stderr = "";
    c.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    c.stdio[4]?.on("data", (data: Buffer) => {
      signal += data.toString();
      const hit = /^commit (.*)\n/.exec(signal);
      if (checkpoint && !at && hit) {
        at = hit[1]!;
        c.kill("SIGKILL");
      }
    });
    c.on("error", reject);
    c.on("exit", (code, sig) => {
      writers.delete(c);
      if (sig === "SIGKILL") resolve({ how: "killed", at });
      else if (code === 0) resolve({ how: "done", at: "" });
      else reject(new Error(`writer exited ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`));
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
  afterAll(() => {
    stopped = true;
    for (const c of writers) c.kill("SIGKILL");
    writers.clear();
    tmp?.cleanup();
  }, 60_000);

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
    const opens: string[] = [];
    // Docs a reader saw once stay: a kill never takes back a commit (grow only appends).
    const lost: string[] = [];
    const warm = await e.openReader({ dir: dir(), sources: BOTH });
    let committed = warm.stats().messages;
    warm.close();
    const probes: number[] = [];
    const hits = new Set<string>();
    // The first segment or MANIFEST commit of the pass: its .tmp half-written, just before its
    // rename, just after. With 20 rounds, each point is hit in a rebuild and in an append pass.
    const sides = ["torn", "before", "after"];
    const checkpoints = [...sides.map((s) => `segment:${s}`), ...sides.map((s) => `manifest:${s}`)];
    for (let round = 0; round < ROUNDS; round++) {
      // Even rounds: a rebuild beside the live generation. Odd: new bytes appended, then a pass.
      const rebuild = round % 2 === 0;
      if (!rebuild) {
        grow(round);
        probes.push(round);
      }
      const checkpoint = checkpoints[Math.floor(round / 2) % checkpoints.length]!;
      const r = await runWriter(checkpoint, rebuild ? "rebuild" : "once");
      if (r.how === "done")
        throw new Error(
          `round ${round}: the writer finished without reaching ${checkpoint}; did the engine's segment/MANIFEST commit change?`,
        );
      if (!r.at) throw new Error(`round ${round}: the writer was SIGKILLed before ${checkpoint}, not by this test`);
      hits.add(`${checkpoint} ${path.relative(dir(), r.at).replace(/seg-\d+/, "seg-N")}`);
      try {
        const rd = await e.openReader({ dir: dir(), sources: BOTH });
        rd.search(eq("error"));
        const n = rd.stats().messages;
        if (n < committed) lost.push(`round ${round} (${checkpoint}): ${n} messages, ${committed} before`);
        committed = Math.max(committed, n);
        rd.close();
      } catch (err) {
        opens.push(`round ${round}: ${(err as Error).message}`);
      }
    }
    console.log(
      `crash torture: first build ${full} ms, append pass ${inc} ms, ${ROUNDS} kills at: ${[...hits].sort().join(", ")}`,
    );
    expect(opens).toEqual([]);
    expect(lost).toEqual([]);
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
  }, 900_000);
});
