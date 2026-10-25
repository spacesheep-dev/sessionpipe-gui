// SPDX-License-Identifier: Apache-2.0

import type { InstalledSkin } from "@shared/skin-api";
import { BUILTIN_SKINS } from "@shared/skins-builtin";
import { describe, expect, it } from "vitest";

// A device that chose Spacesheep before the brand: the stored skin as an older build wrote it.
const store = new Map<string, string>([
  [
    "sessionpipe-gui.skin",
    JSON.stringify({
      id: "spacesheep",
      name: "Spacesheep",
      version: "",
      scheme: "both",
      source: "builtin",
      tokens: { dark: { "--bg": "oklch(0.185 0.01 285)" }, light: { "--bg": "oklch(0.993 0.002 285)" } },
    }),
  ],
]);
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});
const { currentSkin, getDisplaySettings } = await import("./theme");

const skin = (s: Partial<InstalledSkin>): InstalledSkin =>
  ({ name: "x", version: "", scheme: "both", source: "builtin", tokens: {}, ...s }) as InstalledSkin;

describe("the stored skin", () => {
  it("moves a device on Spacesheep to sessionpipe, silently, and stores the move", () => {
    expect(getDisplaySettings().skin.id).toBe("sessionpipe");
    const stored = JSON.parse(store.get("sessionpipe-gui.skin")!) as InstalledSkin;
    expect(stored).toEqual(BUILTIN_SKINS[0]);
  });

  it("is this build's own copy of a built-in, the default for Plain or one no longer shipped", () => {
    const paper = BUILTIN_SKINS.find((b) => b.id === "paper")!;
    expect(currentSkin(skin({ id: "paper", tokens: { light: { "--bg": "old" } } }))).toBe(paper);
    expect(currentSkin(skin({ id: "spacesheep" })).id).toBe("sessionpipe");
    expect(currentSkin(skin({ id: "plain" })).id).toBe("sessionpipe");
    expect(currentSkin(skin({ id: "graphite" })).id).toBe("sessionpipe");
  });

  it("leaves an installed skin alone, whatever its id", () => {
    const own = skin({ id: "spacesheep", source: "skin" });
    expect(currentSkin(own)).toBe(own);
  });
});
