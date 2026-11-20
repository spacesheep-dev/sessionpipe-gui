// SPDX-License-Identifier: Apache-2.0
// The Date chip's label for the `since:` / `until:` days in the query.
import { describe, expect, it } from "vitest";
import { rangeLabel } from "./DateRange";

describe("rangeLabel", () => {
  it("names only a day the search reads", () => {
    expect(rangeLabel(undefined, "2026-11-30")).toMatch(/^Until /);
    // 2026-02-30 is left out of the search, so the chip does not say "Until Mar 2".
    expect(rangeLabel(undefined, "2026-02-30")).toBeNull();
    expect(rangeLabel("2026-11-31", undefined)).toBeNull();
    expect(rangeLabel("2026-02-01", "2026-02-29")).toBe(rangeLabel("2026-02-01", undefined));
    expect(rangeLabel(undefined, "2028-02-29")).toMatch(/^Until /);
  });
});
