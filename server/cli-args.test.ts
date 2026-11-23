// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The CLI's flag values: --port and --keep-days take digits only
// (Number() reads "" as 0 and "0x1F90" as 8080), --rp-id takes a host name alone, and a
// flag never takes the next flag as its value. A refused start exits 2 before it listens;
// one that is let through would start a receiver, so each spawn has a short timeout and a
// refusal is checked by its exit code.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it.each([[""], ["  "]])(
    "--rp-id %j is refused",
    (v) => {
      const r = run("--port", "0", "--rp-id", v);
      expect(r.status).toBe(2);
      expect(r.stderr).toBe("sessionpipe-gui: --rp-id needs a host name\n");
    },
    20_000,
  );

  it.each([
    ["https://foo.example"],
    ["https:foo.example"],
    ["foo.example:7373"],
    ["foo.example:443"],
    ["foo.example:7373:"],
    ["host::7373"],
    ["[::1]:7373"],
    ["foo.example/x"],
    ["foo.example/"],
    ["foo.example\\x"],
    ["foo.example?x"],
    ["foo.example#x"],
    ["user@foo.example"],
    [" foo.example"],
    ["foo example"],
  ])(
    "--rp-id %j is refused",
    (v) => {
      const r = run("--port", "0", "--rp-id", v);
      expect(r.status).toBe(2);
      expect(r.stderr).toBe(`sessionpipe-gui: --rp-id is a host name, no scheme, port or path: ${v}\n`);
    },
    20_000,
  );

  it.each([["foo.example"], ["localhost"], ["my-pc.local"], ["192.0.2.5"], ["::1"], ["[::1]"], ["fe80::1"]])(
    "--rp-id %j is taken",
    (v) => {
      // An IP address is let through: whether a browser makes a passkey for one is not
      // the parser's to decide.
      const r = spawnSync(process.execPath, [cli, "--rp-id", v, "--version"], {
        encoding: "utf8",
        timeout: 15_000,
        cwd: tmp.dir,
      });
      expect(r.status).toBe(0);
    },
    20_000,
  );

  it.each([[""], ["  "]])(
    "--allow-host %j is refused",
    (v) => {
      const r = run("--port", "0", "--allow-host", v);
      expect(r.status).toBe(2);
      expect(r.stderr).toBe("sessionpipe-gui: --allow-host needs a host name\n");
    },
    20_000,
  );

  it.each([
    ["https://studio.lan"],
    ["http://studio.lan:8443"],
    ["studio.lan/x"],
    ["studio.lan?x"],
    ["studio.lan#x"],
    ["user@studio.lan"],
    ["*.lan"],
    ["*"],
    ["studio lan"],
    ["[::1]x"],
    ["studio.lan,other.lan"],
    ["0.0.0.0"],
    ["0"],
    ["::"],
    ["[::]:8443"],
    ["::ffff:127.0.0.1"],
  ])(
    "--allow-host %j is refused",
    (v) => {
      // Each started a receiver that answered 403 unknown_host under the name all the same
      // (0.0.0.0, :: and ::ffff: are never taken as a Host: guard.ts notOpenedBy).
      const r = run("--port", "0", "--allow-host", v);
      expect(r.status).toBe(2);
      expect(r.stderr).toBe(
        `sessionpipe-gui: --allow-host is a name this machine is opened by, a port at most: ${v}\n`,
      );
    },
    20_000,
  );

  it.each([
    ["studio.lan"],
    ["studio.lan:8443"],
    ["STUDIO.LAN"],
    ["studio.lan."],
    ["studio.lan/"],
    ["my-pc"],
    ["192.0.2.5"],
    ["192.0.2.5:8443"],
    ["::1"],
    ["[::1]"],
    ["[::1]:8443"],
    ["fe80::1%en0"],
    ["[fe80::1%en0]"],
    ["127.1"],
  ])(
    "--allow-host %j is taken",
    (v) => {
      // The guard reads each of these as a host (a port and case dropped), as before.
      const r = spawnSync(process.execPath, [cli, "--allow-host", v, "--allow-host", "other.lan", "--version"], {
        encoding: "utf8",
        timeout: 15_000,
        cwd: tmp.dir,
      });
      expect(r.status).toBe(0);
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

  // `search` and `index` take a flag written before them, as every other verb does. An
  // empty config.json is one the search CLI refuses by its path, so the message shows which
  // state folder it read, without indexing anything.
  describe("a flag before search or index", () => {
    const bare = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 15_000, cwd: tmp.dir });
    const brokenState = (name: string): string => {
      const dir = path.join(tmp.dir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "config.json"), "");
      return dir;
    };

    it.each([
      ["search", "q"],
      ["index", "--status"],
    ])(
      "--state DIR %s is read from DIR",
      (verb, arg) => {
        const dir = brokenState(`before-${verb}`);
        const r = bare("--state", dir, verb, arg);
        expect(r.stderr).not.toContain("unknown option");
        expect(r.stderr).toContain(path.join(dir, "config.json"));
        expect(r.status).toBe(2);
      },
      20_000,
    );

    it("a state folder named search is still a value", () => {
      brokenState("search");
      const r = bare("--state", "search", "index", "--status");
      expect(r.stderr).not.toContain("unknown option");
      expect(r.stderr).toMatch(/search[\\/]config\.json is empty/);
      expect(r.status).toBe(2);
    }, 20_000);

    it("index --status after --state and --search-home answers", () => {
      const dir = path.join(tmp.dir, "fresh");
      const r = bare("--state", dir, "--search-home", path.join(tmp.dir, "home"), "index", "--status");
      expect(r.stderr).toBe("");
      expect(r.stdout).toMatch(/^(No search index yet|0 sessions · 0 messages)/);
      expect(r.status).toBe(0);
    }, 20_000);

    it.each([
      ["--port", "7000", "search", "q"],
      ["-q", "search", "q"],
      ["--demo", "index", "--ipc"],
    ])(
      "a flag search and index do not take is refused by name: %s",
      (...args) => {
        const r = bare(...args);
        const verb = args.includes("search") ? "search" : "index";
        expect(r.stderr).toBe(`sessionpipe-gui: unknown option ${args[0]} (try ${verb} --help)\n`);
        expect(r.status).toBe(2);
      },
      20_000,
    );

    it.each([
      [["--state", "@other", "--state", "@dir", "search", "q"]],
      [["--state", "@other", "search", "q", "--state", "@dir"]],
      [["--state", "@other", "index", "--status", "--state", "@dir"]],
    ])(
      "the last --state given is the one read: %j",
      (args) => {
        const dir = brokenState("last");
        const other = brokenState("other");
        const r = bare(...args.map((v) => (v === "@dir" ? dir : v === "@other" ? other : v)));
        expect(r.stderr).toContain(path.join(dir, "config.json"));
        expect(r.stderr).not.toContain(other);
        expect(r.status).toBe(2);
      },
      20_000,
    );

    it("after another command it stays an unknown word", () => {
      const r = bare("tls", "status", "search");
      expect(r.stderr).toBe("sessionpipe-gui: unknown option search (try --help)\n");
      expect(r.status).toBe(2);
    }, 20_000);
  });
});
