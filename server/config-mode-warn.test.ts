// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A chmod that fails (a share that refuses it, a file owned by someone else), made to fail
// here so the test runs the same as any user, root included, and touches no real file.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const chmodSync = vi.fn(() => {
    throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
  });
  return { ...fs, chmodSync, default: { ...fs, chmodSync } };
});

const { readGuiConfig, tightenMode } = await import("./config.js");

describe.skipIf(process.platform === "win32")("config.json mode, when the chmod fails", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const looseConfig = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "spg-config-warn-"));
    dirs.push(dir);
    const cfg = { sinkToken: "spg_test", uiKey: "ui_test", createdAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(cfg)}\n`, { mode: 0o644 });
    return dir;
  };
  const ours = (write: { mock: { calls: unknown[][] } }): string[] =>
    write.mock.calls.map((c) => String(c[0])).filter((t) => t.includes("could not take"));

  it("warns once and starts anyway", () => {
    const dir = looseConfig();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(readGuiConfig(dir).uiKey).toBe("ui_test");
    expect(() => readGuiConfig(dir)).not.toThrow();
    expect(ours(write)).toHaveLength(1);
    expect(ours(write)[0]).toMatch(/config\.json \(EPERM/);
  });

  it("says nothing about a file that is not there yet", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    tightenMode(path.join(os.tmpdir(), "spg-config-warn-none", "config.json"));
    expect(ours(write)).toHaveLength(0);
  });
});
