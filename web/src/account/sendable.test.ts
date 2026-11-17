// SPDX-License-Identifier: Apache-2.0
// Whether this device can send to one computer, the one state every screen reads: the device
// door's word on an account, the key list off one; and each state in its words.
import "../native/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { clock } from "../native/accountWords";
import type { ApprovePhase, ApproveView, MachineState } from "./approve";
import { approvalOf, type SendState, sendState, sendWords } from "./sendable";

const T = Date.parse("2026-11-12T13:05:00Z");
const ID = "m_laptop";
const MINE = { id: "key-phone" };
/** The computer's control status: its id, and the keys it lists. */
const control = (listed: boolean) => ({
  machineId: ID,
  keys: [{ id: "key-mac", alg: -7, addedAt: "" }, ...(listed ? [{ id: MINE.id, alg: -7, addedAt: "" }] : [])],
});
const view = (phase: ApprovePhase, state?: MachineState): ApproveView => ({
  phase,
  machines: state ? [{ id: ID, name: "Misha-Petrov-laptop", state }] : [],
  rest: null,
});
const ON = { keyKnown: true, secure: true, account: true };
const OFF = { keyKnown: true, secure: true, account: false };

const PHASES: Record<string, ApprovePhase> = {
  idle: { kind: "idle" },
  dropped: { kind: "dropped" },
  waiting: { kind: "waiting", code: "71" },
  cooling: { kind: "cooling", until: T + 600_000, exact: true },
  approved: { kind: "approved" },
};

describe("on an account: the device door decides", () => {
  // Every phase against every way the door can name this computer (or not name it), with
  // the computer's own key list both ways: once approved, the list saying yes wins over the
  // door's "not yet" (the newer reading of the same list), and decides where the door is silent.
  const table: [phase: string, entry: MachineState | null, listed: boolean, state: SendState][] = [];
  for (const listed of [true, false])
    for (const entry of ["can", "not-yet", "old", null] as const) {
      table.push(["idle", entry, listed, { kind: "unapproved", dropped: false }]);
      table.push(["dropped", entry, listed, { kind: "unapproved", dropped: true }]);
      table.push(["waiting", entry, listed, { kind: "waiting", code: "71" }]);
      const there: SendState | null =
        entry === "old"
          ? { kind: "old" }
          : !listed && (entry === "not-yet" || entry === null)
            ? { kind: "catching-up", account: true }
            : null;
      table.push(["cooling", entry, listed, there ?? { kind: "cooling", until: T + 600_000, exact: true }]);
      table.push(["approved", entry, listed, there ?? { kind: "can" }]);
    }
  it.each(table)("%s, the door says %s, listed %s", (phase, entry, listed, want) => {
    expect(sendState(view(PHASES[phase]!, entry ?? undefined), control(listed), [MINE], ON)).toEqual(want);
  });

  it("the door wins over the key list: approved there is approved here, listed or not", () => {
    // The phone's key is missing from what this page knows of the computer's list (or the
    // page has not read the phone's own key): spacesheep still says it trusts it.
    expect(sendState(view(PHASES.approved!, "can"), control(false), [], ON)).toEqual({ kind: "can" });
    expect(sendState(view(PHASES.cooling!, "can"), control(false), [], { ...ON, keyKnown: false })).toMatchObject({
      kind: "cooling",
    });
    // Listed, but not approved on spacesheep: not approved.
    expect(sendState(view(PHASES.idle!), control(true), [MINE], ON)).toEqual({ kind: "unapproved", dropped: false });
  });

  it("approved: the computer's list saying yes wins over a door entry read before it added the key", () => {
    expect(sendState(view(PHASES.approved!, "not-yet"), control(true), [MINE], ON)).toEqual({ kind: "can" });
    // In the hour it still waits for the hour.
    expect(sendState(view(PHASES.cooling!, "not-yet"), control(true), [MINE], ON)).toEqual({
      kind: "cooling",
      until: T + 600_000,
      exact: true,
    });
    // Not listed: the door's "not yet" stands.
    expect(sendState(view(PHASES.approved!, "not-yet"), control(false), [MINE], ON)).toEqual({
      kind: "catching-up",
      account: true,
    });
  });

  it("nothing is said before it is known: no machine, the door's first word, or the key while the door is silent", () => {
    expect(sendState(view(PHASES.approved!, "can"), undefined, [MINE], ON)).toEqual({ kind: "unknown" });
    // Before the first look the list may say yes, never no.
    expect(sendState(null, control(true), [MINE], ON)).toEqual({ kind: "can" });
    expect(sendState(null, control(false), [MINE], ON)).toEqual({ kind: "unknown" });
    expect(sendState(null, control(false), [], { ...ON, keyKnown: false })).toEqual({ kind: "unknown" });
    // Approved, the door has no entry for this computer, and the key is not read yet.
    expect(sendState(view(PHASES.approved!), control(false), [], { ...ON, keyKnown: false })).toEqual({
      kind: "unknown",
    });
    // "Not approved" read off the lists against a key not read yet (the app at launch, where
    // the hub has no word of the key): nothing, not "can't send yet".
    for (const phase of [PHASES.idle!, PHASES.dropped!])
      expect(sendState(view(phase), control(false), [], { ...ON, keyKnown: false })).toEqual({ kind: "unknown" });
  });

  it("a page that cannot sign says that first, before any approval", () => {
    for (const phase of Object.values(PHASES))
      expect(sendState(view(phase, "can"), control(true), [MINE], { ...ON, secure: false })).toEqual({
        kind: "cannot-sign",
      });
  });
});

