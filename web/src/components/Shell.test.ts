// SPDX-License-Identifier: Apache-2.0
import "../native/test-env";
import type { InstalledTheme } from "@shared/theme-api";
import { describe, expect, it } from "vitest";
import { navItems } from "./Shell";

const theme = (id: string, o: Partial<InstalledTheme> = {}): InstalledTheme =>
  ({ id, name: id, ...o }) as InstalledTheme;
const THEMES = [
  theme("canvas", { experimental: true }),
  theme("mine"),
  theme("broken", { error: "no index.js" }),
  theme("off", { disabled: true }),
  theme("office", { experimental: true }),
];
const keys = (o: Parameters<typeof navItems>[1]) => navItems(THEMES, o).map((n) => n.key);
const groups = (o: Parameters<typeof navItems>[1]) => navItems(THEMES, o).map((n) => n.group ?? "foot");

describe("navItems: the sidebar's rows and their groups", () => {
  it("Simple: the lists, Workflows and Machines, the views the person chose, then Finish setup", () => {
    expect(keys({ simple: true, setup: true })).toEqual([
      "board",
      "inbox",
      "search",
      "workflows",
      "machines",
      "t:mine",
      "setup",
    ]);
    expect(groups({ simple: true, setup: true })).toEqual([0, 0, 0, 2, 2, 3, "foot"]);
  });

  it("Advanced: Feed and Review are a group of their own, the experimental views one after the views", () => {
    expect(keys({ setup: true })).toEqual([
      "board",
      "inbox",
      "search",
      "feed",
      "review",
      "workflows",
      "machines",
      "t:mine",
      "t:canvas",
      "t:office",
      "setup",
    ]);
    expect(groups({ setup: true })).toEqual([0, 0, 0, 1, 1, 2, 2, 3, 4, 4, "foot"]);
  });

  it("has no Connect row in either mode, and Setup reads as what to do next", () => {
    for (const simple of [true, false]) expect(keys({ simple, setup: true })).not.toContain("connect");
    expect(navItems([], { setup: true }).at(-1)).toMatchObject({ key: "setup", label: "Finish setup" });
    expect(keys({ setup: false })).not.toContain("setup");
  });

  it("a spacesheep account has no Workflows and no Setup, in either mode", () => {
    expect(keys({ simple: true, setup: true, account: true })).toEqual([
      "board",
      "inbox",
      "search",
      "machines",
      "t:mine",
    ]);
    expect(keys({ setup: true, account: true })).toEqual([
      "board",
      "inbox",
      "search",
      "feed",
      "review",
      "machines",
      "t:mine",
      "t:canvas",
      "t:office",
    ]);
  });
});
