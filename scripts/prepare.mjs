// SPDX-License-Identifier: Apache-2.0
// `npm install` from a git URL (npx github:spacesheep-dev/sessionpipe-gui, or a clone)
// runs this: build once so the CLI exists, with Canvas and Office from the tracked
// bundled/ copy when the themes repo isn't beside us. A checkout that already has a
// build (a contributor's `npm ci`) is left alone; `npm run build` is the explicit way.
//
// `npm install -g git+…` is the awkward case: npm prepares the clone with the outer
// command's config in the environment (global=true, the global prefix), so the dev
// dependencies land in the wrong place and the build tools are missing here. When that
// happens, they are installed into the clone with that config cleared.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.SPGUI_SKIP_PREPARE === "1") process.exit(0);
if (existsSync(path.join(root, "dist", "cli.js")) && existsSync(path.join(root, "dist", "web", "index.html"))) {
  process.exit(0);
}
const require = createRequire(path.join(root, "package.json"));
const haveTools = ["esbuild", "vite", "@vitejs/plugin-react", "react", "react-dom", "typescript"].every((m) => {
  try {
    require.resolve(m);
    return true;
  } catch {
    try {
      require.resolve(`${m}/package.json`);
      return true;
    } catch {
      return false;
    }
  }
});
const env = { ...process.env };
for (const k of Object.keys(env))
  if (/^npm_config_(global|prefix|location|save|package_lock_only|dry_run)$/i.test(k)) delete env[k];
env.npm_config_global = "false";
const shell = process.platform === "win32";
if (!haveTools) {
  console.log("sessionpipe-gui: installing the build tools into the checkout (one time)…");
  const i = spawnSync(
    "npm",
    ["install", "--include=dev", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", "--prefix", root],
    { cwd: root, stdio: "inherit", env, shell },
  );
  if (i.status !== 0) process.exit(i.status ?? 1);
}
const r = spawnSync("npm", ["run", "build", "--silent"], { cwd: root, stdio: "inherit", env, shell });
process.exit(r.status ?? 1);
