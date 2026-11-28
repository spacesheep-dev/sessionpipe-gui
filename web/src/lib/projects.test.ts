// SPDX-License-Identifier: Apache-2.0
// Pure project grouping (lib/projects.ts): repo / cwd / Other derivation, collision
// disambiguation, calm ordering (needs_you -> live -> finished -> newest -> alphabetical),
// rolled-up loudness across subtrees, frozen open-row stability, and latest session pick.
import "../native/test-env";
import type { SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { groupByProject, projectOf } from "./projects";
import { arrangeTree, rollUp } from "./tree";

let seq = 0;
const make = (key: string, o: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    key,
    harness: key.split(":")[0],
    id: key.split(":")[1],
    machine: "studio-mac",
    state: "idle",
    stateSince: "2026-11-24T12:00:00.000Z",
    startedAt: new Date(Date.UTC(2026, 10, 24, 12, 0, seq++)).toISOString(),
    lastAt: new Date(Date.UTC(2026, 10, 24, 12, 5, seq)).toISOString(),
    openAttentions: [],
    counts: { turns: 1 },
    ...o,
  }) as unknown as SessionSummary;

describe("projectOf", () => {
  it("normalizes HTTPS, SSH, and owner/repo git URLs with owner subtitle", () => {
    expect(projectOf({ repo: "https://github.com/acme/web.git" })).toEqual({
      key: "repo:acme/web",
      label: "web",
      subtitle: "acme",
      rawRepo: "https://github.com/acme/web.git",
    });
    expect(projectOf({ repo: "git@github.com:Acme/Web.git/" })).toEqual({
      key: "repo:acme/web",
      label: "Web",
      subtitle: "Acme",
      rawRepo: "git@github.com:Acme/Web.git/",
    });
    expect(projectOf({ repo: "solo-repo" })).toEqual({
      key: "repo:solo-repo",
      label: "solo-repo",
      rawRepo: "solo-repo",
    });
  });

  it("falls back to cwd basename with tildified parent, and Other when neither is present", () => {
    expect(projectOf({ cwd: "/Users/misha/Projects/api/" })).toEqual({
      key: "cwd:/Users/misha/Projects/api",
      label: "api",
      subtitle: "~/Projects",
      parentSeg: "Projects",
    });
    expect(projectOf({ cwd: "~/work/cli" })).toEqual({
      key: "cwd:~/work/cli",
      label: "cli",
      subtitle: "~/work",
      parentSeg: "work",
    });
    expect(projectOf({})).toEqual({ key: "other", label: "Other" });
  });
});

