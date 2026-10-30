// SPDX-License-Identifier: Apache-2.0
// The usage limits' words: labels, what is left, resets, staleness, names, New session's pick.
import type { LimitsEntry, LimitWindow } from "@shared/api";
import { describe, expect, it } from "vitest";
import {
  accountFor,
  accountNames,
  agentWords,
  byPlace,
  entrySubtitle,
  entryTitle,
  footnote,
  planWords,
  quietAccounts,
  readWindow,
  resetClock,
  shortNames,
  staleWords,
  tightest,
  untilWords,
  usageText,
  usageTip,
  windowLabel,
  windowShort,
} from "./limits";

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const at = (ms: number) => new Date(NOW + ms).toISOString();

const win = (id: string, usedPercent: number, o: Partial<LimitWindow> = {}): LimitWindow => ({
  id,
  usedPercent,
  ...o,
});
const entry = (o: Partial<LimitsEntry> = {}): LimitsEntry => ({
  key: "claude-code a:acc1",
  harness: "claude-code",
  accountId: "acc1",
  machine: "lab-mac",
  machines: ["lab-mac"],
  windows: [win("five_hour", 38, { windowMinutes: 300, resetsAt: at(2 * H + 21 * MIN) })],
  observedAt: at(-2 * MIN),
  ...o,
});

describe("windowLabel / windowShort", () => {
  it("names Claude's windows honestly, the week across all models", () => {
    expect(windowLabel({ id: "five_hour" })).toBe("5 hours");
    expect(windowLabel({ id: "seven_day", windowMinutes: 10_080 })).toBe("This week, all models");
    expect(windowLabel({ id: "spend_limit" })).toBe("Spend limit");
    expect(windowShort({ id: "five_hour" })).toBe("5h");
    expect(windowShort({ id: "seven_day" })).toBe("week");
    expect(windowShort({ id: "spend_limit" })).toBe("spend");
  });
  it("labels a per-model week from its id, with no change here", () => {
    expect(windowLabel({ id: "seven_day_fable" })).toBe("This week, Fable only");
    expect(windowLabel({ id: "seven_day_sonnet_4" })).toBe("This week, Sonnet 4 only");
    expect(windowShort({ id: "seven_day_fable" })).toBe("week Fable");
  });
  it("reads Codex's windows by their length", () => {
    expect(windowLabel({ id: "primary", windowMinutes: 300 })).toBe("5 hours");
    expect(windowLabel({ id: "secondary", windowMinutes: 10_080 })).toBe("This week");
    expect(windowShort({ id: "secondary", windowMinutes: 10_080 })).toBe("week");
  });
  it("words an unknown id by its length, else by the id itself", () => {
    expect(windowLabel({ id: "burst", windowMinutes: 45 })).toBe("45 minutes");
    expect(windowLabel({ id: "burst", windowMinutes: 120 })).toBe("2 hours");
    expect(windowLabel({ id: "burst", windowMinutes: 4320 })).toBe("3 days");
    expect(windowLabel({ id: "burst", windowMinutes: 90 })).toBe("1.5 hours");
    expect(windowLabel({ id: "burst", windowMinutes: 60 })).toBe("1 hour");
    expect(windowShort({ id: "burst", windowMinutes: 4320 })).toBe("3d");
    expect(windowLabel({ id: "primary" })).toBe("Primary");
    expect(windowLabel({ id: "daily_tokens" })).toBe("Daily tokens");
  });
});

describe("readWindow", () => {
  it("says what is left, rounded down", () => {
    const r = readWindow(win("five_hour", 38.4, { resetsAt: at(2 * H + 21 * MIN) }), NOW);
    expect(r).toMatchObject({ kind: "left", value: "61% left", when: "resets in 2 h 21 m" });
    expect(r.fill).toBeCloseTo(0.616);
    expect(readWindow(win("x", 0), NOW).value).toBe("100% left");
  });
  it("never rounds a sliver to 0% or a full window to 'left'", () => {
    expect(readWindow(win("x", 99.4), NOW)).toMatchObject({ kind: "left", value: "<1% left", fill: 0.01 });
    expect(readWindow(win("x", 100), NOW)).toMatchObject({ kind: "none", value: "None left", fill: 0 });
  });
  it("says how far over a spend limit is, rounded up", () => {
    expect(readWindow(win("spend_limit", 112), NOW)).toMatchObject({ kind: "over", value: "12% over", fill: 0 });
    expect(readWindow(win("spend_limit", 100.2), NOW).value).toBe("1% over");
  });
  it("treats a passed reset as reset, not as its last value, with no bar", () => {
    const r = readWindow(win("five_hour", 64, { resetsAt: at(-40 * MIN) }), NOW);
    expect(r).toMatchObject({ kind: "reset", value: "Reset", fill: null, when: "Reset 40 m ago" });
  });
  it("invents no reset time", () => {
    expect(readWindow(win("x", 10), NOW).when).toBe("");
  });
});

