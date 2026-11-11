// SPDX-License-Identifier: Apache-2.0
// The sessionpipe conformance fixtures this receiver is held to, copied into
// test/conformance/ at the one version of sessionpipe-core that package.json pins:
// conformance/control-vectors (signed commands and enrollment proofs, each with the verdict
// every verifier must reach, CONTROL.md §11) and conformance/delivery (receiver scenarios,
// HTTP.md §7). The sessionpipe-conformance package on npm ships a runner and no fixtures,
// so this copy is what lets CI run them with no second checkout.
//
//   npm run conformance:sync                        copy them from ../sessionpipe (or $SESSIONPIPE_REPO)
//   npm run conformance:sync -- --from <checkout>   … or from that checkout
//   npm run conformance:sync -- --check             change nothing; exit 1 when the copy differs
//
// The files are read from the checkout's git objects at the tag `v<version>`, never from
// its working tree, so a checkout on another commit, or with edits, gives the same copy.
// The tag's tree is data, not instructions: a path it lists is written only when
// conformance-paths.mjs says it is one of ours, and anything else there stops the sync
// before a byte is written. manifest.json records the version, the tag's commit and a
// SHA-256 per file, taken over the JSON written out again so that a checkout's line
// endings don't count.
//
// Where it writes is not the checkout's to place either. The sync removes its folders
// whole and writes files by path, and both go wherever a path resolves: with `test` or
// `test/conformance` a symbolic link, that is somebody else's folder. So before anything
// is removed or written, `test`, `test/conformance` and each fixture folder have to be
// real directories inside this checkout, nothing inside a folder it removes may be a
// link, and manifest.json has to be a regular file where it exists. Otherwise it stops
// with nothing touched; `--check` looks the same way and only ever reads.
//
// Two things hold the copy to this. test/conformance.test.ts fails when the copy, the
// manifest and the pin disagree, with nothing but this repo; it trusts the manifest. CI
// then runs `--check` against a clone of sessionpipe at the tag, which is what catches a
// vector edited together with its hash. Moving the pin means running this in the same change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILES, FOLDERS, fixtureRel } from "./conformance-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "test", "conformance");
const SOURCE = "https://github.com/spacesheep-dev/sessionpipe";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const check = args.includes("--check");
const fail = (why) => {
  console.error(`conformance:sync: ${why}`);
  process.exit(1);
};

// The pin is one exact version: the fixtures are that version's, and a range would let an
// install with no lockfile run a verifier they were never run against.
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies?.["sessionpipe-core"];
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  fail(`package.json pins sessionpipe-core as ${JSON.stringify(version)}: it takes one exact version, no range`);
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
if (lock.packages?.["node_modules/sessionpipe-core"]?.version !== version)
  fail(`package-lock.json is not at sessionpipe-core ${version}, which package.json pins: run npm install`);
