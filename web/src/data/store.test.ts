// SPDX-License-Identifier: Apache-2.0
// The page's store: labels arrive whole and numbered, a change shows at once and goes
// back when the server refuses it, and a view's state version is kept per view. Read
// marks the same way. The stream coming back: only its snapshot makes the page live, each
// one after the first is counted, and the control activity is read again without a
// message ever going back.
import type { ControlActivity, Labels, LabelsPatch, LimitsEntry, Marks, MarksPatch, Snapshot } from "@shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_HISTORY,
  CONTROL_RETRY_MS,
  CONTROL_TRIES,
  furthest,
  mergeControl,
  RESYNC_QUIET_MS,
  Store,
} from "./store";
import { STREAM_KINDS, type StreamHandlers, type Transport } from "./transport";

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

describe("the stream coming back", () => {
  afterEach(() => vi.useRealTimers());

  const snap = (at: string): Snapshot => ({
    at,
    sessions: [],
    machines: [],
    stats: { events: 0, sessions: 0, machines: 0, eventsLastMinute: 0, storageBytes: 0, uptimeS: 0 },
  });
  /** A transport whose stream the test drives: every open, and whether it was closed. */
  function wired(controlActivity?: Transport["controlActivity"]) {
    const streams: { h: StreamHandlers; closed: boolean }[] = [];
    const transport = {
      openStream(h: StreamHandlers) {
        const stream = { h, closed: false };
        streams.push(stream);
        return () => {
          stream.closed = true;
        };
      },
      controlActivity,
    } as unknown as Transport;
    const store = new Store(transport);
    const said: string[] = [];
    store.subscribe(() => {
      const c = store.get().connection;
      if (said[said.length - 1] !== c) said.push(c);
    });
    return { store, streams, said, last: () => streams[streams.length - 1]!.h };
  }
  const msg = (id: string, more: Partial<ControlActivity> = {}): ControlActivity => ({
    id,
    machineId: "m_1",
    kind: "prompt",
    session: "claude-code:s1",
    text: "Run the tests",
    at: "2026-11-10T10:00:00.000Z",
    expiresAt: "2026-11-10T11:00:00.000Z",
    ...more,
  });

  it("an open stream says nothing: a page that dropped is live again only at its snapshot", () => {
    const { store, last } = wired();
    store.start();
    last().onOpen();
    expect(store.get().connection).toBe("connecting");
    last().onMessage({ kind: "snapshot", snapshot: snap("a") });
    expect(store.get().connection).toBe("live");
    last().onError(1000);
    expect(store.get().connection).toBe("reconnecting");
    expect(store.get().retryAt).not.toBeNull();
    // The stream is open again and has sent nothing: the rows are still the ones from before.
    last().onOpen();
    expect(store.get()).toMatchObject({ connection: "reconnecting", retryAt: null, snapshotAt: "a" });
    expect(store.get().resyncs).toBe(0);
    last().onMessage({ kind: "snapshot", snapshot: snap("b") });
    expect(store.get()).toMatchObject({ connection: "live", snapshotAt: "b", resyncs: 1 });
  });

  it("Retry now from a drop goes on saying so until the snapshot; from live it says connecting", () => {
    const { store, streams, last } = wired();
    store.start();
    last().onMessage({ kind: "snapshot", snapshot: snap("a") });
    last().onError(8000);
    store.reconnect();
    expect(streams).toHaveLength(2);
    expect(streams[0]!.closed).toBe(true);
    expect(store.get()).toMatchObject({ connection: "reconnecting", retryAt: null });
    last().onMessage({ kind: "snapshot", snapshot: snap("b") });
    expect(store.get()).toMatchObject({ connection: "live", resyncs: 1 });
    store.reconnect();
    expect(store.get().connection).toBe("connecting");
    last().onMessage({ kind: "snapshot", snapshot: snap("c") });
    expect(store.get()).toMatchObject({ connection: "live", resyncs: 2 });
  });

  it("a page come back opens the stream again without a word, once, and says so only when the snapshot is slow", () => {
    vi.useFakeTimers();
    const { store, streams, said, last } = wired();
    store.resync();
    expect(streams).toHaveLength(0);
    store.start();
    store.resync();
    expect(streams).toHaveLength(1);
    last().onMessage({ kind: "snapshot", snapshot: snap("a") });
    said.length = 0;

    store.resync();
    store.resync();
    expect(streams).toHaveLength(2);
    expect(streams[0]!.closed).toBe(true);
    last().onOpen();
    vi.advanceTimersByTime(RESYNC_QUIET_MS - 1);
    last().onMessage({ kind: "snapshot", snapshot: snap("b") });
    vi.advanceTimersByTime(RESYNC_QUIET_MS * 4);
    expect(said).toEqual(["live"]);
    expect(store.get()).toMatchObject({ connection: "live", snapshotAt: "b", resyncs: 1 });

    // A snapshot that does not come: the page stops calling itself live.
    store.resync();
    vi.advanceTimersByTime(RESYNC_QUIET_MS);
    expect(store.get()).toMatchObject({ connection: "reconnecting", retryAt: null });
    last().onMessage({ kind: "snapshot", snapshot: snap("c") });
    expect(store.get()).toMatchObject({ connection: "live", resyncs: 2 });

    // Down and waiting out a backoff: opened at once, still said to be down.
    last().onError(15_000);
    store.resync();
    expect(streams).toHaveLength(4);
    expect(store.get()).toMatchObject({ connection: "reconnecting", retryAt: null });
  });

  it("a message is kept as the copy further along, whichever was read last", () => {
    const queued = msg("01A");
    const taken = msg("01A", { outcome: "taken", takenAt: "2026-11-10T10:00:01.000Z" });
    const saying = { ...taken, reply: "Running", replySeq: 2 };
    const said = { ...taken, reply: "Running the", replySeq: 3 };
    const done = { ...said, outcome: "delivered" as const, ackedAt: "2026-11-10T10:00:09.000Z" };
    const order = [queued, taken, saying, said, done];
    for (let i = 0; i < order.length; i++)
      for (let j = 0; j < order.length; j++)
        expect(furthest(order[i]!, order[j]!), `${i} against ${j}`).toBe(order[Math.max(i, j)]);
    // A reply that began before the `taken` ack is behind the same reply once taken.
    const early = msg("01A", { outcome: "progress", reply: "Running", replySeq: 2 });
    expect(furthest(saying, early)).toBe(saying);
    expect(furthest(early, saying)).toBe(saying);

    const held = [msg("01C", { outcome: "taken", takenAt: "t" }), done];
    const read = [msg("01D"), msg("01C", { outcome: "taken", takenAt: "t" }), queued, msg("01B")];
    const merged = mergeControl(held, read);
    expect(merged.map((a) => a.id)).toEqual(["01C", "01A", "01D", "01B"]);
    // Nothing new about a message: the very object the page held, so nothing redraws.
    expect(merged[0]).toBe(held[0]);
    expect(merged[1]).toBe(done);
  });

  it("reads the control activity again after a drop, once, and no late answer or frame takes a message back", async () => {
    const answers: ((list: ControlActivity[]) => void)[] = [];
    const read = vi.fn((_limit: number) => new Promise<ControlActivity[]>((r) => answers.push(r)));
    const { store, last } = wired(read);
    store.start();
    last().onMessage({ kind: "snapshot", snapshot: snap("a") });
    expect(read).not.toHaveBeenCalled();
    store.loadControl();
    store.loadControl();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(CONTROL_HISTORY);
    const taken = msg("01B", { outcome: "taken", takenAt: "2026-11-10T10:00:01.000Z" });
    last().onMessage({ kind: "control", message: taken });
    // The first answer, read before that frame, lands after it.
    answers[0]!([msg("01B"), msg("01A", { outcome: "delivered" })]);
    await Promise.resolve();
    expect(store.get().control.map((a) => [a.id, a.outcome])).toEqual([
      ["01B", "taken"],
      ["01A", "delivered"],
    ]);

    // The stream drops; the machine's final ack is a frame nobody heard.
    last().onError(1000);
    last().onMessage({ kind: "snapshot", snapshot: snap("b") });
    expect(read).toHaveBeenCalledTimes(2);
    store.loadControl();
    expect(read).toHaveBeenCalledTimes(2);
    const delivered = {
      ...taken,
      outcome: "delivered" as const,
      reply: "All 212 pass.",
      ackedAt: "2026-11-10T10:00:30.000Z",
    };
    answers[1]!([delivered, msg("01A", { outcome: "delivered" })]);
    await Promise.resolve();
    expect(store.get().control.find((a) => a.id === "01B")).toEqual(delivered);
    // A frame from before that answer, delivered after it, changes nothing.
    last().onMessage({ kind: "control", message: taken });
    expect(store.get().control.find((a) => a.id === "01B")).toEqual(delivered);

    // An answer that does not come is asked for again, and then by the next page that asks.
    vi.useFakeTimers();
    last().onError(1000);
    read.mockImplementation(() => Promise.reject(new Error("offline")));
    last().onMessage({ kind: "snapshot", snapshot: snap("c") });
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(CONTROL_RETRY_MS);
    expect(read).toHaveBeenCalledTimes(4);
    store.loadControl();
    expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(CONTROL_RETRY_MS * 2);
    expect(read).toHaveBeenCalledTimes(2 + CONTROL_TRIES);
    await vi.advanceTimersByTimeAsync(CONTROL_RETRY_MS * 10);
    expect(read).toHaveBeenCalledTimes(2 + CONTROL_TRIES);
    read.mockImplementation(async () => [msg("01C")]);
    store.loadControl();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get().control.map((a) => a.id)).toEqual(["01B", "01A", "01C"]);
  });

  it("asks for no activity until a page does, and none where there is no receiver to ask", () => {
    const read = vi.fn(async () => []);
    const { store, last } = wired(read);
    store.start();
    last().onMessage({ kind: "snapshot", snapshot: snap("a") });
    last().onError(1000);
    last().onMessage({ kind: "snapshot", snapshot: snap("b") });
    expect(read).not.toHaveBeenCalled();
    const mock = wired();
    mock.store.start();
    expect(() => mock.store.loadControl()).not.toThrow();
  });
});
