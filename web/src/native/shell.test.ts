// SPDX-License-Identifier: Apache-2.0
import "./test-env";
import { describe, expect, it, vi } from "vitest";
import { parseShell, safePath } from "./shell";

vi.mock("../lib/router", () => ({ navigate: vi.fn(), back: vi.fn() }));

const ok = {
  v: 1,
  platform: "macos",
  appVersion: "0.3.0",
  features: ["tray", "vibrancy", "teleport"],
  receiver: { id: "abcdefghij", name: "This Mac", origin: "http://127.0.0.1:7815", local: true },
  rxBase: "rx://localhost/abcdefghij",
};

describe("parseShell", () => {
  it("reads a v1 flag and drops unknown features", () => {
    expect(parseShell(ok)).toEqual({ ...ok, features: ["tray", "vibrancy"] });
  });
  it("absent or malformed is no shell", () => {
    for (const raw of [undefined, null, "macos", 1, [], {}, { platform: "macos" }]) expect(parseShell(raw)).toBeNull();
    expect(parseShell({ ...ok, platform: "beos" })).toBeNull();
  });
  it("another version is no shell", () => {
    expect(parseShell({ ...ok, v: 2 })).toBeNull();
    expect(parseShell({ ...ok, v: "1" })).toBeNull();
  });
  it("no receiver: receiver and rxBase are null", () => {
    expect(parseShell({ ...ok, receiver: null, rxBase: null })).toMatchObject({ receiver: null, rxBase: null });
    // A base without a receiver is meaningless.
    expect(parseShell({ ...ok, receiver: null })).toMatchObject({ receiver: null, rxBase: null });
    expect(parseShell({ ...ok, receiver: { name: "x" } })).toMatchObject({ receiver: null });
  });
  it("tolerates missing optional fields", () => {
    expect(parseShell({ v: 1, platform: "ios" })).toEqual({
      v: 1,
      platform: "ios",
      appVersion: "",
      features: [],
      receiver: null,
      rxBase: null,
    });
    expect(parseShell({ ...ok, receiver: { id: "r1", origin: "http://x" } })?.receiver).toEqual({
      id: "r1",
      name: "r1",
      origin: "http://x",
      local: false,
    });
  });
});

describe("safePath", () => {
  it("accepts in-app paths only", () => {
    expect(safePath("/inbox")).toBe("/inbox");
    expect(safePath("/s/claude/abc?agent=x")).toBe("/s/claude/abc?agent=x");
    for (const bad of ["//evil.example/x", "https://x", "inbox", "/a\\b", "/a\nb", "", 3, null])
      expect(safePath(bad)).toBeNull();
  });
});
