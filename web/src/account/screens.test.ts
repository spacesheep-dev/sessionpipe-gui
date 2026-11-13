// SPDX-License-Identifier: Apache-2.0
// What the account's screens say for each state, apart from their React: how a connect
// ended, how the account stands, where this phone's key stands in a row, and an ask's
// refusal. (Each state drawn, start to end, is test/e2e/account-screens.spec.ts.)
import { describe, expect, it } from "vitest";
import { NEW_WORDS as N } from "../native/accountWords";
import { accountState, approveError, endedWords, phoneLine } from "./screenWords";

const HOST = "spacesheep.dev";
const relay = (state: string) => ({ state, events: 0, cursor: 0, machines: [] }) as never;

describe("how a connect ended, in words", () => {
  it("has a title and a next step for each way, and the hub's own note where a key was made and not kept", () => {
    const note =
      "A key was made for this app on spacesheep and is not kept here. Revoke it there: Settings → API keys.";
    for (const why of ["unreachable", "wait", "busy", "denied", "expired", "unexpected"] as const) {
      const w = endedWords({ kind: "ended", why, host: HOST });
      expect(w.title, why).not.toBe("");
      expect(w.body, why).not.toBe("");
    }
    expect(endedWords({ kind: "ended", why: "declined", host: HOST, note }).body).toBe(note);
    expect(endedWords({ kind: "ended", why: "not-kept", host: HOST, note }).body).toBe(note);
    // A held approval that ran out says the note too: a key was made.
    expect(endedWords({ kind: "ended", why: "expired", host: HOST, note }).body).toBe(note);
    expect(endedWords({ kind: "ended", why: "expired", host: HOST }).body).toBe(N.expiredBody);
    // A time to try again when the hub gave one, else "in a few minutes".
    const at = Date.parse("2026-11-12T14:05:00Z");
    expect(endedWords({ kind: "ended", why: "wait", host: HOST, at }).body).toBe(
      N.waitAt(new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })),
    );
    expect(endedWords({ kind: "ended", why: "wait", host: HOST }).body).toBe(N.waitSoon);
  });
});

describe("how the account stands, as a mark and words", () => {
  it("a refused or missing key asks to be connected again; unreachable and limited wait; else it is connected", () => {
    expect(accountState({ state: "ok", relay: relay("ok") })).toEqual({ mark: "ok", words: N.stateOk, again: false });
    expect(accountState({ state: "ok", relay: relay("gap") })).toMatchObject({ mark: "ok" });
    expect(accountState({ state: "ok", relay: relay("starting") })).toMatchObject({ mark: "ok" });
    expect(accountState({ state: "ok", relay: relay("offline") })).toEqual({
      mark: "wait",
      words: N.stateOffline,
      again: false,
    });
    expect(accountState({ state: "ok", relay: relay("limited") })).toMatchObject({ mark: "wait", again: false });
    expect(accountState({ state: "unauthorized", relay: relay("ok") })).toEqual({
      mark: "warn",
      words: N.stateRevoked,
      again: true,
    });
    expect(accountState({ state: "ok", relay: relay("unauthorized") })).toMatchObject({ mark: "warn", again: true });
    expect(accountState({ state: "no_key", relay: relay("offline") })).toMatchObject({ mark: "warn", again: true });
  });
});

describe("where this phone's key stands, in a row", () => {
  const view = (phase: object) => ({ phase, machines: [], rest: null }) as never;
  it("is a mark and a few words, or nothing before the first look", () => {
    expect(phoneLine(null)).toBeNull();
    expect(phoneLine(view({ kind: "idle" }))).toEqual({ mark: "wait", words: N.approveNotYet });
    expect(phoneLine(view({ kind: "waiting", code: "71" }))).toEqual({ mark: "wait", words: N.approveWaiting });
    expect(phoneLine(view({ kind: "approved" }))).toEqual({ mark: "ok", words: N.approveCanSend });
    expect(phoneLine(view({ kind: "dropped" }))).toEqual({ mark: "warn", words: N.approveDroppedTitle });
    // Inside the hour: "from" when the time is known, "by" when it is the latest it can be.
    const until = Date.parse("2026-11-12T14:05:00Z");
    const exact = phoneLine(view({ kind: "cooling", until, exact: true }))!;
    const bound = phoneLine(view({ kind: "cooling", until, exact: false }))!;
    expect([exact.mark, bound.mark]).toEqual(["wait", "wait"]);
    expect(exact.words).toMatch(/ can send from \d/);
    expect(bound.words).toMatch(/ can send by \d/);
  });
});

describe("an ask's refusal, in words", () => {
  const now = Date.parse("2026-11-12T13:00:00Z");
  it("says when to ask again, what could not be reached, why the phone cannot, or spacesheep's own sentence", () => {
    const at = new Date(now + 900_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(approveError({ code: "too_many_asks", message: "x", retryAfterS: 900 }, now)).toEqual({
      words: N.approveTooMany(at),
      elsewhere: false,
    });
    for (const code of ["unreachable", "timeout"])
      expect(approveError({ code, message: "x" }, now)).toEqual({
        words: "spacesheep could not be reached.",
        elsewhere: false,
      });
    expect(
      approveError({ code: "unsupported", message: "Sending from this phone comes in a later version." }, now),
    ).toEqual({ words: N.approveCannot("Sending from this phone comes in a later version"), elsewhere: true });
    expect(
      approveError({ code: "signer", message: "the stored key is unreadable", upstream: "failed" }, now),
    ).toMatchObject({
      elsewhere: true,
    });
    const said = "Reaching your computers from spacesheep.dev is part of Pro and Team.";
    expect(approveError({ code: "refused", message: said, upstream: "pro_required" }, now)).toEqual({
      words: said,
      elsewhere: true,
    });
    // The same refusal from the door that says where the key stands.
    expect(approveError({ code: "talk_off", message: "Turn it on.", upstream: "talk_off" }, now)).toEqual({
      words: "Turn it on.",
      elsewhere: true,
    });
    expect(
      approveError({ code: "bad_answer", message: "spacesheep's answer can't be used by this version." }, now),
    ).toEqual({ words: "spacesheep's answer can't be used by this version.", elsewhere: false });
  });
});
