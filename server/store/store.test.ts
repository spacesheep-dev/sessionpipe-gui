// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DONE_AFTER_MS,
  GAP_AFTER_MS,
  SLOW_TOOL_MS,
  SNIPPET_CHARS,
  STALE_AFTER_MS,
  type StreamMessage,
  sessionKey,
} from "../../shared/api.js";
import { Session, SID, tempDir } from "../../test/events.js";
import { Store } from "./store.js";

const KEY = sessionKey("claude-code", SID);
/** A time a minute ago plus `s` seconds: fixtures dated by hand go "done" by silence a day later. */
const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
let tmp: { dir: string; cleanup: () => void };
let store: Store;

beforeEach(() => {
  tmp = tempDir();
  store = new Store(tmp.dir, { tickMs: 1_000, statsMs: 1_000 });
});
afterEach(async () => {
  await store.close();
  tmp.cleanup();
  vi.useRealTimers();
});

describe("ingest", () => {
  it("files events, dedups on (harness, session, seq) within and across batches", () => {
    const s = new Session();
    const a = s.ev("session.started", { source: "startup" });
    const b = s.ev("turn.started", { turn_id: "t1" });
    const r1 = store.ingest([a, b, { ...b }], "http");
    expect(r1).toMatchObject({ accepted: 2, duplicates: 1, rejected: [] });
    expect(r1.stored).toHaveLength(2);
    expect(r1.stored[0]).toMatchObject({ source: "http", type: "session.started" });
    expect(store.ingest([a], "outbox")).toMatchObject({ accepted: 0, duplicates: 1 });
    const other = new Session(SID, "codex");
    expect(store.ingest([other.ev("session.started", {}, { seq: 0 })], "http").accepted).toBe(1);
    expect(store.snapshot().sessions).toHaveLength(2);
    const file = path.join(tmp.dir, "events", "claude-code", `${SID}.jsonl`);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("rejects what it cannot file, never the batch", () => {
    const s = new Session();
    const bad = { ...s.ev("tool.ended"), session: { id: "", seq: 1 } };
    const r = store.ingest([bad, s.ev("session.started")], "http");
    expect(r.accepted).toBe(1);
    expect(r.rejected).toEqual([{ id: bad.id, reason: "bad_session" }]);
  });
});

describe("coalesce", () => {
  it("keeps full values over empty ones and the better title source", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev(
          "session.started",
          {},
          { session: { title: "first ask", title_source: "first-ask", branch: "main", model: "m1" } },
        ),
      ],
      "http",
    );
    store.ingest([s.ev("turn.started", {}, { session: { branch: "", model: undefined, title: "" } })], "http");
    let sum = store.session(KEY)!;
    expect(sum).toMatchObject({ branch: "main", model: "m1", title: "first ask", titleSource: "first-ask" });
    store.ingest(
      [s.ev("tool.started", { tool: "Bash" }, { session: { title: "Harness title", title_source: "harness" } })],
      "http",
    );
    sum = store.session(KEY)!;
    expect(sum).toMatchObject({ title: "Harness title", titleSource: "harness" });
    store.ingest(
      [s.ev("tool.ended", { tool: "Bash", ok: true }, { session: { title: "worse", title_source: "first-ask" } })],
      "http",
    );
    expect(store.session(KEY)!.title).toBe("Harness title");
    store.ingest(
      [s.ev("turn.ended", { reason: "stop" }, { session: { title: "Mine", title_source: "custom" } })],
      "http",
    );
    expect(store.session(KEY)).toMatchObject({ title: "Mine", titleSource: "custom", harnessVersion: "2.1.296" });
  });
});

