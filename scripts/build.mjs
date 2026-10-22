// SPDX-License-Identifier: Apache-2.0
// Bundles the server to dist/*.js with esbuild. `--watch` rebuilds on change.
// The web app is built separately by Vite into dist/web (see package.json).
//
// Bundled extensions: every official extension ships with the GUI (the views Canvas and
// Office, the plugin ping-a-human; the two skins are built in, shared/skins-builtin.ts). Each
// is copied into dist/bundled/<kind>/<id>/ from the themes repo's packages: built first with
// its own `npm run build` when it has one, then exactly what its npm
// tarball would carry (package.json `files`, minus source maps). `--bundle-from <path>`
// names that checkout (default: the sibling ../sessionpipe-gui-themes); when it is absent
// the tracked copy in bundled/ is used instead, so a bare clone still ships everything.
// `--no-bundle` (or SPGUI_NO_BUNDLE=1) skips it. A release must not ship without them by
// accident: `--require-bundle` (what `npm publish` runs through prepublishOnly) fails the
// build when neither source is there or a package's build fails, unless SPGUI_NO_BUNDLE=1
// says so on purpose. The themes repo stays the source of truth: `--sync-bundle` refreshes
// the tracked bundled/ copy from it; dist/ is ignored.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const watch = argv.includes("--watch");
const noBundle = argv.includes("--no-bundle") || process.env.SPGUI_NO_BUNDLE === "1";
const requireBundle = argv.includes("--require-bundle") && !noBundle;

/** A missing piece of the bundle: a note in a dev build, the end of a release build. */
function missing(msg) {
  if (!requireBundle) {
    console.log(`bundled extensions: skipped ${msg}`);
    return;
  }
  console.error(
    `bundled extensions: ${msg}\n  a release ships Canvas, Office and ping-a-human: clone spacesheep-dev/sessionpipe-gui-themes beside this repo (or --bundle-from <path>) and \`npm ci && npm run build\` there; SPGUI_NO_BUNDLE=1 publishes without them on purpose`,
  );
  process.exit(1);
}
mkdirSync(path.join(root, "dist"), { recursive: true });

const options = {
  entryPoints: {
    cli: path.join(root, "server/cli.ts"),
    index: path.join(root, "server/index.ts"),
    conformance: path.join(root, "server/conformance/cli.ts"),
  },
  outdir: path.join(root, "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
};

/** The packages that ship with the GUI: kind → themes-repo package folder. */
const BUNDLED = [
  { kind: "views", pkg: "packages/canvas", manifest: "theme.json" },
  { kind: "views", pkg: "packages/office", manifest: "theme.json" },
  { kind: "plugins", pkg: "packages/plugin-ping-a-human", manifest: "plugin.json" },
];

/** The tracked copy of the bundled extensions (`bundled/` at the repo root): what a bare
 *  clone ships when the themes repo isn't checked out beside it. `--sync-bundle`
 *  refreshes it from a fresh build of the sibling; commit the result. */
const tracked = path.join(root, "bundled");
const syncBundle = argv.includes("--sync-bundle");

/** npm always packs these when present, whatever `files` says. */
const ALWAYS_PACKED = ["README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "DESIGN.md"];

/** The regular files `files` selects under `pkg`, as relative paths: a folder (every file
 *  under it), a `dir/*.ext` glob (one level), a plain file. Source maps never make it
 *  (the one `!dist/**\/*.map` negation the packages use), nor node_modules. */
function packedFiles(pkg, files) {
  const picked = new Set();
  const walk = (rel) => {
    const abs = path.join(pkg, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) if (name !== "node_modules") walk(path.join(rel, name));
    } else if (!rel.endsWith(".map")) picked.add(rel);
  };
  const expand = (pattern) => {
    const dir = path.dirname(pattern);
    const base = path.basename(pattern);
    if (!base.includes("*")) return [pattern];
    const re = new RegExp(
      `^${base
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    const parent = path.join(pkg, dir);
    if (!existsSync(parent)) return [];
    return readdirSync(parent)
      .filter((n) => re.test(n))
      .map((n) => path.join(dir, n));
  };
  for (const f of [...files, ...ALWAYS_PACKED]) {
    if (f.startsWith("!")) continue;
    for (const rel of expand(f)) walk(rel);
  }
  return [...picked].sort();
}

function bundleExtensions() {
  const i = argv.indexOf("--bundle-from");
  const from = path.resolve(root, i >= 0 ? argv[i + 1] : process.env.SPGUI_THEMES_DIR || "../sessionpipe-gui-themes");
  const out = path.join(root, "dist", "bundled");
  if (!existsSync(path.join(from, "packages"))) {
    if (existsSync(path.join(tracked, "views"))) {
      rmSync(out, { recursive: true, force: true });
      cpSync(tracked, out, { recursive: true });
      for (const kind of readdirSync(tracked))
        for (const id of readdirSync(path.join(tracked, kind)))
          console.log(`bundled extensions: ${kind}/${id} ← bundled/ (tracked copy; --sync-bundle refreshes it)`);
      return;
    }
    missing(`(no themes repo at ${from} and no tracked bundled/ copy; --bundle-from <path> names one)`);
    return;
  }
  rmSync(out, { recursive: true, force: true });
  for (const b of BUNDLED) {
    const pkg = path.join(from, b.pkg);
    const manifestFile = path.join(pkg, b.manifest);
    if (!existsSync(manifestFile)) {
      missing(`${b.pkg} (no ${b.manifest})`);
      continue;
    }
    const pkgJson = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"));
    // Views and the plugin build to dist/; a package with no build ships its files as they are.
    if (pkgJson.scripts?.build) {
      const r = spawnSync("npm", ["run", "build", "--silent"], { cwd: pkg, encoding: "utf8" });
      if (r.status !== 0) {
        missing(`${b.pkg} (its build failed)\n${(r.stderr || r.stdout).trim()}`);
        continue;
      }
    }
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const dest = path.join(out, b.kind, manifest.id);
    mkdirSync(dest, { recursive: true });
    // What the npm tarball would carry (package.json `files`, plus the files npm always
    // packs), without source maps: half the weight, and nobody debugs a bundled copy
    // from here (the themes repo has the sources).
    for (const rel of packedFiles(pkg, pkgJson.files ?? ["dist", b.manifest])) {
      cpSync(path.join(pkg, rel), path.join(dest, rel), { recursive: true, dereference: true });
    }
    if (!existsSync(path.join(dest, b.manifest))) cpSync(manifestFile, path.join(dest, b.manifest));
    console.log(`bundled extensions: ${b.kind}/${manifest.id} ${manifest.version} ← ${b.pkg}`);
  }
  if (syncBundle) {
    rmSync(tracked, { recursive: true, force: true });
    cpSync(out, tracked, { recursive: true });
    console.log(`bundled extensions: tracked copy refreshed at bundled/ (commit it)`);
  }
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
  if (!noBundle) bundleExtensions();
  else if (requireBundle === false && argv.includes("--require-bundle"))
    console.log("bundled extensions: skipped on purpose (SPGUI_NO_BUNDLE=1)");
}
