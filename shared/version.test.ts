// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareVersions } from "./version.js";

const table = JSON.parse(readFileSync(new URL("./version-cases.json", import.meta.url), "utf8")) as {
  cases: [string, string, number][];
};

describe("compareVersions", () => {
  it("orders the shared table as the desktop app's version_cmp does", () => {
    for (const [a, b, sign] of table.cases) expect([a, b, Math.sign(compareVersions(a, b))]).toEqual([a, b, sign]);
    expect(table.cases.length).toBeGreaterThan(10);
  });
});
