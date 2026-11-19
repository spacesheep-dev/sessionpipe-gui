// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. config.json on disk: a file that does not parse or cannot be
// read stops the read and is left as it was (it holds the sink token and the UI key), a
// byte-order mark is read past, a missing file gets fresh secrets, and the CLI stops with
// the message before it writes anything.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../test/events.js";
import { ConfigError, readGuiConfig, setTlsPreference } from "./config.js";

const KEPT = { sinkToken: "spg_test_keepme", uiKey: "uik_keepme", createdAt: "2026-01-01T00:00:00.000Z" };
const BOM = String.fromCharCode(0xfeff);

let tmp: { dir: string; cleanup: () => void };
let file: string;
beforeAll(() => {
  tmp = tempDir();
});
afterAll(() => tmp.cleanup());
afterEach(() => rmSync(file, { recursive: true, force: true }));

const fresh = (name: string): string => {
  const dir = path.join(tmp.dir, name);
  mkdirSync(dir, { recursive: true });
  file = path.join(dir, "config.json");
  return dir;
};

describe("readGuiConfig", () => {
  it("reads a config.json with a byte-order mark, and writes it back without one", () => {
    const dir = fresh("bom");
    writeFileSync(file, `${BOM}${JSON.stringify({ ...KEPT, tls: true }, null, 2)}\n`);
    const before = readFileSync(file);
    const cfg = readGuiConfig(dir);
    expect(cfg).toMatchObject({ ...KEPT, tls: true });
    // Nothing was missing, so nothing was written: the file is as the person saved it.
    expect(readFileSync(file).equals(before)).toBe(true);
    // The next write is in the GUI's own format.
    setTlsPreference(dir, cfg, false);
    const text = readFileSync(file, "utf8");
    expect(text.startsWith(BOM)).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ ...KEPT, tls: false });
  });

  it("stops on a config.json that does not parse, leaving it byte for byte, and never quotes it", () => {
    const dir = fresh("cut");
    // What a write that died halfway leaves (the token's first bytes, no closing quote), and
    // a bare token, which V8's own message would quote in full.
    for (const text of ['{\n  "sinkToken": "spg_test_keepme', "spg_test_keepme"]) {
      writeFileSync(file, text);
      let err: unknown;
      try {
        readGuiConfig(dir);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      const m = (err as Error).message;
      expect(m).toContain(file);
      expect(m).toMatch(/is not valid JSON/);
      expect(m).toMatch(/not written over/);
      expect(m).toMatch(/sink token/);
      expect(m).toMatch(/move it aside/);
      expect(m).not.toContain("keepme");
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });

  it("stops on a config.json that is valid JSON but not an object", () => {
    const dir = fresh("array");
    for (const text of ["null", "[]", '"spg_test_keepme"', "42"]) {
      writeFileSync(file, text);
      expect(() => readGuiConfig(dir)).toThrow(ConfigError);
      expect(() => readGuiConfig(dir)).toThrow(/is not a JSON object/);
      expect(() => readGuiConfig(dir)).not.toThrow(/keepme/);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });

  it("stops on a config.json that cannot be read, such as a folder of that name", () => {
    const dir = fresh("folder");
    mkdirSync(file);
    let err: unknown;
    try {
      readGuiConfig(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const m = (err as Error).message;
    expect(m).toContain(file);
    expect(m).toMatch(/could not be read \(EISDIR\)/);
    expect(m).toMatch(/not written over/);
    expect(m).toMatch(/move it aside/);
    // Still the folder it was, with nothing written into it.
    expect(readdirSync(file)).toEqual([]);
  });

  it("stops on an empty config.json (what a write that died at once leaves), never writing it", () => {
    const dir = fresh("blank");
    for (const text of ["", "\n  \n"]) {
      writeFileSync(file, text);
      expect(() => readGuiConfig(dir)).toThrow(ConfigError);
      expect(() => readGuiConfig(dir)).toThrow(/is empty, so it was not written over/);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });

  it("a missing config.json is the first run: fresh secrets, written", () => {
    const dir = fresh("missing");
    const cfg = readGuiConfig(dir);
    expect(cfg.sinkToken).toMatch(/^spg_/);
    expect(cfg.uiKey).not.toBe("");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ sinkToken: cfg.sinkToken, uiKey: cfg.uiKey });
  });

  it("fills in a missing secret and keeps the rest", () => {
    const dir = fresh("partial");
    writeFileSync(file, JSON.stringify({ sinkToken: KEPT.sinkToken, tls: true }));
    const cfg = readGuiConfig(dir);
    expect(cfg.sinkToken).toBe(KEPT.sinkToken);
    expect(cfg.uiKey).not.toBe("");
    expect(cfg.tls).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      sinkToken: KEPT.sinkToken,
      uiKey: cfg.uiKey,
      tls: true,
    });
  });
});

// The CLI itself, bundled from source into the repo's ignored .tmp/ (as runfile.test.ts
// does), started on a state dir whose config.json does not parse.
describe("sessionpipe-gui with a config.json that does not parse", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  let out: string;
  let cli: string;
  beforeAll(async () => {
    mkdirSync(path.join(root, "..", ".tmp"), { recursive: true });
    out = mkdtempSync(path.join(root, "..", ".tmp", "config-"));
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

  const cut = '{"sinkToken": "spg_test_keepme", "uiKey": "uik_keepme"';

  it("a start stops with the message, exit 2, the file untouched", () => {
    const dir = fresh("cli-start");
    writeFileSync(file, cut);
    const r = spawnSync(
      process.execPath,
      [cli, "--no-outbox", "--quiet", "--host", "127.0.0.1", "--port", "0", "--state", dir],
      {
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^sessionpipe-gui: .*config\.json is not valid JSON/m);
    expect(r.stderr).not.toMatch(/^\s+at /m);
    expect(readFileSync(file, "utf8")).toBe(cut);
    // Nothing else was made: no store, no run.json, no search folder.
    expect(readdirSync(dir)).toEqual(["config.json"]);
  }, 20_000);

  it("a config.json that is a folder stops a start the same way", () => {
    const dir = fresh("cli-folder");
    mkdirSync(file);
    const r = spawnSync(
      process.execPath,
      [cli, "--no-outbox", "--quiet", "--host", "127.0.0.1", "--port", "0", "--state", dir],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^sessionpipe-gui: .*config\.json could not be read \(EISDIR\)/m);
    expect(r.stderr).not.toMatch(/^\s+at /m);
    expect(readdirSync(dir)).toEqual(["config.json"]);
    expect(readdirSync(file)).toEqual([]);
  }, 20_000);

  it("`plugin list` stops the same way", () => {
    const dir = fresh("cli-list");
    writeFileSync(file, cut);
    const r = spawnSync(process.execPath, [cli, "plugin", "list", "--state", dir], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/config\.json is not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe(cut);
  }, 20_000);
});
