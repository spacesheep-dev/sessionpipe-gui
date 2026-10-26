// SPDX-License-Identifier: Apache-2.0
// run.json: written atomically, read back only while its pid lives, removed only by its
// owner; and the real thing: a receiver started from the CLI writes it on listen and
// removes it on SIGTERM and SIGINT.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pidAlive, readRunFile, readRunFileRaw, removeRunFile, runFilePath, writeRunFile } from "./runfile.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "spgui-run-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const info = (pid = process.pid) => ({
  port: 7827,
  pid,
  version: "0.2.0",
  url: "http://127.0.0.1:7827",
  startedAt: new Date().toISOString(),
});

describe("run.json", () => {
  it("is written atomically (no temporary file left) and read back", () => {
    const r = info();
    writeRunFile(dir, r);
    expect(readdirSync(dir)).toEqual(["run.json"]);
    expect(readRunFile(dir)).toEqual(r);
  });

  it("is ignored when its pid is dead (a crash) or when it is malformed", () => {
    // A pid that was alive and is not now.
    const child = spawn(process.execPath, ["-e", ""]);
    const pid = child.pid!;
    return new Promise<void>((resolve) =>
      child.on("exit", () => {
        writeRunFile(dir, info(pid));
        expect(pidAlive(pid)).toBe(false);
        expect(readRunFileRaw(dir)?.pid).toBe(pid);
        expect(readRunFile(dir)).toBeNull();
        writeFileSync(runFilePath(dir), "{ not json");
        expect(readRunFile(dir)).toBeNull();
        writeFileSync(runFilePath(dir), JSON.stringify({ port: "7827", pid: 1 }));
        expect(readRunFile(dir)).toBeNull();
        resolve();
      }),
    );
  });

  it("is removed only by the process that wrote it", () => {
    writeRunFile(dir, info(process.pid + 100000));
    expect(removeRunFile(dir)).toBe(false);
    expect(existsSync(runFilePath(dir))).toBe(true);
    writeRunFile(dir, info());
    expect(removeRunFile(dir)).toBe(true);
    expect(existsSync(runFilePath(dir))).toBe(false);
    expect(removeRunFile(dir)).toBe(false);
  });

  it("treats pid 1 (someone else's, EPERM) as alive and pid 0 as not", () => {
    expect(pidAlive(1)).toBe(true);
    expect(pidAlive(0)).toBe(false);
  });
});

// The CLI itself, bundled from source into the repo's ignored .tmp/ (so its packages
// resolve), started as a demo receiver on a free port with a scratch state dir.
describe("the receiver's run.json lifecycle", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let out: string;
  let cli: string;
  beforeAll(async () => {
    mkdirSync(path.join(root, ".tmp"), { recursive: true });
    out = mkdtempSync(path.join(root, ".tmp", "runfile-"));
    cli = path.join(out, "cli.js");
    await build({
      entryPoints: [path.join(root, "server/cli.ts")],
      outfile: cli,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "external",
      logLevel: "silent",
    });
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const start = (state: string): ChildProcess =>
    spawn(
      process.execPath,
      [cli, "--demo", "--no-outbox", "--quiet", "--host", "127.0.0.1", "--port", "0", "--state", state],
      { stdio: "ignore" },
    );
  const waitFor = async (cond: () => boolean, ms = 10_000) => {
    const until = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > until) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`is written on listen and removed on ${signal}`, async () => {
      const state = path.join(dir, "state");
      const child = start(state);
      try {
        await waitFor(() => readRunFile(state) !== null);
        const r = readRunFile(state)!;
        expect(r.pid).toBe(child.pid);
        expect(r.port).toBeGreaterThan(0);
        expect(r.url).toBe(`http://127.0.0.1:${r.port}`);
        const res = await fetch(`${r.url}/api/ui/info`);
        expect(((await res.json()) as { name: string }).name).toBe("sessionpipe-gui");
        const exited = new Promise((resolve) => child.on("exit", resolve));
        child.kill(signal);
        await exited;
        expect(existsSync(runFilePath(state))).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);
  }

  it("a killed receiver leaves a stale file that readers ignore", async () => {
    const state = path.join(dir, "state");
    const child = start(state);
    await waitFor(() => readRunFile(state) !== null);
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect(readRunFileRaw(state)?.pid).toBe(child.pid);
    expect(readRunFile(state)).toBeNull();
  }, 20_000);
});
