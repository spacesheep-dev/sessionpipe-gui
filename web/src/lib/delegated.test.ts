// SPDX-License-Identifier: Apache-2.0
// Where an asked session goes on the board: under its asker; a chain under the chain's
// top; a loop nests nobody; a parent the child may not hang under (another machine, a
// filter, not a root) ends the climb; nothing is ever lost from the board.
import type { SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { ASKED_SHOWN, askedComputer, askedSessions, askedShown, foldsAway, nestDelegated } from "./delegated";

const s = (key: string, delegatedBy?: string, machine = "lab-mac"): SessionSummary =>
  ({ key, machine, ...(delegatedBy ? { delegatedBy } : {}) }) as unknown as SessionSummary;
const sameMachine = (c: SessionSummary, p: SessionSummary) => c.machine === p.machine;
const keys = (list: readonly SessionSummary[]) => list.map((x) => x.key);
const shape = (roots: SessionSummary[], all = roots, hangs = sameMachine) => {
  const { roots: r, nested } = nestDelegated(roots, all, hangs);
  return { roots: keys(r), nested: Object.fromEntries([...nested].map(([k, v]) => [k, keys(v)])) };
};

describe("nestDelegated", () => {
  it("an asked session nests under its asker; one with no asker on the board stays a root", () => {
    const a = s("claude-code:a");
    const b = s("codex:b", a.key);
    const lone = s("codex:lone", "claude-code:gone");
    expect(shape([a, b, lone])).toEqual({
      roots: ["claude-code:a", "codex:lone"],
      nested: { "claude-code:a": ["codex:b"] },
    });
  });

  it("a chain hangs every link under its top, and the top stays a root", () => {
    const a = s("claude-code:a");
    const b = s("codex:b", a.key);
    const c = s("gemini-cli:c", b.key);
    expect(shape([c, b, a])).toEqual({
      roots: ["claude-code:a"],
      nested: { "claude-code:a": ["gemini-cli:c", "codex:b"] },
    });
  });

  it("a loop nests nobody: both stay roots, a session asked by one of them hangs under it", () => {
    const a = s("claude-code:a", "codex:b");
    const b = s("codex:b", "claude-code:a");
    const c = s("gemini-cli:c", "codex:b");
    expect(shape([a, b, c])).toEqual({ roots: ["claude-code:a", "codex:b", "gemini-cli:c"], nested: {} });
  });

  it("the climb ends at a parent the child may not hang under: another machine, a filter, not a root", () => {
    const far = s("claude-code:far", undefined, "build-box");
    const b = s("codex:b", far.key);
    const c = s("gemini-cli:c", b.key);
    // far is on another machine: b is the top, c under it.
    expect(shape([far, b, c])).toEqual({
      roots: ["claude-code:far", "codex:b"],
      nested: { "codex:b": ["gemini-cli:c"] },
    });
    // A parent filtered off the board (not in roots) is the same: the child stays a root.
    const a = s("claude-code:a");
    const kid = s("codex:kid", a.key);
    expect(shape([kid], [a, kid])).toEqual({ roots: ["codex:kid"], nested: {} });
    // A parent that is a subagent's child session is not a root either.
    expect(shape([kid], [a, kid], () => true)).toEqual({ roots: ["codex:kid"], nested: {} });
  });

  it("a session naming itself stays a root", () => {
    const me = s("claude-code:me", "claude-code:me");
    expect(shape([me])).toEqual({ roots: ["claude-code:me"], nested: {} });
  });

  it("a parent in a folded Done keeps no live child: the asked session stays a root until Done opens", () => {
    const done = s("claude-code:a");
    const live = s("codex:b", done.key);
    const ended = s("codex:c", done.key);
    const states = { [done.key]: "done", [live.key]: "working", [ended.key]: "done" } as const;
    const withState = (x: SessionSummary) => ({ ...x, state: states[x.key as keyof typeof states] }) as SessionSummary;
    const [d, l, e] = [done, live, ended].map(withState) as [SessionSummary, SessionSummary, SessionSummary];
    expect(foldsAway(l, d, false)).toBe(true);
    expect(foldsAway(l, d, true)).toBe(false);
    expect(foldsAway(e, d, false)).toBe(false);
    const hangs = (showDone: boolean) => (c: SessionSummary, p: SessionSummary) =>
      sameMachine(c, p) && !foldsAway(c, p, showDone);
    expect(shape([d, l, e], [d, l, e], hangs(false))).toEqual({
      roots: ["claude-code:a", "codex:b"],
      nested: { "claude-code:a": ["codex:c"] },
    });
    expect(shape([d, l, e], [d, l, e], hangs(true))).toEqual({
      roots: ["claude-code:a"],
      nested: { "claude-code:a": ["codex:b", "codex:c"] },
    });
  });
});

describe("askedSessions (a session's page)", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 24, 12, min)).toISOString();
  const kid = (key: string, o: Partial<SessionSummary> = {}): SessionSummary =>
    ({ key, machine: "lab-mac", state: "done", startedAt: at(0), ...o }) as unknown as SessionSummary;
  const parent = kid("claude-code:p", {
    state: "working",
    delegations: [
      { askId: "1", via: "ask", harness: "codex", to: "codex:asked", startedAt: at(1) },
      // Its id not revealed yet: the turn's AskRow has it, the list has nothing to open.
      { askId: "2", via: "ask", harness: "codex", startedAt: at(2) },
      // One that names the parent itself counts once, as nothing.
      { askId: "3", via: "handoff", harness: "claude-code", to: "claude-code:p", startedAt: at(3) },
    ],
  });

  it("counts what it asked, what was started for it and what it launched; not its subagents, not others'", () => {
    const all = [
      parent,
      kid("codex:asked", { startedAt: at(1) }),
      kid("codex:for", { delegatedBy: parent.key, startedAt: at(2) }),
      kid("claude-code:run", { launchedBy: parent.key, startedAt: at(3) }),
      kid("claude-code:sub", { parentId: "p", startedAt: at(4) }),
      kid("codex:other", { delegatedBy: "claude-code:other", startedAt: at(5) }),
      // A grandchild is on its own parent's page: one level.
      kid("gemini-cli:grand", { delegatedBy: "codex:for", startedAt: at(6) }),
    ];
    expect(keys(askedSessions(parent, all))).toEqual(["claude-code:run", "codex:for", "codex:asked"]);
    // Named twice (a delegation and its own delegated_by), listed once.
    const both = kid("codex:asked", { delegatedBy: parent.key, startedAt: at(1) });
    expect(keys(askedSessions(parent, [parent, both]))).toEqual(["codex:asked"]);
    // No children: an empty list, so the page draws none.
    expect(askedSessions(kid("claude-code:alone"), all)).toEqual([]);
  });

  it("puts the ones that need you first, then the newest started", () => {
    const all = [
      kid("a:old-needs", { delegatedBy: parent.key, state: "needs_you", startedAt: at(1) }),
      kid("a:new-done", { delegatedBy: parent.key, state: "done", startedAt: at(9) }),
      kid("a:mid-working", { delegatedBy: parent.key, state: "working", startedAt: at(5) }),
      kid("a:new-needs", { delegatedBy: parent.key, state: "needs_you", startedAt: at(7) }),
    ];
    expect(keys(askedSessions(parent, all))).toEqual(["a:new-needs", "a:old-needs", "a:new-done", "a:mid-working"]);
  });

  it("shows five and leaves the rest for Show all; never hides one that needs you", () => {
    const list = (n: number, needs = 0) =>
      Array.from({ length: n }, (_, i) => kid(`a:${i}`, { state: i < needs ? "needs_you" : "done" }));
    expect(ASKED_SHOWN).toBe(5);
    expect(askedShown(list(5), false)).toMatchObject({ more: 0 });
    expect(askedShown(list(5), false).shown).toHaveLength(5);
    expect(askedShown(list(7), false).shown).toHaveLength(5);
    expect(askedShown(list(7), false).more).toBe(2);
    expect(askedShown(list(7), true)).toMatchObject({ more: 0 });
    expect(askedShown(list(7), true).shown).toHaveLength(7);
    expect(askedShown(list(9, 6), false)).toMatchObject({ more: 3 });
  });

  it("always names the computer, the asking session's own included", () => {
    expect(askedComputer(kid("a:1"))).toBe("lab-mac");
    expect(askedComputer(kid("a:2", { machine: "build-runner-eu-west-1-c5-xlarge-0042-ab" }))).toBe(
      "build-runner-eu-west-1-c5-xlarge-0042-ab",
    );
    expect(askedComputer(kid("a:3", { machine: undefined }))).toBe("Unknown computer");
    expect(askedComputer(kid("a:4", { machine: "  " }))).toBe("Unknown computer");
  });
});
