// SPDX-License-Identifier: Apache-2.0
// What the account's screens say for each state, apart from their React: how a connect
// ended, how the account stands, where this phone's key stands in a row, and an ask's
// refusal. (Each state drawn, start to end, is test/e2e/account-screens.spec.ts.)
import { describe, expect, it } from "vitest";
import type { Ended } from "../native/accountConnect";
import { clock, day, NEW_WORDS as N, thisPhone } from "../native/accountWords";
import { accountState, approveError, endedWords, phoneLine } from "./screenWords";

const HOST = "spacesheep.dev";
const relay = (state: string) => ({ state, events: 0, cursor: 0, machines: [] }) as never;

describe("how a connect ended, in words", () => {
  const note = "A key was made for this app on spacesheep and is not kept here. Revoke it there: Settings → API keys.";
  const revokeUrl = "https://spacesheep.dev/settings/api-keys";
  const ended = (why: Ended, more: object = {}) => endedWords({ kind: "ended", why, host: HOST, ...more });

  it("has a title that says what happened and one line for what to do next", () => {
    for (const why of ["unreachable", "wait", "busy", "denied", "expired", "unexpected"] as const) {
      const w = ended(why);
      expect(w.title, why).not.toBe("");
      expect(w.body, why).not.toBe("");
    }
    expect(ended("unreachable")).toEqual({ title: `Couldn't reach ${HOST}`, body: N.unreachableBody });
    expect(ended("busy")).toEqual({ title: N.busyTitle, body: N.busyBody });
    expect(ended("denied")).toEqual({ title: N.notConnected, body: N.deniedBody });
    expect(ended("expired")).toEqual({ title: N.expiredTitle, body: N.expiredBody });
    expect(ended("unexpected")).toEqual({ title: N.unexpectedTitle, body: N.unexpectedBody });
    // A time to try again when the hub gave one, else "in a few minutes".
    const at = Date.parse("2026-11-12T14:05:00Z");
    expect(ended("wait", { at }).body).toBe(N.waitAt(clock(at)));
    expect(ended("wait").body).toBe(N.waitSoon);
  });

  it("where a key was made and not kept, says to revoke it once: the button opens the page, the hub's note says where only without one", () => {
    // With the button: one short line, not the way there in words.
    expect(ended("declined", { note, revokeUrl })).toEqual({ title: N.notConnected, body: N.unusedKey });
    expect(ended("not-kept", { note, revokeUrl })).toEqual({ title: N.notKeptTitle(thisPhone()), body: N.unusedKey });
    // A held approval that ran out says it too: a key was made.
    expect(ended("expired", { note, revokeUrl })).toEqual({ title: N.expiredTitle, body: N.unusedKey });
    // Without the button (its page would be on another origin), the hub's note, which says where.
    for (const why of ["declined", "expired", "not-kept"] as const) expect(ended(why, { note }).body, why).toBe(note);
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
    const at = clock(now + 900_000);
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

describe("a time and a day inside a sentence", () => {
  const at = Date.parse("2026-11-03T17:30:00Z");
  const withLocale = (locale: string, f: () => void): void => {
    const real = Intl.DateTimeFormat;
    // The phone's own language, as `undefined` resolves to it.
    const stub = function (this: unknown, l?: string | string[], o?: Intl.DateTimeFormatOptions) {
      return new real(l ?? locale, o);
    } as unknown as typeof Intl.DateTimeFormat;
    stub.supportedLocalesOf = real.supportedLocalesOf;
    Intl.DateTimeFormat = stub;
    try {
      f();
    } finally {
      Intl.DateTimeFormat = real;
    }
  };
  it("is written in the sentence's language whatever the phone's is, with the phone's 12 or 24 hours", () => {
    const utc = (s: string) => s.replace(/\u202f/g, " ");
    for (const locale of ["ar-EG", "fa-IR", "hi-IN-u-nu-deva", "th-TH-u-ca-buddhist"])
      withLocale(locale, () => {
        // English digits and names: nothing of another script inside an English sentence.
        expect(clock(at), locale).toMatch(/^\d{1,2}:\d{2}( [AP]M)?$/);
        expect(utc(day("2026-11-03T09:00:00Z")), locale).toMatch(/^Nov \d{1,2}, 2026$/);
      });
    withLocale("en-GB", () => expect(clock(at)).toMatch(/^\d{1,2}:\d{2}$/));
    withLocale("en-US", () => expect(utc(clock(at))).toMatch(/^\d{1,2}:\d{2} [AP]M$/));
  });
});
