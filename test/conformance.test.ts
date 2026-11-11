// SPDX-License-Identifier: Apache-2.0
// The conformance fixtures in test/conformance/ are the pinned sessionpipe's, whole and
// unedited. The control vectors and the delivery scenarios are only worth running while
// that holds: a bump of sessionpipe-core that leaves them behind, a vector edited or taken
// out to get green, or a file added by hand fails here and says what to run.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
  it("are the pinned sessionpipe-core's", () => {
    const lock = json<{ packages: Record<string, { version?: string } | undefined> }>(
      path.join(root, "package-lock.json"),
    );
    const pinned = lock.packages["node_modules/sessionpipe-core"]?.version;
    expect(pinned, "package-lock.json pins no sessionpipe-core").toBeTruthy();
    expect(
      manifest.version,
      `the fixtures are sessionpipe ${manifest.version}'s and package-lock.json pins sessionpipe-core ${pinned}: ${SYNC}`,
    ).toBe(pinned);
    expect(manifest.tag).toBe(`v${pinned}`);
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("and the verifier installed is that version", () => {
    const installed = json<{ version: string }>(path.join(root, "node_modules", "sessionpipe-core", "package.json"));
    expect(installed.version, "node_modules is not what package-lock.json pins: run `npm ci`").toBe(manifest.version);
  });

  it("are whole and unedited: every file the manifest lists, as it lists it, and no other", () => {
    const held: Record<string, string> = {};
    for (const folder of FIXTURE_FOLDERS)
      for (const f of fixtures(folder, {}).files)
        held[`${folder}/${f}`] = digest(readFileSync(path.join(VENDORED, folder, f), "utf8"));
    expect(held, SYNC).toEqual(manifest.files);
    for (const folder of FIXTURE_FOLDERS)
      expect(Object.keys(held).filter((rel) => rel.startsWith(`${folder}/`)).length).toBeGreaterThan(0);
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
