// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_DEVICE_WAIT_MS } from "./approve";
import { LOOK_FAST_MS, LOOK_IDLE_MS, memoKey, type PhoneWatch, startPhoneWatch } from "./device";
import type { DoorAnswer } from "./doors";
import { approveError } from "./screenWords";

const T = Date.parse("2026-11-12T13:05:00Z");
const M = { id: "m_studio", name: "studio-mac", takes_device: true };

/** spacesheep's device door and the hub's ask, as a test moves them. */
function bed(o: { visible?: () => boolean } = {}) {
  const kept = new Map<string, string>();
  const s = {
    asked: false,
    pending: false,
    trusted: false,
    cooling: undefined as number | null | undefined,
    looks: 0,
    asks: 0,
    machines: 0,
    refuse: null as unknown,
    doorError: null as DoorAnswer | null,
    cooled: (_until: number): void => {},
  };
  const w = startPhoneWatch({
    id: "acct",
    store: {
      getItem: (k) => kept.get(k) ?? null,
      setItem: (k, v) => void kept.set(k, v),
      removeItem: (k) => void kept.delete(k),
    },
    visible: o.visible,
    async deviceAsk() {
      s.asks++;
      if (s.refuse) throw s.refuse;
      s.asked = true;
      s.pending = true;
      return { code: "71", keyId: "key-1", trustedOn: [], devicesUrl: "https://spacesheep.test/devices" };
    },
    async device() {
      s.looks++;
      if (s.doorError) return s.doorError;
      if (!s.asked)
        return { status: 409, hub: "no_device_key", json: { hub: true, reason: "no_device_key", error: "x" } };
      return {
        status: 200,
        hub: null,
        json: {
          trusted_on: s.trusted ? [M.id] : [],
          machines: [{ ...M, trusts: s.trusted }],
          pending: s.pending,
          ...(s.cooling !== undefined ? { cooling_until: s.cooling } : {}),
        },
      };
    },
    async machinesNow() {
      s.machines++;
    },
    onCooling(l) {
      s.cooled = l;
      return () => {};
    },
  });
  return { w, s, kept };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

let w: PhoneWatch | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  w?.stop();
  w = null;
  vi.useRealTimers();
});

