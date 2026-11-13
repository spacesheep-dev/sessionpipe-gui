// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ConnectView } from "../account/shell";
import { alreadyHere, type ConnectStep, connectStep, refusedWhy, spaced } from "./accountConnect";

const HOST = "spacesheep.dev";
const connect = (state: ConnectView["state"], more: Partial<ConnectView> = {}): ConnectView => ({
  origin: "https://spacesheep.dev",
  digits: "4821",
  expiresAt: "2026-11-12T10:10:00.000Z",
  state,
  ...more,
});
const walk = (from: ConnectStep, ...events: Parameters<typeof connectStep>[1][]): ConnectStep =>
  events.reduce((s, e) => connectStep(s, e, HOST), from);

describe("connecting an account: the steps", () => {
  it("goes from the intro to the number, the browser, the question here, and the account", () => {
    let s = walk({ kind: "intro" }, { type: "go" });
    expect(s).toEqual({ kind: "starting" });
    s = walk(s, { type: "connect", connect: connect("pending") });
    expect(s).toEqual({ kind: "number", host: HOST, digits: "4821", opened: false });
    s = walk(s, { type: "opened" });
    expect(s).toMatchObject({ kind: "number", opened: true });
    // The hub says the same pending connect again (a poll, the app back in front): still opened.
    s = walk(s, { type: "connect", connect: connect("pending") });
    expect(s).toMatchObject({ kind: "number", opened: true });
    s = walk(s, { type: "connect", connect: connect("asking") });
    expect(s).toEqual({ kind: "asking", host: HOST });
    s = walk(s, { type: "connect", connect: connect("approved", { receiver: "acct1", email: "me@example.com" }) });
    expect(s).toEqual({ kind: "opening", host: HOST, receiver: "acct1" });
    // Nothing moves it once the shell is asked to show the account.
    expect(walk(s, { type: "connect", connect: null }, { type: "reset" }, { type: "go" })).toBe(s);
  });

  it("names the host the hub connects to, when it is another", () => {
    const s = walk(
      { kind: "starting" },
      {
        type: "connect",
        connect: connect("pending", { origin: "https://sheep.example:8443" }),
      },
    );
    expect(s).toMatchObject({ kind: "number", host: "sheep.example:8443" });
  });

  it("a new number is not yet opened", () => {
    const s = walk(
      { kind: "number", host: HOST, digits: "4821", opened: true },
      { type: "connect", connect: connect("pending", { digits: "9000" }) },
    );
    expect(s).toMatchObject({ digits: "9000", opened: false });
  });

  it("picks up a connect that was under way when the app opened", () => {
    expect(walk({ kind: "intro" }, { type: "connect", connect: connect("pending") })).toMatchObject({
      kind: "number",
      opened: false,
    });
    expect(walk({ kind: "intro" }, { type: "connect", connect: connect("asking") })).toMatchObject({ kind: "asking" });
    expect(walk({ kind: "intro" }, { type: "connect", connect: null })).toEqual({ kind: "intro" });
  });

  it("an approval whose account is gone is old news", () => {
    const approved = connect("approved", { receiver: "acct1" });
    expect(walk({ kind: "intro" }, { type: "connect", connect: approved, accounts: [] })).toEqual({ kind: "intro" });
    expect(walk({ kind: "intro" }, { type: "connect", connect: approved, accounts: ["acct1"] })).toMatchObject({
      kind: "opening",
    });
    expect(walk({ kind: "intro" }, { type: "connect", connect: connect("approved") })).toEqual({ kind: "intro" });
  });

  it("says why a connect ended, with the hub's note where a key was made and not kept", () => {
    const note = "A key was made for this app on spacesheep and is not kept here.";
    const revokeUrl = "https://spacesheep.dev/settings/api-keys";
    const from: ConnectStep = { kind: "number", host: HOST, digits: "4821", opened: true };
    expect(walk(from, { type: "connect", connect: connect("denied") })).toEqual({
      kind: "ended",
      why: "denied",
      host: HOST,
    });
    expect(walk(from, { type: "connect", connect: connect("expired") })).toMatchObject({ why: "expired" });
    expect(walk(from, { type: "connect", connect: connect("declined", { note, revokeUrl }) })).toEqual({
      kind: "ended",
      why: "declined",
      host: HOST,
      note,
      revokeUrl,
    });
    for (const error of ["keystore", "io", "conflict"])
      expect(walk(from, { type: "connect", connect: connect("failed", { error, note, revokeUrl }) })).toMatchObject({
        why: "not-kept",
        note,
      });
    expect(walk(from, { type: "connect", connect: connect("failed", { error: "bad_answer" }) })).toMatchObject({
      why: "unexpected",
    });
    // The last try's outcome does not end the next start.
    expect(walk({ kind: "starting" }, { type: "connect", connect: connect("denied") })).toEqual({ kind: "starting" });
    // Try again from there.
    expect(walk({ kind: "ended", why: "denied", host: HOST }, { type: "go" })).toEqual({ kind: "starting" });
  });

  it("a connect that went away while waited for goes back to the start", () => {
    expect(
      walk({ kind: "number", host: HOST, digits: "4821", opened: true }, { type: "connect", connect: null }),
    ).toEqual({ kind: "intro" });
    expect(walk({ kind: "asking", host: HOST }, { type: "connect", connect: null })).toEqual({ kind: "intro" });
    expect(walk({ kind: "starting" }, { type: "connect", connect: null })).toEqual({ kind: "starting" });
  });

  it("a refused start says why, and when to try again where the hub says", () => {
    const now = 1_000_000;
    const refused = (error: unknown) => walk({ kind: "starting" }, { type: "refused", error, now });
    expect(refused({ code: "unreachable", message: "x" })).toEqual({ kind: "ended", why: "unreachable", host: HOST });
    expect(refused({ code: "too_many_starts", message: "x", retryAfterS: 1200 })).toEqual({
      kind: "ended",
      why: "wait",
      host: HOST,
      at: now + 1_200_000,
    });
    expect(refused({ code: "rate_limited", message: "x" })).toEqual({ kind: "ended", why: "wait", host: HOST });
    expect(refused({ code: "busy", message: "x" })).toMatchObject({ why: "busy" });
    expect(refused({ code: "not_asked", message: "x" })).toMatchObject({ why: "busy" });
    for (const code of ["refused", "bad_answer", "unsupported", "bad_origin", "forbidden"])
      expect(refused({ code, message: "x" })).toMatchObject({ why: "unexpected" });
    expect(refused("something else")).toMatchObject({ why: "unexpected" });
    // The person's own no is not a failure.
    expect(refused({ code: "cancelled", message: "Cancelled." })).toEqual({ kind: "intro" });
    expect(refusedWhy({ code: "cancelled" })).toBeNull();
    // A refusal that arrives late changes nothing.
    const number: ConnectStep = { kind: "number", host: HOST, digits: "4821", opened: false };
    expect(walk(number, { type: "refused", error: { code: "unreachable" }, now })).toBe(number);
  });

  it("an account that would not show is said, not waited on", () => {
    expect(
      walk({ kind: "opening", host: HOST, receiver: "acct1" }, { type: "refused", error: "unknown receiver", now: 0 }),
    ).toEqual({ kind: "ended", why: "unexpected", host: HOST });
  });
});

describe("connecting an account: the small things", () => {
  it("reads four digits in two pairs", () => {
    expect(spaced("4821")).toBe("48 21");
    expect(spaced("123")).toBe("123");
  });

  it("finds the account a refused start says is already here", () => {
    const a = (id: string, origin: string, state = "ok") => ({ id, origin, state });
    expect(alreadyHere([a("one", "https://spacesheep.dev")], undefined)).toBe("one");
    expect(alreadyHere([a("one", "https://a.example"), a("two", "https://b.example")], "https://b.example")).toBe(
      "two",
    );
    expect(alreadyHere([a("one", "https://a.example"), a("two", "https://b.example")], undefined)).toBeNull();
    expect(alreadyHere([a("one", "https://spacesheep.dev", "unauthorized")], undefined)).toBeNull();
    expect(alreadyHere([], undefined)).toBeNull();
  });
});
