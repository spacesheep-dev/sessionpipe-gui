// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  approveView,
  type DeviceMemo,
  deviceDoor,
  memoFrom,
  NEW_DEVICE_WAIT_MS,
  remember,
  WATCHED_MS,
} from "./approve";

const T = Date.parse("2026-11-12T13:05:00Z");
const HOUR = NEW_DEVICE_WAIT_MS;
const m = (id: string, trusts: boolean, takes = true) => ({
  id,
  name: id.replace("m_", ""),
  trusts,
  takes_device: takes,
});
const door = (o: { trusted?: string[]; pending?: boolean; machines?: unknown[]; cooling?: number | null } = {}) =>
  deviceDoor({
    trusted_on: o.trusted ?? [],
    machines: o.machines ?? [m("m_studio", (o.trusted ?? []).includes("m_studio"))],
    pending: o.pending ?? false,
    ...(o.cooling !== undefined ? { cooling_until: o.cooling } : {}),
  });
const asked: DeviceMemo = { keyId: "k", code: "71", askedAt: T - 60_000, devicesUrl: "https://spacesheep.dev/devices" };

describe("the device door, read", () => {
  it("says each computer, whether it trusts this phone and whether it could", () => {
    const d = deviceDoor({
      trusted_on: ["m_a"],
      machines: [m("m_a", false), m("m_b", false), m("m_c", false, false), { name: "no id" }, null],
      pending: true,
    });
    expect(d).toEqual({
      trusted: true,
      machines: [
        { id: "m_a", name: "a", trusts: true, takesDevice: true },
        { id: "m_b", name: "b", trusts: false, takesDevice: true },
        { id: "m_c", name: "c", trusts: false, takesDevice: false },
      ],
      pending: true,
    });
  });

  it("carries the hour's end only where spacesheep says it", () => {
    expect("coolingUntil" in door()).toBe(false);
    expect(door({ cooling: T + 5 }).coolingUntil).toBe(T + 5);
    expect(door({ cooling: null }).coolingUntil).toBeNull();
    expect(deviceDoor({ cooling_until: "soon" }).coolingUntil).toBeNull();
    expect(deviceDoor({})).toEqual({ trusted: false, machines: [], pending: false });
  });
});

