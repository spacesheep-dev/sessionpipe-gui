// SPDX-License-Identifier: Apache-2.0
// The Node floor (scripts/node-floor.mjs): the range package.json declares, and what a
// Node outside it is told, by the CLI before it starts and by the `npx github:` build
// (scripts/prepare.mjs) before it installs anything. An older Node is faked by redefining
// process.versions.node before the script runs.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NODE_FLOOR, nodeSupported } from "../scripts/node-floor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `node <script>` as if it were Node `version`. */
const runAs = (version: string, script: string, cwd: string) =>
  spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,Object.defineProperty(process.versions,"node",{value:${JSON.stringify(version)}})`,
      script,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, SPGUI_SKIP_PREPARE: "" }, timeout: 30_000 },
  );

describe("the Node floor", () => {
  it("is the range package.json declares, ^20.19.0 || >=22.12.0", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe("^20.19.0 || >=22.12.0");
    for (const v of ["20.19.0", "v20.19.0", "20.20.2", "22.12.0", "22.23.4", "23.0.0", "24.11.1", "26.0.0"])
      expect(nodeSupported(v), v).toBe(true);
    for (const v of ["16.20.2", "18.20.8", "20.0.0", "20.18.3", "v20.18.3", "21.7.3", "22.0.0", "22.11.0", "", "x"])
      expect(nodeSupported(v), v).toBe(false);
  });
});

describe("on a Node outside it", () => {
  let dir: string;
  beforeAll(() => {
    mkdirSync(path.join(root, ".tmp"), { recursive: true });
    dir = mkdtempSync(path.join(root, ".tmp", "node-floor-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("the npx build stops before it installs anything, with one sentence naming the Node to install", () => {
    // A clone with no build yet: prepare.mjs and the floor beside it, nothing else.
    mkdirSync(path.join(dir, "clone", "scripts"), { recursive: true });
    for (const f of ["prepare.mjs", "node-floor.mjs"])
      copyFileSync(path.join(root, "scripts", f), path.join(dir, "clone", "scripts", f));
    const r = runAs("20.18.1", path.join(dir, "clone", "scripts", "prepare.mjs"), path.join(dir, "clone"));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `sessionpipe-gui: building it needs ${NODE_FLOOR} (you have v20.18.1); install a newer Node from nodejs.org and run the command again.\n`,
    );
  });

  it("the CLI says so on its first line and exits 1", async () => {
    const cli = path.join(dir, "cli.js");
    await build({
      entryPoints: [path.join(root, "server/cli.ts")],
      outfile: cli,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "external",
      logLevel: "silent",
    });
    const r = runAs("21.7.3", cli, root);
    expect(r.status).toBe(1);
    expect(r.stderr.split("\n")[0]).toBe(
      "sessionpipe-gui needs Node 22.12 or later, or Node 20 from 20.19 on (you have v21.7.3)",
    );
  }, 60_000);
});