describe("readings", () => {
  it("tracks turns, tools, the current tool and recent tools", () => {
    const s = new Session();
    store.ingest([s.ev("session.started", { source: "startup" })], "http");
    expect(store.session(KEY)!.state).toBe("idle");
    store.ingest([s.ev("turn.started", { turn_id: "t1", prompt_chars: 42 })], "http");
    let sum = store.session(KEY)!;
    expect(sum.state).toBe("working");
    expect(sum.currentTurn).toMatchObject({ turnId: "t1", promptChars: 42 });
    store.ingest([s.ev("tool.started", { tool: "Bash", call_id: "c1" })], "http");
    expect(store.session(KEY)!.currentTool).toMatchObject({ tool: "Bash", callId: "c1" });
    store.ingest([s.ev("tool.ended", { tool: "Bash", call_id: "other", ok: true, ms: 5 })], "http");
    expect(store.session(KEY)!.currentTool?.callId).toBe("c1");
    store.ingest([s.ev("tool.ended", { tool: "Bash", call_id: "c1", ok: false, ms: 10 })], "http");
    sum = store.session(KEY)!;
    expect(sum.currentTool).toBeUndefined();
    expect(sum.counts).toMatchObject({ tools: 2, toolErrors: 1, turns: 1 });
    store.ingest([s.ev("tool.started", { tool: "Read" })], "http");
    store.ingest([s.ev("tool.ended", { tool: "Read", ok: true })], "http");
    expect(store.session(KEY)!.currentTool).toBeUndefined();
    store.ingest([s.ev("tool.started", { tool: "Edit" })], "http");
    store.ingest([s.ev("turn.ended", { reason: "stop" })], "http");
    sum = store.session(KEY)!;
    expect(sum.currentTool).toBeUndefined();
    expect(sum.currentTurn).toBeUndefined();
    expect(sum.state).toBe("idle");
    for (let i = 0; i < 10; i++) store.ingest([s.ev("tool.ended", { tool: `T${i}`, ok: true })], "http");
    sum = store.session(KEY)!;
    expect(sum.recentTools).toHaveLength(8);
    expect(sum.recentTools[7]).toEqual({ tool: "T9", ok: true });
  });

  it("counts files, subagents, compactions and children", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("session.started"),
        s.ev("files.changed", { paths: ["a.ts", "b.ts"] }),
        s.ev("files.changed", { paths: ["a.ts"] }),
        s.ev("subagent.started", { agent_id: "ag1" }),
        s.ev("context.compacted", { trigger: "auto" }),
      ],
      "http",
    );
    expect(store.session(KEY)!.counts).toMatchObject({ filesChanged: 2, subagents: 1, compactions: 1, events: 5 });
    const child = new Session("child-1");
    store.ingest([child.ev("session.started", {}, { session: { parent_id: SID } })], "http");
    expect(store.session(KEY)!.children).toBe(1);
    expect(store.session(sessionKey("claude-code", "child-1"))!.parentId).toBe(SID);
    // A child that arrives before its parent still counts once the parent shows up.
    const orphan = new Session("child-of-later");
    store.ingest([orphan.ev("session.started", {}, { session: { parent_id: "later" } })], "http");
    store.ingest([new Session("later").ev("session.started")], "http");
    expect(store.session(sessionKey("claude-code", "later"))!.children).toBe(1);
    expect(store.sessionDetail(sessionKey("claude-code", "later"))!.children.map((c) => c.id)).toEqual([
      "child-of-later",
    ]);
  });

  it("keeps the launcher a launched session names; a later event without it changes nothing", () => {
    const launched = new Session("launched-1");
    const launcher = sessionKey("claude-code", "launcher-1");
    store.ingest([launched.ev("session.started", {}, { session: { launched_by: launcher } })], "http");
    store.ingest([launched.ev("turn.started", { turn_id: "t1" })], "http");
    const s = store.session(sessionKey("claude-code", "launched-1"))!;
    expect(s.launchedBy).toBe(launcher);
    expect(s.parentId ?? null).toBeNull();
  });
  it("keeps a launched_by only in the protocol's key shape, trimmed", () => {
    const bad = new Session("launched-2");
    store.ingest([bad.ev("session.started", {}, { session: { launched_by: "Claude Code:abc" } })], "http");
    expect(store.session(sessionKey("claude-code", "launched-2"))?.launchedBy).toBeUndefined();
    const digit = new Session("launched-4");
    store.ingest([digit.ev("session.started", {}, { session: { launched_by: "9lives:abc" } })], "http");
    expect(store.session(sessionKey("claude-code", "launched-4"))?.launchedBy).toBeUndefined();
    const padded = new Session("launched-3");
    store.ingest([padded.ev("session.started", {}, { session: { launched_by: " codex:thread-9 " } })], "http");
    expect(store.session(sessionKey("claude-code", "launched-3"))?.launchedBy).toBe("codex:thread-9");
  });

  it("keeps progress until its transcript or the turn's end; snippets are cut", () => {
    const s = new Session();
    store.ingest([s.ev("session.started"), s.ev("turn.started", { turn_id: "t1" })], "http");
    store.ingest(
      [s.ev("turn.progress", { turn: 3, user: "hi", assistant: "so far", at: "2026-10-14T10:00:05.000Z" })],
      "http",
    );
    expect(store.session(KEY)!.progress).toMatchObject({ turn: 3, user: "hi", assistant: "so far" });
    store.ingest([s.ev("turn.transcript", { turn: 2, user: "old", assistant: "old", at: "x" })], "http");
    expect(store.session(KEY)!.progress?.turn).toBe(3);
    const long = "x".repeat(1000);
    store.ingest([s.ev("turn.transcript", { turn: 3, user: long, assistant: `${long}!`, at: "x" })], "http");
    const sum = store.session(KEY)!;
    expect(sum.progress).toBeUndefined();
    expect(sum.lastUser).toHaveLength(SNIPPET_CHARS);
    expect(sum.lastAssistant).toHaveLength(SNIPPET_CHARS);
    store.ingest([s.ev("turn.progress", { turn: 4, user: "u", assistant: "a", at: "x" })], "http");
    expect(store.session(KEY)!.progress?.turn).toBe(4);
    store.ingest([s.ev("turn.ended", { reason: "stop" })], "http");
    expect(store.session(KEY)!.progress).toBeUndefined();
  });

  it("opens an attention until attention.cleared or the session's next hook event", () => {
    const s = new Session();
    store.ingest([s.ev("session.started"), s.ev("turn.started")], "http");
    store.ingest(
      [s.ev("attention.needed", { attention_id: "p1", kind: "permission", tool: "Bash", message: "rm -rf" })],
      "http",
    );
    let sum = store.session(KEY)!;
    expect(sum.state).toBe("needs_you");
    expect(sum.openAttentions).toEqual([
      { attentionId: "p1", kind: "permission", tool: "Bash", message: "rm -rf", at: expect.any(String) },
    ]);
    expect(sum.counts.attentions).toBe(1);
    // Worker-derived events do not prove the harness moved on.
    store.ingest([s.ev("turn.progress", { turn: 1, user: "u", assistant: "a", at: "x" })], "http");
    expect(store.session(KEY)!.state).toBe("needs_you");
    store.ingest([s.ev("attention.cleared", { attention_id: "p1", how: "answered" })], "http");
    sum = store.session(KEY)!;
    expect(sum.openAttentions).toEqual([]);
    expect(sum.state).toBe("working");
    store.ingest([s.ev("attention.needed", { attention_id: "p2", kind: "question" })], "http");
    expect(store.session(KEY)!.state).toBe("needs_you");
    store.ingest([s.ev("tool.started", { tool: "Bash" })], "http");
    sum = store.session(KEY)!;
    expect(sum.openAttentions).toEqual([]);
    expect(sum.state).toBe("working");
    expect(sum.counts.attentions).toBe(2);
  });

  it("keeps a session idle through the harness's idle notice", () => {
    const s = new Session();
    store.ingest([s.ev("session.started"), s.ev("turn.started"), s.ev("turn.ended", { reason: "stop" })], "http");
    expect(store.session(KEY)!.state).toBe("idle");
    // Claude Code's Notification a minute after the Stop: `idle_prompt` reads kind idle.
    const idle = s.ev("attention.needed", {
      attention_id: "notif-1",
      kind: "idle",
      message: "Claude is waiting for your input",
    });
    store.ingest([{ ...idle, harness: { ...idle.harness, event: "Notification" } }], "http");
    let sum = store.session(KEY)!;
    expect(sum.state).toBe("idle");
    expect(sum.openAttentions).toEqual([]);
    expect(sum.counts.attentions).toBe(0);
    // A Claude Code that names no notification type: the same words, read as kind question.
    const old = s.ev("attention.needed", {
      attention_id: "notif-2",
      kind: "question",
      message: "Claude is waiting for your input",
    });
    store.ingest([{ ...old, harness: { ...old.harness, event: "Notification" } }], "http");
    expect(store.session(KEY)!.state).toBe("idle");
    // A real question still needs you.
    store.ingest(
      [s.ev("attention.needed", { attention_id: "q1", kind: "question", message: "Which branch?" })],
      "http",
    );
    sum = store.session(KEY)!;
    expect(sum.state).toBe("needs_you");
    expect(sum.openAttentions).toMatchObject([{ attentionId: "q1", kind: "question" }]);
    // The idle notice that follows is a hook event like any: the question is over.
    store.ingest([{ ...s.ev("attention.needed", { attention_id: "notif-3", kind: "idle" }) }], "http");
    expect(store.session(KEY)!.state).toBe("idle");
  });

  it("comes back from done when the session starts again", () => {
    const s = new Session();
    store.ingest([s.ev("session.started"), s.ev("turn.started"), s.ev("session.ended", { reason: "other" })], "http");
    expect(store.session(KEY)!.state).toBe("done");
    store.ingest([s.ev("session.started", { source: "resume" })], "http");
    let sum = store.session(KEY)!;
    expect(sum.state).toBe("idle");
    expect(sum.endedAt).toBeUndefined();
    store.ingest([s.ev("turn.started", { prompt_chars: 12 })], "http");
    sum = store.session(KEY)!;
    expect(sum.state).toBe("working");
    store.ingest([s.ev("session.ended", { reason: "exit" })], "http");
    expect(store.session(KEY)!.state).toBe("done");
  });

  it("is done on session.ended and for a backfill-only session", () => {
    const s = new Session();
    store.ingest([s.ev("session.started"), s.ev("turn.started"), s.ev("session.ended", { reason: "exit" })], "http");
    const sum = store.session(KEY)!;
    expect(sum.state).toBe("done");
    expect(sum.endedAt).toBeDefined();
    expect(sum.currentTurn).toBeUndefined();
    const b = new Session("old-one");
    store.ingest(
      [
        b.ev(
          "session.backfill",
          { started_at: "2026-09-01T00:00:00.000Z", last_at: "2026-09-02T00:00:00.000Z", turns: 7 },
          { seq: 0 },
        ),
      ],
      "outbox",
    );
    const back = store.session(sessionKey("claude-code", "old-one"))!;
    expect(back).toMatchObject({
      state: "done",
      backfilled: true,
      startedAt: "2026-09-01T00:00:00.000Z",
      lastAt: "2026-09-02T00:00:00.000Z",
      source: "outbox",
    });
    expect(back.counts.turns).toBe(7);
    store.ingest([b.ev("session.started", { source: "resume" })], "outbox");
    expect(store.session(sessionKey("claude-code", "old-one"))!.backfilled).toBe(false);
  });

  it("goes stale and then done on the timers, emitting session messages", async () => {
    await store.close();
    vi.useFakeTimers();
    const t0 = Date.parse("2026-10-14T12:00:00.000Z");
    vi.setSystemTime(t0);
    store = new Store(tmp.dir, { tickMs: 1_000 });
    const got: StreamMessage[] = [];
    store.subscribe((m) => got.push(m));
    const s = new Session();
    s.clock = t0 - 2_000;
    store.ingest([s.ev("session.started"), s.ev("turn.started", { turn_id: "t1" })], "http");
    expect(store.session(KEY)!.state).toBe("working");
    vi.advanceTimersByTime(STALE_AFTER_MS - 5_000);
    expect(got.filter((m) => m.kind === "session")).toHaveLength(0);
    vi.advanceTimersByTime(10_000);
    const stale = got.filter((m) => m.kind === "session");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ kind: "session", session: { state: "stale" } });
    vi.advanceTimersByTime(DONE_AFTER_MS);
    const done = got.filter((m) => m.kind === "session");
    expect(done[done.length - 1]).toMatchObject({ session: { state: "done" } });
    // An idle session is also done after DONE_AFTER_MS of silence.
    const s2 = new Session("quiet");
    s2.clock = Date.now();
    store.ingest([s2.ev("session.started"), s2.ev("turn.started"), s2.ev("turn.ended", { reason: "stop" })], "http");
    expect(store.session(sessionKey("claude-code", "quiet"))!.state).toBe("idle");
    vi.advanceTimersByTime(DONE_AFTER_MS + 1_000);
    expect(store.session(sessionKey("claude-code", "quiet"))!.state).toBe("done");
  });
});

