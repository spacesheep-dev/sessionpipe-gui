// SPDX-License-Identifier: Apache-2.0
// The one rule for a tab that leaves the strip, whoever takes it out: a tab closed
// (lib/split.ts) or a session opened as its own page (lib/router.tsx).
import { describe, expect, it } from "vitest";
import { dropTab, splitParams } from "./splitState";

const tabs = ["claude-code:a", "claude-code:b", "claude-code:c"];

describe("dropTab", () => {
  it("keeps the same tab active when an earlier one leaves", () => {
    expect(dropTab({ tabs, active: 2 }, 0)).toEqual({ tabs: ["claude-code:b", "claude-code:c"], active: 1 });
    expect(dropTab({ tabs, active: 0 }, 2)).toEqual({ tabs: ["claude-code:a", "claude-code:b"], active: 0 });
  });

  it("hands the active tab over to its right neighbour, else the left one", () => {
    expect(dropTab({ tabs, active: 1 }, 1)).toEqual({ tabs: ["claude-code:a", "claude-code:c"], active: 1 });
    expect(dropTab({ tabs, active: 2 }, 2)).toEqual({ tabs: ["claude-code:a", "claude-code:b"], active: 1 });
  });

  it("leaves no tab, and so no s and no t, when the last one goes", () => {
    const none = dropTab({ tabs: ["claude-code:a"], active: 0 }, 0);
    expect(none).toEqual({ tabs: [], active: 0 });
    expect(splitParams(none)).toEqual({ s: null, t: null });
  });

  it("changes nothing for an index the strip does not have", () => {
    const state = { tabs, active: 1 };
    expect(dropTab(state, 3)).toBe(state);
    expect(dropTab(state, -1)).toBe(state);
  });
});

describe("splitParams", () => {
  it("writes t only where it says something: two tabs or more, or an index past the first", () => {
    expect(splitParams({ tabs: ["claude-code:a"], active: 0 })).toEqual({ s: "claude-code:a", t: null });
    expect(splitParams({ tabs, active: 0 })).toEqual({ s: tabs.join(","), t: "0" });
    expect(splitParams({ tabs, active: 2 })).toEqual({ s: tabs.join(","), t: "2" });
  });
});
