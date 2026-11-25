// SPDX-License-Identifier: Apache-2.0
// A rule's run in words: started, continued, or run when how it began is not known; where
// the rule lives, the computer's name isolated; nothing for a name a rule cannot have.
import { describe, expect, it } from "vitest";
import { triggerWords } from "./triggered";

const REST = "Rules are made, paused and removed only at that computer.\nTo see them there: sessionpipe trigger list";

describe("triggerWords", () => {
  it("says a rule started the session, naming the rule and its computer", () => {
    expect(triggerWords({ triggeredBy: "card-todo", triggeredFrom: "start", machine: "studio-mac" })).toEqual({
      name: "card-todo",
      lead: "Started by trigger ",
      sentence: "Started by trigger card-todo",
      tip: `A rule named card-todo on ⁨studio-mac⁩ started this session.\n${REST}`,
    });
  });

  it("says a rule continued a session", () => {
    const w = triggerWords({ triggeredBy: "monday-report", triggeredFrom: "continue", machine: "build-box" })!;
    expect(w.sentence).toBe("Continued by trigger monday-report");
    expect(w.tip).toBe(`A rule named monday-report on ⁨build-box⁩ continued this session.\n${REST}`);
  });

  it("says run, never started, when how the run began is not known", () => {
    for (const from of ["unknown", undefined] as const) {
      const w = triggerWords({ triggeredBy: "card-todo", triggeredFrom: from, machine: "studio-mac" })!;
      expect(w.sentence).toBe("Run by trigger card-todo");
      expect(w.tip).toBe(`A rule named card-todo on ⁨studio-mac⁩ ran this session.\n${REST}`);
      expect(w.tip).not.toMatch(/started|continued/);
    }
  });

  it("names no computer it does not know, and isolates one that holds a direction mark", () => {
    expect(triggerWords({ triggeredBy: "card-todo", triggeredFrom: "start" })!.tip).toMatch(
      /^A rule named card-todo on its computer started this session\.\n/,
    );
    expect(triggerWords({ triggeredBy: "card-todo", triggeredFrom: "start", machine: "  " })!.tip).toContain(
      "on its computer",
    );
    const rtl = triggerWords({ triggeredBy: "card-todo", triggeredFrom: "start", machine: "mac\u202eevil" })!;
    expect(rtl.tip).toContain("on \u2068macevil\u2069 started");
  });

  it("keeps the computer's name inside its isolation: a close of its own, or any control, is dropped", () => {
    // Its own U+2069 would close the isolation early and let the U+202E after it turn the
    // rest of the tip around.
    const w = triggerWords({
      triggeredBy: "card-todo",
      triggeredFrom: "start",
      machine: "mac\u2069\u202eevil\u200b\n",
    })!;
    expect(w.tip).toContain("on \u2068macevil\u2069 started this session.");
    const bidi = [...w.tip].filter((c) => /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(c));
    expect(bidi).toEqual(["\u2068", "\u2069"]);
    expect(w.tip.split("\n")).toHaveLength(3);
    expect(triggerWords({ triggeredBy: "card-todo", triggeredFrom: "start", machine: "\u202e\u2069" })!.tip).toContain(
      "on its computer",
    );
  });

  it("is a sentence a line, the command whole on its own", () => {
    const w = triggerWords({ triggeredBy: "card-todo", triggeredFrom: "start", machine: "studio-mac" })!;
    expect(w.tip.split("\n")).toEqual([
      "A rule named card-todo on \u2068studio-mac\u2069 started this session.",
      "Rules are made, paused and removed only at that computer.",
      "To see them there: sessionpipe trigger list",
    ]);
  });

  it("says nothing when no rule ran it, or of a name no rule can have", () => {
    expect(triggerWords({ machine: "studio-mac" })).toBeNull();
    for (const bad of ["", "Card", "card todo", "card:todo", "x".repeat(41)])
      expect(triggerWords({ triggeredBy: bad, triggeredFrom: "start" }), bad).toBeNull();
    expect(triggerWords({ triggeredBy: "x".repeat(40), triggeredFrom: "start" })?.name).toBe("x".repeat(40));
  });
});
