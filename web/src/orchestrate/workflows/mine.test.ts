// SPDX-License-Identifier: Apache-2.0
// The runs this browser signs for, across tabs: a write starts from what the storage
// holds, so a run another tab started is kept, and another tab's write is followed.
import { afterEach, describe, expect, it, vi } from "vitest";

describe("mine", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("adds up across tabs instead of one tab's stale copy dropping the other's", async () => {
    let stored: string | null = null;
    let onStorage: ((e: { key: string | null }) => void) | undefined;
    vi.stubGlobal("localStorage", {
      getItem: () => stored,
      setItem: (_: string, v: string) => (stored = v),
      removeItem: () => (stored = null),
    });
    vi.stubGlobal("window", {
      addEventListener: (type: string, f: typeof onStorage) => {
        if (type === "storage") onStorage = f;
      },
    });
    vi.resetModules();
    const { forgetMine, markMine, mineNow } = await import("./mine");
    markMine("r1");
    expect([...mineNow()]).toEqual(["r1"]);
    // Tab B starts r2 and writes [r1, r2]; this tab has not heard yet.
    stored = JSON.stringify(["r1", "r2"]);
    // This tab starts r3: r2 stays.
    markMine("r3");
    expect(JSON.parse(stored!)).toEqual(["r1", "r2", "r3"]);
    expect([...mineNow()]).toEqual(["r1", "r2", "r3"]);
    // Tab B forgets r1; the storage event brings it here, the same set object until then.
    const before = mineNow();
    expect(mineNow()).toBe(before);
    stored = JSON.stringify(["r2", "r3"]);
    onStorage?.({ key: "sessionpipe.workflows.mine" });
    expect([...mineNow()]).toEqual(["r2", "r3"]);
    expect(mineNow()).not.toBe(before);
    // Forgetting starts from the storage too.
    stored = JSON.stringify(["r2", "r3", "r4"]);
    forgetMine("r3");
    expect(JSON.parse(stored!)).toEqual(["r2", "r4"]);
  });
});
