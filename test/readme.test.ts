// SPDX-License-Identifier: Apache-2.0
// The README's download links (RELEASING.md step 7 moves them by hand at each release):
// one tag for all of them, and each file named with that tag's version, as the release
// workflows name what they attach.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const links = [...readme.matchAll(/releases\/download\/v([^/]+)\/([^)"\s]+)/g)].map((m) => ({
  tag: m[1]!,
  file: m[2]!,
}));

describe("the README's download links", () => {
  it("all point at one release", () => {
    expect(links.length).toBeGreaterThan(0);
    expect(new Set(links.map((l) => l.tag)).size).toBe(1);
  });

  it("name each file with that release's version", () => {
    expect(links.filter((l) => !l.file.includes(l.tag))).toEqual([]);
  });

  // A link's words too: the table once read sessionpipe_0.7.2_universal.dmg over a 0.7.5 link.
  it("write no other version's file name anywhere on the page", () => {
    const tag = links[0]?.tag;
    const named = [...readme.matchAll(/sessionpipe(?:-gui)?[_-](\d+\.\d+\.\d+)[_.-]/g)].map((m) => m[1]!);
    expect(named.filter((v) => v !== tag)).toEqual([]);
  });
});
