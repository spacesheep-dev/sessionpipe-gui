// SPDX-License-Identifier: Apache-2.0
// The page's store: labels arrive whole and numbered, a change shows at once and goes
// back when the server refuses it, and a view's state version is kept per view. Read
// marks the same way.
import type { Labels, LabelsPatch, LimitsEntry, Marks, MarksPatch } from "@shared/api";
import { describe, expect, it } from "vitest";
import { Store } from "./store";
import { STREAM_KINDS, type Transport } from "./transport";

const doc = (rev: number, sessions: Labels["sessions"] = {}, names: Labels["names"] = {}): Labels => ({
  rev,
  names,
  sessions,
});

function storeWith(patch: (p: LabelsPatch) => Promise<Labels>): Store {
  return new Store({ patchLabels: patch } as unknown as Transport);
}

describe("machines in the store", () => {
  it("keeps a machine frame whole, its hello's pool with it", () => {
    const store = storeWith(async () => doc(0));
    const pool = {
      on: true,
      harness: "claude-code",
      accounts: [
        {
          id: "a",
          enabled: true,
          status: "ready" as const,
          current: true,
          windows: [{ id: "five_hour", usedPercent: 3 }],
        },
      ],
    };
    store.apply({
      kind: "machine",
      machine: {
        name: "lab-mac",
        lastAt: "",
        harnesses: {},
        sessions: 0,
        working: 0,
        needsYou: 0,
        control: { machineId: "m", online: true, keys: [], queued: 0, pool },
      },
    });
    expect(store.get().machines.get("lab-mac")?.control?.pool).toEqual(pool);
    store.apply({
      kind: "machine",
      machine: {
        name: "lab-mac",
        lastAt: "",
        harnesses: {},
        sessions: 0,
        working: 0,
        needsYou: 0,
        control: { machineId: "m", online: true, keys: [], queued: 0 },
      },
    });
    expect(store.get().machines.get("lab-mac")?.control?.pool).toBeUndefined();
  });
});

describe("labels in the store", () => {
  it("takes the snapshot's labels, then newer frames only", () => {
    const store = storeWith(async () => doc(0));
    store.apply({
      kind: "snapshot",
      snapshot: {
        at: "",
        sessions: [],
        machines: [],
        stats: { events: 0, sessions: 0, machines: 0, eventsLastMinute: 0, storageBytes: 0, uptimeS: 0 },
        labels: doc(3, { a: "red" }),
      },
    });
    expect(store.get().labels.sessions).toEqual({ a: "red" });
    store.apply({ kind: "labels", labels: doc(2, { a: "blue" }) });
    expect(store.get().labels.rev).toBe(3);
    store.apply({ kind: "labels", labels: doc(4, { a: "green" }) });
    expect(store.get().labels.sessions).toEqual({ a: "green" });
  });

  it("shows a change at once, keeps the server's answer, and goes back on a refusal", async () => {
    let answer: (l: Labels) => void = () => {};
    const store = storeWith(() => new Promise<Labels>((r) => (answer = r)));
    const done = store.patchLabels({ sessions: { a: "red" }, names: { red: " Urgent " } });
    expect(store.get().labels).toEqual(doc(0, { a: "red" }, { red: "Urgent" }));
    answer(doc(1, { a: "red" }, { red: "Urgent" }));
    await done;
    expect(store.get().labels.rev).toBe(1);

    const refusing = storeWith(() => Promise.reject(new Error("not_found")));
    await expect(refusing.patchLabels({ sessions: { nope: "red" } })).rejects.toThrow("not_found");
    expect(refusing.get().labels).toEqual(doc(0));
  });

  it("keeps the newest version of each view's stored state", () => {
    const store = storeWith(async () => doc(0));
    store.apply({ kind: "viewState", id: "canvas", etag: '"a"' });
    store.apply({ kind: "viewState", id: "canvas", etag: '"b"' });
    expect(store.get().viewStates.get("canvas")).toBe('"b"');
  });
});

describe("marks in the store", () => {
  const marks = (rev: number, read: Marks["read"] = {}, unread: Marks["unread"] = {}): Marks => ({
    rev,
    since: "2026-10-28T10:00:00.000Z",
    read,
    unread,
  });
  const storeWith = (patch: (p: MarksPatch) => Promise<Marks>) =>
    new Store({ patchMarks: patch } as unknown as Transport);

  it("takes newer frames only, and shows a change at once until the answer or a refusal", async () => {
    let answer: (m: Marks) => void = () => {};
    const store = storeWith(() => new Promise<Marks>((r) => (answer = r)));
    store.apply({ kind: "marks", marks: marks(3, { a: "2026-10-28T10:01:00.000Z" }) });
    store.apply({ kind: "marks", marks: marks(2) });
    expect(store.get().marks.rev).toBe(3);
    const done = store.patchMarks({ read: { a: null, b: "2026-10-28T10:02:00.000Z" }, unread: { c: true } });
    expect(store.get().marks).toEqual(marks(3, { b: "2026-10-28T10:02:00.000Z" }, { c: true }));
    answer(marks(4, { b: "2026-10-28T10:02:00.000Z" }, { c: true }));
    await done;
    expect(store.get().marks.rev).toBe(4);

    const refusing = storeWith(() => Promise.reject(new Error("bad_read")));
    refusing.apply({ kind: "marks", marks: marks(1) });
    await expect(refusing.patchMarks({ unread: { a: true } })).rejects.toThrow("bad_read");
    expect(refusing.get().marks).toEqual(marks(1));
  });

  it("shows a Notify me level at once, and puts it back on a refusal", async () => {
    const store = storeWith(() => Promise.reject(new Error("bad_notify")));
    store.apply({ kind: "marks", marks: { ...marks(1), notify: { a: "finishes" } } });
    const done = store.patchMarks({ notify: { a: null, b: "never" } });
    expect(store.get().marks.notify).toEqual({ b: "never" });
    await expect(done).rejects.toThrow("bad_notify");
    expect(store.get().marks.notify).toEqual({ a: "finishes" });
  });
});

describe("usage limits in the store", () => {
  const entry = (key: string): LimitsEntry => ({
    key,
    harness: "claude-code",
    machine: "lab-mac",
    machines: ["lab-mac"],
    windows: [{ id: "five_hour", usedPercent: 38 }],
    observedAt: "2026-10-29T10:00:00.000Z",
  });

  it("takes the snapshot's list, then each limits frame whole, and listens for the frame", () => {
    const store = storeWith(async () => doc(0));
    expect(store.get().limits).toEqual([]);
    store.apply({
      kind: "snapshot",
      snapshot: {
        at: "",
        sessions: [],
        machines: [],
        stats: { events: 0, sessions: 0, machines: 0, eventsLastMinute: 0, storageBytes: 0, uptimeS: 0 },
        limits: [entry("claude-code a:1"), entry("codex m:lab-mac")],
      },
    });
    expect(store.get().limits.map((e) => e.key)).toEqual(["claude-code a:1", "codex m:lab-mac"]);
    store.apply({ kind: "limits", limits: [entry("codex m:lab-mac")] });
    expect(store.get().limits.map((e) => e.key)).toEqual(["codex m:lab-mac"]);
    expect(STREAM_KINDS).toContain("limits");
  });
});
