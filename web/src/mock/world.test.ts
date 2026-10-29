// SPDX-License-Identifier: Apache-2.0
// The mock reads the agents a session asked as the receiver does (server/store/readings.ts
// delegations): an open ask keeps the asker working, the end brings the answer, the asked
// session says who it is for, and the handoff's message is in the control activity.
import type { StoredEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import { World } from "./world";

describe("World: agents that ask each other", () => {
  const world = new World();
  const snap = world.snapshot();
  const sessions = snap.kind === "snapshot" ? snap.snapshot.sessions : [];
  const asker = sessions.find((s) => s.title === "Webhook retries with backoff")!;

  it("reads an answered ask and a running one on the asking session", () => {
    expect(asker.delegations).toHaveLength(2);
    const [done, open] = asker.delegations!;
    expect(done).toMatchObject({ via: "ask", harness: "codex", ok: true, to: expect.stringMatching(/^codex:/) });
    expect(done!.reply).toMatch(/^Two things/);
    expect(open).toMatchObject({ via: "ask", harness: "codex" });
    expect(open!.endedAt).toBeUndefined();
    expect(asker.counts.delegationsRunning).toBe(1);
    expect(asker.state).toBe("working");
  });

  it("marks the asked sessions as delegated_by the asker, on every event", () => {
    const kids = sessions.filter((s) => s.delegatedBy === asker.key);
    expect(kids.length).toBe(2);
    for (const k of kids) {
      expect(k.harness).toBe("codex");
      const d = world.detail(k.harness, k.id)!;
      for (const e of d.events) expect((e as StoredEvent).session.delegated_by).toBe(asker.key);
      expect(
        String(d.events[d.events.length - 1]!.data.user ?? d.events.find((e) => e.type === "turn.progress")?.data.user),
      ).toContain("with sessionpipe ask");
    }
  });

  it("reads a handoff as relayed, with the answer brought back as a framed prompt and its message in the activity", () => {
    const parent = sessions.find((s) => s.delegations?.some((d) => d.via === "handoff"))!;
    const d = parent.delegations!.find((x) => x.via === "handoff")!;
    expect(d).toMatchObject({ ok: true, relayed: "delivered", to: expect.stringMatching(/^codex:/) });
    const detail = world.detail(parent.harness, parent.id)!;
    const relayed = detail.events.find(
      (e) => e.type === "turn.transcript" && String(e.data.user).startsWith("Answer from codex:"),
    );
    expect(relayed).toBeDefined();
    expect(String(relayed!.data.user)).toMatch(/\(sessionpipe handoff, asked via [^)]+\):\n\n/);
    const a = world.controlActivity().find((x) => x.replyTo === parent.key)!;
    expect(a).toMatchObject({ kind: "start", session: d.to, from: parent.key, outcome: "delivered" });
    const machine = snap.kind === "snapshot" ? snap.snapshot.machines.find((m) => m.name === "misha-air") : undefined;
    expect(machine?.control).toMatchObject({ ask: true, handoff: true });
  });
});
