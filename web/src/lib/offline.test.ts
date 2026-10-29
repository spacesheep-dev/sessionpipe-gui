// SPDX-License-Identifier: Apache-2.0
// The board's offline line: which paired machines it names, and hiding it until it changes.
import type { MachineSummary, SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { ackKey, acknowledge, heldLine, offlineMachines, offlineWords, pruneAcks, unacknowledged } from "./offline";

const POLL = "2026-10-28T14:02:00.000Z";

const machine = (name: string, control?: Partial<NonNullable<MachineSummary["control"]>>): MachineSummary => ({
  name,
  lastAt: POLL,
  harnesses: {},
  sessions: 0,
  working: 0,
  needsYou: 0,
  ...(control && {
    control: { machineId: `m_${name}`, online: false, lastPollAt: POLL, keys: [], queued: 0, ...control },
  }),
});

const session = (machine: string, state: SessionSummary["state"]) =>
  ({ key: `claude-code/${machine}-${state}`, machine, state }) as SessionSummary;

describe("offlineMachines", () => {
  it("leaves out event-only machines, online ones, and offline ones with nothing waiting or running", () => {
    const sessions = [session("laptop", "working"), session("build-box", "idle"), session("old-mac", "done")];
    expect(offlineMachines([machine("laptop")], sessions)).toEqual([]);
    expect(offlineMachines([machine("studio", { online: true, queued: 3 })], [session("studio", "working")])).toEqual(
      [],
    );
    expect(offlineMachines([machine("build-box", {}), machine("old-mac", {})], sessions)).toEqual([]);
  });

  it("names one with a message waiting, or a session that needs you, works or went stale", () => {
    expect(offlineMachines([machine("build-box", { queued: 2 })], [])).toEqual([
      { name: "build-box", lastPollAt: POLL, queued: 2 },
    ]);
    for (const st of ["working", "needs_you", "stale"] as const)
      expect(offlineMachines([machine("build-box", {})], [session("build-box", st)]).map((m) => m.name)).toEqual([
        "build-box",
      ]);
  });

  it("considers only the board's machine when the filter names one", () => {
    const both = [machine("build-box", { queued: 1 }), machine("render", { queued: 1 })];
    expect(offlineMachines(both, []).map((m) => m.name)).toEqual(["build-box", "render"]);
    expect(offlineMachines(both, [], "render").map((m) => m.name)).toEqual(["render"]);
    expect(offlineMachines(both, [], "laptop")).toEqual([]);
  });
});

describe("hiding the line until it changes", () => {
  const sessions = [session("build-box", "working")];
  /** One look at the board: prune, then what the line would show. */
  const look = (machines: MachineSummary[], seen: string[]) => {
    const kept = pruneAcks(seen, machines);
    return { kept, shown: unacknowledged(offlineMachines(machines, sessions), kept) };
  };

  it("shows a drop, hides it once dismissed, and brings back the next drop", () => {
    let seen: string[] = [];
    expect(look([machine("build-box", { online: true })], seen).shown).toEqual([]);

    const dropped = [machine("build-box", { lastPollAt: POLL })];
    const first = look(dropped, seen);
    expect(first.shown.map((m) => m.name)).toEqual(["build-box"]);

    seen = acknowledge(first.kept, first.shown);
    expect(seen).toEqual([ackKey({ name: "build-box", lastPollAt: POLL })]);
    expect(look(dropped, seen).shown).toEqual([]);
    // The same drop, seen again later: still hidden.
    seen = look(dropped, seen).kept;
    expect(look(dropped, seen).shown).toEqual([]);

    // Back online: its key goes, and the line has nothing to say.
    const back = look([machine("build-box", { online: true, lastPollAt: "2026-10-28T14:30:00.000Z" })], seen);
    expect(back.kept).toEqual([]);
    expect(back.shown).toEqual([]);
    seen = back.kept;

    // Dropped again, with a newer last poll: shown again.
    const again = look([machine("build-box", { lastPollAt: "2026-10-28T14:31:00.000Z" })], seen);
    expect(again.shown.map((m) => m.name)).toEqual(["build-box"]);
  });

  it("a new last poll alone is a new drop, even if no reconnect was seen", () => {
    const seen = acknowledge([], [{ name: "build-box", lastPollAt: POLL, queued: 0 }]);
    const later = look([machine("build-box", { lastPollAt: "2026-10-28T15:00:00.000Z" })], seen);
    expect(later.kept).toEqual([]);
    expect(later.shown.map((m) => m.name)).toEqual(["build-box"]);
  });

  it("prunes the keys of machines no longer offline, forgotten or never paired, and keeps the rest", () => {
    const seen = [
      ackKey({ name: "build-box", lastPollAt: POLL }),
      ackKey({ name: "studio", lastPollAt: POLL }),
      ackKey({ name: "gone", lastPollAt: POLL }),
      ackKey({ name: "laptop" }),
    ];
    const kept = pruneAcks(seen, [machine("build-box", {}), machine("studio", { online: true }), machine("laptop")]);
    expect(kept).toEqual([ackKey({ name: "build-box", lastPollAt: POLL })]);
  });

  it("holds still while the board does: no line appears or clears under the hand, but × still hides it", () => {
    const drop = offlineMachines([machine("build-box", { queued: 2 })], []);
    // Dropped while the pointer rests on a row: nothing above the rows appears yet.
    expect(heldLine([], drop, [], true)).toEqual([]);
    expect(heldLine([], drop, [], false)).toEqual(drop);
    // Back while held: the line stays until the board lets go.
    expect(heldLine(drop, [], [], true)).toEqual(drop);
    expect(heldLine(drop, [], [], false)).toEqual([]);
    // Dismissed by the person's own hand: gone at once, held or not.
    expect(heldLine(drop, drop, acknowledge([], drop), true)).toEqual([]);
  });

  it("hides every machine the line named at once, and only those", () => {
    const shown = [
      { name: "build-box", lastPollAt: POLL, queued: 1 },
      { name: "render", queued: 0 },
    ];
    const seen = acknowledge([], shown);
    expect(unacknowledged(shown, seen)).toEqual([]);
    expect(unacknowledged([{ name: "render", lastPollAt: POLL, queued: 0 }], seen)).toHaveLength(1);
  });
});

describe("offlineWords", () => {
  it("names one machine, when it was last heard, and what waits for it", () => {
    expect(offlineWords([{ name: "build-box", queued: 0 }])).toBe("build-box is offline.");
    expect(offlineWords([{ name: "build-box", queued: 1 }])).toBe(
      "build-box is offline. 1 message waits until it's back.",
    );
    expect(offlineWords([{ name: "build-box", queued: 2 }])).toBe(
      "build-box is offline. 2 messages wait until it's back.",
    );
    const at = new Date(POLL);
    const hm = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(offlineWords([{ name: "build-box", lastPollAt: POLL, queued: 0 }], at.getTime() + 60_000)).toBe(
      `build-box is offline, last heard ${hm}.`,
    );
    const day = at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    expect(offlineWords([{ name: "build-box", lastPollAt: POLL, queued: 0 }], at.getTime() + 3 * 86_400_000)).toBe(
      `build-box is offline, last heard ${day} ${hm}.`,
    );
  });

  it("counts several machines and the messages waiting for all of them", () => {
    const two = [
      { name: "build-box", queued: 2 },
      { name: "render", queued: 1 },
    ];
    expect(offlineWords(two)).toBe("2 machines are offline. 3 messages wait until they're back.");
    expect(offlineWords(two.map((m) => ({ ...m, queued: 0 })))).toBe("2 machines are offline.");
    expect(offlineWords([{ ...two[0]!, queued: 0 }, two[1]!])).toBe(
      "2 machines are offline. 1 message waits until they're back.",
    );
  });
});
