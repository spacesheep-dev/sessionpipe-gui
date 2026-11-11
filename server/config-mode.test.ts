// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGuiConfig, setTlsPreference, tightenMode } from "./config.js";

// Node applies writeFileSync's `mode` only when it makes the file; config.json holds the
// sink token and the UI key, so a write must leave it at 0600 even when it was looser.
describe.skipIf(process.platform === "win32")("config.json mode", () => {
  let dir: string;
  let file: string;
  const mode = (): number => statSync(file).mode & 0o777;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "spg-config-mode-"));
    file = path.join(dir, "config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is made at 0600", () => {
    readGuiConfig(dir);
    expect(mode()).toBe(0o600);
  });

  it("goes to 0600 when a missing secret is written into a 0644 file", () => {
    // SECURITY.md's way to a new UI key: delete `uiKey`, saved by an editor at umask 022.
    writeFileSync(file, `${JSON.stringify({ sinkToken: "spg_test", createdAt: "2026-01-01T00:00:00.000Z" })}\n`);
    chmodSync(file, 0o644);
    const cfg = readGuiConfig(dir);
    expect(cfg.sinkToken).toBe("spg_test");
    expect(mode()).toBe(0o600);
  });

  it("goes to 0600 when a complete 0644 file is written again", () => {
    const cfg = readGuiConfig(dir);
    chmodSync(file, 0o644);
    setTlsPreference(dir, cfg, !cfg.tls);
    expect(mode()).toBe(0o600);
  });

  it("goes to 0600 on a plain start, when a complete file is only read", () => {
    // Copied back from a backup or another machine: nothing is missing, so nothing is written.
    const cfg = readGuiConfig(dir);
    chmodSync(file, 0o640);
    expect(readGuiConfig(dir)).toEqual(cfg);
    expect(mode()).toBe(0o600);
  });

  it("leaves the bits alone on Windows, where they are not the file's access rules", () => {
    readGuiConfig(dir);
    chmodSync(file, 0o644);
    tightenMode(file, "win32");
    expect(mode()).toBe(0o644);
  });

  it("keeps the owner's own bits, so a read-only file is not made writable", () => {
    readGuiConfig(dir);
    chmodSync(file, 0o444);
    tightenMode(file);
    expect(mode()).toBe(0o400);
  });
});