describe("forget", () => {
  it("deletes the file and the index entry and emits forgotten", () => {
    const s = new Session();
    store.ingest([s.ev("session.started"), s.ev("turn.started")], "http");
    const file = path.join(tmp.dir, "events", "claude-code", `${SID}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const got: StreamMessage[] = [];
    store.subscribe((m) => got.push(m));
    expect(store.ingest([s.ev("session.forgotten")], "http")).toMatchObject({ accepted: 1, stored: [] });
    expect(existsSync(file)).toBe(false);
    expect(store.session(KEY)).toBeUndefined();
    expect(store.feed().events).toHaveLength(0);
    expect(got).toContainEqual({ kind: "forgotten", key: KEY });
    expect(store.stats()).toMatchObject({ events: 0, sessions: 0, storageBytes: 0 });
    expect(store.forget(KEY)).toBe(false);
  });
});

describe("detail and feed", () => {
  it("pages a session's events by seq, reading the full data from disk", () => {
    const s = new Session();
    const big = "y".repeat(10_000);
    const events = [s.ev("session.started")];
    for (let i = 0; i < 5; i++)
      events.push(s.ev("tool.ended", { tool: "Bash", ok: true, input: { command: big }, output: big }));
    store.ingest(events, "http");
    const p1 = store.sessionDetail(KEY, undefined, 3)!;
    expect(p1.total).toBe(6);
    expect(p1.events.map((e) => e.session.seq)).toEqual([0, 1, 2]);
    expect(p1.events[1]!.data.output).toBe(big);
    expect((p1.events[1]!.data.input as { command: string }).command).toBe(big);
    expect("preview" in p1.events[1]!).toBe(false);
    const p2 = store.sessionDetail(KEY, 2, 10)!;
    expect(p2.events.map((e) => e.session.seq)).toEqual([3, 4, 5]);
    expect(p2).toMatchObject({ firstSeq: 3, hasOlder: true });
    expect(p1).toMatchObject({ firstSeq: 0, hasOlder: false });
    // Backwards: the newest page first (what the Session page opens on), then older ones.
    const tail = store.sessionDetail(KEY, undefined, 2, { tail: true })!;
    expect(tail.events.map((e) => e.session.seq)).toEqual([4, 5]);
    expect(tail).toMatchObject({ firstSeq: 4, hasOlder: true, total: 6 });
    expect(tail.events[0]!.data.output).toBe(big);
    const older = store.sessionDetail(KEY, undefined, 3, { before: 4 })!;
    expect(older.events.map((e) => e.session.seq)).toEqual([1, 2, 3]);
    expect(older).toMatchObject({ firstSeq: 1, hasOlder: true });
    const oldest = store.sessionDetail(KEY, undefined, 10, { before: 1 })!;
    expect(oldest.events.map((e) => e.session.seq)).toEqual([0]);
    expect(oldest.hasOlder).toBe(false);
    expect(store.sessionDetail(KEY, undefined, 10, { before: 0 })!.events).toEqual([]);
    // Slim pages come from the index, not the disk: previews and their lengths.
    const slimTail = store.sessionDetail(KEY, undefined, 2, { tail: true, slim: true })!;
    expect((slimTail.events[0]!.data.output as string).length).toBe(2048);
    expect((slimTail.events[0]! as { preview?: Record<string, number> }).preview).toEqual({
      input: JSON.stringify({ command: big }).length,
      output: 10_000,
    });
    // The feed and the stream carry the slim copy.
    const slim = store.feed({ session: KEY, type: "tool.ended" }).events[0]!;
    expect((slim.data.output as string).length).toBe(2048);
    expect((slim as { preview?: Record<string, number> }).preview).toEqual({
      input: JSON.stringify({ command: big }).length,
      output: 10_000,
    });
    expect(store.sessionDetail("claude-code:nope")).toBeUndefined();
  });

  it("feeds newest event time first with an opaque cursor and filters", () => {
    const a = new Session("a");
    const b = new Session("b", "codex", Date.now() - 90_000);
    store.ingest([a.ev("session.started", {}, { session: { title: "Alpha work" } })], "http");
    store.ingest([b.ev("session.started", {}, { session: { machine: "box-2" } })], "http");
    for (let i = 0; i < 5; i++) store.ingest([a.ev("tool.ended", { tool: i % 2 ? "Bash" : "Read", ok: true })], "http");
    // History that arrives late (a backfill, an outbox drain) sorts by its own time, not by arrival.
    const old = new Session("old");
    old.clock = Date.now() - 86_400_000;
    store.ingest(
      [old.ev("session.backfill", { started_at: "2026-09-01T00:00:00.000Z", last_at: "2026-09-02T00:00:00.000Z" })],
      "outbox",
    );
    store.ingest(
      [
        b.ev(
          "turn.transcript",
          { turn: 0, user: "find the needle please", assistant: "ok", at: "x" },
          { session: { machine: "box-2" } },
        ),
      ],
      "http",
    );
    const all = store.feed({ limit: 3 });
    expect(all.events).toHaveLength(3);
    // b's transcript arrived last but its clock is 30 s behind a's: a's last tools come first.
    expect(all.events.map((e) => e.type)).toEqual(["tool.ended", "tool.ended", "tool.ended"]);
    expect(all.cursor).toBeDefined();
    expect(all.cursor).not.toMatch(/^\d+$/);
    const next = store.feed({ limit: 3, before: all.cursor });
    expect(next.events.map((e) => e.type)).toEqual(["tool.ended", "tool.ended", "session.started"]);
    const rest = store.feed({ limit: 10, before: next.cursor });
    expect(rest.events.map((e) => e.type)).toEqual(["turn.transcript", "session.started", "session.backfill"]);
    expect(rest.cursor).toBeUndefined();
    const times = store.feed({ limit: 20 }).events.map((e) => e.time);
    expect([...times].sort().reverse()).toEqual(times);
    expect(store.feed({ before: "garbage" }).events).toHaveLength(9);
    expect(store.feed({ harness: "codex" }).events).toHaveLength(2);
    expect(store.feed({ machine: "box-2" }).events).toHaveLength(2);
    expect(store.feed({ type: "tool.ended" }).events).toHaveLength(5);
    expect(store.feed({ session: "claude-code:a" }).events).toHaveLength(6);
    expect(store.feed({ q: "bash" }).events).toHaveLength(2);
    expect(store.feed({ q: "needle" }).events).toHaveLength(1);
    expect(store.feed({ q: "alpha" }).events).toHaveLength(6);
  });

  it("does not count an initial load as live traffic", () => {
    const s = new Session();
    store.setLoading(true);
    store.ingest([s.ev("session.started"), s.ev("turn.started")], "http");
    store.setLoading(false);
    expect(store.stats()).toMatchObject({ events: 2, eventsLastMinute: 0 });
    expect(store.stats().latencyP50Ms).toBeUndefined();
    store.ingest([s.ev("tool.started", { tool: "Bash" })], "http");
    expect(store.stats()).toMatchObject({ events: 3, eventsLastMinute: 1 });
    expect(store.stats().latencyP50Ms).toBeGreaterThanOrEqual(0);
  });
});

describe("machines and stats", () => {
  it("summarises machines and measures http latency", () => {
    const a = new Session("a");
    const b = new Session("b", "codex");
    const now = Date.now();
    store.ingest(
      [a.ev("session.started", {}, { time: new Date(now - 300).toISOString() }), a.ev("turn.started")],
      "http",
    );
    store.ingest([b.ev("session.started", {}, { session: { machine: "box-2" }, version: "0.9" })], "outbox");
    const ms = store.machines();
    expect(ms.map((m) => m.name).sort()).toEqual(["box-2", "misha-air"]);
    expect(ms.find((m) => m.name === "misha-air")).toMatchObject({
      sessions: 1,
      working: 1,
      harnesses: { "claude-code": "2.1.296" },
    });
    expect(ms.find((m) => m.name === "box-2")).toMatchObject({ harnesses: { codex: "0.9" } });
    const st = store.stats();
    expect(st).toMatchObject({ events: 3, sessions: 2, machines: 2, eventsLastMinute: 3 });
    expect(st.latencyP50Ms).toBeGreaterThanOrEqual(0);
    expect(st.storageBytes).toBeGreaterThan(0);
  });

  it("emits event, machine and stats messages", async () => {
    await store.close();
    vi.useFakeTimers();
    store = new Store(tmp.dir, { statsMs: 1_000 });
    const got: StreamMessage[] = [];
    store.subscribe((m) => got.push(m));
    const s = new Session();
    store.ingest([s.ev("session.started")], "http");
    expect(got.map((m) => m.kind)).toEqual(["event", "machine"]);
    expect(got[0]).toMatchObject({ kind: "event", event: { type: "session.started" }, session: { key: KEY } });
    vi.advanceTimersByTime(1_100);
    expect(got.at(-1)).toMatchObject({ kind: "stats", stats: { events: 1 } });
  });
});

describe("reboot", () => {
  it("rebuilds the same index from the files", async () => {
    const s = new Session();
    const t = new Session("two", "codex");
    // Arrival order across sessions is kept by arrivedAt, so let the batches land in different ms.
    const pause = () => new Promise((r) => setTimeout(r, 3));
    store.ingest(
      [s.ev("session.started", {}, { session: { title: "T", title_source: "harness" } }), s.ev("turn.started")],
      "http",
    );
    await pause();
    store.ingest(
      [t.ev("session.backfill", { started_at: "2026-09-01T00:00:00.000Z", last_at: "2026-09-02T00:00:00.000Z" })],
      "outbox",
    );
    await pause();
    store.ingest(
      [
        s.ev("tool.started", { tool: "Bash", call_id: "c" }),
        s.ev("attention.needed", { attention_id: "p", kind: "permission" }),
      ],
      "http",
    );
    const before = store.snapshot();
    const feedBefore = store.feed().events.map((e) => e.id);
    await store.close();
    store = new Store(tmp.dir);
    const after = store.snapshot();
    expect(after.sessions).toEqual(before.sessions);
    expect(after.stats).toMatchObject({
      events: 5,
      sessions: 2,
      storageBytes: before.stats.storageBytes,
      eventsLastMinute: 0,
    });
    expect(store.feed().events.map((e) => e.id)).toEqual(feedBefore);
    expect(store.ingest([s.ev("turn.ended", {}, { seq: 1 })], "http").duplicates).toBe(1);
    const detail = store.sessionDetail(KEY)!;
    expect(detail.events.map((e) => e.session.seq)).toEqual([0, 1, 2, 3]);
    expect(detail.events[0]!.arrivedAt).toBeDefined();
  });
});

describe("tier upgrade", () => {
  it("keeps the richer copy when the same seq arrives again at a higher tier, and after a reboot", async () => {
    const { Store } = await import("./store.js");
    const { mkdtempSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "spgui-upgrade-"));
    const store = new Store(dir, { tickMs: 3600_000, statsMs: 3600_000 });
    const base = {
      protocol: 1 as const,
      // A fresh timestamp: a session silent for a day is read as done and its prompts closed.
      time: new Date(Date.now() - 60_000).toISOString(),
      harness: { name: "claude-code" },
      privacy: { rulesets: ["secrets@1"], pii: false },
    };
    const sess = { id: "up-1", seq: 0, machine: "m1" };
    const started = {
      ...base,
      id: "01K00000000000000000000001",
      type: "session.started",
      tier: 0 as const,
      session: sess,
      data: { source: "startup" },
    };
    const t0 = {
      ...base,
      id: "01K00000000000000000000002",
      type: "attention.needed",
      tier: 0 as const,
      session: { ...sess, seq: 1 },
      data: { attention_id: "a1", kind: "permission" },
    };
    const t3 = {
      ...t0,
      tier: 3 as const,
      data: { attention_id: "a1", kind: "permission", tool: "Bash", message: "rm -rf dist" },
    };
    expect(store.ingest([started, t0], "http")).toMatchObject({ accepted: 2, duplicates: 0 });
    expect(store.session("claude-code:up-1")?.openAttentions[0]?.tool).toBeUndefined();
    expect(store.ingest([t3], "outbox")).toMatchObject({ accepted: 0, duplicates: 1 });
    const s = store.session("claude-code:up-1")!;
    expect(s.maxTier).toBe(3);
    expect(s.openAttentions[0]?.tool).toBe("Bash");
    expect(s.counts.events).toBe(2);
    const detail = store.sessionDetail("claude-code:up-1")!;
    expect(detail.events.find((e) => e.session.seq === 1)?.tier).toBe(3);
    await store.close();
    const again = new Store(dir, { tickMs: 3600_000, statsMs: 3600_000 });
    const s2 = again.session("claude-code:up-1")!;
    expect(s2.maxTier).toBe(3);
    expect(s2.counts.events).toBe(2);
    expect(again.sessionDetail("claude-code:up-1")!.events.find((e) => e.session.seq === 1)?.tier).toBe(3);
    await again.close();
  });
});

describe("permission twins", () => {
  it("keeps the answerable prompt open when the notification about it arrives", async () => {
    // The events below carry fixed times; the clock must sit near them, or a day after
    // they were written every state here reads done (DONE_AFTER_MS).
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-14T23:18:00.000Z"));
    const { Store } = await import("./store.js");
    const { mkdtempSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const store = new Store(mkdtempSync(path.join(os.tmpdir(), "spgui-twin-")), {
      tickMs: 3600_000,
      statsMs: 3600_000,
    });
    const base = { protocol: 1 as const, tier: 3 as const, privacy: { rulesets: ["secrets@1"], pii: false } };
    const sess = (seq: number) => ({ id: "tw-1", seq, machine: "m1" });
    store.ingest(
      [
        {
          ...base,
          id: "01K00000000000000000000011",
          type: "session.started",
          time: "2026-10-14T23:17:00.000Z",
          harness: { name: "claude-code", event: "SessionStart" },
          session: sess(0),
          data: { source: "startup" },
        },
        {
          ...base,
          id: "01K00000000000000000000012",
          type: "turn.started",
          time: at(1),
          harness: { name: "claude-code", event: "UserPromptSubmit" },
          session: sess(1),
          data: {},
        },
        {
          ...base,
          id: "01K00000000000000000000013",
          type: "attention.needed",
          time: at(2),
          harness: { name: "claude-code", event: "PermissionRequest" },
          session: sess(2),
          data: { attention_id: "perm-273e341ed1d104b1", kind: "permission", tool: "Bash", message: "Bash cat > x" },
        },
        {
          ...base,
          id: "01K00000000000000000000014",
          type: "attention.needed",
          time: at(8),
          harness: { name: "claude-code", event: "Notification" },
          session: sess(3),
          data: { attention_id: "notif-1792019828511", kind: "permission" },
        },
      ],
      "outbox",
    );
    const s = store.session("claude-code:tw-1")!;
    expect(s.state).toBe("needs_you");
    expect(s.openAttentions).toHaveLength(1);
    expect(s.openAttentions[0]).toMatchObject({ attentionId: "perm-273e341ed1d104b1", answerable: true, tool: "Bash" });
    // A notification with no prompt open stays an (unanswerable) attention of its own.
    store.ingest(
      [
        {
          ...base,
          id: "01K00000000000000000000015",
          type: "tool.started",
          time: "2026-10-14T23:17:20.000Z",
          harness: { name: "claude-code", event: "PreToolUse" },
          session: sess(4),
          data: { tool: "Bash" },
        },
        {
          ...base,
          id: "01K00000000000000000000016",
          type: "attention.needed",
          time: "2026-10-14T23:17:30.000Z",
          harness: { name: "claude-code", event: "Notification" },
          session: sess(5),
          data: { attention_id: "notif-2", kind: "permission" },
        },
      ],
      "outbox",
    );
    expect(store.session("claude-code:tw-1")!.openAttentions).toMatchObject([{ attentionId: "notif-2" }]);
    expect(store.session("claude-code:tw-1")!.openAttentions[0]!.answerable).toBeUndefined();
    await store.close();
  });
});

describe("flags and turn stats", () => {
  const sessionMsgs = (got: StreamMessage[]) =>
    got.filter((m): m is Extract<StreamMessage, { kind: "session" }> => m.kind === "session");

  it("reads nothing into a quiet session", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("session.started"),
        s.ev("turn.started", { turn_id: "t1" }),
        s.ev("tool.started", { tool: "Read", call_id: "c1", input: { file_path: "a.ts" } }),
        s.ev("tool.ended", { tool: "Read", call_id: "c1", ok: true, ms: 5 }),
        s.ev("turn.ended", { reason: "stop", ms: 4000 }),
      ],
      "http",
    );
    const sum = store.session(KEY)!;
    expect(sum.flags).toEqual([]);
    expect(sum.turnStats).toEqual({ count: 1, medianMs: 4000, lastMs: 4000, toolsPerTurn: 1 });
    expect(store.snapshot().sessions[0]!.flags).toEqual([]);
  });

  it("flags a slow tool on the tick and clears it when the tool ends", async () => {
    await store.close();
    vi.useFakeTimers();
    const t0 = Date.parse("2026-10-14T12:00:00.000Z");
    vi.setSystemTime(t0);
    store = new Store(tmp.dir, { tickMs: 1_000 });
    const got: StreamMessage[] = [];
    store.subscribe((m) => got.push(m));
    const s = new Session();
    s.clock = t0 - 5_000;
    store.ingest(
      [s.ev("session.started"), s.ev("turn.started"), s.ev("tool.started", { tool: "Bash", call_id: "c1" })],
      "http",
    );
    const since = store.session(KEY)!.currentTool!.since;
    expect(store.session(KEY)!.flags).toEqual([]);
    got.length = 0;
    vi.advanceTimersByTime(SLOW_TOOL_MS - 3_000);
    expect(sessionMsgs(got)).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    const msgs = sessionMsgs(got);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.session.flags).toEqual([{ kind: "slow_tool", since, detail: "Bash · 3 m" }]);
    expect(msgs[0]!.session.state).toBe("working");
    const r = store.ingest([s.ev("tool.ended", { tool: "Bash", call_id: "c1", ok: true, ms: 181_000 })], "http");
    expect(r.accepted).toBe(1);
    expect(store.session(KEY)!.flags).toEqual([]);
    const ev = got.find((m) => m.kind === "event" && m.event.type === "tool.ended");
    expect(ev && ev.kind === "event" ? ev.session.flags : null).toEqual([]);
  });

  it("flags three tool errors in a row and clears on the next success", () => {
    const s = new Session();
    store.ingest([s.ev("session.started"), s.ev("turn.started")], "http");
    const fail = (n: number) =>
      store.ingest(
        [
          s.ev("tool.started", { tool: "Bash", call_id: `c${n}` }),
          s.ev("tool.ended", { tool: "Bash", call_id: `c${n}`, ok: false, error: "exit 1" }),
        ],
        "http",
      );
    fail(1);
    const firstErrorAt = store.session(KEY)!.lastAt;
    fail(2);
    expect(store.session(KEY)!.flags).toEqual([]);
    fail(3);
    expect(store.session(KEY)!.flags).toEqual([
      { kind: "error_streak", since: firstErrorAt, detail: "3 tool errors in a row" },
    ]);
    fail(4);
    expect(store.session(KEY)!.flags[0]).toMatchObject({ kind: "error_streak", detail: "4 tool errors in a row" });
    store.ingest(
      [
        s.ev("tool.started", { tool: "Read", call_id: "ok" }),
        s.ev("tool.ended", { tool: "Read", call_id: "ok", ok: true }),
      ],
      "http",
    );
    expect(store.session(KEY)!.flags).toEqual([]);
    expect(store.session(KEY)!.counts.toolErrors).toBe(4);
  });

  it("reads the loop from tool ends alone, for a harness with no pre-tool hook (Antigravity)", () => {
    const s = new Session();
    const edit = (file: string) =>
      s.ev("tool.ended", { tool: "edit_file", ok: true, input: { file_path: file } }, { tier: 3 });
    store.ingest([s.ev("session.started"), s.ev("turn.started"), edit("a.ts"), edit("b.ts"), edit("a.ts")], "http");
    expect(store.session(KEY)!.flags).toEqual([]);
    store.ingest([edit("a.ts")], "http");
    expect(store.session(KEY)!.flags.map((f) => f.kind)).toEqual(["loop"]);
    // A start that was matched by its end is counted once, not twice.
    const t = new Session("pair-0000-0000-0000-000000000000");
    const pair = (file: string) => [
      t.ev("tool.started", { tool: "Read", call_id: file, input: { file_path: file } }, { tier: 3 }),
      t.ev("tool.ended", { tool: "Read", call_id: file, ok: true, input: { file_path: file } }, { tier: 3 }),
    ];
    store.ingest([t.ev("session.started"), t.ev("turn.started"), ...pair("x.ts"), ...pair("x.ts")], "http");
    expect(store.session(sessionKey(t.harness, t.id))!.flags).toEqual([]);
  });

  it("flags a loop: the same tool on the same input three times in the last ten starts, tier 3 only", () => {
    const s = new Session();
    const read = (file: string, tier: 1 | 3 = 3) =>
      s.ev("tool.started", { tool: "Read", input: { file_path: file } }, { tier });
    store.ingest([s.ev("session.started"), s.ev("turn.started"), read("a.ts"), read("b.ts"), read("a.ts")], "http");
    const since = store.sessionDetail(KEY)!.events[2]!.time;
    expect(store.session(KEY)!.flags).toEqual([]);
    store.ingest([read("a.ts")], "http");
    expect(store.session(KEY)!.flags).toEqual([{ kind: "loop", since, detail: "Read ×3 on the same input" }]);
    // Eight different starts push the window past them.
    store.ingest(
      Array.from({ length: 8 }, (_, i) => s.ev("tool.started", { tool: "Bash", input: { command: `ls ${i}` } })),
      "http",
    );
    expect(store.session(KEY)!.flags).toEqual([]);
    // Below tier 3 there is no input to compare.
    const low = new Session("low");
    store.ingest([low.ev("session.started", {}, { tier: 1 }), read("x", 1), read("x", 1), read("x", 1)], "http");
    expect(store.session(sessionKey("claude-code", "low"))!.flags).toEqual([]);
  });

  it("flags repeated compaction within half an hour of the last event", () => {
    const t0 = Date.now();
    const s = new Session();
    s.clock = t0 - 40 * 60_000;
    store.ingest([s.ev("session.started"), s.ev("context.compacted", { trigger: "auto" })], "http");
    expect(store.session(KEY)!.flags).toEqual([]);
    s.clock = t0 - 20 * 60_000 + 1_000;
    store.ingest([s.ev("context.compacted", { trigger: "auto" })], "http");
    const second = store.session(KEY)!.lastAt;
    expect(store.session(KEY)!.flags).toEqual([
      { kind: "compacting", since: second, detail: "compacted twice in 20 m" },
    ]);
    s.clock = t0 - 5 * 60_000;
    store.ingest([s.ev("turn.ended", { reason: "stop" })], "http");
    expect(store.session(KEY)!.flags).toEqual([]);
    expect(store.session(KEY)!.counts.compactions).toBe(2);
  });

  it("flags a hole behind the highest seq after 30 s and clears it as the events arrive", async () => {
    await store.close();
    vi.useFakeTimers();
    const t0 = Date.parse("2026-10-14T12:00:00.000Z");
    vi.setSystemTime(t0);
    store = new Store(tmp.dir, { tickMs: 1_000 });
    const got: StreamMessage[] = [];
    store.subscribe((m) => got.push(m));
    const s = new Session();
    s.clock = t0 - 60_000;
    store.ingest([s.ev("session.started"), s.ev("turn.started"), s.ev("tool.started", { tool: "Read" })], "http");
    store.ingest([s.ev("tool.started", { tool: "Edit" }, { seq: 5 })], "http");
    expect(store.session(KEY)!.flags).toEqual([]);
    got.length = 0;
    vi.advanceTimersByTime(GAP_AFTER_MS - 1_000);
    expect(sessionMsgs(got)).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    const msgs = sessionMsgs(got);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.session.flags).toEqual([
      { kind: "gap", since: new Date(t0).toISOString(), detail: "waiting for 2 events (seq 3–4)" },
    ]);
    store.ingest([s.ev("tool.ended", { tool: "Read", ok: true }, { seq: 3 })], "http");
    expect(store.session(KEY)!.flags[0]).toMatchObject({ kind: "gap", detail: "waiting for 1 event (seq 4)" });
    store.ingest([s.ev("tool.ended", { tool: "Edit", ok: true }, { seq: 4 })], "http");
    expect(store.session(KEY)!.flags).toEqual([]);
    expect(store.sessionDetail(KEY)!.events.map((e) => e.session.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    // A sink that joined mid-session: nothing before its first seq is "missing", nor a
    // hole wider than a hundred events.
    const late = new Session("late");
    late.clock = t0 - 60_000;
    store.ingest([late.ev("turn.started", {}, { seq: 500 }), late.ev("tool.started", { tool: "Bash" })], "http");
    store.ingest([late.ev("tool.ended", { tool: "Bash", ok: true }, { seq: 900 })], "http");
    vi.advanceTimersByTime(GAP_AFTER_MS + 2_000);
    expect(store.session(sessionKey("claude-code", "late"))!.flags).toEqual([]);
  });

  it("measures turns: median and last duration, tools per turn", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("session.started"),
        s.ev("turn.started", { turn_id: "t1" }),
        s.ev("tool.started", { tool: "Read", call_id: "a" }),
        s.ev("tool.ended", { tool: "Read", call_id: "a", ok: true }),
        s.ev("turn.ended", { turn_id: "t1", reason: "stop", ms: 4000 }),
      ],
      "http",
    );
    expect(store.session(KEY)!.turnStats).toEqual({ count: 1, medianMs: 4000, lastMs: 4000, toolsPerTurn: 1 });
    // No `ms` on the second turn: its span, from turn.started to turn.ended (1 s per event here).
    store.ingest(
      [
        s.ev("turn.started", { turn_id: "t2" }),
        s.ev("tool.started", { tool: "Bash", call_id: "b" }),
        s.ev("tool.ended", { tool: "Bash", call_id: "b", ok: true }),
        s.ev("tool.started", { tool: "Edit", call_id: "c" }),
        s.ev("tool.ended", { tool: "Edit", call_id: "c", ok: true }),
        s.ev("turn.ended", { turn_id: "t2", reason: "stop" }),
      ],
      "http",
    );
    expect(store.session(KEY)!.turnStats).toEqual({ count: 2, medianMs: 4500, lastMs: 5000, toolsPerTurn: 1.5 });
    expect(store.session(KEY)!.counts.turns).toBe(2);
  });

  it("reproduces the same flags and turn stats after a reboot", async () => {
    await store.close();
    vi.useFakeTimers();
    const t0 = Date.parse("2026-10-14T12:00:00.000Z");
    vi.setSystemTime(t0);
    store = new Store(tmp.dir, { tickMs: 1_000 });
    const s = new Session();
    s.clock = t0 - 60_000;
    const events = [s.ev("session.started"), s.ev("turn.started", { turn_id: "t1" })];
    for (let i = 0; i < 3; i++) {
      events.push(
        s.ev("tool.started", { tool: "Bash", call_id: `c${i}`, input: { command: "make" } }),
        s.ev("tool.ended", { tool: "Bash", call_id: `c${i}`, ok: false }),
      );
    }
    events.push(s.ev("turn.ended", { turn_id: "t1", reason: "error", ms: 9_000 }));
    events.push(s.ev("turn.started", { turn_id: "t2" }, { seq: 12 }));
    store.ingest(events, "http");
    vi.advanceTimersByTime(GAP_AFTER_MS + 2_000);
    const before = store.session(KEY)!;
    expect(before.flags.map((f) => f.kind)).toEqual(["error_streak", "loop", "gap"]);
    expect(before.turnStats).toEqual({ count: 1, medianMs: 9000, lastMs: 9000, toolsPerTurn: 3 });
    await store.close();
    store = new Store(tmp.dir, { tickMs: 1_000 });
    const after = store.session(KEY)!;
    expect(after.flags).toEqual(before.flags);
    expect(after.turnStats).toEqual(before.turnStats);
    expect(store.snapshot().sessions).toEqual([before]);
  });
});

describe("sessionpipe 0.10 readings", () => {
  const key = sessionKey("claude-code", SID);
  it("a turn that ended with background work in flight keeps the session working until it wakes", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("session.started", { source: "startup" }),
        s.ev("turn.started", { turn_id: "t1" }),
        s.ev("turn.ended", { turn_id: "t1", reason: "stop", background: 2 }),
      ],
      "http",
    );
    const waiting = store.session(key)!;
    expect(waiting.state).toBe("working");
    expect(waiting.background?.tasks).toBe(2);
    expect(waiting.stateSince).toBe(waiting.background?.since);
    store.ingest([s.ev("turn.started", { turn_id: "t2", injected: true })], "http");
    expect(store.session(key)!.background).toBeUndefined();
    store.ingest([s.ev("turn.ended", { turn_id: "t2", reason: "stop", background: 0 })], "http");
    expect(store.session(key)!).toMatchObject({ state: "idle" });
    expect(store.session(key)!.background).toBeUndefined();
    // A session that ends while waiting is done.
    store.ingest(
      [s.ev("turn.started", { turn_id: "t3" }), s.ev("turn.ended", { turn_id: "t3", reason: "stop", background: 1 })],
      "http",
    );
    store.ingest([s.ev("session.ended", { reason: "exit" })], "http");
    expect(store.session(key)!).toMatchObject({ state: "done" });
    expect(store.session(key)!.background).toBeUndefined();
  });

  it("attended: the latest value; absent is unknown and keeps what was said", () => {
    const s = new Session();
    store.ingest([s.ev("session.started", { source: "startup" })], "http");
    expect(store.session(key)!.attended).toBeUndefined();
    store.ingest([s.ev("turn.started", {}, { session: { attended: false } })], "http");
    expect(store.session(key)!.attended).toBe(false);
    store.ingest([s.ev("tool.started", { tool: "Read" })], "http");
    expect(store.session(key)!.attended).toBe(false);
    store.ingest([s.ev("tool.ended", { tool: "Read", ok: true }, { session: { attended: true } })], "http");
    expect(store.session(key)!.attended).toBe(true);
  });

  it("submitted_by is kept as the harness's word; a malformed one is dropped", () => {
    const s = new Session();
    store.ingest([s.ev("turn.started", { turn_id: "t1", submitted_by: "schedule_wakeup" })], "http");
    expect(store.session(key)!.currentTurn).toMatchObject({ submittedBy: "schedule_wakeup" });
    store.ingest([s.ev("turn.started", { turn_id: "t2", submitted_by: "a person, typing" })], "http");
    expect(store.session(key)!.currentTurn?.submittedBy).toBeUndefined();
    store.ingest([s.ev("turn.started", { turn_id: "t3", submitted_by: "future_word" })], "http");
    expect(store.session(key)!.currentTurn?.submittedBy).toBe("future_word");
  });

  it("an injected turn never becomes the last ask, and a refired turn.started never reclassifies its turn", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("turn.started", { turn_id: "t1" }),
        s.ev("turn.ended", { turn_id: "t1", reason: "stop" }),
        s.ev("turn.transcript", { turn: 0, user: "Fix the date picker", assistant: "Done.", at: at(1) }),
        s.ev("turn.started", { turn_id: "t2", injected: true }),
        s.ev("turn.progress", { turn: 1, user: "<task-notification>…", assistant: "Reading", at: at(2) }),
      ],
      "http",
    );
    expect(store.session(key)!.progress?.user).toBe("");
    store.ingest(
      [
        s.ev("turn.ended", { turn_id: "t2", reason: "stop" }),
        s.ev("turn.transcript", { turn: 1, user: "<task-notification>…", assistant: "It passed.", at: at(3) }),
      ],
      "http",
    );
    const after = store.session(key)!;
    expect(after.lastUser).toBe("Fix the date picker");
    expect(after.lastAssistant).toBe("It passed.");
    expect(after.counts.turns).toBe(2);

    store.ingest(
      [s.ev("turn.started", { turn_id: "t3" }), s.ev("turn.started", { turn_id: "t3", injected: true })],
      "http",
    );
    expect(store.session(key)!.currentTurn?.injected).toBeUndefined();
    expect(store.session(key)!.counts.turns).toBe(3);
  });
});

describe("machines", () => {
  it("keeps a harness's version from the newest session that names one, a backfill before it or not", () => {
    const backfill = new Session("bf-1", "codex");
    const live = new Session("live-1", "codex");
    const other = new Session("other-1", "claude-code");
    store.ingest(
      [backfill.ev("session.backfill", { started_at: at(0), last_at: at(55) }, { harness: "codex", version: "" })],
      "http",
    );
    store.ingest([live.ev("session.started", { source: "startup" }, { version: "0.157.1" })], "http");
    store.ingest([other.ev("session.started", { source: "startup" })], "http");
    expect(store.machines().find((m) => m.name === "misha-air")!.harnesses).toMatchObject({ codex: "0.157.1" });
  });
});