describe("groupByProject", () => {
  it("disambiguates colliding repo names and colliding cwd basenames", () => {
    const a = make("claude-code:a", { repo: "https://github.com/alpha/app.git" });
    const b = make("claude-code:b", { repo: "https://github.com/beta/app.git" });
    const c = make("codex:c", { cwd: "~/work/tools" });
    const d = make("codex:d", { cwd: "~/personal/tools" });
    const e = make("codex:e", { cwd: "~/unique" });
    const tree = arrangeTree({ all: [a, b, c, d, e], arrangement: { placed: {}, pinned: [] } });
    const roll = rollUp(tree.roots, { unread: () => false });
    const groups = groupByProject(tree.roots, roll);
    const byKey = new Map(groups.map((g) => [g.key, g.label]));
    expect(byKey.get("repo:alpha/app")).toBe("alpha/app");
    expect(byKey.get("repo:beta/app")).toBe("beta/app");
    expect(byKey.get("cwd:~/work/tools")).toBe("work/tools");
    expect(byKey.get("cwd:~/personal/tools")).toBe("personal/tools");
    expect(byKey.get("cwd:~/unique")).toBe("unique");
  });

  it("groups a Windows folder spelled in another case as one project, keeping POSIX case", () => {
    const a = make("codex:a", { cwd: "C:\\Users\\Me\\Proj" });
    const b = make("codex:b", { cwd: "c:\\users\\me\\proj\\" });
    const c = make("claude-code:c", { cwd: "~\\Code\\acme" });
    const d = make("claude-code:d", { cwd: "~\\code\\acme" });
    const e = make("gemini:e", { cwd: "/srv/App" });
    const f = make("gemini:f", { cwd: "/srv/app" });
    const tree = arrangeTree({ all: [a, b, c, d, e, f], arrangement: { placed: {}, pinned: [] } });
    const roll = rollUp(tree.roots, { unread: () => false });
    const groups = groupByProject(tree.roots, roll);
    const win = groups.find((g) => g.key === "cwd:c:/users/me/proj");
    const home = groups.find((g) => g.key === "cwd:~/code/acme");
    expect(win?.count).toBe(2);
    expect(home?.count).toBe(2);
    // The label keeps a session's own spelling: the first of the group's roots as given.
    const first = (keyOf: string) => tree.roots.find((n) => projectOf(n.s).key === keyOf)!;
    expect(win?.label).toBe(projectOf(first("cwd:c:/users/me/proj").s).label);
    expect(home?.label).toBe(projectOf(first("cwd:~/code/acme").s).label);
    expect(
      groups
        .filter((g) => g.key.startsWith("cwd:/srv/"))
        .map((g) => g.key)
        .sort(),
    ).toEqual(["cwd:/srv/App", "cwd:/srv/app"]);
    expect(projectOf({ cwd: "C:\\Users\\Me\\Proj" })).toEqual({
      key: "cwd:c:/users/me/proj",
      label: "Proj",
      subtitle: "C:/Users/Me",
      parentSeg: "Me",
    });
  });

  it("orders needs_you first, then live, then finished; then newest startedAt and alphabetical", () => {
    const doneOld = make("claude-code:done", {
      repo: "org/done-proj",
      state: "done",
      startedAt: "2026-11-24T10:00:00.000Z",
    });
    const liveOld = make("claude-code:live-old", {
      repo: "org/zeta",
      state: "working",
      startedAt: "2026-11-24T11:00:00.000Z",
    });
    const liveNew = make("claude-code:live-new", {
      repo: "org/alpha",
      state: "idle",
      startedAt: "2026-11-24T12:00:00.000Z",
    });
    const needs = make("claude-code:needs", {
      repo: "org/urgent",
      state: "needs_you",
      startedAt: "2026-11-24T09:00:00.000Z",
    });
    const tree = arrangeTree({
      all: [doneOld, liveOld, liveNew, needs],
      arrangement: { placed: {}, pinned: [] },
    });
    const roll = rollUp(tree.roots, { unread: () => false });
    const groups = groupByProject(tree.roots, roll);
    expect(groups.map((g) => g.label)).toEqual(["urgent", "alpha", "zeta", "done-proj"]);
    expect(groups.map((g) => g.block)).toEqual([0, 1, 1, 2]);
  });

  it("rolls up child loudness and unread state and tracks latest session for New session", () => {
    const parent = make("claude-code:p", {
      repo: "org/core",
      state: "idle",
      cwd: "~/code/core",
      startedAt: "2026-11-24T11:00:00.000Z",
      lastAt: "2026-11-24T11:10:00.000Z",
    });
    const child = make("codex:c", {
      delegatedBy: parent.key,
      state: "needs_you",
      startedAt: "2026-11-24T11:05:00.000Z",
    });
    const sibling = make("claude-code:s", {
      repo: "org/core",
      state: "done",
      cwd: "~/code/core",
      startedAt: "2026-11-24T12:00:00.000Z",
      lastAt: "2026-11-24T12:30:00.000Z",
    });
    const unreadOnly = make("claude-code:u", {
      repo: "org/docs",
      state: "done",
      startedAt: "2026-11-24T10:00:00.000Z",
    });
    const tree = arrangeTree({
      all: [parent, child, sibling, unreadOnly],
      arrangement: { placed: {}, pinned: [] },
    });
    const unread = (x: SessionSummary) => x.key === unreadOnly.key;
    const roll = rollUp(tree.roots, { unread });
    const groups = groupByProject(tree.roots, roll, { unread });
    const core = groups.find((g) => g.label === "core")!;
    const docs = groups.find((g) => g.label === "docs")!;
    expect(core.loud).toBe("needs_you");
    expect(core.count).toBe(2);
    expect(core.latest.key).toBe(sibling.key);
    expect(docs.loud).toBe("unread");
  });
});