describe("where this phone's key stands", () => {
  it("nothing asked: idle; before the hub ever asked: idle", () => {
    expect(approveView({}, null, T).phase).toEqual({ kind: "idle" });
    expect(approveView({}, door(), T).phase).toEqual({ kind: "idle" });
  });

  it("a request open on spacesheep: waiting, with the number this phone was given", () => {
    expect(approveView(asked, door({ pending: true }), T)).toEqual({
      phase: { kind: "waiting", code: "71" },
      machines: [{ id: "m_studio", name: "studio", state: "not-yet" }],
      rest: null,
    });
    // Asked from somewhere that did not keep the number (storage cleared): open, no number.
    expect(approveView({}, door({ pending: true }), T).phase).toEqual({ kind: "waiting", code: null });
  });

  it("asked, and the request is gone with nothing trusted: dropped", () => {
    expect(approveView(asked, door(), T).phase).toEqual({ kind: "dropped" });
  });

  it("trusted while the page watched: the hour runs from the moment it saw it, and that is exact", () => {
    let memo = remember(asked, door({ pending: true }), T);
    expect(memo.openAt).toBe(T);
    memo = remember(memo, door({ trusted: ["m_studio"] }), T + 5000);
    expect(memo).toMatchObject({ trustedAt: T + 5000, watched: true });
    expect(memo.openAt).toBeUndefined();
    const v = approveView(memo, door({ trusted: ["m_studio"] }), T + 6000);
    expect(v.phase).toEqual({ kind: "cooling", until: T + 5000 + HOUR, exact: true });
    expect(v.machines).toEqual([{ id: "m_studio", name: "studio", state: "can" }]);
    // The first sight is kept: looking again does not move the hour.
    memo = remember(memo, door({ trusted: ["m_studio"] }), T + 600_000);
    expect(memo.trustedAt).toBe(T + 5000);
    // And when the hour is over it can send.
    expect(approveView(memo, door({ trusted: ["m_studio"] }), T + 5000 + HOUR).phase).toEqual({ kind: "approved" });
  });

  it("trusted while the page was not looking: an hour from first sight, the latest it can be", () => {
    let memo = remember(asked, door({ pending: true }), T);
    // The app was away for half an hour; the approval came somewhere in between.
    memo = remember(memo, door({ trusted: ["m_studio"] }), T + 1_800_000);
    expect(memo).toMatchObject({ trustedAt: T + 1_800_000, watched: false });
    expect(approveView(memo, door({ trusted: ["m_studio"] }), T + 1_800_000).phase).toEqual({
      kind: "cooling",
      until: T + 1_800_000 + HOUR,
      exact: false,
    });
    // Just outside the watch: not exact either.
    const late = remember({ ...asked, openAt: T }, door({ trusted: ["m_studio"] }), T + WATCHED_MS + 1);
    expect(late.watched).toBe(false);
    // Never seen open at all (the memo is new): the same bound, from now.
    const fresh = remember({}, door({ trusted: ["m_studio"] }), T);
    expect(approveView(fresh, door({ trusted: ["m_studio"] }), T).phase).toEqual({
      kind: "cooling",
      until: T + HOUR,
      exact: false,
    });
  });

  it("spacesheep's own word for the hour's end wins: on the door, then in a refusal", () => {
    const memo: DeviceMemo = { ...asked, trustedAt: T, watched: false, until: T + 1000 };
    // The door says it: that, whatever was remembered.
    expect(approveView(memo, door({ trusted: ["m_studio"], cooling: T + 2_000_000 }), T).phase).toEqual({
      kind: "cooling",
      until: T + 2_000_000,
      exact: true,
    });
    expect(approveView(memo, door({ trusted: ["m_studio"], cooling: null }), T).phase).toEqual({ kind: "approved" });
    // The door is silent: the refusal's `until`.
    expect(approveView(memo, door({ trusted: ["m_studio"] }), T).phase).toEqual({
      kind: "cooling",
      until: T + 1000,
      exact: true,
    });
    expect(approveView(memo, door({ trusted: ["m_studio"] }), T + 1000).phase).toEqual({ kind: "approved" });
  });

  it("removed on spacesheep: the hour is forgotten with the trust", () => {
    const memo = remember({ ...asked, trustedAt: T, watched: true, until: T + 5 }, door(), T + 10);
    expect(memo).toEqual(asked);
    expect(approveView(memo, door(), T + 10).phase).toEqual({ kind: "dropped" });
  });

  it("some computers took the key and one has not: the number is still there for it", () => {
    const d = door({
      trusted: ["m_a"],
      pending: true,
      machines: [m("m_a", true), m("m_b", false), m("m_old", false, false)],
    });
    const v = approveView({ ...asked, trustedAt: T - 2 * HOUR }, d, T);
    expect(v.phase).toEqual({ kind: "approved" });
    expect(v.rest).toBe("71");
    expect(v.machines.map((x) => x.state)).toEqual(["can", "not-yet", "old"]);
    // Nothing left that could take it: no number to type.
    expect(
      approveView(asked, door({ trusted: ["m_a"], pending: true, machines: [m("m_a", true)] }), T).rest,
    ).toBeNull();
  });
});

describe("what the page remembers of its ask", () => {
  it("reads back what it kept, and nothing else", () => {
    const memo: DeviceMemo = { ...asked, openAt: T, trustedAt: T, watched: true, until: T + 9 };
    expect(memoFrom(JSON.stringify(memo))).toEqual(memo);
    expect(memoFrom(JSON.stringify({ keyId: 7, code: "", askedAt: "x", watched: "yes", more: 1 }))).toEqual({});
    expect(memoFrom("not json")).toEqual({});
    expect(memoFrom("null")).toEqual({});
    expect(memoFrom(null)).toEqual({});
  });
});
