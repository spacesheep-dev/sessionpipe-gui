// SPDX-License-Identifier: Apache-2.0
// Whether New session and Ask another agent can go to a machine from here: each phase of this
// phone's approval against each way the machine can stand, in the composer's order, with the
// hour only where its end is known, and nothing made up before the device door's first word.
import "../native/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovePhase, ApproveView, MachineState } from "../account/approve";
import { type SendState, sendState } from "../account/sendable";
import { clock } from "../native/accountWords";
import { machineBlocked, type StartGate, startGate } from "./startGate";

const T = Date.parse("2026-11-17T05:26:00Z");
const ID = "m_laptop";
const NAME = "Misha-Petrov-laptop";
const MINE = { id: "key-phone" };
const DEVICE = { keyTypes: ["passkey", "device"] as ("passkey" | "device")[] };
const control = (listed: boolean) => ({
  machineId: ID,
  keys: [{ id: "key-mac", alg: -7, addedAt: "" }, ...(listed ? [{ id: MINE.id, alg: -7, addedAt: "" }] : [])],
});
const view = (phase: ApprovePhase, state?: MachineState): ApproveView => ({
  phase,
  machines: state ? [{ id: ID, name: NAME, state }] : [],
  rest: null,
});
const ON = { keyKnown: true, secure: true, account: true };
const OK: { wrong: string | null; secure: boolean; hint: string } = { wrong: null, secure: true, hint: "" };
const gate = (send: SendState, c: { keyTypes?: ("passkey" | "device")[] } | undefined = DEVICE, o = OK) =>
  startGate(NAME, c, { ...o, send });

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.sessionpipeShell = { platform: "ios" };
});
afterEach(() => {
  delete g.sessionpipeShell;
});

describe("on an account, each phase against each way the computer stands", () => {
  const PHASES: Record<string, ApprovePhase> = {
    idle: { kind: "idle" },
    dropped: { kind: "dropped" },
    waiting: { kind: "waiting", code: "71" },
    exact: { kind: "cooling", until: T, exact: true },
    bound: { kind: "cooling", until: T, exact: false },
    approved: { kind: "approved" },
  };
  const NOT_HERE: StartGate = {
    kind: "machine",
    short: "not approved",
    long: "Misha-Petrov-laptop adds this iPhone when it's next online.",
  };
  const OLD: StartGate = {
    kind: "machine",
    short: "update sessionpipe",
    long: "Update sessionpipe on Misha-Petrov-laptop to send from the app.",
  };
  const COOLING: StartGate = { kind: "cooling", until: T, long: `This iPhone can send from ${clock(T)}.` };
  const table: [phase: string, entry: MachineState, want: StartGate | null][] = [];
  for (const entry of ["can", "not-yet", "old"] as const) {
    // Not approved anywhere: the sheet is the way to approve it, whatever the computer says;
    // a computer too old for the key is said first, as the composer says it.
    for (const p of ["idle", "dropped", "waiting"]) table.push([p, entry, entry === "old" ? OLD : { kind: "approve" }]);
    const there = entry === "old" ? OLD : entry === "not-yet" ? NOT_HERE : null;
    table.push(["exact", entry, there ?? COOLING]);
    // The end only the latest it can be: the start goes, and a refusal makes it known.
    table.push(["bound", entry, there]);
    table.push(["approved", entry, there]);
  }
  it.each(table)("%s, the computer %s", (phase, entry, want) => {
    // "old" on the door is a computer whose hello takes no device key.
    const c = entry === "old" ? { keyTypes: ["passkey" as const] } : DEVICE;
    expect(gate(sendState(view(PHASES[phase]!, entry), control(entry === "can"), [MINE], ON), c)).toEqual(want);
  });

  it("before the device door's first word nothing is held back, and no hour is made up", () => {
    expect(gate(sendState(null, control(true), [MINE], ON))).toBeNull();
    expect(gate(sendState(null, control(false), [MINE], ON))).toBeNull();
  });

  it("a computer whose sessionpipe can't take the key: its own reason, before any approval", () => {
    for (const p of Object.values(PHASES))
      expect(gate(sendState(view(p, "can"), control(true), [MINE], ON), { keyTypes: ["passkey"] })).toEqual(OLD);
  });

  it("only the computer's own reasons turn its row off in the picker", () => {
    expect(machineBlocked(NOT_HERE)).toBe(true);
    expect(machineBlocked(OLD)).toBe(true);
    expect(machineBlocked(COOLING)).toBe(false);
    expect(machineBlocked({ kind: "approve" })).toBe(false);
    expect(machineBlocked(null)).toBe(false);
  });
});

describe("the page's own reasons come first", () => {
  const can: SendState = { kind: "can" };
  it("not paired, then an address that can't sign, then a page that can't", () => {
    expect(startGate(NAME, undefined, { ...OK, send: can })).toEqual({
      kind: "machine",
      short: "not paired",
      long: "Pair Misha-Petrov-laptop from its terminal to start sessions there.",
    });
    expect(
      gate({ kind: "unapproved", dropped: false }, DEVICE, { ...OK, wrong: "https://studio.local" }),
    ).toMatchObject({
      kind: "machine",
      short: "can't sign from this address",
    });
    expect(
      gate({ kind: "cooling", until: T, exact: true }, DEVICE, { ...OK, secure: false, hint: "no signer here" }),
    ).toEqual({
      kind: "machine",
      short: "can't sign here",
      long: "No signer here.",
    });
  });
});

describe("off an account (the Mac app, a browser), the key list", () => {
  const untrusted: SendState = { kind: "catching-up", account: false };
  it("the app: the machine doesn't trust it, with the way to approve it", () => {
    g.sessionpipeShell = { platform: "macos" };
    expect(gate(untrusted)).toEqual({
      kind: "machine",
      short: "not approved",
      long: "Misha-Petrov-laptop doesn't trust this Mac yet.",
      approve: true,
    });
  });
  it("a browser: no passkey here that it trusts, and no Approve", () => {
    delete g.sessionpipeShell;
    expect(gate(untrusted, {})).toEqual({
      kind: "machine",
      short: "no passkey here that Misha-Petrov-laptop trusts",
      long: "Misha-Petrov-laptop trusts no passkey from this browser. Add this device from one it trusts.",
    });
    expect(gate({ kind: "can" }, {})).toBeNull();
    expect(gate({ kind: "unknown" }, {})).toBeNull();
  });
});
