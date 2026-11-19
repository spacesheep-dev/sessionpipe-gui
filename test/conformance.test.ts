// SPDX-License-Identifier: Apache-2.0
// The conformance fixtures in test/conformance/ are the pinned sessionpipe's: the copy, its
// manifest and the one version package.json pins agree. That is what this file can say
// with nothing but this repo, and it catches a bump of sessionpipe-core that leaves the
// fixtures behind, and a file edited, removed or added without the manifest.
//
// It trusts the manifest, which sits beside the copy. A vector edited together with its
// hash, or removed together with its line, passes here; what catches that is the copy
// compared with sessionpipe's own tag (`npm run conformance:sync -- --check`), which CI
// runs against a clone at that tag (.github/workflows/ci.yml).
//
// And the sync script itself: the paths it will write, and that a tag's tree which lists
// anything else stops it before a byte is written.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FILES, FOLDERS, fixtureRel } from "../scripts/conformance-paths.mjs";
import { FIXTURE_FOLDERS, fixtures, VENDORED } from "./conformance.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
/** As scripts/sync-conformance.mjs takes it: over the JSON written out again, so the line
 *  endings a checkout gives the files (Windows) don't count. */
const digest = (text: string): string =>
  createHash("sha256")
    .update(JSON.stringify(JSON.parse(text)))
    .digest("hex");

const manifest = json<{ version: string; tag: string; commit: string; files: Record<string, string> }>(
  path.join(VENDORED, "manifest.json"),
);
const SYNC = "run `npm run conformance:sync` with a sessionpipe checkout beside this repo";

describe("the vendored conformance fixtures (test/conformance)", () => {
  it("are for the one version of sessionpipe-core package.json pins, exactly", () => {
    const pinned = json<{ dependencies: Record<string, string | undefined> }>(path.join(root, "package.json"))
      .dependencies["sessionpipe-core"];
    // No range: `^0.13.6` would let an install with no lockfile (npx github:…) run a newer
    // verifier than the one these vectors were run against.
    expect(pinned, "package.json pins sessionpipe-core to one exact version, no range").toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    );
    expect(
      manifest.version,
      `the fixtures are sessionpipe ${manifest.version}'s and package.json pins sessionpipe-core ${pinned}: ${SYNC}`,
    ).toBe(pinned);
    expect(manifest.tag).toBe(`v${pinned}`);
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    const lock = json<{ packages: Record<string, { version?: string; dependencies?: Record<string, string> }> }>(
      path.join(root, "package-lock.json"),
    );
    expect(lock.packages[""]?.dependencies?.["sessionpipe-core"], "package-lock.json: run `npm install`").toBe(pinned);
    expect(lock.packages["node_modules/sessionpipe-core"]?.version, "package-lock.json: run `npm install`").toBe(
      pinned,
    );
  });

  it("and the verifier installed is that version", () => {
    const installed = json<{ version: string }>(path.join(root, "node_modules", "sessionpipe-core", "package.json"));
    expect(installed.version, "node_modules is not what package-lock.json pins: run `npm ci`").toBe(manifest.version);
  });

  it("agree with their manifest: every file it lists, as it lists it, and no other", () => {
    const held: Record<string, string> = {};
    for (const folder of FIXTURE_FOLDERS)
      for (const f of fixtures(folder, {}).files)
        held[`${folder}/${f}`] = digest(readFileSync(path.join(VENDORED, folder, f), "utf8"));
    expect(held, SYNC).toEqual(manifest.files);
    for (const folder of FIXTURE_FOLDERS)
      expect(Object.keys(held).filter((rel) => rel.startsWith(`${folder}/`)).length).toBeGreaterThan(0);
    // The folders the suites read are the folders the sync writes, and every file is one it would write.
    expect([...FIXTURE_FOLDERS]).toEqual(FOLDERS);
    for (const rel of Object.keys(manifest.files)) expect(fixtureRel(`conformance/${rel}`), rel).toBe(rel);
  });

  it("are what the suites read, unless SESSIONPIPE_REPO names a checkout", () => {
    expect(fixtures("control-vectors", {}).dir).toBe(path.join(VENDORED, "control-vectors"));
    expect(fixtures("delivery", { SESSIONPIPE_REPO: "" }).dir).toBe(path.join(VENDORED, "delivery"));
    expect(fixtures("delivery", {}).files).toEqual(
      Object.keys(manifest.files)
        .filter((rel) => rel.startsWith("delivery/"))
        .map((rel) => rel.slice("delivery/".length)),
    );
    // A checkout that is named and has no fixtures fails the suite; it is not skipped.
    expect(() => fixtures("delivery", { SESSIONPIPE_REPO: path.join(VENDORED, "nowhere") })).toThrow();
  });
});

