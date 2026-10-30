// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { type NavEnv, navDirection } from "./transitions";

const phone: NavEnv = { phone: true, reduced: false, supported: true };

describe("navDirection", () => {
  it("pushes a session opened from any list", () => {
    for (const list of ["board", "inbox", "search", "feed", "review"])
      expect(navDirection(list, "session", "navigate", phone)).toBe("push");
  });

  it("pops back from a session to its list, through history.back() or the fallback navigate", () => {
    expect(navDirection("session", "board", "back", phone)).toBe("pop");
    expect(navDirection("session", "inbox", "back", phone)).toBe("pop");
  });

  it("plays nothing on a popstate the browser or the native gesture already animated", () => {
    expect(navDirection("session", "board", "popstate", phone)).toBeNull();
    expect(navDirection("board", "session", "popstate", phone)).toBeNull();
  });

  it("plays nothing on a desktop, under reduced motion, or without view transitions", () => {
    expect(navDirection("board", "session", "navigate", { ...phone, phone: false })).toBeNull();
    expect(navDirection("board", "session", "navigate", { ...phone, reduced: true })).toBeNull();
    expect(navDirection("board", "session", "navigate", { ...phone, supported: false })).toBeNull();
  });

  it("plays nothing between pages that are not a list and a session", () => {
    expect(navDirection("board", "inbox", "navigate", phone)).toBeNull();
    expect(navDirection("session", "session", "navigate", phone)).toBeNull();
    expect(navDirection("machines", "session", "navigate", phone)).toBeNull();
    expect(navDirection("session", "machines", "back", phone)).toBeNull();
    // A tab tapped while on a session is a jump, as it is on iOS.
    expect(navDirection("session", "inbox", "navigate", phone)).toBeNull();
    // A list going back to a list (the browser's history) is not a pop.
    expect(navDirection("inbox", "board", "back", phone)).toBeNull();
  });

  it("plays nothing on a replace", () => {
    expect(navDirection("board", "session", "replace", phone)).toBeNull();
  });
});
