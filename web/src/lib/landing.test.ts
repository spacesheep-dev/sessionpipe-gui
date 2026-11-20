// SPDX-License-Identifier: Apache-2.0
// Open on (Settings › General): the app lands on it only from a bare / nobody asked for.
import { describe, expect, it } from "vitest";
import { landingFor } from "./landing";

describe("landingFor", () => {
  it("lands on the chosen page when the app was opened at a bare /", () => {
    expect(landingFor({ at: "/", asked: false }, "/inbox")).toBe("/inbox");
    expect(landingFor({ at: "/", asked: false }, "/machines")).toBe("/machines");
  });

  it("stays when Open on is the Board", () => {
    expect(landingFor({ at: "/", asked: false }, "/")).toBeNull();
  });

  it("stays when the address carries anything: the mock, a key, another page", () => {
    expect(landingFor({ at: "/?mock=1", asked: false }, "/inbox")).toBeNull();
    expect(landingFor({ at: "/?k=abc", asked: false }, "/inbox")).toBeNull();
    expect(landingFor({ at: "/s/claude-code/x", asked: false }, "/inbox")).toBeNull();
    expect(landingFor({ at: "/feed", asked: false }, "/inbox")).toBeNull();
  });

  it("stays on the Board when the address itself names the tabs: a reload, a bookmark", () => {
    expect(landingFor({ at: "/?s=claude-code%3Ak", asked: false }, "/inbox")).toBeNull();
  });

  it("lands from the New session shortcut: its parameters name a sheet, not a page", () => {
    expect(landingFor({ at: "/?new=1", asked: false }, "/inbox")).toBe("/inbox");
    expect(landingFor({ at: "/?new=1&machine=m&harness=h&cwd=%2Fx", asked: false }, "/inbox")).toBe("/inbox");
    // Anything else beside them is still someone asking.
    expect(landingFor({ at: "/?new=1&mock=1", asked: false }, "/inbox")).toBeNull();
    expect(landingFor({ at: "/?new=1&s=claude-code%3Ak", asked: false }, "/inbox")).toBeNull();
    expect(landingFor({ at: "/feed?new=1", asked: false }, "/inbox")).toBeNull();
    // Without new=1 the sheet does not open and the three stay in the address.
    expect(landingFor({ at: "/?machine=m", asked: false }, "/inbox")).toBeNull();
    expect(landingFor({ at: "/?new=0", asked: false }, "/inbox")).toBeNull();
  });

  it("stays when the page was asked for: Go › Board with the window closed", () => {
    expect(landingFor({ at: "/", asked: true }, "/inbox")).toBeNull();
    expect(landingFor({ at: "/?new=1", asked: true }, "/inbox")).toBeNull();
  });
});
