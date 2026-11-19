// SPDX-License-Identifier: Apache-2.0
// Two receivers on one state folder, as two real processes (the CLI bundled from source, as
// keyCommand.test.ts does): a stale copy of config.json landing after a new key, and an
// older writer that drops the retired list while writing a retired key back. Both end on
// the newest key, the retired one is refused at both, the list is back, and the file stops
// changing.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES, UI_KEY_COOKIE } from "../shared/api.js";
import { tempDir } from "../test/events.js";
import { hashSecret, RETIRED_MAX } from "./config.js";
import { listDoors } from "./localDoor.js";

const PUBLIC = "https://box.tail1234.ts.net";
/** A visitor through the proxy: never this computer, so the key decides. */
const VISITOR = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };

const root = path.dirname(fileURLToPath(import.meta.url));
let out: string;
let cli: string;
beforeAll(async () => {
  mkdirSync(path.join(root, "..", ".tmp"), { recursive: true });
  out = mkdtempSync(path.join(root, "..", ".tmp", "keyshared-"));
  cli = path.join(out, "cli.js");
  await build({
    entryPoints: [path.join(root, "cli.ts")],
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await sleep(100);
  expect(await cond()).toBe(true);
}

describe("two receivers on one folder", () => {
  it("a stale copy after a new key, and an older writer's: both end on the newest key and stop writing", async () => {
    const tmp = tempDir("spgui-keyshared-");
    const dir = path.join(tmp.dir, "state");
    const procs: ChildProcess[] = [];
    const start = (): ChildProcess => {
      const p = spawn(
        process.execPath,
        [
          cli,
          "--port",
          "0",
          "--host",
          "127.0.0.1",
          "--state",
          dir,
          "--no-outbox",
          "--quiet",
          "--public-url",
          PUBLIC,
          "--search-home",
          path.join(tmp.dir, "h"),
        ],
        { stdio: "ignore" },
      );
      procs.push(p);
      return p;
    };
    const file = path.join(dir, "config.json");
    const disk = () => JSON.parse(readFileSync(file, "utf8")) as { uiKey: string; retired?: string[] };
    const at = (port: number, key: string) =>
      fetch(`http://127.0.0.1:${port}${ROUTES.ui.info}`, {
        headers: { ...VISITOR, cookie: `${UI_KEY_COOKIE}=${key}` },
      }).then((r) => r.status);
    const land = (text: string) => {
      writeFileSync(`${file}.landing`, text, { mode: 0o600 });
      renameSync(`${file}.landing`, file);
    };
    try {
      start();
      await until(() => listDoors(dir).length === 1);
      const portA = listDoors(dir)[0]!.port;
      const stale = readFileSync(file, "utf8");
      const k1 = disk().uiKey;
      expect((await fetch(`http://127.0.0.1:${portA}${ROUTES.ui.renewKey}`, { method: "POST" })).status).toBe(204);
      const k2 = disk().uiKey;
      expect(k2).not.toBe(k1);
      start();
      await until(() => listDoors(dir).length === 2);
      const portB = listDoors(dir).find((d) => d.port !== portA)!.port;
      expect(await at(portB, k2)).toBe(200);

      // The stale copy (from before the new key, no retired list) lands.
      land(stale);
      await until(async () => disk().uiKey === k2 && (await at(portA, k1)) === 401 && (await at(portB, k1)) === 401);
      expect(disk().retired).toContain(hashSecret(k1));
      await sleep(3000);
      const m1 = statSync(file).mtimeMs;
      await sleep(4000);
      expect(statSync(file).mtimeMs).toBe(m1);
      expect(await at(portA, k2)).toBe(200);
      expect(await at(portB, k2)).toBe(200);

      // An older writer: the retired key back, the retired list dropped, its own field kept.
      const { retired: _gone, ...older } = { ...disk(), uiKey: k1, olderField: true } as Record<string, unknown>;
      land(`${JSON.stringify(older, null, 2)}\n`);
      await until(() => disk().uiKey === k2 && (disk().retired ?? []).includes(hashSecret(k1)));
      expect((disk() as unknown as { olderField?: boolean }).olderField).toBe(true);
      expect(await at(portA, k1)).toBe(401);
      expect(await at(portB, k1)).toBe(401);
      await sleep(3000);
      const m2 = statSync(file).mtimeMs;
      await sleep(4000);
      expect(statSync(file).mtimeMs).toBe(m2);
    } finally {
      for (const p of procs) p.kill("SIGTERM");
      await sleep(1000);
      tmp.cleanup();
    }
  }, 120_000);

  it("a retired list already at its cap: one new key, and the file settles with the right key at both", async () => {
    const tmp = tempDir("spgui-keycap-");
    const dir = path.join(tmp.dir, "state");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    const seed = Array.from({ length: RETIRED_MAX }, () => randomBytes(32).toString("hex"));
    writeFileSync(
      file,
      `${JSON.stringify({ sinkToken: `spg_${randomBytes(24).toString("base64url")}`, uiKey: randomBytes(12).toString("base64url"), createdAt: new Date().toISOString(), retired: seed }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const procs: ChildProcess[] = [];
    const at = (port: number, key: string) =>
      fetch(`http://127.0.0.1:${port}${ROUTES.ui.info}`, {
        headers: { ...VISITOR, cookie: `${UI_KEY_COOKIE}=${key}` },
      }).then((r) => r.status);
    try {
      for (let i = 0; i < 2; i++)
        procs.push(
          spawn(
            process.execPath,
            [
              cli,
              "--port",
              "0",
              "--host",
              "127.0.0.1",
              "--state",
              dir,
              "--no-outbox",
              "--quiet",
              "--public-url",
              PUBLIC,
              "--search-home",
              path.join(tmp.dir, "h"),
            ],
            { stdio: "ignore" },
          ),
        );
      await until(() => listDoors(dir).length === 2);
      const [a, b] = listDoors(dir).map((d) => d.port) as [number, number];
      const k1 = (JSON.parse(readFileSync(file, "utf8")) as { uiKey: string }).uiKey;
      expect((await fetch(`http://127.0.0.1:${a}${ROUTES.ui.renewKey}`, { method: "POST" })).status).toBe(204);
      const k2 = (JSON.parse(readFileSync(file, "utf8")) as { uiKey: string }).uiKey;
      expect(k2).not.toBe(k1);
      await until(async () => (await at(a, k2)) === 200 && (await at(b, k2)) === 200);
      // Settled: the file stops changing within a few seconds.
      await sleep(4000);
      const m = statSync(file).mtimeMs;
      await sleep(4000);
      expect(statSync(file).mtimeMs).toBe(m);
      const kept = JSON.parse(readFileSync(file, "utf8")) as { uiKey: string; retired: string[] };
      expect(kept.uiKey).toBe(k2);
      expect(kept.retired).toHaveLength(RETIRED_MAX);
      expect(kept.retired).toContain(hashSecret(k1));
      expect(await at(a, k1)).toBe(401);
      expect(await at(b, k1)).toBe(401);
      expect(await at(a, k2)).toBe(200);
      expect(await at(b, k2)).toBe(200);
    } finally {
      for (const p of procs) p.kill("SIGTERM");
      await sleep(1000);
      tmp.cleanup();
    }
  }, 120_000);
});
