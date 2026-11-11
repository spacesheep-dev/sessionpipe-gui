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
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.SPGUI_SKIP_PREPARE === "1") process.exit(0);
if (existsSync(path.join(root, "dist", "cli.js")) && existsSync(path.join(root, "dist", "web", "index.html"))) {
  process.exit(0);
}
// Each tool's package.json on disk, not require.resolve("<tool>/package.json"): a package
// whose "exports" leave package.json out (@vitejs/plugin-react) never resolves that way,
// so the tools always looked missing and were installed again on every run.
const haveTools = ["esbuild", "vite", "@vitejs/plugin-react", "react", "react-dom", "typescript"].every((m) =>
  existsSync(path.join(root, "node_modules", ...m.split("/"), "package.json")),
);
const env = { ...process.env };
for (const k of Object.keys(env))
  if (/^npm_config_(global|prefix|location|save|package_lock_only|dry_run)$/i.test(k)) delete env[k];
env.npm_config_global = "false";
// The install below is for the tools only: should npm run this script again inside it
// (npm on Windows does, --ignore-scripts or not), it returns at once instead of
// installing again, and again.
env.SPGUI_SKIP_PREPARE = "1";

/** One word for cmd.exe: as it is when it is plainly safe, else in double quotes, inside
 *  which & | < > ( ) ^ and spaces are literal (a Windows path has no " to escape). */
const cmdArg = (a) => (/^[\w.:\\/=@+-]+$/.test(a) ? a : `"${a}"`);

/** npm, with no shell. npm runs this script with npm_execpath set to its own CLI
 *  (npm-cli.js), which runs under this node. A bare "npm" is npm.cmd on Windows, and
 *  spawnSync can't start a .cmd without a shell: `npx github:…` failed there with no
 *  message. Run by hand (no npm_execpath), Windows gets one quoted command under a shell. */
function npm(args) {
  const cli = process.env.npm_execpath;
  const r =
    cli && /npm-cli\.[cm]?js$/i.test(cli)
      ? spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: "inherit", env })
      : process.platform === "win32"
        ? spawnSync(["npm", ...args].map(cmdArg).join(" "), {
            cwd: root,
            stdio: "inherit",
            env,
            shell: true,
          })
        : spawnSync("npm", args, { cwd: root, stdio: "inherit", env });
  if (r.error) console.error(`sessionpipe-gui: couldn't run npm ${args[0]}: ${r.error.message}`);
  return r;
}
if (!haveTools) {
  console.log("sessionpipe-gui: installing the build tools into the checkout (one time)…");
  const i = npm([
    "install",
    "--include=dev",
    "--no-save",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    "--prefix",
    root,
  ]);
  if (i.status !== 0) process.exit(i.status ?? 1);
}
const r = npm(["run", "build", "--silent"]);
process.exit(r.status ?? 1);