describe("this phone's key, watched", () => {
  it("looks once when somebody shows it, and not again for a minute", async () => {
    const b = bed();
    w = b.w;
    expect(w.get().view).toBeNull();
    const off = w.subscribe(() => {});
    await settle();
    expect(b.s.looks).toBe(1);
    expect(w.get().view?.phase).toEqual({ kind: "idle" });
    off();
    w.subscribe(() => {});
    await settle();
    expect(b.s.looks).toBe(1);
    await vi.advanceTimersByTimeAsync(LOOK_IDLE_MS);
    w.subscribe(() => {});
    await settle();
    expect(b.s.looks).toBe(2);
  });

  it("asks, shows the number, and remembers it across a reload", async () => {
    const b = bed();
    w = b.w;
    await w.ask();
    expect(w.get()).toMatchObject({ asking: false, error: null, view: { phase: { kind: "waiting", code: "71" } } });
    expect(JSON.parse(b.kept.get(memoKey("acct"))!)).toMatchObject({ keyId: "key-1", code: "71", askedAt: T });
    expect(w.get().memo.devicesUrl).toBe("https://spacesheep.test/devices");
  });

  it("while the Approve page is open it looks every five seconds, until nothing is waited for", async () => {
    const b = bed();
    w = b.w;
    await w.ask();
    w.watch(true);
    await settle();
    const before = b.s.looks;
    await vi.advanceTimersByTimeAsync(LOOK_FAST_MS * 3);
    expect(b.s.looks).toBe(before + 3);
    // Approved on spacesheep: seen within five seconds, the machines read again once, and
    // the hour runs from that sight, exactly.
    b.s.trusted = true;
    b.s.pending = false;
    await vi.advanceTimersByTimeAsync(LOOK_FAST_MS);
    const seen = T + LOOK_FAST_MS * 4;
    expect(w.get().view?.phase).toEqual({ kind: "cooling", until: seen + NEW_DEVICE_WAIT_MS, exact: true });
    expect(b.s.machines).toBe(1);
    // Nothing more is waited for: no more looks, however long the page stays open.
    const after = b.s.looks;
    await vi.advanceTimersByTimeAsync(LOOK_FAST_MS * 10);
    expect(b.s.looks).toBe(after);
    expect(b.s.machines).toBe(1);
    // The hour ends by itself.
    await vi.advanceTimersByTimeAsync(NEW_DEVICE_WAIT_MS);
    expect(w.get().view?.phase).toEqual({ kind: "approved" });
  });

  it("asks nothing while the app is in the background", async () => {
    let visible = true;
    const b = bed({ visible: () => visible });
    w = b.w;
    await w.ask();
    w.watch(true);
    await settle();
    visible = false;
    const before = b.s.looks;
    await vi.advanceTimersByTimeAsync(LOOK_FAST_MS * 6);
    expect(b.s.looks).toBe(before);
    visible = true;
    await vi.advanceTimersByTimeAsync(LOOK_FAST_MS);
    expect(b.s.looks).toBe(before + 1);
  });

  it("closed again, the page stops looking", async () => {
    const b = bed();
    w = b.w;
    await w.ask();
    w.watch(true);
    await settle();
    w.watch(false);
    const before = b.s.looks;
    await vi.advanceTimersByTimeAsync(LOOK_FAST_MS * 6);
    expect(b.s.looks).toBe(before);
  });

  it("takes spacesheep's word for the hour's end from a send it refused", async () => {
    const b = bed();
    w = b.w;
    b.s.asked = true;
    b.s.trusted = true;
    await w.look();
    // Not watched: the latest it can be.
    expect(w.get().view?.phase).toEqual({ kind: "cooling", until: T + NEW_DEVICE_WAIT_MS, exact: false });
    b.s.cooled(T + 600_000);
    expect(w.get().view?.phase).toEqual({ kind: "cooling", until: T + 600_000, exact: true });
    expect(JSON.parse(b.kept.get(memoKey("acct"))!).until).toBe(T + 600_000);
  });

  it("says a refused ask and a door that would not answer, and keeps what it knew", async () => {
    const b = bed();
    w = b.w;
    b.s.refuse = { code: "too_many_asks", message: "Too many tries.", retryAfterS: 900 };
    await w.ask();
    expect(w.get()).toMatchObject({ asking: false, error: { code: "too_many_asks", retryAfterS: 900 } });
    b.s.refuse = null;
    await w.ask();
    expect(w.get().error).toBeNull();
    b.s.doorError = { status: 502, hub: "unreachable", json: { hub: true, error: "spacesheep could not be reached." } };
    await w.look();
    expect(w.get()).toMatchObject({
      error: { code: "unreachable", message: "spacesheep could not be reached." },
      view: { phase: { kind: "waiting", code: "71" } },
    });
    b.s.doorError = { status: 403, hub: null, json: { code: "talk_off", error: "Turn it on." } };
    await w.look();
    expect(w.get().error).toEqual({ code: "talk_off", message: "Turn it on.", upstream: "talk_off" });
  });

  it("a refusal is stamped when it comes: the time it names is said once and does not move with the clock", async () => {
    const b = bed();
    w = b.w;
    b.s.refuse = { code: "too_many_asks", message: "Too many tries.", retryAfterS: 900 };
    const at = Date.now();
    await w.ask();
    expect(w.get().errorAt).toBe(at);
    const said = approveError(w.get().error!, w.get().errorAt!).words;
    // Ten minutes on, the page still open: the same refusal, the same time.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(w.get().error).toMatchObject({ code: "too_many_asks" });
    expect(w.get().errorAt).toBe(at);
    expect(approveError(w.get().error!, w.get().errorAt!).words).toBe(said);
    // Counted from now instead, it would have moved.
    expect(approveError(w.get().error!, Date.now()).words).not.toBe(said);
    // No refusal, no time.
    b.s.refuse = null;
    await w.ask();
    expect(w.get()).toMatchObject({ error: null, errorAt: null });
  });
});
