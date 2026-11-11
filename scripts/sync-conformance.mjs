// SPDX-License-Identifier: Apache-2.0
// The sessionpipe conformance fixtures this receiver is held to, copied into
// test/conformance/ at the version of sessionpipe-core that package-lock.json pins:
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
// manifest.json records the version, the tag's commit and a SHA-256 per file, taken over
// the JSON written out again so that a checkout's line endings don't count.
// test/conformance.test.ts fails when the copy, the manifest and the pinned version
// disagree: run this after every bump of sessionpipe-core.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "test", "conformance");
const FOLDERS = ["control-vectors", "delivery"];
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

const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const version = lock.packages?.["node_modules/sessionpipe-core"]?.version;
if (!version) fail("package-lock.json pins no sessionpipe-core");
const tag = `v${version}`;
const repo = path.resolve(root, flag("--from") ?? process.env.SESSIONPIPE_REPO ?? "../sessionpipe");
if (!existsSync(repo)) fail(`no sessionpipe checkout at ${repo}: pass --from <checkout>, or set SESSIONPIPE_REPO`);
const git = (...a) =>
  execFileSync("git", ["-C", repo, ...a], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

let commit;
try {
  commit = git("rev-parse", "--verify", "--quiet", `${tag}^{commit}`).toString().trim();
} catch {
  fail(`${repo} has no tag ${tag}, the sessionpipe-core package-lock.json pins: git -C ${repo} fetch --tags`);
}

/** A fixture's content, whatever its line endings and spacing: SHA-256 of the JSON written out again. */
const digest = (bytes) =>
  createHash("sha256")
    .update(JSON.stringify(JSON.parse(bytes.toString("utf8"))))
    .digest("hex");

// What the tag holds: <folder>/<name>.json → its bytes, as git has them.
const upstream = new Map();
const listed = git("ls-tree", "-r", "-z", "--name-only", tag, "--", ...FOLDERS.map((f) => `conformance/${f}`))
  .toString()
  .split("\0")
  .filter((p) => p.endsWith(".json"))
  .sort();
for (const p of listed) upstream.set(p.slice("conformance/".length), git("show", `${tag}:${p}`));
for (const f of FOLDERS)
  if (![...upstream.keys()].some((rel) => rel.startsWith(`${f}/`))) fail(`${tag} has no conformance/${f}/*.json`);

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

if (check) {
  const problems = [];
  const held = new Map();
  for (const f of FOLDERS) {
    const dir = path.join(out, f);
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      let d = "unreadable";
      try {
        d = digest(readFileSync(path.join(dir, name)));
      } catch {}
      held.set(`${f}/${name}`, d);
    }
  }
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

for (const f of FOLDERS) rmSync(path.join(out, f), { recursive: true, force: true });
for (const [rel, bytes] of upstream) {
  const file = path.join(out, ...rel.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`test/conformance: ${what}`);