const tag = `v${version}`;
const repo = path.resolve(root, flag("--from") ?? process.env.SESSIONPIPE_REPO ?? "../sessionpipe");
if (!existsSync(repo)) fail(`no sessionpipe checkout at ${repo}: pass --from <checkout>, or set SESSIONPIPE_REPO`);
const git = (...a) =>
  execFileSync("git", ["-C", repo, ...a], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

let commit;
try {
  commit = git("rev-parse", "--verify", "--quiet", `${tag}^{commit}`).toString().trim();
} catch {
  fail(`${repo} has no tag ${tag}, the sessionpipe-core package.json pins: git -C ${repo} fetch --tags`);
}

/** A fixture's content, whatever its line endings and spacing: SHA-256 of the JSON written out again. */
const digest = (bytes) =>
  createHash("sha256")
    .update(JSON.stringify(JSON.parse(bytes.toString("utf8"))))
    .digest("hex");

// What the tag holds: <folder>/<name>.json → its bytes, as git has them. Every path the
// tree lists there is checked before any is read or written (conformance-paths.mjs): a
// tree can name `control-vectors/../../../package.json`, and the copy is not the tree's to place.
const upstream = new Map();
const listed = git(
  "ls-tree",
  "-r",
  "-z",
  "--name-only",
  tag,
  "--",
  ...[...FOLDERS, ...FILES].map((f) => `conformance/${f}`),
)
  .toString()
  .split("\0")
  .filter(Boolean)
  .sort();
const strays = listed.filter((p) => fixtureRel(p) === null);
if (strays.length) {
  for (const p of strays.slice(0, 40)) console.error(`  ✘ ${JSON.stringify(p)}`);
  fail(
    `${tag} lists ${strays.length === 1 ? "a path that is" : "paths that are"} not a fixture of ours (conformance/<${FOLDERS.join("|")}>/<name>.json): nothing was read or written`,
  );
}
for (const p of listed) upstream.set(fixtureRel(p), git("show", `${tag}:${p}`));
for (const f of FOLDERS)
  if (![...upstream.keys()].some((rel) => rel.startsWith(`${f}/`))) fail(`${tag} has no conformance/${f}/*.json`);
for (const f of FILES) if (!upstream.has(f)) fail(`${tag} has no conformance/${f}`);

const manifest = {
  source: SOURCE,
  license: "Apache-2.0",
  version,
  tag,
  commit,
  files: Object.fromEntries([...upstream].map(([rel, bytes]) => [rel, digest(bytes)])),
};
const manifestFile = path.join(out, "manifest.json");
const count = (f) => [...upstream.keys()].filter((rel) => rel.startsWith(`${f}/`)).length;
const what = `${count("control-vectors")} control vectors and ${count("delivery")} delivery fixtures of sessionpipe ${version} (${commit.slice(0, 7)})`;

/** What stands between the sync and a test/conformance made of this checkout's own real
 *  folders and files; empty when nothing does. Looks only (lstat, readdir, realpath). */
function outputProblems() {
  const shown = (p) => path.relative(root, p).split(path.sep).join("/");
  const look = (p) => {
    try {
      return lstatSync(p);
    } catch {
      return null;
    }
  };
  const realRoot = realpathSync(root);
  const problems = [];
  // The way down from the repo root: each is absent (the sync makes it) or a real folder
  // of this checkout. A junction on Windows reads as a link here too.
  for (const dir of [path.join(root, "test"), out, ...FOLDERS.map((f) => path.join(out, f))]) {
    const st = look(dir);
    if (!st) continue;
    if (st.isSymbolicLink()) problems.push(`${shown(dir)} is a symbolic link`);
    else if (!st.isDirectory()) problems.push(`${shown(dir)} is not a folder`);
    else {
      const inside = path.relative(realRoot, realpathSync(dir));
      if (inside.startsWith("..") || path.isAbsolute(inside))
        problems.push(`${shown(dir)} resolves outside this checkout`);
    }
    // Nothing below a link is looked at: it is somewhere else.
    if (problems.length) return problems;
  }
  // Inside the folders it removes whole: no link, at any depth.
  const walk = (dir) => {
    for (const e of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) problems.push(`${shown(p)} is a symbolic link`);
      else if (e.isDirectory()) walk(p);
    }
  };
  for (const f of FOLDERS) walk(path.join(out, f));
  // The files it writes that sit beside those folders: regular files, where they exist.
  for (const file of [manifestFile, ...FILES.map((f) => path.join(out, f))]) {
    const st = look(file);
    if (st?.isSymbolicLink()) problems.push(`${shown(file)} is a symbolic link`);
    else if (st && !st.isFile()) problems.push(`${shown(file)} is not a file`);
  }
  return problems;
}
const blocked = outputProblems();
if (blocked.length) {
  for (const p of blocked.slice(0, 40)) console.error(`  ✘ ${p}`);
  fail(
    `test/conformance has to be real folders and files of this checkout, and it is not (above): nothing was ${check ? "read" : "removed or written"}`,
  );
}

if (check) {
  const problems = [];
  const held = new Map();
  const hold = (rel) => {
    let d = "unreadable";
    try {
      d = digest(readFileSync(path.join(out, ...rel.split("/"))));
    } catch {}
    held.set(rel, d);
  };
  // What the suites read: the .json files of each folder (test/conformance.ts), and the named files.
  for (const f of FOLDERS) {
    const dir = path.join(out, f);
    for (const name of existsSync(dir) ? readdirSync(dir) : []) if (name.endsWith(".json")) hold(`${f}/${name}`);
  }
  for (const f of FILES) if (existsSync(path.join(out, f))) hold(f);
  for (const [rel, d] of Object.entries(manifest.files)) {
    if (!held.has(rel)) problems.push(`missing ${rel}`);
    else if (held.get(rel) !== d) problems.push(`differs ${rel}`);
  }
  for (const rel of held.keys()) if (!(rel in manifest.files)) problems.push(`not sessionpipe's ${rel}`);
  let recorded = null;
  try {
    recorded = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {}
  if (JSON.stringify(recorded) !== JSON.stringify(manifest)) problems.push("manifest.json is not this tag's");
  if (problems.length) {
    for (const p of problems.slice(0, 40)) console.error(`  ✘ ${p}`);
    fail(`test/conformance is not the ${what}; run \`npm run conformance:sync\``);
  }
  console.log(`test/conformance: the ${what}`);
  process.exit(0);
}

// Everything it touches was looked at above. What it writes is made new ("wx": never
// opened where something already is), so a link put there since is refused, not followed.
for (const f of [...FOLDERS, ...FILES, "manifest.json"]) rmSync(path.join(out, f), { recursive: true, force: true });
for (const [rel, bytes] of upstream) {
  const file = path.join(out, ...rel.split("/"));
  // Said twice on purpose: the rule above, and where the path really lands.
  if (path.relative(out, file).startsWith("..") || path.isAbsolute(path.relative(out, file)))
    fail(`${JSON.stringify(rel)} would be written outside test/conformance`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes, { flag: "wx" });
}
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(`test/conformance: ${what}`);