describe("untilWords", () => {
  it("counts down in the app's duration grammar", () => {
    expect(untilWords(30_000)).toBe("resets in under a minute");
    expect(untilWords(42 * MIN)).toBe("resets in 42 m");
    expect(untilWords(2 * H + 21 * MIN + 30_000)).toBe("resets in 2 h 21 m");
    expect(untilWords(2 * H + 5 * MIN)).toBe("resets in 2 h 05 m");
    expect(untilWords(3 * H)).toBe("resets in 3 h");
    expect(untilWords(2 * D + 18 * H)).toBe("resets in 2 d 18 h");
    expect(untilWords(12 * D)).toBe("resets in 12 d");
  });
  it("keeps the clock for the tooltip", () => {
    const at = new Date(2026, 9, 31, 14, 0);
    // The person's own clock, as the rest of the app shows times: no fixed 24-hour English.
    const hm = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(resetClock(at.toISOString())).toBe(
      `${at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${hm}`,
    );
    expect(resetClock(undefined)).toBe("");
  });
});

describe("tightest", () => {
  it("is the window with least left, skipping reset ones", () => {
    const e = entry({
      windows: [
        win("primary", 64, { windowMinutes: 300, resetsAt: at(-40 * MIN) }),
        win("secondary", 91, { windowMinutes: 10_080, resetsAt: at(D) }),
      ],
    });
    expect(tightest(e, NOW)?.id).toBe("secondary");
  });
  it("counts the spend limit, and the first listed wins a tie", () => {
    expect(tightest(entry({ windows: [win("spend_limit", 112), win("five_hour", 50)] }), NOW)?.id).toBe("spend_limit");
    expect(tightest(entry({ windows: [win("five_hour", 50), win("seven_day", 50)] }), NOW)?.id).toBe("five_hour");
  });
  it("is null once every window has reset", () => {
    expect(tightest(entry({ windows: [win("five_hour", 90, { resetsAt: at(-MIN) })] }), NOW)).toBeNull();
  });
});

describe("staleWords and planWords", () => {
  it("says how old a report is past 15 minutes, and nothing before", () => {
    expect(staleWords({ observedAt: at(-14 * MIN) }, NOW)).toBe("");
    expect(staleWords({ observedAt: at(-16 * MIN) }, NOW)).toBe("as of 16 m ago");
    expect(staleWords({ observedAt: at(-3 * H) }, NOW)).toBe("as of 3 h ago");
  });
  it("humanises a plan lightly", () => {
    expect(planWords("plus")).toBe("Plus");
    expect(planWords("max_20x")).toBe("Max 20x");
    expect(planWords(undefined)).toBe("");
  });
});

