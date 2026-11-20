// SPDX-License-Identifier: Apache-2.0
// The stack's hold (holdToasts): while it is held no timer runs and a new toast waits; on
// release each timer goes on with what it had left, never under HOLD_FLOOR_MS.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sounds", () => ({ playSound: vi.fn(async () => {}) }));

type Lib = typeof import("./toasts");
let lib: Lib;
let sounds: { playSound: ReturnType<typeof vi.fn> };

const ids = () => lib.peekToasts().map((t) => t.id);
const error = (id: string) =>
  ({ id, kind: "error", sticky: false, title: id, label: "error", sound: "error", at: Date.now() }) as const;
const prompt = (id: string) =>
  ({ id, kind: "needs-you", sticky: true, title: id, label: "permission", sound: "needsYou", at: Date.now() }) as const;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  lib = await import("./toasts");
  sounds = (await import("./sounds")) as unknown as typeof sounds;
  sounds.playSound.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("holdToasts", () => {
  it("held at 5 s, an error stays for as long as the hold, then goes 3 s after release", () => {
    lib.pushToast(error("e"));
    vi.advanceTimersByTime(5_000);
    lib.holdToasts("pointer", true);
    vi.advanceTimersByTime(60_000);
    expect(ids()).toEqual(["e"]);
    lib.holdToasts("pointer", false);
    vi.advanceTimersByTime(2_999);
    expect(ids()).toEqual(["e"]);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
  });

  it("held at 7.5 s, it gets at least 2 s once let go", () => {
    lib.pushToast(error("e"));
    vi.advanceTimersByTime(7_500);
    lib.holdToasts("focus", true);
    vi.advanceTimersByTime(1_000);
    lib.holdToasts("focus", false);
    vi.advanceTimersByTime(lib.HOLD_FLOOR_MS - 1);
    expect(ids()).toEqual(["e"]);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
  });

  it("a toast pushed while held waits for the release, its sound played as it came", () => {
    lib.pushToast(prompt("a"));
    lib.holdToasts("pointer", true);
    lib.pushToast(prompt("b"));
    lib.pushUndo({ id: "u", title: "Hidden", undo: () => {} });
    expect(ids()).toEqual(["a"]);
    expect(sounds.playSound).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    lib.holdToasts("pointer", false);
    expect(ids()).toEqual(["a", "b", "undo|u"]);
    expect(sounds.playSound).toHaveBeenCalledTimes(2);
    // The undo's own time starts now.
    vi.advanceTimersByTime(lib.UNDO_MS - 1);
    expect(ids()).toContain("undo|u");
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual(["a", "b"]);
  });

  it("two reasons let go only when both end", () => {
    lib.pushToast(error("e"));
    lib.holdToasts("pointer", true);
    lib.holdToasts("hidden", true);
    lib.pushToast(error("f"));
    lib.holdToasts("pointer", false);
    vi.advanceTimersByTime(60_000);
    expect(ids()).toEqual(["e"]);
    lib.holdToasts("hidden", false);
    expect(ids()).toEqual(["e", "f"]);
    vi.advanceTimersByTime(lib.TOAST_MS);
    expect(ids()).toEqual([]);
  });

  it("a toast dismissed or pruned while held leaves no timer and no waiting copy behind", () => {
    lib.pushToast(error("e"));
    lib.pushToast({ ...prompt("p"), session: "claude-code:s", attentionId: "x" });
    lib.holdToasts("pointer", true);
    lib.pushToast({ ...prompt("q"), session: "claude-code:s", attentionId: "y" });
    lib.dismissToast("e");
    lib.pruneAttentionToasts(new Set());
    lib.holdToasts("pointer", false);
    expect(ids()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a sticky toast is never timed, held or not", () => {
    lib.pushToast(prompt("a"));
    lib.holdToasts("finger", true);
    lib.holdToasts("finger", false);
    vi.advanceTimersByTime(600_000);
    expect(ids()).toEqual(["a"]);
  });
});
