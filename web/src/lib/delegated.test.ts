// SPDX-License-Identifier: Apache-2.0
// Where an asked session goes on the board: under its asker; a chain under the chain's
// top; a loop nests nobody; a parent the child may not hang under (another machine, a
// filter, not a root) ends the climb; nothing is ever lost from the board.
import type { SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { foldsAway, nestDelegated } from "./delegated";

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
