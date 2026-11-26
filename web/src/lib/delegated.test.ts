// SPDX-License-Identifier: Apache-2.0
// Lineage across sessions (where an asked session goes is lib/tree.test.ts's): a session's
// page lists what it asked, and a child that needs you takes its parent into Needs you,
// whose count is the Inbox badge's.
// The badge's own test (data/hooks.ts needsYouNow) needs the page's window.
import "../native/test-env";
import type { Attention, SessionState, SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import type { AnswerOut } from "../control/answers";
import { needsYouNow } from "../data/hooks";
import { ASKED_SHOWN, askedComputer, askedSessions, askedShown, parentOf, sectionOf, waitingIn } from "./delegated";
import { arrangeTree } from "./tree";

const keys = (list: readonly SessionSummary[]) => list.map((x) => x.key);

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

  it("counts a session started for it on its own machine only; one its delegations name, on any", () => {
    const all = [
      parent,
      kid("codex:here", { delegatedBy: parent.key, startedAt: at(1) }),
      // Another computer's hooks say so: no lineage in this stage.
      kid("codex:there", { delegatedBy: parent.key, machine: "build-box", startedAt: at(2) }),
      // The parent's own delegation names it: listed wherever it runs.
      kid("codex:asked", { machine: "build-box", startedAt: at(3) }),
    ];
    expect(keys(askedSessions(parent, all))).toEqual(["codex:asked", "codex:here"]);
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

describe("a child that needs you lifts its parent into Needs you", () => {
  const at = "2026-11-24T10:00:00.000Z";
  const prompt = (id: string): Attention => ({ attentionId: id, kind: "permission", at }) as Attention;
  const row = (key: string, state: SessionState, delegatedBy?: string): SessionSummary =>
    ({
      key,
      machine: "lab-mac",
      state,
      stateSince: at,
      startedAt: at,
      openAttentions: state === "needs_you" ? [prompt(`p-${key}`)] : [],
      ...(delegatedBy ? { delegatedBy } : {}),
    }) as unknown as SessionSummary;
  /** The Board's Needs you, as pages/Board.tsx draws it with nothing held, and the badge's
   *  number (data/hooks.ts useNeedsYouCount) for the same sessions. */
  const board = (all: SessionSummary[], out: Record<string, AnswerOut> = {}) => {
    const needs = (c: SessionSummary) => c.state === "needs_you";
    const tree = arrangeTree({ all, arrangement: { placed: {}, pinned: [] }, needs });
    const roots = tree.roots.map((n) => n.s);
    const nested = tree.childrenOf;
    const section = new Map(roots.map((r) => [r.key, sectionOf(r, nested.get(r.key), needs)]));
    const rows = roots.filter((r) => section.get(r.key) === "needs_you");
    const wait = (x: SessionSummary) => needsYouNow(x, {}, out);
    return {
      rows: keys(rows),
      count: waitingIn(rows, (r) => nested.get(r.key), wait),
      badge: all.filter(wait).length,
      section: Object.fromEntries(section),
    };
  };

  it("the parent needs you and its child does not: the parent alone, one", () => {
    const b = board([row("claude-code:p", "needs_you"), row("codex:c", "working", "claude-code:p")]);
    expect(b).toMatchObject({ rows: ["claude-code:p"], count: 1, badge: 1 });
  });

  it("the child needs you under a working parent: the parent's row is in Needs you, one", () => {
    const b = board([row("claude-code:p", "working"), row("codex:c", "needs_you", "claude-code:p")]);
    expect(b).toMatchObject({ rows: ["claude-code:p"], count: 1, badge: 1 });
    expect(b.section["claude-code:p"]).toBe("needs_you");
  });

  it("both need you: one row, two sessions", () => {
    const b = board([row("claude-code:p", "needs_you"), row("codex:c", "needs_you", "claude-code:p")]);
    expect(b).toMatchObject({ rows: ["claude-code:p"], count: 2, badge: 2 });
  });

  it("two children need you under an idle parent, beside a row that needs you itself: three", () => {
    const b = board([
      row("claude-code:p", "idle"),
      row("codex:c1", "needs_you", "claude-code:p"),
      row("gemini-cli:c2", "needs_you", "claude-code:p"),
      row("claude-code:q", "needs_you"),
    ]);
    expect(b).toMatchObject({ rows: ["claude-code:p", "claude-code:q"], count: 3, badge: 3 });
  });

  it("a child whose prompt has its answer out keeps the parent there and counts no more, as the badge", () => {
    const b = board([row("claude-code:p", "working"), row("codex:c", "needs_you", "claude-code:p")], {
      "p-codex:c": { status: "sent", decision: "allow" },
    });
    expect(b).toMatchObject({ rows: ["claude-code:p"], count: 0, badge: 0 });
  });

  it("the child stops needing you: the parent goes back to its own section", () => {
    const b = board([row("claude-code:p", "working"), row("codex:c", "working", "claude-code:p")]);
    expect(b).toMatchObject({ rows: [], count: 0, badge: 0 });
    expect(b.section["claude-code:p"]).toBe("working");
  });
});

describe('parentOf (the Inbox\'s "for <parent>")', () => {
  const all = new Map(
    [
      { key: "claude-code:p", harness: "claude-code", title: "Plan the migration" },
      { key: "claude-code:q", harness: "claude-code", title: "Launch the batch" },
    ].map((x) => [x.key, x as unknown as SessionSummary]),
  );
  const get = (k: string) => all.get(k);
  const child = (o: Partial<SessionSummary>) =>
    ({ key: "codex:c", harness: "codex", ...o }) as unknown as SessionSummary;
  it("names the session that asked it, whose subagent it is, or that launched it", () => {
    expect(parentOf(child({ delegatedBy: "claude-code:p" }), get)?.key).toBe("claude-code:p");
    expect(parentOf(child({ harness: "claude-code", key: "claude-code:c", parentId: "p" }), get)?.key).toBe(
      "claude-code:p",
    );
    expect(parentOf(child({ launchedBy: "claude-code:q" }), get)?.key).toBe("claude-code:q");
    // Asked and launched: the one that asked.
    expect(parentOf(child({ delegatedBy: "claude-code:p", launchedBy: "claude-code:q" }), get)?.key).toBe(
      "claude-code:p",
    );
  });
  it("names none for a session of its own, one whose parent is not known here, or itself", () => {
    expect(parentOf(child({}), get)).toBeUndefined();
    expect(parentOf(child({ delegatedBy: "claude-code:gone" }), get)).toBeUndefined();
    // A subagent's parent is of its own harness: a Codex child's parentId names no Claude session.
    expect(parentOf(child({ parentId: "p" }), get)).toBeUndefined();
    expect(parentOf(child({ key: "claude-code:p", delegatedBy: "claude-code:p" }), get)).toBeUndefined();
  });
  it("takes an asker's say-so only on its own machine", () => {
    const on = (m: string) =>
      new Map([["claude-code:p", { key: "claude-code:p", harness: "claude-code", machine: m }]]);
    const kid = child({ delegatedBy: "claude-code:p", machine: "lab-mac" });
    expect(parentOf(kid, (k) => on("lab-mac").get(k) as SessionSummary | undefined)?.key).toBe("claude-code:p");
    expect(parentOf(kid, (k) => on("build-box").get(k) as SessionSummary | undefined)).toBeUndefined();
  });
});
