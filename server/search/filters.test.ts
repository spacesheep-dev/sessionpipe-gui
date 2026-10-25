// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service.
import { describe, expect, it } from "vitest";
import type { Labels } from "../../shared/api.js";
import { parseSearch } from "../../shared/searchQuery.js";
import { compileFilters, hasFilters, machineKey } from "./filters.js";
import type { IndexedSession } from "./types.js";

const NOW = Date.UTC(2026, 9, 25, 15, 0); // 2026-10-25 15:00 UTC = 22:00 +07
const DAY = 86_400_000;
const labels: Labels = {
  rev: 1,
  names: { blue: "Client work" },
  sessions: { "claude-code:a": "red", "codex:b": "blue" },
};

const sess = (over: Partial<IndexedSession>): IndexedSession => ({
  key: "claude-code:a",
  harness: "claude-code",
  id: "a",
  sources: ["history"],
  titleRank: 0,
  firstAt: NOW - 2 * DAY,
  lastAt: NOW - DAY,
  messages: 3,
  ...over,
});

const A = sess({ cwd: "/Users/demo/code/billing-api" });
const B = sess({
  key: "codex:b",
  harness: "codex",
  id: "b",
  sources: ["sessionpipe"],
  machine: "build-box",
  repo: "acme/Design-System",
  firstAt: NOW - 40 * DAY,
  lastAt: NOW - 35 * DAY,
});
const C = sess({
  key: "gemini-cli:c",
  harness: "gemini-cli",
  id: "c",
  machine: "Studio-Mac.local",
  sources: ["sessionpipe"],
});

const ctx = { hostname: "studio-mac", labels, now: NOW, tz: -420, available: ["sessionpipe", "history"] as const };
const pick = (q: string): string[] => {
  const f = compileFilters(parseSearch(q), { ...ctx, available: [...ctx.available] });
  return [A, B, C].filter((s) => !f.allow || f.allow(s)).map((s) => s.id);
};

describe("compileFilters", () => {
  it("has no predicate when nothing filters", () => {
    expect(compileFilters(parseSearch("webhook retry"), { ...ctx, available: ["history"] }).allow).toBeUndefined();
  });

  it("agent: exact harness (aliases resolved by the parser), several ORed", () => {
    expect(pick("agent:claude")).toEqual(["a"]);
    expect(pick("agent:codex agent:gemini")).toEqual(["b", "c"]);
    expect(pick("-agent:codex")).toEqual(["a", "c"]);
  });

  it("machine: case-insensitive, .local ignored, history ran here, `this` is this machine", () => {
    expect(pick("machine:this")).toEqual(["a", "c"]);
    expect(pick("machine:BUILD-BOX")).toEqual(["b"]);
    expect(pick("machine:studio-mac.local")).toEqual(["a", "c"]);
    expect(machineKey("Mac.lan")).toBe("mac");
  });

  it("repo: prefix of the short name, the whole name, or any folder segment", () => {
    expect(pick("repo:design")).toEqual(["b"]);
    expect(pick("repo:acme/des")).toEqual(["b"]);
    expect(pick("repo:billing")).toEqual(["a"]);
    expect(pick("repo:code")).toEqual(["a"]);
    expect(pick("repo:api")).toEqual([]);
  });

  it("label: colour or name with _ for spaces; -label inverts", () => {
    expect(pick("label:red")).toEqual(["a"]);
    expect(pick("label:client_work")).toEqual(["b"]);
    expect(pick('label:"Client work"')).toEqual(["b"]);
    expect(pick("-label:red")).toEqual(["b", "c"]);
    expect(pick("label:green")).toEqual([]);
  });

  it("since/until overlap the session's span, in the viewer's days", () => {
    expect(pick("since:7d")).toEqual(["a", "c"]);
    expect(pick("until:30d")).toEqual(["b"]);
    // b ran 40–35 days ago: a window inside it overlaps.
    expect(pick("since:38d until:36d")).toEqual(["b"]);
    expect(pick("since:today")).toEqual([]);
    expect(pick("since:yesterday")).toEqual(["a", "c"]);
  });

  it("ignores a value that does not read, and reports its key", () => {
    const f = compileFilters(parseSearch("since:someday in:everything source:mars x"), {
      ...ctx,
      available: ["history", "sessionpipe"],
    });
    expect(f.allow).toBeUndefined();
    expect(f.bad).toEqual(["since", "in", "source"]);
    expect(f.fields).toBeUndefined();
    expect(f.sources).toEqual(["history", "sessionpipe"]);
  });

  it("in: → fields; source: → indexes, never one that is closed", () => {
    expect(compileFilters(parseSearch("x in:prompt in:title"), { ...ctx, available: ["history"] }).fields).toEqual([
      "prompt",
      "title",
    ]);
    expect(compileFilters(parseSearch("x -in:tool"), { ...ctx, available: ["history"] }).fields).toEqual([
      "prompt",
      "reply",
      "title",
    ]);
    expect(
      compileFilters(parseSearch("x source:local"), { ...ctx, available: ["sessionpipe", "history"] }).sources,
    ).toEqual(["history"]);
    expect(compileFilters(parseSearch("x is:history"), { ...ctx, available: ["sessionpipe"] }).sources).toEqual([]);
    expect(
      compileFilters(parseSearch("x -source:history"), { ...ctx, available: ["sessionpipe", "history"] }).sources,
    ).toEqual(["sessionpipe"]);
  });

  it("hasFilters sees positive and negated filters", () => {
    expect(hasFilters(parseSearch("x"))).toBe(false);
    expect(hasFilters(parseSearch("x -label:red"))).toBe(true);
  });
});
