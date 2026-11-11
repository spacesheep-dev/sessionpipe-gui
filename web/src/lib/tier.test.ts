// SPDX-License-Identifier: Apache-2.0
// The tier lens keeps what a receiver at that tier gets from the client, key for key, for
// the types it filters by key: atTier against sessionpipe-core's own filterEvent.
import type { StoredEvent, Tier } from "@shared/api";
import { filterEvent } from "sessionpipe-core";
import { describe, expect, it } from "vitest";
import { atTier } from "./tier";

/** Every data key the protocol names for each type the lens filters by key, at tier 3, plus
 *  `agent_type`, which none of these types carries, so a lens that keeps a stray key fails. */
const FULL: Record<string, Record<string, unknown>> = {
  "turn.started": { turn_id: "t1", submitted_by: "user", injected: true, prompt_chars: 12, agent_type: "x" },
  "turn.ended": { turn_id: "t1", reason: "error", ms: 900, background: 2, error: "overloaded", agent_type: "x" },
  "tool.started": {
    tool: "Bash",
    call_id: "c1",
    turn_id: "t1",
    agent_id: "a1",
    agent_type: "x",
    input: { command: "ls" },
  },
  "tool.ended": {
    tool: "Bash",
    call_id: "c1",
    turn_id: "t1",
    agent_id: "a1",
    agent_type: "x",
    ms: 40,
    ok: false,
    error: "exit 1",
    input: { command: "ls" },
    output: "nope",
  },
  "attention.needed": {
    attention_id: "p1",
    kind: "permission",
    tool: "Bash",
    message: "Allow ls?",
    agent_id: "a1",
    turn_id: "t1",
    call_id: "c1",
    agent_type: "x",
  },
};

/** Keys the spec (PROTOCOL.md §4) and sessionpipe-core 0.13.1+ carry that the installed
 *  core 0.10 does not yet: `agent_id` on attention.needed from tier 1. Merged as a set, so
 *  this stays true once core sends them too. */
const NEWER: Record<string, Partial<Record<Tier, string[]>>> = {
  "attention.needed": { 1: ["agent_id"], 2: ["agent_id"] },
};

function ev(type: string): StoredEvent {
  return {
    protocol: 1,
    id: `e-${type}`,
    type,
    time: "2026-11-07T10:00:00.000Z",
    tier: 3,
    harness: { name: "claude-code" },
    session: { id: "s1", seq: 1, machine: "devbox", cwd: "/work/acme/app" },
    data: { ...FULL[type] },
  } as StoredEvent;
}

const keys = (d: Record<string, unknown> | undefined) => Object.keys(d ?? {}).sort();

describe("atTier", () => {
  for (const lens of [0, 1, 2] as Tier[]) {
    for (const type of Object.keys(FULL)) {
      it(`${type} at lens ${lens} keeps what core sends a tier-${lens} sink`, () => {
        const e = ev(type);
        const core = filterEvent(e as never, lens, false) as { data: Record<string, unknown> } | null;
        const gui = atTier(e, lens);
        if (core === null) {
          expect(gui).toBeNull();
          return;
        }
        expect(gui).not.toBeNull();
        expect(gui!.tier).toBe(lens);
        const want = [...new Set([...keys(core.data), ...(NEWER[type]?.[lens] ?? [])])].sort();
        expect(keys(gui!.data)).toEqual(want);
      });
    }
  }

  it("leaves an event at or under the lens as it is", () => {
    const e = { ...ev("turn.started"), tier: 0 as Tier };
    expect(atTier(e, 1)).toBe(e);
  });
});
