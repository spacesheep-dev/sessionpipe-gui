// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The indexer child's messages to a server that has gone away: when
// the server exits first (say "port in use"), a status the child sends before it has seen the
// disconnect fails with EPIPE. It is dropped; the child must not die with an unhandled 'error'.
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "spe-child-"));
const child = join(root, "late-send.mjs");
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeAll(async () => {
  // A child that says "ready", then stays busy (so it cannot see the parent's disconnect) until
  // the test has disconnected, and then sends more. A send whose write fails is reported on
  // stderr as SENDERR, so the test knows the failing path was taken.
  await build({
    stdin: {
      contents: `
        import { existsSync } from "node:fs";
        import { sendToParent } from "./child.js";
        const send = process.send.bind(process);
        process.send = (m, h, o, cb) =>
          cb ? send(m, h, o, (e) => { if (e) process.stderr.write("SENDERR:" + e.code + "\\n"); cb(e); }) : send(m, h, o);
        const gone = process.argv[2];
        sendToParent({ t: "error", message: "ready" });
        const tick = new Int32Array(new SharedArrayBuffer(4));
        for (let i = 0; i < 400 && !existsSync(gone); i++) Atomics.wait(tick, 0, 0, 25);
        Atomics.wait(tick, 0, 0, 100);
        for (let i = 0; i < 3; i++) sendToParent({ t: "error", message: "late" });
        setTimeout(() => process.exit(0), 200);
      `,
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: child,
    logLevel: "error",
  });
});

describe("indexer child, server gone", () => {
  it("drops a message the server can no longer get, and exits cleanly", { timeout: 30_000 }, async () => {
    const gone = join(root, "disconnected");
    const c = fork(child, [gone], { serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    c.stderr!.on("data", (d) => {
      stderr += String(d);
    });
    c.once("message", () => {
      c.disconnect();
      writeFileSync(gone, "");
    });
    // stderr is read to its end, not only to the exit, before the checks.
    const [code] = await Promise.all([
      new Promise((r) => c.once("exit", r)),
      new Promise((r) => c.stderr!.once("end", r)),
    ]);
    // The write failed, so the case was hit. Not on Windows: a named-pipe write that fails later
    // is ignored by Node, with or without a callback.
    if (process.platform !== "win32") expect(stderr).toMatch(/SENDERR:E(PIPE|CONNRESET)/);
    expect(stderr).not.toContain("Unhandled");
    expect(stderr).not.toContain("write EPIPE");
    expect(code).toBe(0);
  });
});
