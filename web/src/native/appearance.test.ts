// SPDX-License-Identifier: Apache-2.0
import "./test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { followAppearance, schemeOf, sendAppearance } from "./appearance";

const invoke = vi.fn();
vi.mock("./bridge", () => ({ invoke: (...a: unknown[]) => invoke(...a), listen: vi.fn(), channel: vi.fn() }));
let platform = "ios";
vi.mock("./shell", () => ({ platform: () => platform }));

const root = document.documentElement as unknown as { dataset: Record<string, string | undefined> };
const g = globalThis as { spAppearance?: { set: (s: string) => void } };

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  platform = "ios";
  root.dataset.theme = undefined;
  g.spAppearance = undefined;
});

describe("schemeOf", () => {
  it("is the forced scheme, else auto", () => {
    expect(schemeOf("light")).toBe("light");
    expect(schemeOf("dark")).toBe("dark");
    for (const other of [undefined, null, "", "auto", "system", "Dark", 1]) expect(schemeOf(other)).toBe("auto");
  });
});

describe("sendAppearance", () => {
  it("iOS: the app_appearance command", () => {
    sendAppearance("dark");
    expect(invoke.mock.calls).toEqual([["app_appearance", { scheme: "dark" }]]);
  });
  it("a refused scheme never surfaces", async () => {
    invoke.mockRejectedValueOnce(new Error("unknown scheme"));
    expect(() => sendAppearance("auto")).not.toThrow();
    await Promise.resolve();
  });
  it("Android: spAppearance.set, and nothing without it", () => {
    platform = "android";
    const set = vi.fn();
    g.spAppearance = { set };
    sendAppearance("light");
    expect(set).toHaveBeenCalledWith("light");
    expect(invoke).not.toHaveBeenCalled();
    g.spAppearance = undefined;
    expect(() => sendAppearance("light")).not.toThrow();
  });
});

describe("followAppearance", () => {
  it("sends what <html data-theme> says at start", () => {
    root.dataset.theme = "light";
    followAppearance();
    expect(invoke.mock.calls).toEqual([["app_appearance", { scheme: "light" }]]);
  });
  it("no attribute is auto", () => {
    followAppearance();
    expect(invoke.mock.calls).toEqual([["app_appearance", { scheme: "auto" }]]);
  });
});
