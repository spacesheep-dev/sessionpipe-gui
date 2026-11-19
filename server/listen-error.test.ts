// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. A receiver that cannot listen says which flag to change: --port
// for a port in use or not open to this user, --host for an address that is not this
// machine's or a name that does not look up. 192.0.2.1 is a documentation address
// (RFC 5737) that no machine has; .invalid never resolves (RFC 6761).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../test/events.js";
import { DEFAULT_HOST, listenErrorMessage } from "./listen-error.js";

/** The error a real listen on host:port gives (undefined when it listens). */
const listenError = (host: string, port: number): Promise<NodeJS.ErrnoException | undefined> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (e) => resolve(e as NodeJS.ErrnoException));
    s.listen(port, host, () => s.close(() => resolve(undefined)));
  });

const OTHER_HOST = "try another --host, or --host 0.0.0.0 to listen on every address";

// A machine set to bind any address (Linux's ip_nonlocal_bind) listens on 192.0.2.1:
// the tests that need it refused say so and skip there.
const nonLocalBinds = async (): Promise<boolean> => (await listenError("192.0.2.1", 0)) === undefined;

describe("listenErrorMessage", () => {
  it("a port in use names --port, as before", async () => {
    const held = net.createServer();
    await new Promise<void>((r) => held.listen(0, "127.0.0.1", r));
    const port = (held.address() as net.AddressInfo).port;
    try {
      const err = await listenError("127.0.0.1", port);
      expect(err?.code).toBe("EADDRINUSE");
      expect(listenErrorMessage(err, "127.0.0.1", port)).toBe(`port ${port} is in use (try --port)`);
    } finally {
      await new Promise((r) => held.close(r));
    }
  });

  it("an address that is not this machine's names --host and the default", async (ctx) => {
    if (await nonLocalBinds()) ctx.skip();
    const err = await listenError("192.0.2.1", 0);
    expect(err?.code).toBe("EADDRNOTAVAIL");
    expect(listenErrorMessage(err, "192.0.2.1", 0)).toBe(
      `--host 192.0.2.1 is not an address of this machine (${OTHER_HOST})`,
    );
    expect(DEFAULT_HOST).toBe("0.0.0.0");
  });

  // The shapes Node gives (net's listen on 127.0.0.1:80 as a user, and its lookup of a
  // name that does not resolve, or of any name with no network): an EACCES depends on the
  // machine, and a lookup on its resolver, so they are built here.
  const shaped = (code: string, syscall: string, extra: object = {}) =>
    Object.assign(new Error(`${syscall} ${code}`), { code, syscall, ...extra });

  it("a port this user may not open names --port; root only below 1024, and not on Windows", () => {
    const eacces = (port: number) => shaped("EACCES", "listen", { address: "127.0.0.1", port });
    expect(listenErrorMessage(eacces(80), "127.0.0.1", 80, "linux")).toBe(
      "port 80 is not open to this user (try another --port; ports below 1024 are kept for root)",
    );
    expect(listenErrorMessage(eacces(7373), "127.0.0.1", 7373, "darwin")).toBe(
      "port 7373 is not open to this user (try another --port)",
    );
    // macOS opens a low port to any user on every address, and refuses it on one.
    expect(listenErrorMessage(eacces(80), "127.0.0.1", 80, "darwin")).toBe(
      "port 80 is open to this user only on every address (try another --port, or --host 0.0.0.0)",
    );
    // An excluded port range, or a port another program holds exclusively.
    expect(listenErrorMessage(eacces(7373), "127.0.0.1", 7373, "win32")).toBe(
      "port 7373 is reserved by Windows or held by another program (try another --port)",
    );
  });

  it("a name that looks up to an address this machine lacks says which", () => {
    const err = shaped("EADDRNOTAVAIL", "listen", { address: "::1", port: 7373 });
    expect(listenErrorMessage(err, "localhost", 7373)).toBe(
      `--host localhost is not an address of this machine, it looks up to ::1 (${OTHER_HOST})`,
    );
  });

  it("a name that does not look up names --host, whether the answer is no or not now", () => {
    const host = "not-a-real-host.invalid";
    expect(listenErrorMessage(shaped("ENOTFOUND", "getaddrinfo", { hostname: host }), host, 0)).toBe(
      `--host ${host} is not a name this machine can look up (${OTHER_HOST})`,
    );
    expect(listenErrorMessage(shaped("EAI_AGAIN", "getaddrinfo", { hostname: host }), host, 0)).toBe(
      `--host ${host} could not be looked up just now (${OTHER_HOST})`,
    );
  });

  it("leaves every other error to its own message", () => {
    // The same codes from something other than the bind on this port or the lookup of --host.
    expect(listenErrorMessage(shaped("EACCES", "mkdir", { path: "/x" }), DEFAULT_HOST, 7373)).toBeUndefined();
    expect(listenErrorMessage(shaped("EACCES", "open"), DEFAULT_HOST, 7373)).toBeUndefined();
    expect(listenErrorMessage(shaped("EADDRINUSE", "listen", { port: 9000 }), DEFAULT_HOST, 7373)).toBeUndefined();
    expect(
      listenErrorMessage(shaped("ENOTFOUND", "getaddrinfo", { hostname: "other.invalid" }), "a.invalid", 0),
    ).toBeUndefined();
    expect(listenErrorMessage(shaped("ECONNRESET", "listen", { port: 7373 }), DEFAULT_HOST, 7373)).toBeUndefined();
    expect(listenErrorMessage(new Error("plain"), DEFAULT_HOST, 7373)).toBeUndefined();
    expect(listenErrorMessage(undefined, DEFAULT_HOST, 7373)).toBeUndefined();
    expect(listenErrorMessage(null, DEFAULT_HOST, 7373)).toBeUndefined();
  });
});

// The CLI itself, bundled from source into the repo's ignored .tmp/ (as runfile.test.ts
// does), started in demo mode (no history indexer) on a --host it cannot listen on.
describe("sessionpipe-gui on a --host it cannot listen on", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  let out: string;
  let cli: string;
  let tmp: { dir: string; cleanup: () => void };
  beforeAll(async () => {
    tmp = tempDir();
    mkdirSync(path.join(root, "..", ".tmp"), { recursive: true });
    out = mkdtempSync(path.join(root, "..", ".tmp", "listen-"));
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

  const start = (host: string) => {
    const { SPGUI_SEARCH_HOME: _, ...env } = process.env;
    return spawnSync(
      process.execPath,
      [cli, "--demo", "--no-outbox", "--quiet", "--host", host, "--port", "0", "--state", path.join(tmp.dir, "s")],
      // On a busy machine the start up to the bind, and a name that does not look up, can
      // each take many seconds.
      { encoding: "utf8", timeout: 90_000, env },
    );
  };

  it("an address that is not this machine's: exit 2 and a line naming --host", async (ctx) => {
    if (await nonLocalBinds()) ctx.skip();
    const r = start("192.0.2.1");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^sessionpipe-gui: --host 192\.0\.2\.1 is not an address of this machine \(/m);
    expect(r.stderr).not.toMatch(/EADDRNOTAVAIL/);
  }, 120_000);

  it("a name that does not look up: exit 2 and a line naming --host", () => {
    const r = start("not-a-real-host.invalid");
    expect(r.status).toBe(2);
    // ENOTFOUND, or EAI_AGAIN on a machine with no resolver: both name the flag.
    expect(r.stderr).toMatch(
      /^sessionpipe-gui: --host not-a-real-host\.invalid (is not a name|could not be looked up)/m,
    );
    expect(r.stderr).not.toMatch(/getaddrinfo/);
  }, 120_000);
});