describe("names", () => {
  const names = accountNames([
    { harness: "claude-code", id: "acc1", email: "dev@example.com" },
    { harness: "claude-code", id: "api-1", name: "api.z.ai" },
    { harness: "claude-code", id: "acc3", email: "dev@acme.dev" },
  ]);
  it("titles an account by its hello, else by the harness, and a machine's numbers by the machine", () => {
    expect(entryTitle(entry(), names)).toBe("dev@example.com");
    expect(entryTitle(entry({ accountId: "api-1" }), names)).toBe("api.z.ai");
    expect(entryTitle(entry({ accountId: "zzz" }), names)).toBe("Claude Code account");
    expect(entryTitle(entry({ harness: "codex", accountId: undefined }), names)).toBe("Codex on lab-mac");
  });
  it("says where an account reported, and the plan", () => {
    expect(entrySubtitle(entry({ machines: ["lab-mac", "build-box"] }))).toBe("Claude Code on lab-mac and build-box");
    expect(entrySubtitle(entry({ harness: "codex", accountId: undefined, plan: "plus" }))).toBe("Plus plan");
    expect(entrySubtitle(entry({ harness: "codex", accountId: undefined }))).toBe("");
    expect(entrySubtitle(entry({ harness: "codex", plan: "pro" }))).toBe("Codex on lab-mac, Pro plan");
  });
  it("shortens names for the sidebar, the whole email when two share a local part", () => {
    const e = (key: string, o: Partial<LimitsEntry>) => entry({ key, ...o });
    const short = shortNames(
      [
        e("a", { accountId: "acc1" }),
        e("b", { accountId: "api-1" }),
        e("c", { accountId: "unknown", machine: "studio-mac" }),
        e("d", { harness: "codex", accountId: undefined, machine: "lab-mac" }),
        e("f", { harness: "codex", accountId: undefined, machine: "build-box" }),
      ],
      names,
    );
    // The glyph says the harness: an account no hello names, and a machine's numbers, take the machine.
    expect([...short.values()]).toEqual(["dev", "api.z.ai", "studio-mac", "lab-mac", "build-box"]);
    const both = shortNames([e("a", { accountId: "acc1" }), e("b", { accountId: "acc3" })], names);
    expect([...both.values()]).toEqual(["dev@example.com", "dev@acme.dev"]);
    const twoUnknown = shortNames(
      [e("a", { accountId: "u1", machine: "a-mac" }), e("b", { accountId: "u2", machine: "b-mac" })],
      names,
    );
    expect([...twoUnknown.values()]).toEqual(["a-mac", "b-mac"]);
    expect([...shortNames([e("a", { accountId: "u1", machine: "" })], names).values()]).toEqual(["Claude Code"]);
  });
  it("orders Claude Code, then Codex, then the rest, each by title, never by numbers", () => {
    const rows = [
      { harness: "goose", title: "goose on x", machine: "x" },
      { harness: "codex", title: "Codex on lab-mac", machine: "lab-mac" },
      { harness: "claude-code", title: "dev@example.com", machine: "lab-mac" },
      { harness: "codex", title: "Codex on build-box", machine: "build-box" },
      { harness: "claude-code", title: "api.z.ai", machine: "lab-mac" },
    ];
    expect([...rows].sort(byPlace).map((r) => r.title)).toEqual([
      "api.z.ai",
      "dev@example.com",
      "Codex on build-box",
      "Codex on lab-mac",
      "goose on x",
    ]);
  });
  it("puts the accounts with numbers first, and among them the ones a hello names", () => {
    const rows = [
      { harness: "claude-code", title: "Claude Code account", machine: "build-box", named: false, quiet: {} },
      { harness: "claude-code", title: "Claude Code account", machine: "studio-mac", named: false },
      { harness: "claude-code", title: "work@acme.dev", machine: "lab-mac", named: true, quiet: {} },
      { harness: "claude-code", title: "dev@example.com", machine: "lab-mac", named: true },
      { harness: "codex", title: "Codex on lab-mac", machine: "lab-mac", named: false },
      { harness: "claude-code", title: "api.z.ai", machine: "lab-mac", named: true },
    ];
    expect([...rows].sort(byPlace).map((r) => `${r.title} ${r.machine}`)).toEqual([
      "api.z.ai lab-mac",
      "dev@example.com lab-mac",
      "Claude Code account studio-mac",
      "work@acme.dev lab-mac",
      "Claude Code account build-box",
      "Codex on lab-mac lab-mac",
    ]);
  });
});

describe("sentences", () => {
  const e = entry({
    windows: [
      win("five_hour", 38, { resetsAt: at(2 * H + 21 * MIN) }),
      win("seven_day", 20, { resetsAt: at(2 * D + 18 * H) }),
    ],
  });
  it("copies usage as one line", () => {
    expect(usageText(e, "dev@example.com", NOW)).toBe(
      "dev@example.com, Claude Code: 5 hours 62% left, resets in 2 h 21 m; This week, all models 80% left, resets in 2 d 18 h",
    );
    expect(usageText({ ...e, observedAt: at(-3 * H) }, "Claude Code account", NOW)).toBe(
      "Claude Code account: 5 hours 62% left, resets in 2 h 21 m; This week, all models 80% left, resets in 2 d 18 h; as of 3 h ago",
    );
  });
  it("tips a sentence a line, with the age", () => {
    expect(usageTip(e, "dev@example.com", NOW).split("\n")).toEqual([
      "dev@example.com, Claude Code.",
      "5 hours: 62% left, resets in 2 h 21 m.",
      "This week, all models: 80% left, resets in 2 d 18 h.",
      "As of 2 m ago.",
    ]);
  });
});

