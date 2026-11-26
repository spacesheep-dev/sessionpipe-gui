// SPDX-License-Identifier: Apache-2.0
// Keyboard folds and moves suppress FLIP slides for 50 ms via calmNextCommit().
import "../native/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calmNextCommit, isCalmCommit } from "./motion";

describe("calmNextCommit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("suppresses FLIP motion for 50 ms and then clears", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    expect(isCalmCommit()).toBe(false);
    calmNextCommit();
    expect(isCalmCommit()).toBe(true);
    now = 1049;
    expect(isCalmCommit()).toBe(true);
    now = 1051;
    expect(isCalmCommit()).toBe(false);
  });
});
