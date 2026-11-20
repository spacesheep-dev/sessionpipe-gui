// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The CLI's flag values: --port and --keep-days take digits only
// (Number() reads "" as 0 and "0x1F90" as 8080), and a flag never takes the next flag as
// its value. A refused start exits 2 before it listens; one that is let through would
// start a receiver, so each spawn has a short timeout and a refusal is checked by its
// exit code.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../test/events.js";

// The CLI itself, bundled from source into the repo's ignored .tmp/ (as runfile.test.ts
// does).
describe("sessionpipe-gui flag values", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  let out: string;
  let cli: string;
  let tmp: { dir: string; cleanup: () => void };
  beforeAll(async () => {
    tmp = tempDir();
    mkdirSync(path.join(root, "..", ".tmp"), { recursive: true });
    out = mkdtempSync(path.join(root, "..", ".tmp", "args-"));
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
  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
    tmp.cleanup();
  });

  // Loopback, no outbox, its own state folder: a start that is let through touches nothing
  // else, and the timeout stops it.
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [cli, "--demo", "--no-outbox", "--quiet", "--host", "127.0.0.1", "--state", path.join(tmp.dir, "s"), ...args],
      // In the temp folder: a parser that takes `--state --no-outbox` makes that folder
      // there, not in the checkout.
      { encoding: "utf8", timeout: 15_000, cwd: tmp.dir },
    );

  it.each([[""], ["  "], ["0x1F90"], ["1e4"], ["80.0"], ["+80"], ["-1"], ["65536"]])(
    "--port %j is refused",
    (v) => {
      const r = run("--port", v);
      expect(r.status).toBe(2);
      expect(r.stderr).toBe("sessionpipe-gui: --port needs a number 0–65535\n");
    },
    20_000,
  );

  it.each([[""], [" "], ["1e1"], ["0x2"], ["1.5"]])(
    "--keep-days %j is refused",
    (v) => {
      const r = run("--port", "0", "--keep-days", v);
      expect(r.status).toBe(2);
      expect(r.stderr).toBe("sessionpipe-gui: --keep-days needs a whole number of days\n");
    },
    20_000,
  );

  it.each([
    ["--host", "--no-tls"],
    ["--port", "--demo"],
    ["--keep-days", "--quiet"],
    ["--state", "--no-outbox"],
    ["--replay", "--speed"],
    ["--allow-host", "--"],
  ])(
    "%s %s: the flag needs a value",
    (flag, value) => {
      const r = run("--port", "0", flag, value);
      expect(r.status).toBe(2);
      expect(r.stderr).toBe(`sessionpipe-gui: ${flag} needs a value\n`);
    },
    20_000,
  );

  it("digits still parse, with leading zeros", () => {
    // --version answers where it stands, after the flags before it parsed.
    const r = spawnSync(process.execPath, [cli, "--port", "07373", "--keep-days", "0", "--version"], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: tmp.dir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+/);
  }, 20_000);

  it("a value that starts with one dash is still a value", () => {
    // Only "--" marks the next flag; a lone "-" or "-name" (a folder, a host) is taken as is.
    const r = spawnSync(process.execPath, [cli, "--state", "-", "--rp-id", "-x", "--version"], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: tmp.dir,
    });
    expect(r.status).toBe(0);
  }, 20_000);
});
