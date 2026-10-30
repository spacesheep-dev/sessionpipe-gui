// SPDX-License-Identifier: Apache-2.0
// The pool's words (UX-SPEC §2): names, status words from the hello, the room count, the
// swap and served-by sentences, the picker's line, and the readings of a session's events.
import type { ControlActivity, LimitsEntry, MachinePoolAccount, ProtocolEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import {
  accountSentence,
  commandNote,
  eventWindows,
  firstBack,
  leftBecause,
  loginFailure,
  loginFromDetail,
  moveIn,
  offlineNotice,
  poolAgentWords,
  pooledIds,
  pooling,
  poolPickerWords,
  poolTip,
  removeConfirm,
  roomWords,
  rowTitle,
  sentenceName,
  servedBy,
  servedWords,
  signInLead,
  statusWords,
  stillSaving,
  swaps,
  swapWords,
  switchHint,
} from "./pool";

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const MIN = 60_000;
const H = 60 * MIN;
const acc = (over: Partial<MachinePoolAccount> & { id: string }): MachinePoolAccount => ({
  enabled: true,
  status: "ready",
  current: false,
  ...over,
});
const misha = acc({ id: "a", email: "misha@example.com", label: "Misha", current: true });
const fiction = acc({ id: "b", email: "fiction@example.com", label: "Fiction" });
const sheep = acc({
  id: "c",
  email: "spacesheep@example.com",
  status: "limited",
  until: new Date(NOW + 2 * H + 10 * MIN).toISOString(),
});

describe("names", () => {
  it("titles a row by its label with the email muted, else the email, never the id", () => {
    expect(rowTitle(misha)).toEqual({ title: "Misha", muted: "misha@example.com" });
    expect(rowTitle(sheep)).toEqual({ title: "spacesheep@example.com" });
    expect(rowTitle({ label: "Old" })).toEqual({ title: "Old" });
    expect(rowTitle({})).toEqual({ title: "Claude account" });
  });
  it("names an account in a sentence by its label, else the email's local part unless shared", () => {
    expect(sentenceName(misha)).toBe("Misha");
    expect(sentenceName(sheep)).toBe("spacesheep");
    const twin = acc({ id: "d", email: "spacesheep@other.example" });
    expect(sentenceName(sheep, [misha, sheep, twin])).toBe("spacesheep@example.com");
    expect(sentenceName(acc({ id: "e" }))).toBe("Claude account");
  });
});

describe("status words", () => {
  it("come from the hello alone", () => {
    expect(statusWords(misha, true, NOW)).toEqual({ word: "In use", tone: "fg" });
    expect(statusWords(misha, false, NOW)).toEqual({ word: "Has room", tone: "fg-2" });
    expect(statusWords(fiction, true, NOW)).toEqual({ word: "Has room", tone: "fg-2" });
    expect(statusWords(sheep, true, NOW)).toEqual({ word: "Used up", tone: "needs", after: " · resets in 2 h 10 m" });
    expect(statusWords({ ...sheep, until: undefined }, true, NOW)).toEqual({ word: "Used up", tone: "needs" });
    expect(statusWords({ ...sheep, until: new Date(NOW - MIN).toISOString() }, true, NOW)).toEqual({
      word: "Used up",
      tone: "needs",
    });
    expect(statusWords(acc({ id: "x", status: "error" }), true, NOW)).toEqual({
      word: "Sign in again…",
      tone: "fg-2",
      action: "sign-in",
    });
    expect(statusWords(acc({ id: "x", status: "disabled", enabled: false }), true, NOW)).toEqual({
      word: "Off",
      tone: "fg-3",
    });
    expect(statusWords(acc({ id: "x", enabled: false, current: true }), true, NOW)).toEqual({
      word: "Off",
      tone: "fg-3",
    });
  });
});

describe("the room count", () => {
  it("counts every account, and only ready ones as room", () => {
    expect(roomWords([misha, fiction, sheep], NOW)).toBe("3 accounts, 2 with room");
    expect(roomWords([misha, acc({ id: "x", status: "error" }), sheep], NOW)).toBe("3 accounts, 1 with room");
    expect(
      roomWords([sheep, acc({ id: "x", status: "error" }), acc({ id: "y", enabled: false, status: "disabled" })], NOW),
    ).toBe("3 accounts, none with room · first back in 2 h 10 m");
    expect(roomWords([sheep, acc({ id: "x", status: "error" })], NOW, false)).toBe("2 accounts, none with room");
    expect(roomWords([acc({ id: "x", status: "limited" }), acc({ id: "y", status: "error" })], NOW)).toBe(
      "2 accounts, none with room",
    );
    expect(roomWords([misha], NOW)).toBe("1 account");
    expect(roomWords([], NOW)).toBe("No accounts");
    expect(firstBack([sheep, { until: new Date(NOW + 30 * MIN).toISOString() }, { until: "bad" }], NOW)).toBe(
      "first back in 30 m",
    );
    expect(firstBack([{ until: new Date(NOW - 1).toISOString() }], NOW)).toBeNull();
  });
  it("words the switch's hint by state", () => {
    expect(switchHint(true, "lab-mac")).toMatch(
      /^Requests go to the first account .* Claude Code on lab-mac sends through sessionpipe while this is on\.$/,
    );
    expect(switchHint(false, "lab-mac")).toMatch(/Claude Code on lab-mac uses its own login\.$/);
  });
});

describe("the swap sentence", () => {
  const entry = (windows: LimitsEntry["windows"]): Pick<LimitsEntry, "windows"> => ({ windows });
  const later = new Date(NOW + H).toISOString();
  it("says why the account was left, from the hello's word or the account's tightest window", () => {
    expect(leftBecause({ limitedBy: "seven_day" }, NOW)).toBe("week is used up");
    expect(leftBecause({ limitedBy: "five_hour" }, NOW)).toBe("5 hours are used up");
    expect(leftBecause({ limitedBy: "seven_day_fable" }, NOW)).toBe("week for Fable is used up");
    expect(leftBecause({ limitedBy: "spend_limit" }, NOW)).toBe("spend limit is reached");
    expect(leftBecause({ status: "error" }, NOW)).toBe("needs to sign in again");
    expect(leftBecause({ limitedBy: "error" }, NOW)).toBe("needs to sign in again");
    expect(leftBecause({ limitedBy: "rejected" }, NOW)).toBe("is used up");
    expect(leftBecause({ limitedBy: "mystery" }, NOW)).toBe("is used up");
    expect(
      leftBecause(
        {
          entry: entry([
            { id: "five_hour", usedPercent: 40, resetsAt: later },
            { id: "seven_day", usedPercent: 98.5, resetsAt: later },
          ]),
        },
        NOW,
      ),
    ).toBe("week is used up");
    expect(leftBecause({ entry: entry([{ id: "five_hour", usedPercent: 100, resetsAt: later }]) }, NOW)).toBe(
      "5 hours are used up",
    );
    expect(leftBecause({ entry: entry([{ id: "spend_limit", usedPercent: 112 }]) }, NOW)).toBe(
      "spend limit is reached",
    );
    expect(
      leftBecause({ status: "limited", entry: entry([{ id: "five_hour", usedPercent: 40, resetsAt: later }]) }, NOW),
    ).toBe("5 hours are used up");
    expect(leftBecause({ entry: entry([{ id: "five_hour", usedPercent: 40, resetsAt: later }]) }, NOW)).toBeNull();
    expect(leftBecause({ status: "limited" }, NOW)).toBe("is used up");
    expect(leftBecause({}, NOW)).toBeNull();
  });
  it("reads as the spec writes it", () => {
    expect(swapWords("Fiction", "Misha", "week is used up")).toBe("Switched to Fiction: Misha's week is used up");
    expect(swapWords("Fiction", undefined, "week is used up")).toBe(
      "Switched to Fiction: its own account's week is used up",
    );
    expect(swapWords("Fiction", "Misha", null)).toBe("Switched to Fiction");
    expect(swapWords("Fiction", undefined, null)).toBe("Switched to Fiction from its own account");
  });
});

describe("served by", () => {
  it("names the account and the clock time", () => {
    const d = new Date(2026, 9, 29, 14, 2, 0);
    expect(servedWords("Fiction", d.toISOString())).toBe("Served by Fiction since 14:02");
    expect(servedWords("Fiction", "bad")).toBe("Served by Fiction since ");
  });
});

describe("a session's events", () => {
  const ev = (seq: number, data: Record<string, unknown>, type = "limits.observed"): ProtocolEvent => ({
    protocol: 1,
    id: `01${String(seq).padStart(24, "0")}`,
    type,
    time: new Date(NOW + seq * MIN).toISOString(),
    tier: 1,
    harness: { name: "claude-code" },
    session: { id: "s", seq },
    privacy: { rulesets: ["secrets@1"], pii: false },
    data,
  });
  const w = [{ id: "five_hour", used_percent: 10 }];
  it("finds each switch in seq order, from the session's own account", () => {
    const events = [
      ev(5, { windows: w, account_id: "fiction" }),
      ev(1, { windows: w }),
      ev(2, { windows: w, account_id: "own" }),
      ev(3, { windows: w, account_id: "fiction" }),
      ev(4, { windows: w }, "turn.ended"),
      ev(6, { windows: w, account_id: "own" }),
      ev(7, { windows: w, account_id: 7 }),
    ];
    expect(swaps(events, { accountId: "own" })).toEqual([
      { seq: 3, at: new Date(NOW + 3 * MIN).toISOString(), from: "own", to: "fiction" },
      { seq: 6, at: new Date(NOW + 6 * MIN).toISOString(), from: "fiction", to: "own" },
    ]);
    expect(swaps(events, {})).toMatchObject([
      { seq: 2, to: "own" },
      { seq: 3, from: "own", to: "fiction" },
      { seq: 6, to: "own" },
    ]);
    expect(servedBy(events, { accountId: "own" })).toBeNull();
    expect(servedBy(events.slice(0, 4), { accountId: "own" })).toEqual({
      accountId: "fiction",
      since: new Date(NOW + 3 * MIN).toISOString(),
    });
    expect(servedBy([], { accountId: "own" })).toBeNull();
  });
});

describe("the picker and the machines", () => {
  const pool = { on: true, harness: "claude-code", accounts: [misha, fiction, sheep] };
  const entries = new Map<string, LimitsEntry>([
    [
      "a",
      {
        key: "claude-code a:a",
        harness: "claude-code",
        accountId: "a",
        machine: "lab-mac",
        machines: ["lab-mac"],
        windows: [
          {
            id: "five_hour",
            usedPercent: 38,
            windowMinutes: 300,
            resetsAt: new Date(NOW + 2 * H + 21 * MIN).toISOString(),
          },
          {
            id: "seven_day",
            usedPercent: 20,
            windowMinutes: 10_080,
            resetsAt: new Date(NOW + 3 * 24 * H).toISOString(),
          },
        ],
        observedAt: new Date(NOW).toISOString(),
      },
    ],
  ]);
  it("says the room count and the current account's tightest window", () => {
    expect(poolAgentWords(pool, (id) => entries.get(id), NOW)).toEqual({
      hint: "3 accounts, 2 with room",
      detail: "Misha, 5 hours 62% left, resets in 2 h 21 m",
    });
    expect(poolAgentWords({ ...pool, accounts: [fiction, misha] }, () => undefined, NOW)).toEqual({
      hint: "2 accounts, 2 with room",
      detail: "Misha",
    });
    expect(
      poolAgentWords({ ...pool, accounts: [sheep, acc({ id: "x", status: "error" })] }, () => undefined, NOW),
    ).toEqual({
      hint: "2 accounts, none with room · first back in 2 h 10 m",
      out: true,
    });
    expect(poolAgentWords({ ...pool, accounts: [] }, () => undefined, NOW)).toEqual({
      hint: "No accounts",
      out: false,
    });
  });
  it("knows which ids some machine pools, and which machines pool", () => {
    const lab = { name: "lab-mac", control: { machineId: "m", online: true, keys: [], queued: 0, pool } };
    const desk = {
      name: "desk-pc",
      control: { machineId: "m2", online: true, keys: [], queued: 0, pool: { ...pool, on: false, accounts: [misha] } },
    };
    const plain: { name: string; control?: undefined } = { name: "studio-mac" };
    expect(pooledIds([lab, desk, plain, lab])).toEqual(
      new Map([
        ["a", ["lab-mac", "desk-pc"]],
        ["b", ["lab-mac"]],
        ["c", ["lab-mac"]],
      ]),
    );
    expect([lab, desk, plain, undefined].map(pooling)).toEqual([true, false, false, false]);
  });
});

describe("a login.begin's detail", () => {
  it('reads the pending id and the URL out of "<id> <URL>"', () => {
    expect(loginFromDetail("login_8f3k2m https://claude.ai/oauth/authorize?code=true&state=abc")).toEqual({
      url: "https://claude.ai/oauth/authorize?code=true&state=abc",
      pendingId: "login_8f3k2m",
      text: "",
    });
    expect(loginFromDetail("lg.1:a https://claude.ai/x. then paste the code")).toEqual({
      url: "https://claude.ai/x",
      pendingId: "lg.1:a",
      text: ". then paste the code",
    });
    expect(loginFromDetail("https://claude.ai/x")).toEqual({ url: "https://claude.ai/x", pendingId: null, text: "" });
    expect(loginFromDetail("nothing here")).toEqual({ url: null, pendingId: null, text: "nothing here" });
    expect(loginFromDetail(undefined)).toEqual({ url: null, pendingId: null, text: "" });
  });
});

describe("the Agent menu's pooled line (UX-SPEC §6)", () => {
  const pool = { on: true, harness: "claude-code", accounts: [misha, fiction, sheep] };
  const fresh: LimitsEntry = {
    key: "claude-code a:a",
    harness: "claude-code",
    accountId: "a",
    machine: "lab-mac",
    machines: ["lab-mac"],
    windows: [
      {
        id: "five_hour",
        usedPercent: 38,
        windowMinutes: 300,
        resetsAt: new Date(NOW + 2 * H + 21 * MIN).toISOString(),
      },
      { id: "seven_day", usedPercent: 20, windowMinutes: 10_080, resetsAt: new Date(NOW + 3 * 24 * H).toISOString() },
    ],
    observedAt: new Date(NOW).toISOString(),
  };
  it("puts the value at the right and the count with the window under", () => {
    expect(poolPickerWords(pool, () => fresh, NOW)).toEqual({
      hint: "62% left",
      detail: "3 accounts, 2 with room · Misha, 5 hours, resets in 2 h 21 m",
      out: false,
    });
    expect(poolPickerWords(pool, () => undefined, NOW)).toEqual({ detail: "3 accounts, 2 with room · Misha" });
    expect(poolPickerWords(pool, () => ({ ...fresh, observedAt: new Date(NOW - 3 * H).toISOString() }), NOW)).toEqual({
      hint: "62% left",
      detail: "3 accounts, 2 with room · Misha, 5 hours, resets in 2 h 21 m, numbers as of 3 h ago",
      out: false,
    });
  });
  it("says None left when no account has room, and nothing when every one is off or in error", () => {
    const err = acc({ id: "x", status: "error" });
    expect(poolPickerWords({ ...pool, accounts: [sheep, err] }, () => undefined, NOW)).toEqual({
      hint: "None left",
      detail: "2 accounts, none with room · first back in 2 h 10 m",
      out: true,
    });
    expect(poolPickerWords({ ...pool, accounts: [{ ...sheep, until: undefined }, err] }, () => undefined, NOW)).toEqual(
      { hint: "None left", detail: "2 accounts, none with room", out: true },
    );
    expect(
      poolPickerWords({ ...pool, accounts: [err, acc({ id: "y", enabled: false })] }, () => undefined, NOW),
    ).toEqual({ detail: "2 accounts, none with room" });
  });
  it("words the sidebar's tooltip a sentence a line", () => {
    expect(accountSentence(fiction, pool.accounts, NOW)).toBe("Fiction has room.");
    expect(accountSentence(sheep, pool.accounts, NOW)).toBe("spacesheep is used up, resets in 2 h 10 m.");
    expect(accountSentence(acc({ id: "x", label: "Old", enabled: false }), [], NOW)).toBe("Old is off.");
    expect(accountSentence(acc({ id: "x", label: "Misha", status: "error" }), [], NOW)).toBe(
      "Misha needs to sign in again.",
    );
    expect(poolTip(pool, "lab-mac", { ...fresh, observedAt: new Date(NOW - 2 * MIN).toISOString() }, NOW)).toBe(
      [
        "Misha, Claude Code on lab-mac, in use.",
        "5 hours: 62% left, resets in 2 h 21 m.",
        "This week, all models: 80% left, resets in 3 d.",
        "Fiction has room.",
        "spacesheep is used up, resets in 2 h 10 m.",
        "As of 2 m ago.",
      ].join("\n"),
    );
    expect(poolTip({ ...pool, accounts: [sheep] }, "lab-mac", undefined, NOW)).toBe(
      "Claude Code on lab-mac: 1 account.\nspacesheep is used up, resets in 2 h 10 m.",
    );
  });
  it("reads a report's windows into the page's shape", () => {
    expect(
      eventWindows({
        data: {
          windows: [
            { id: "five_hour", used_percent: 99.2, window_minutes: 300, resets_at: "2026-10-29T14:10:00Z" },
            { id: "bad" },
            null,
          ],
        },
      }),
    ).toEqual([{ id: "five_hour", usedPercent: 99.2, windowMinutes: 300, resetsAt: "2026-10-29T14:10:00Z" }]);
    expect(eventWindows({ data: {} })).toEqual([]);
  });
});

describe("the section's words", () => {
  const refusal = (code: string | undefined) => `words for ${code}`;
  it("says where a command stands, in the page's words", () => {
    expect(commandNote({}, "lab-mac", true, refusal)).toEqual({ text: "Sending to lab-mac…", err: false });
    expect(commandNote({}, "lab-mac", false, refusal)?.text).toBe("Waiting for lab-mac to come online.");
    expect(commandNote({ outcome: "delivered" }, "lab-mac", true, refusal)).toBeNull();
    expect(commandNote({ outcome: "refused", code: "pool_off" }, "lab-mac", true, refusal)).toEqual({
      text: "lab-mac refused it: words for pool_off.",
      err: true,
    });
    expect(commandNote({ outcome: "unsupported" }, "lab-mac", true, refusal)).toEqual({
      text: "lab-mac's sessionpipe is older than account switching. Update it there.",
      err: true,
      sticky: true,
    });
    expect(commandNote({ outcome: "failed", detail: "socket closed" }, "lab-mac", true, refusal)?.text).toBe(
      "It didn't reach lab-mac: socket closed.",
    );
    expect(commandNote({ outcome: "expired" }, "lab-mac", true, refusal)?.text).toBe("lab-mac didn't take it in time.");
  });
  it("words a sign-in's failures by the §4.2 table", () => {
    const complete = (over: Partial<ControlActivity>) =>
      loginFailure({ poolAction: "login.complete", outcome: "refused", ...over }, "lab-mac", refusal)?.text;
    expect(complete({ code: "expired" })).toBe("The sign-in took too long. Start over to get a new link.");
    expect(complete({ code: "pool_account", detail: "the login expired" })).toBe(
      "The sign-in took too long. Start over to get a new link.",
    );
    expect(complete({ code: "pool_account", detail: "fiction@example.com is already in the pool" })).toBe(
      "fiction@example.com is already on lab-mac.",
    );
    expect(complete({ code: "login", detail: "bad code" })).toBe(
      "lab-mac couldn't finish the sign-in: bad code. Check the code and try again.",
    );
    expect(loginFailure({ poolAction: "login.begin", outcome: "unsupported" }, "lab-mac", refusal)).toEqual({
      text: "lab-mac's sessionpipe can't sign in from here. Use the command below.",
      err: true,
      sticky: true,
    });
    expect(loginFailure({ poolAction: "login.begin" }, "lab-mac", refusal)?.text).toBe("Sending to lab-mac…");
    expect(loginFailure({ poolAction: "login.begin", outcome: "delivered" }, "lab-mac", refusal)).toBeNull();
  });
  it("asks before a remove, and says what one account left leaves", () => {
    expect(removeConfirm("Fiction", "lab-mac", false)).toEqual({
      title: "Remove Fiction from lab-mac?",
      body: "sessionpipe forgets its sign-in on lab-mac. Sessions on it move to the next account with room. Claude Code's own login is not touched.",
    });
    expect(removeConfirm("Fiction", "lab-mac", true).body).toContain(
      "lab-mac will have no accounts to switch between.",
    );
  });
  it("moves one item and leaves the rest in order", () => {
    expect(moveIn(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveIn(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveIn(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveIn(["a", "b", "c"], 1, 7)).toEqual(["a", "b", "c"]);
  });
  it("says the rest once each", () => {
    expect(offlineNotice("lab-mac", true)).toMatch(/can't reach Claude while switching is on\.$/);
    expect(offlineNotice("lab-mac", false)).toBe("lab-mac's sessionpipe is offline.");
    expect(signInLead("lab-mac", "fiction@example.com")).toMatch(
      /^Sign in again as fiction@example\.com\. lab-mac opens/,
    );
    expect(stillSaving("lab-mac")).toBe("lab-mac is still saving the last change");
  });
});
