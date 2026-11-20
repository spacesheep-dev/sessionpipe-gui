// SPDX-License-Identifier: Apache-2.0
// `sessionpipe-gui tls status` on a certificate folder that is there but broken: it names
// the file and the cause, and what the next --tls start does about it (exit 2, as the
// CLI's other refusals), instead of "none yet"; an unreadable key is a one-line reason,
// not Node's stack trace. An empty folder is still "none yet". Skipped with a message
// when openssl is missing (as tls.test.ts).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../test/events.js";
import { certsProblem, ensureCerts, opensslAvailable, readCerts } from "./tls/certs.js";

const HAVE_OPENSSL = opensslAvailable();
if (!HAVE_OPENSSL) process.stderr.write("[tls-status.test] openssl is not on the PATH: these tests are skipped\n");

describe.skipIf(!HAVE_OPENSSL)("sessionpipe-gui tls status", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  let out: string;
  let cli: string;
  let tmp: { dir: string; cleanup: () => void };
  beforeAll(async () => {
    tmp = tempDir();
    mkdirSync(path.join(root, "..", ".tmp"), { recursive: true });
    out = mkdtempSync(path.join(root, "..", ".tmp", "tls-status-"));
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

  // A state folder with a full, good set of certificates.
  let n = 0;
  const stateWithCerts = () => {
    const state = path.join(tmp.dir, `s${n++}`);
    ensureCerts(path.join(state, "tls"), { hostname: "box.local", addresses: [] });
    return state;
  };
  const status = (state: string) =>
    spawnSync(process.execPath, [cli, "tls", "status", "--state", state], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: tmp.dir,
    });

  const tls = (state: string) => path.join(state, "tls");
  const refusal = (state: string, problem: string, next: string) =>
    `sessionpipe-gui: the certificates under ${tls(state)} cannot be used: ${problem}. ${next}\n`;
  const NEW_CA = "The next --tls start makes a new CA and server certificate; phones must trust the new CA again.";
  const NEW_SERVER = "The next --tls start makes a new server certificate from the same CA; phones need nothing new.";
  const byHand = () =>
    "Fix it by hand, or run `sessionpipe-gui tls reset` (with the same --state) and the next --tls start makes a new CA, which phones must trust again.";

  it("names a cut-off ca.crt instead of saying none yet (an empty folder still says it)", () => {
    const empty = status(path.join(tmp.dir, "empty"));
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain("certs      none yet under");
    const state = stateWithCerts();
    const ca = path.join(tls(state), "ca.crt");
    writeFileSync(ca, readFileSync(ca, "utf8").slice(0, 300));
    const r = status(state);
    expect(r.stdout).not.toContain("none yet");
    expect(r.stderr).toBe(refusal(state, "ca.crt is not a certificate", NEW_CA));
    expect(r.status).toBe(2);
  }, 20_000);

  it("names a missing ca.key instead of saying none yet", () => {
    const state = stateWithCerts();
    rmSync(path.join(tls(state), "ca.key"));
    const r = status(state);
    expect(r.stdout).not.toContain("none yet");
    expect(r.stderr).toBe(refusal(state, "ca.key is missing", NEW_CA));
    expect(r.status).toBe(2);
  }, 20_000);

  it("says a missing server.crt is remade from the same CA", () => {
    const state = stateWithCerts();
    rmSync(path.join(tls(state), "server.crt"));
    const r = status(state);
    expect(r.stderr).toBe(refusal(state, "server.crt is missing", NEW_SERVER));
    expect(r.status).toBe(2);
  }, 20_000);

  it("names a server.key that is not a key", () => {
    const state = stateWithCerts();
    writeFileSync(path.join(tls(state), "server.key"), "");
    const r = status(state);
    expect(r.stderr).toBe(refusal(state, "server.key is not a private key", byHand()));
    expect(r.status).toBe(2);
  }, 20_000);

  it("names a tls path that is not a folder", () => {
    const state = path.join(tmp.dir, `s${n++}`);
    mkdirSync(state);
    writeFileSync(tls(state), "");
    const r = status(state);
    expect(r.stderr).toBe(refusal(state, `${tls(state)} is not a folder`, byHand()));
    expect(r.status).toBe(2);
  }, 20_000);

  it("names every broken file and says what start does for the widest of them", () => {
    const state = stateWithCerts();
    const ca = path.join(tls(state), "ca.crt");
    writeFileSync(ca, readFileSync(ca, "utf8").slice(0, 300));
    rmSync(path.join(tls(state), "server.crt"));
    const r = status(state);
    expect(r.stderr).toBe(refusal(state, "ca.crt is not a certificate, server.crt is missing", NEW_CA));
    expect(r.status).toBe(2);
  }, 20_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says an unreadable ca.crt is remade with a new CA",
    () => {
      const state = stateWithCerts();
      const ca = path.join(tls(state), "ca.crt");
      chmodSync(ca, 0o000);
      try {
        const r = status(state);
        expect(r.stderr).toBe(refusal(state, "ca.crt cannot be read (EACCES)", NEW_CA));
        expect(r.status).toBe(2);
      } finally {
        chmodSync(ca, 0o600);
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "names an unsearchable tls folder of ours instead of saying none yet",
    () => {
      const state = stateWithCerts();
      chmodSync(tls(state), 0o000);
      try {
        const r = status(state);
        expect(r.stderr).toBe(
          refusal(
            state,
            `${tls(state)} cannot be read (EACCES)`,
            "The next --tls start makes the folder readable again (mode 700) and checks the files in it.",
          ),
        );
        expect(r.status).toBe(2);
      } finally {
        chmodSync(tls(state), 0o700);
      }
    },
    20_000,
  );

  it("says a server.key that is not a key is written anew with a new server certificate", () => {
    const state = stateWithCerts();
    writeFileSync(path.join(tls(state), "server.key"), "");
    rmSync(path.join(tls(state), "server.crt"));
    const r = status(state);
    expect(r.stderr).toBe(refusal(state, "server.key is not a private key, server.crt is missing", NEW_SERVER));
    expect(r.status).toBe(2);
  }, 20_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "gives an unreadable server.key a one-line reason, not a stack trace",
    () => {
      const state = stateWithCerts();
      const key = path.join(tls(state), "server.key");
      chmodSync(key, 0o000);
      try {
        const r = status(state);
        expect(r.stderr).toBe(refusal(state, "server.key cannot be read (EACCES)", byHand()));
        expect(r.status).toBe(2);
      } finally {
        chmodSync(key, 0o600);
      }
    },
    20_000,
  );
  // The corners kombuchapunk listed on #194: status says what the next --tls start does,
  // and each test runs that start (ensureCerts) to show it does that.
  it("says a CA near its end is made anew even beside a file that needs a hand", () => {
    const state = stateWithCerts();
    writeFileSync(path.join(tls(state), "server.key"), "");
    const nearEnd = Date.parse(readCerts(tls(state))!.caExpiresAt) - 86_400_000;
    expect(certsProblem(tls(state), nearEnd)).toEqual({ problem: "server.key is not a private key", repair: "ca" });
    expect(ensureCerts(tls(state), { hostname: "box.local", addresses: [], now: () => nearEnd }).made).toBe("all");
  }, 20_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says a server.key it cannot write is fixed by hand when the server certificate is to be remade",
    () => {
      const state = stateWithCerts();
      const key = path.join(tls(state), "server.key");
      rmSync(path.join(tls(state), "server.crt"));
      chmodSync(key, 0o400);
      try {
        const r = status(state);
        expect(r.stderr).toBe(refusal(state, "server.crt is missing, server.key cannot be written", byHand()));
        expect(r.status).toBe(2);
        expect(() => ensureCerts(tls(state), { hostname: "box.local", addresses: [] })).toThrow(/server\.key/);
      } finally {
        chmodSync(key, 0o600);
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says a server.crt it cannot write is fixed by hand when the server certificate is to be remade",
    () => {
      const state = stateWithCerts();
      const crt = path.join(tls(state), "server.crt");
      writeFileSync(crt, "not a certificate");
      chmodSync(crt, 0o400);
      try {
        const r = status(state);
        expect(r.stderr).toBe(
          refusal(state, "server.crt is not a certificate, server.crt cannot be written", byHand()),
        );
        expect(r.status).toBe(2);
        expect(() => ensureCerts(tls(state), { hostname: "box.local", addresses: [] })).toThrow(/server\.crt/);
      } finally {
        chmodSync(crt, 0o600);
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "still says a new CA when files it cannot write are deleted first",
    () => {
      const state = stateWithCerts();
      const key = path.join(tls(state), "server.key");
      rmSync(path.join(tls(state), "ca.key"));
      rmSync(path.join(tls(state), "server.crt"));
      chmodSync(key, 0o400);
      const r = status(state);
      expect(r.stderr).toBe(refusal(state, "ca.key is missing, server.crt is missing", NEW_CA));
      expect(r.status).toBe(2);
      expect(ensureCerts(tls(state), { hostname: "box.local", addresses: [] }).made).toBe("all");
    },
    20_000,
  );

  it("says a folder named ca.crt is fixed by hand, as start stops at deleting it", () => {
    const state = stateWithCerts();
    const ca = path.join(tls(state), "ca.crt");
    rmSync(ca);
    mkdirSync(ca);
    const r = status(state);
    expect(r.stderr).toBe(refusal(state, "ca.crt is a folder", byHand()));
    expect(r.status).toBe(2);
    expect(() => ensureCerts(tls(state), { hostname: "box.local", addresses: [] })).toThrow(/EISDIR|is a directory/);
  }, 20_000);

  it("says a folder in place of any file is fixed by hand, even when a new CA is due", () => {
    const state = stateWithCerts();
    rmSync(path.join(tls(state), "ca.key"));
    rmSync(path.join(tls(state), "server.crt"));
    mkdirSync(path.join(tls(state), "server.crt"));
    const r = status(state);
    expect(r.stderr).toBe(refusal(state, "ca.key is missing, server.crt is a folder", byHand()));
    expect(r.status).toBe(2);
    expect(() => ensureCerts(tls(state), { hostname: "box.local", addresses: [] })).toThrow(/EISDIR|is a directory/);
  }, 20_000);
});