describe("the sync (scripts/sync-conformance.mjs): what it will write", () => {
  it("takes a .json file directly inside one of its folders, and nothing else a tree could list", () => {
    expect(fixtureRel("conformance/control-vectors/01-valid-grant-prompt.json")).toBe(
      "control-vectors/01-valid-grant-prompt.json",
    );
    expect(fixtureRel("conformance/delivery/33-control-start-cancelled.json")).toBe(
      "delivery/33-control-start-cancelled.json",
    );
    expect(fixtureRel("conformance/delivery/a.b_c-9.json")).toBe("delivery/a.b_c-9.json");
    for (const stray of [
      // climbing out, the way a hand-made tree can list it
      "conformance/control-vectors/../../../package.json",
      "conformance/control-vectors/../delivery/01-accept.json",
      "conformance/delivery/..json",
      "conformance/../package.json",
      "../conformance/delivery/01-accept.json",
      "/conformance/delivery/01-accept.json",
      // one name that is a path somewhere (Windows), or hidden, or not a plain name
      "conformance/delivery/..\\..\\package.json",
      "conformance/delivery/C:x.json",
      "conformance/delivery/.hidden.json",
      "conformance/delivery/-rf.json",
      "conformance/delivery/a b.json",
      "conformance/delivery/a\n.json",
      "conformance/delivery/.json",
      // a folder inside a folder, another folder, another kind of file
      "conformance/delivery/more/01-accept.json",
      "conformance/control-vectors",
      "conformance/control-vectors/",
      "conformance/harness/claude-code/stop.json",
      "conformance/delivery/README.md",
      "conformance/delivery/01-accept.json.sh",
      "conformance/delivery/01-accept.JSON",
      // a file at the top level is taken by name only, and none is named yet
      "conformance/control-attention.json",
      "conformance/short-id.json",
      "delivery/01-accept.json",
      "",
    ])
      expect(fixtureRel(stray), JSON.stringify(stray)).toBeNull();
    for (const notText of [undefined, null, 7, ["conformance/delivery/01-accept.json"], {}])
      expect(fixtureRel(notText)).toBeNull();
    // The named list is the only way a top-level file gets in.
    expect(FILES).toEqual([]);
  });
});

