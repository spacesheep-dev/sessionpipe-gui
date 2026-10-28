// SPDX-License-Identifier: Apache-2.0
// The delegations reading (shared/api.ts Delegation): a session that asked another agent
// through the daemon (sessionpipe ask), a handoff relayed into it, and the child session's
// `delegated_by`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELEGATIONS_MAX, STALE_AFTER_MS, sessionKey } from "../../shared/api.js";
import { Session, SID, tempDir } from "../../test/events.js";
import { PREVIEW_CHARS } from "./slim.js";
import { Store } from "./store.js";

const KEY = sessionKey("claude-code", SID);
const ASK = "01K8ASK000000000000000AAAA";
let tmp: { dir: string; cleanup: () => void };
let store: Store;

beforeEach(() => {
  tmp = tempDir();
  store = new Store(tmp.dir, { tickMs: 60_000, statsMs: 60_000 });
});
afterEach(async () => {
  await store.close();
  tmp.cleanup();
});

const read = () => store.session(KEY)!;

describe("delegations", () => {
  it("reads an ask: open, it keeps the session working after its turn ended; the end brings the answer", () => {
    const s = new Session();
    const feed = (type: string, data: Record<string, unknown> = {}) => store.ingest([s.ev(type, data)], "http");
    feed("session.started", { source: "startup" });
    feed("turn.started", { turn_id: "t1" });
    feed("delegation.started", { ask_id: ASK, via: "ask", harness: "codex", text: "Review this diff" });
    feed("turn.ended", { turn_id: "t1", reason: "stop" });
    let r = read();
    expect(r.state).toBe("working");
    expect(r.counts.delegationsRunning).toBe(1);
    expect(r.delegations).toEqual([
      { askId: ASK, via: "ask", harness: "codex", text: "Review this diff", startedAt: expect.any(String) },
    ]);
    // Unlike a subagent, an ask opens no turn of its own.
    expect(r.currentTurn).toBeUndefined();

    feed("delegation.ended", { ask_id: ASK, to: "codex:thread-1", ok: true, ms: 4200, reply: "Two issues." });
    r = read();
    expect(r.state).toBe("idle");
    expect(r.counts.delegationsRunning).toBe(0);
    expect(r.delegations![0]).toMatchObject({
      askId: ASK,
      to: "codex:thread-1",
      ok: true,
      ms: 4200,
      reply: "Two issues.",
    });
    expect(r.delegations![0]!.endedAt).toBeDefined();
  });

  it("reads a handoff with how it was relayed, and an error when it was not ok", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("delegation.started", { ask_id: ASK, via: "handoff", harness: "codex", to: "codex:thread-2" }),
        s.ev("delegation.ended", { ask_id: ASK, to: "codex:thread-2", ok: true, ms: 9000, relayed: "delivered" }),
        s.ev("delegation.started", { ask_id: "01K8ASK000000000000000BBBB", via: "handoff", harness: "gemini-cli" }),
        s.ev("delegation.ended", {
          ask_id: "01K8ASK000000000000000BBBB",
          ok: false,
          ms: 300,
          error: "harness: gemini-cli is not installed here",
          relayed: "failed",
        }),
      ],
      "http",
    );
    const [a, b] = read().delegations!;
    expect(a).toMatchObject({ via: "handoff", to: "codex:thread-2", ok: true, relayed: "delivered" });
    expect(b).toMatchObject({ via: "handoff", harness: "gemini-cli", ok: false, relayed: "failed" });
    expect(b!.error).toBe("harness: gemini-cli is not installed here");
    expect(b!.reply).toBeUndefined();
  });

  it("reads an end whose start it never saw (a sink that joined late), the harness from `to`", () => {
    const s = new Session();
    store.ingest([s.ev("delegation.ended", { ask_id: ASK, to: "codex:thread-3", ok: true, ms: 10 })], "http");
    expect(read().delegations).toEqual([
      {
        askId: ASK,
        via: "ask",
        harness: "codex",
        to: "codex:thread-3",
        ok: true,
        ms: 10,
        startedAt: expect.any(String),
        endedAt: expect.any(String),
      },
    ]);
    expect(read().state).toBe("idle");
  });

  it("ignores a start or an end with no ask id", () => {
    const s = new Session();
    store.ingest([s.ev("delegation.started", { via: "ask", harness: "codex" }), s.ev("delegation.ended", {})], "http");
    expect(read().delegations).toBeUndefined();
    expect(read().counts.delegationsRunning).toBe(0);
  });

  it("keeps at most DELEGATIONS_MAX, dropping the oldest ended ones and never an open one", () => {
    const s = new Session();
    const events = [s.ev("delegation.started", { ask_id: "01K8ASK0000000000000OPEN00", via: "ask", harness: "codex" })];
    for (let i = 0; i < DELEGATIONS_MAX + 5; i++) {
      const id = `01K8ASK00000000000000${String(i).padStart(5, "0")}`;
      events.push(s.ev("delegation.started", { ask_id: id, via: "ask", harness: "codex" }));
      events.push(s.ev("delegation.ended", { ask_id: id, ok: true, ms: 1 }));
    }
    store.ingest(events, "http");
    const r = read();
    expect(r.delegations).toHaveLength(DELEGATIONS_MAX);
    expect(r.delegations![0]!.askId).toBe("01K8ASK0000000000000OPEN00");
    expect(r.delegations![1]!.askId).toBe("01K8ASK0000000000000000006");
    expect(r.counts.delegationsRunning).toBe(1);
    expect(r.state).toBe("working");
  });

  it("reads delegated_by on the child session, across harnesses", () => {
    const child = new Session("thread-9", "codex");
    store.ingest(
      [child.ev("session.started", { source: "startup" }, { session: { delegated_by: `claude-code:${SID}` } })],
      "http",
    );
    const r = store.session(sessionKey("codex", "thread-9"))!;
    expect(r.delegatedBy).toBe(`claude-code:${SID}`);
    // Lineage, not parentage: it is not the asker's subagent.
    expect(r.parentId).toBeUndefined();
    // A later event without the field keeps it (COALESCE), a malformed one is not a ref.
    store.ingest([child.ev("turn.started", { turn_id: "t1" }, { session: { delegated_by: "nope" } })], "http");
    expect(store.session(sessionKey("codex", "thread-9"))!.delegatedBy).toBe(`claude-code:${SID}`);
  });

  it("closes open delegations when the session ends, the answer unknown", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("delegation.started", { ask_id: ASK, via: "ask", harness: "codex" }),
        s.ev("session.ended", { reason: "exit" }),
      ],
      "http",
    );
    const r = read();
    expect(r.state).toBe("done");
    expect(r.counts.delegationsRunning).toBe(0);
    expect(r.delegations![0]!.endedAt).toBeDefined();
    expect(r.delegations![0]!.ok).toBeUndefined();
  });

  it("goes stale when the asked agent is silent for STALE_AFTER_MS", () => {
    const s = new Session();
    store.ingest([s.ev("delegation.started", { ask_id: ASK, via: "ask", harness: "codex" })], "http");
    expect(read().state).toBe("working");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1000);
      expect(read().state).toBe("stale");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cuts a long reply to the preview and reads the same after a restart", async () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("delegation.started", { ask_id: ASK, via: "ask", harness: "codex", text: "x".repeat(300) }),
        s.ev("delegation.ended", { ask_id: ASK, ok: true, ms: 5, reply: "r".repeat(5000) }),
      ],
      "http",
    );
    const before = read();
    expect(before.delegations![0]!.reply).toHaveLength(PREVIEW_CHARS);
    expect(before.delegations![0]!.text).toHaveLength(200);
    await store.close();
    store = new Store(tmp.dir, { tickMs: 60_000, statsMs: 60_000 });
    expect(read().delegations).toEqual(before.delegations);
    expect(read().counts.delegationsRunning).toBe(0);
    // The event on disk has the whole answer.
    const d = store.sessionDetail(KEY)!;
    expect((d.events[1]!.data.reply as string).length).toBe(5000);
  });
});