describe("accountFor / agentWords", () => {
  const dev = entry();
  const codex = entry({
    key: "codex m:lab-mac",
    harness: "codex",
    accountId: undefined,
    plan: "plus",
    windows: [
      win("primary", 8, { windowMinutes: 300, resetsAt: at(3 * H + 43 * MIN) }),
      win("secondary", 26, { windowMinutes: 10_080, resetsAt: at(4 * D + 2 * H) }),
    ],
  });
  const all = [dev, codex];
  it("takes the one account a hello names", () => {
    const pick = accountFor("claude-code", "lab-mac", [{ harness: "claude-code", id: "acc1" }], all);
    expect(pick).toEqual({ kind: "entry", entry: dev });
  });
  it("has no one number when the hello names two: a start cannot choose, so each says its own", () => {
    const two = [
      { harness: "claude-code", id: "acc1", email: "dev@example.com" },
      { harness: "claude-code", id: "acc2", email: "work@acme.dev" },
    ];
    const work = entry({
      key: "claude-code a:acc2",
      accountId: "acc2",
      windows: [win("five_hour", 40, { resetsAt: at(H) }), win("seven_day", 88, { resetsAt: at(2 * D) })],
    });
    const pick = accountFor("claude-code", "lab-mac", two, [...all, work]);
    expect(pick).toEqual({
      kind: "ambiguous",
      count: 2,
      each: [
        { name: "dev", entry: dev },
        { name: "work", entry: work },
      ],
    });
    // No hint, so no number is guessed; the detail has each one's tightest window.
    expect(agentWords(pick, NOW)).toEqual({ detail: "dev 62% left, work 12% left" });
    const out = { ...work, windows: [win("five_hour", 100, { resetsAt: at(H) })], observedAt: at(-3 * H) };
    expect(agentWords({ kind: "ambiguous", count: 2, each: [{ name: "work", entry: out }] }, NOW)).toEqual({
      detail: "work none left as of 3 h ago",
    });
    // Neither has sent numbers.
    expect(accountFor("claude-code", "lab-mac", two, [codex])).toEqual({ kind: "ambiguous", count: 2, each: [] });
    expect(agentWords({ kind: "ambiguous", count: 2, each: [] }, NOW)).toEqual({ detail: "2 accounts here" });
  });
  it("with none named, takes the machine's own numbers, else the one account seen there", () => {
    expect(accountFor("codex", "lab-mac", [], all)).toEqual({ kind: "entry", entry: codex });
    expect(accountFor("claude-code", "lab-mac", undefined, all)).toEqual({ kind: "entry", entry: dev });
    expect(accountFor("claude-code", "build-box", undefined, all)).toBeNull();
    expect(accountFor("gemini-cli", "lab-mac", undefined, all)).toBeNull();
    expect(agentWords(null, NOW)).toEqual({});
  });
  it("words the pick by its tightest window", () => {
    expect(agentWords({ kind: "entry", entry: codex }, NOW)).toEqual({
      hint: "74% left",
      detail: "This week, resets in 4 d 2 h",
      out: false,
    });
    const stale = { ...dev, observedAt: at(-3 * H) };
    expect(agentWords({ kind: "entry", entry: stale }, NOW).detail).toBe("5 hours, resets in 2 h 21 m, as of 3 h ago");
    const out = { ...dev, windows: [win("five_hour", 100, { resetsAt: at(H + 10 * MIN) })] };
    expect(agentWords({ kind: "entry", entry: out }, NOW)).toEqual({
      hint: "None left",
      detail: "5 hours, resets in 1 h 10 m",
      out: true,
    });
    const reset = { ...dev, windows: [win("five_hour", 90, { resetsAt: at(-40 * MIN) })] };
    expect(agentWords({ kind: "entry", entry: reset }, NOW)).toEqual({
      hint: "Reset",
      detail: "5 hours reset 40 m ago",
    });
  });
});

describe("footnote and quiet accounts", () => {
  it("names the harnesses with no source, once", () => {
    expect(footnote(["claude-code", "codex", "gemini-cli"], [])).toBe("Gemini CLI doesn't report its limits.");
    expect(footnote(["gemini-cli", "cursor", "goose", "gemini-cli", "codex"], [])).toBe(
      "Cursor, Gemini CLI and goose don't report their limits.",
    );
    expect(footnote(["claude-code", "codex"], [])).toBe("");
  });
  it("drops a harness once it sends numbers", () => {
    expect(footnote(["gemini-cli"], [{ harness: "gemini-cli" }])).toBe("");
  });
  it("lists Claude Code accounts with no numbers, never an API home", () => {
    const q = quietAccounts(
      [
        { harness: "claude-code", accountId: "acc1", machine: "lab-mac" },
        { harness: "claude-code", accountId: "quiet", machine: "build-box" },
        { harness: "claude-code", accountId: "quiet", machine: "lab-mac" },
        { harness: "claude-code", accountId: "api-9", machine: "lab-mac" },
        { harness: "codex", accountId: "c1", machine: "lab-mac" },
      ],
      [{ harness: "claude-code", accountId: "acc1" }],
    );
    expect(q).toEqual([
      { key: "claude-code a:quiet", harness: "claude-code", accountId: "quiet", machines: ["build-box", "lab-mac"] },
    ]);
  });
});