// The script run for real, in a throwaway copy with a root of its own, against a throwaway
// sessionpipe whose tags hold trees made by hand (git's plumbing writes any name).
describe("the sync (scripts/sync-conformance.mjs): run against a tree", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "spgui-sync-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const copy = path.join(tmp, "copy");
  const upstream = path.join(tmp, "sessionpipe");
  const script = path.join(copy, "scripts", "sync-conformance.mjs");

  const git = (args: string[], input?: string): string =>
    execFileSync("git", ["-C", upstream, ...args], {
      encoding: "utf8",
      ...(input !== undefined ? { input } : {}),
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  const blob = (text: string) => git(["hash-object", "-w", "--stdin"], text);
  const tree = (entries: [kind: "blob" | "tree", sha: string, name: string][]) =>
    git(
      ["mktree"],
      entries.map(([k, sha, name]) => `${k === "tree" ? "040000" : "100644"} ${k} ${sha}\t${name}\n`).join(""),
    );
  /** A tag whose tree is `conformance/{control-vectors,delivery}` with these entries. */
  const tagged = (tag: string, vectors: Parameters<typeof tree>[0], delivery: Parameters<typeof tree>[0]) => {
    const conformance = tree([
      ["tree", tree(vectors), "control-vectors"],
      ["tree", tree(delivery), "delivery"],
    ]);
    git(["tag", tag, git(["commit-tree", tree([["tree", conformance, "conformance"]]), "-m", tag])]);
  };
  /** The copy pins this version, the way this repo pins one. */
  const pin = (version: string): string => {
    const pkg = `${JSON.stringify({ name: "copy", private: true, dependencies: { "sessionpipe-core": version } })}\n`;
    writeFileSync(path.join(copy, "package.json"), pkg);
    writeFileSync(
      path.join(copy, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/sessionpipe-core": { version } } }),
    );
    return pkg;
  };
  const sync = (...args: string[]) =>
    spawnSync(process.execPath, [script, "--from", upstream, ...args], { encoding: "utf8" });

  beforeAll(() => {
    mkdirSync(path.join(copy, "scripts"), { recursive: true });
    for (const f of ["sync-conformance.mjs", "conformance-paths.mjs"])
      copyFileSync(path.join(root, "scripts", f), path.join(copy, "scripts", f));
    mkdirSync(upstream);
    git(["init", "-q"]);
  });
  // Each case starts from a copy that holds no fixtures.
  beforeEach(() => rmSync(path.join(copy, "test"), { recursive: true, force: true }));

  it("stops before a byte is written when the tag's tree lists a path that is not a fixture", () => {
    const ok = blob('{"name":"ok","steps":[]}');

    // conformance/control-vectors/../../../package.json: three trees named "..", then the file.
    let climb = tree([["blob", blob('{"name":"written-by-the-tree"}'), "package.json"]]);
    for (let i = 0; i < 2; i++) climb = tree([["tree", climb, ".."]]);
    tagged(
      "v0.0.1",
      [
        ["tree", climb, ".."],
        ["blob", ok, "01-ok.json"],
      ],
      [["blob", ok, "01-ok.json"]],
    );
    const pkg = pin("0.0.1");
    const r = sync();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("conformance/control-vectors/../../../package.json");
    expect(r.stderr).toContain("nothing was read or written");
    // The copy's own package.json is where that path lands: it is as it was, and nothing else was made.
    expect(readFileSync(path.join(copy, "package.json"), "utf8")).toBe(pkg);
    expect(existsSync(path.join(copy, "test"))).toBe(false);
    // The same for a check, and for a file that is merely not a fixture.
    expect(sync("--check").status).toBe(1);
    tagged(
      "v0.0.2",
      [
        ["blob", ok, "01-ok.json"],
        ["blob", ok, "notes.md"],
      ],
      [["blob", ok, "01-ok.json"]],
    );
    pin("0.0.2");
    const stray = sync();
    expect(stray.status, stray.stderr).toBe(1);
    expect(stray.stderr).toContain("conformance/control-vectors/notes.md");
    expect(existsSync(path.join(copy, "test"))).toBe(false);
  }, 60_000);

  it("copies a tree of fixtures whole, and --check then tells an edit from the tag even when the manifest was edited with it", () => {
    const one = '{"name":"one","expect":{"ok":true}}';
    tagged(
      "v0.0.3",
      [["blob", blob(one), "01-one.json"]],
      [["blob", blob('{"name":"two","steps":[]}'), "01-two.json"]],
    );
    pin("0.0.3");
    const r = sync();
    expect(r.status, r.stderr).toBe(0);
    const out = path.join(copy, "test", "conformance");
    expect(readFileSync(path.join(out, "control-vectors", "01-one.json"), "utf8")).toBe(one);
    const written = json<typeof manifest>(path.join(out, "manifest.json"));
    expect(written).toMatchObject({ version: "0.0.3", tag: "v0.0.3", commit: git(["rev-parse", "v0.0.3^{commit}"]) });
    expect(written.files).toEqual({
      "control-vectors/01-one.json": digest(one),
      "delivery/01-two.json": digest('{"name":"two","steps":[]}'),
    });
    expect(sync("--check").status).toBe(0);

    // What the in-repo test cannot see: the vector's verdict flipped, and its hash in the manifest with it.
    const edited = '{"name":"one","expect":{"ok":false}}';
    writeFileSync(path.join(out, "control-vectors", "01-one.json"), edited);
    writeFileSync(
      path.join(out, "manifest.json"),
      JSON.stringify({ ...written, files: { ...written.files, "control-vectors/01-one.json": digest(edited) } }),
    );
    const caught = sync("--check");
    expect(caught.status).toBe(1);
    expect(caught.stderr).toContain("differs control-vectors/01-one.json");
    // A vector taken out together with its line, and a manifest that names another commit.
    expect(sync().status).toBe(0);
    rmSync(path.join(out, "delivery", "01-two.json"));
    const { "delivery/01-two.json": _gone, ...rest } = written.files;
    writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ ...written, files: rest }));
    expect(sync("--check").stderr).toContain("missing delivery/01-two.json");
    expect(sync().status).toBe(0);
    writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ ...written, commit: "0".repeat(40) }));
    expect(sync("--check").stderr).toContain("manifest.json is not this tag's");
    // And a pin that is a range is refused outright.
    expect(sync().status).toBe(0);
    pin("^0.0.3");
    const ranged = sync("--check");
    expect(ranged.status).toBe(1);
    expect(ranged.stderr).toContain("one exact version");
  }, 60_000);

  // The sync removes its folders whole and writes files by path, and both go wherever a
  // path resolves. A checkout can hold a symbolic link where a folder or a file should be
  // (git stores them), so each place is looked at before anything is removed or written.
  it("touches nothing when test, test/conformance, a fixture folder or a file it writes is a symbolic link", () => {
    const one = '{"name":"one","expect":{"ok":true}}\n';
    const two = '{"name":"two","steps":[]}\n';
    tagged("v0.0.4", [["blob", blob(one), "01-one.json"]], [["blob", blob(two), "01-two.json"]]);
    pin("0.0.4");
    const test = path.join(copy, "test");
    const out = path.join(test, "conformance");

    // Somebody else's folder, laid out so that whatever the sync would remove or write
    // through a link has something of theirs to hit.
    const elsewhere = path.join(tmp, "elsewhere");
    const theirs = () => {
      rmSync(elsewhere, { recursive: true, force: true });
      for (const under of ["", "conformance"]) {
        for (const f of FOLDERS) {
          mkdirSync(path.join(elsewhere, under, f), { recursive: true });
          writeFileSync(path.join(elsewhere, under, f, "01-one.json"), "theirs");
          writeFileSync(path.join(elsewhere, under, f, "kept.txt"), "theirs");
        }
        writeFileSync(path.join(elsewhere, under, "manifest.json"), "theirs");
      }
      writeFileSync(path.join(elsewhere, "victim.json"), "theirs");
    };
    /** Every file under a folder with its bytes, and every link with where it points (never followed). */
    const snapshot = (dir: string, at = ""): Record<string, string> => {
      const found: Record<string, string> = {};
      for (const name of readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const rel = at ? `${at}/${name}` : name;
        const st = lstatSync(full);
        if (st.isSymbolicLink()) found[rel] = `link to ${readlinkSync(full)}`;
        else if (st.isDirectory()) Object.assign(found, { [`${rel}/`]: "folder" }, snapshot(full, rel));
        else found[rel] = readFileSync(full, "base64");
      }
      return found;
    };
    /** A symbolic link (a junction for a folder on Windows, which needs no privilege). False
     *  where the platform will not make one: a file link on Windows without the privilege. */
    const link = (target: string, at: string, kind: "dir" | "file"): boolean => {
      try {
        symlinkSync(target, at, kind === "dir" && process.platform === "win32" ? "junction" : kind);
        return true;
      } catch (e) {
        if (process.platform === "win32" && (e as NodeJS.ErrnoException).code === "EPERM") return false;
        throw e;
      }
    };
    /** The sync and the check both stop, name the link, and leave their folder and the copy as they were. */
    const refused = (what: string) => {
      const before = { theirs: snapshot(elsewhere), copy: snapshot(copy) };
      for (const args of [[], ["--check"]]) {
        const r = sync(...args);
        const said = `${what} ${args.join(" ")}: ${r.stdout}${r.stderr}`;
        expect(r.status, said).toBe(1);
        expect(r.stderr, said).toContain(`${what} is a symbolic link`);
        expect(r.stderr, said).toContain(args.length ? "nothing was read" : "nothing was removed or written");
        expect(snapshot(elsewhere), said).toEqual(before.theirs);
        expect(snapshot(copy), said).toEqual(before.copy);
      }
    };
    const fresh = () => {
      rmSync(test, { recursive: true, force: true });
      theirs();
    };

    // test itself is a link: test/conformance/<folder> would be their conformance/<folder>.
    fresh();
    expect(link(elsewhere, test, "dir")).toBe(true);
    refused("test");

    // test/conformance is a link: its folders and its manifest.json would be theirs.
    fresh();
    mkdirSync(test);
    link(elsewhere, out, "dir");
    refused("test/conformance");

    // One fixture folder is a link.
    fresh();
    mkdirSync(path.join(out, "delivery"), { recursive: true });
    link(path.join(elsewhere, "control-vectors"), path.join(out, "control-vectors"), "dir");
    refused("test/conformance/control-vectors");
    // … or holds one, at any depth: a folder that is removed whole is removed through nothing.
    fresh();
    mkdirSync(path.join(out, "delivery", "more"), { recursive: true });
    link(path.join(elsewhere, "delivery"), path.join(out, "delivery", "more", "deeper"), "dir");
    refused("test/conformance/delivery/more/deeper");

    // A real copy, synced; then a vector, and then the manifest, replaced by a link to a
    // file of theirs. The manifest is the one a write would have gone through.
    fresh();
    expect(sync().status).toBe(0);
    const vector = path.join(out, "control-vectors", "01-one.json");
    rmSync(vector);
    if (link(path.join(elsewhere, "victim.json"), vector, "file")) {
      refused("test/conformance/control-vectors/01-one.json");
      fresh();
      expect(sync().status).toBe(0);
      rmSync(path.join(out, "manifest.json"));
      link(path.join(elsewhere, "victim.json"), path.join(out, "manifest.json"), "file");
      refused("test/conformance/manifest.json");
    }

    // And with nothing in the way, the ordinary sync: the tag's bytes, exactly, into an
    // empty checkout and again over a copy that has drifted.
    fresh();
    const tagBytes = (rel: string) =>
      execFileSync("git", ["-C", upstream, "show", `v0.0.4:conformance/${rel}`]).toString("base64");
    const whole = () => {
      const r = sync();
      expect(r.status, r.stderr).toBe(0);
      const got = snapshot(out);
      expect(Object.keys(got).sort()).toEqual(
        [
          "control-vectors/",
          "control-vectors/01-one.json",
          "delivery/",
          "delivery/01-two.json",
          "manifest.json",
        ].sort(),
      );
      expect(got["control-vectors/01-one.json"]).toBe(tagBytes("control-vectors/01-one.json"));
      expect(got["control-vectors/01-one.json"]).toBe(Buffer.from(one).toString("base64"));
      expect(got["delivery/01-two.json"]).toBe(tagBytes("delivery/01-two.json"));
      expect(sync("--check").status).toBe(0);
      return got;
    };
    const first = whole();
    writeFileSync(path.join(out, "control-vectors", "01-one.json"), "{}");
    writeFileSync(path.join(out, "control-vectors", "99-stale.json"), "{}");
    mkdirSync(path.join(out, "delivery", "more"));
    writeFileSync(path.join(out, "delivery", "more", "x.json"), "{}");
    expect(whole()).toEqual(first);
    // Their folder was never part of it.
    expect(snapshot(elsewhere)["victim.json"]).toBe(Buffer.from("theirs").toString("base64"));
  }, 120_000);
});
