// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { compareVersions } from "./version.js";

describe("compareVersions", () => {
  it("orders x.y.z by number, not by text", () => {
    expect(compareVersions("0.7.2", "0.8.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.8.0", "0.8.0")).toBe(0);
    expect(compareVersions("v0.8.0", "0.8")).toBe(0);
  });

  it("puts a prerelease before its release, and reads what isn't a number as 0", () => {
    expect(compareVersions("0.9.0-rc.1", "0.9.0")).toBeLessThan(0);
    expect(compareVersions("0.9.0", "0.9.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0-rc.1", "0.8.5")).toBeGreaterThan(0);
    expect(compareVersions("", "0.0.0")).toBe(0);
    expect(compareVersions("x.y", "0.1")).toBeLessThan(0);
  });
});