describe("off an account: the key list decides, as it always has", () => {
  it("a key this device holds among the machine's: it can send; none: not approved on it", () => {
    expect(sendState(null, control(true), [MINE], OFF)).toEqual({ kind: "can" });
    expect(sendState(null, control(false), [MINE], OFF)).toEqual({ kind: "catching-up", account: false });
    // The device's own keys not read yet (the app at launch): nothing flashes.
    expect(sendState(null, control(false), [], { ...OFF, keyKnown: false })).toEqual({ kind: "unknown" });
    expect(sendState(null, control(true), [MINE], { ...OFF, secure: false })).toEqual({ kind: "cannot-sign" });
    expect(sendState(null, undefined, [MINE], OFF)).toEqual({ kind: "unknown" });
  });
});

describe("what turns sending off before anything is signed", () => {
  const DEVICE = { device: true, keyKnown: true };
  it("the app's own key: not approved or waiting hides the answers; not added yet disables them", () => {
    expect(approvalOf({ kind: "unapproved", dropped: false }, DEVICE)).toBe("unapproved");
    expect(approvalOf({ kind: "unapproved", dropped: true }, DEVICE)).toBe("unapproved");
    expect(approvalOf({ kind: "waiting", code: "71" }, DEVICE)).toBe("unapproved");
    expect(approvalOf({ kind: "catching-up", account: true }, DEVICE)).toBe("catching-up");
    // Off an account (the Mac app): only an approval brings it back there too.
    expect(approvalOf({ kind: "catching-up", account: false }, DEVICE)).toBe("unapproved");
    for (const s of [
      { kind: "can" },
      { kind: "cooling", until: T, exact: true },
      { kind: "unknown" },
      { kind: "old" },
      { kind: "cannot-sign" },
    ] as SendState[])
      expect(approvalOf(s, DEVICE), s.kind).toBe("ok");
  });

  it("from the send states themselves: a phone never asked is unapproved, one approved and listed is not", () => {
    const idle = sendState(view(PHASES.idle!), control(false), [MINE], ON);
    expect(approvalOf(idle, DEVICE)).toBe("unapproved");
    expect(approvalOf(sendState(view(PHASES.approved!, "can"), control(true), [MINE], ON), DEVICE)).toBe("ok");
  });

  it("nothing before the app's key is read, and nothing in a browser, whose list misses synced passkeys", () => {
    const states: SendState[] = [
      { kind: "unapproved", dropped: false },
      { kind: "waiting", code: "71" },
      { kind: "catching-up", account: true },
      { kind: "catching-up", account: false },
    ];
    for (const s of states) {
      expect(approvalOf(s, { device: true, keyKnown: false }), s.kind).toBe("ok");
      expect(approvalOf(s, { device: false, keyKnown: true }), s.kind).toBe("ok");
    }
  });
});

describe("each state in words", () => {
  const g = globalThis as Record<string, unknown>;
  const ios = () => {
    g.sessionpipeShell = { platform: "ios" };
  };
  afterEach(() => {
    delete g.sessionpipeShell;
  });
  const name = "Misha-Petrov-laptop";
  const at = clock(T + 600_000);

  it("a row's few words and the one sentence, from the one table", () => {
    ios();
    expect(sendWords({ kind: "can" }, name)).toEqual({ short: "Can send", long: null, approve: false });
    expect(sendWords({ kind: "cooling", until: T + 600_000, exact: true }, name)).toEqual({
      short: `Can send from ${at}`,
      long: `This iPhone can send from ${at}.`,
      approve: false,
    });
    expect(sendWords({ kind: "cooling", until: T + 600_000, exact: false }, name)).toEqual({
      short: `Can send by ${at}`,
      long: `This iPhone can send by ${at}.`,
      approve: false,
    });
    expect(sendWords({ kind: "unapproved", dropped: false }, name)).toEqual({
      short: "Not approved yet",
      long: "This iPhone can't send yet.",
      approve: true,
    });
    expect(sendWords({ kind: "unapproved", dropped: true }, name)?.short).toBe("Not approved");
    expect(sendWords({ kind: "waiting", code: "71" }, name)).toEqual({
      short: "Waiting for approval",
      long: "This iPhone can't send yet.",
      approve: true,
    });
    expect(sendWords({ kind: "catching-up", account: true }, name)).toEqual({
      short: "Not on this computer yet",
      long: "Misha-Petrov-laptop hasn't added this iPhone yet.",
      approve: true,
    });
    expect(sendWords({ kind: "old" }, name)).toEqual({
      short: "Update sessionpipe there",
      long: "Update sessionpipe on Misha-Petrov-laptop to send from the app.",
      approve: false,
    });
  });

  it("the Mac reads as itself; nothing where the page's own words say it", () => {
    expect(sendWords({ kind: "unapproved", dropped: false }, name)?.long).toBe("This Mac can't send yet.");
    // Off an account the signer's own words; can't sign and not known: the page's own line, or nothing.
    expect(sendWords({ kind: "catching-up", account: false }, name)).toBeNull();
    expect(sendWords({ kind: "cannot-sign" }, name)).toBeNull();
    expect(sendWords({ kind: "unknown" }, name)).toBeNull();
  });
});
