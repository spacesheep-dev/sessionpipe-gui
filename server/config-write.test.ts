// SPDX-License-Identifier: Apache-2.0
// config.json is written whole by a file only this user can read: a new name each time,
// made by the write itself (nothing planted at a name is written through, a symbolic link
// least of all), and a symbolic link at config.json is replaced, never followed or
// chmodded. The fields this version does not know are kept.
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGuiConfig, renewUiKey, rotateSinkToken } from "./config.js";

let dir: string;
let outside: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "spg-config-write-"));
  outside = mkdtempSync(path.join(os.tmpdir(), "spg-config-outside-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("the config write", () => {
  it("writes through nothing planted at the old temp name, and leaves no file beside config.json", () => {
    const cfg = readGuiConfig(dir);
    const victim = path.join(outside, "readable-by-others");
    writeFileSync(victim, "x");
    chmodSync(victim, 0o666);
    symlinkSync(victim, path.join(dir, `config.json.${process.pid}.tmp`));
    const next = renewUiKey(dir, cfg);
    expect(readFileSync(victim, "utf8")).toBe("x");
    expect(statSync(victim).mode & 0o777).toBe(0o666);
    expect(lstatSync(path.join(dir, "config.json")).isSymbolicLink()).toBe(false);
    expect(statSync(path.join(dir, "config.json")).mode & 0o777).toBe(0o600);
    expect(readGuiConfig(dir).uiKey).toBe(next.uiKey);
    expect(readdirSync(dir).sort()).toEqual(["config.json", `config.json.${process.pid}.tmp`]);
  });

  it("replaces a symbolic link at config.json, and leaves its target and the target's mode alone", () => {
    const cfg = readGuiConfig(dir);
    const target = path.join(outside, "target.json");
    writeFileSync(target, JSON.stringify(cfg));
    chmodSync(target, 0o644);
    rmSync(path.join(dir, "config.json"));
    symlinkSync(target, path.join(dir, "config.json"));
    // A read takes no bits off the link's target either.
    readGuiConfig(dir);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    renewUiKey(dir, cfg);
    expect(lstatSync(path.join(dir, "config.json")).isSymbolicLink()).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(JSON.parse(readFileSync(target, "utf8")).uiKey).toBe(cfg.uiKey);
  });

  it("keeps the fields it does not know through every rewrite", () => {
    readGuiConfig(dir);
    const f = path.join(dir, "config.json");
    const raw = JSON.parse(readFileSync(f, "utf8"));
    raw.futureField = { keep: true };
    writeFileSync(f, JSON.stringify(raw));
    renewUiKey(dir, readGuiConfig(dir));
    rotateSinkToken(dir, readGuiConfig(dir));
    expect(JSON.parse(readFileSync(f, "utf8")).futureField).toEqual({ keep: true });
  });
});
