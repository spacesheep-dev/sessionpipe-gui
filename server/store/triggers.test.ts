// SPDX-License-Identifier: Apache-2.0
// The trigger reading (shared/api.ts SessionSummary.triggeredBy / triggeredFrom): the name
// of the rule a machine's daemon started or resumed a run for (sessionpipe CONTROL.md
// §14.9), and how that run began. The run is the newest unbroken stretch, in seq order, of
// events carrying one name; the word is that stretch's own first session.started. It is a
// function of the events in their own order and of nothing else: every order of arrival,
// a rebuild and a restart read the same.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ProtocolEvent, type ProtocolSession, sessionKey } from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { Rng } from "../demo/rng.js";
import { eventProblem } from "../receiver/validate.js";
import { SESSION_SHARED, slimEvent } from "./slim.js";
import { Store } from "./store.js";
import { newTriggerTrack, noteTrigger, type TriggerTrack, triggerReading } from "./triggers.js";

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

const read = (id: string) => store.session(sessionKey("claude-code", id))!;
const reading = (id: string) => {
  const s = read(id);
  return s.triggeredBy === undefined ? null : { by: s.triggeredBy, from: s.triggeredFrom };
};
const by = (name: string) => ({ session: { triggered_by: name } });
const restart = async () => {
  await store.close();
  store = new Store(tmp.dir, { tickMs: 60_000, statsMs: 60_000 });
};

/** What the machine writes into a session on its own, not the run's hooks (triggers.ts
 *  MACHINE_WRITES), each with data the receiver takes. */
const MACHINE = {
  "limits.observed": { windows: [{ id: "five_hour", used_percent: 41 }] },
  "delegation.started": { ask_id: "01JDELEGATION0000000000001", via: "ask", harness: "codex" },
  "delegation.ended": { ask_id: "01JDELEGATION0000000000001", ok: true, ms: 4200 },
  "session.backfill": { started_at: "2026-11-25T07:00:00.000Z", last_at: "2026-11-25T07:20:00.000Z" },
} as const;
type MachineType = keyof typeof MACHINE;

/** One event of a fixture: its seq, the rule it names (or none) and, for a start, its source;
 *  `machine`, one the machine writes on its own. */
interface Spec {
  seq: number;
  name?: string;
  start?: string;
  machine?: MachineType;
}
const events = (id: string, specs: Spec[], tier: (seq: number) => 1 | 3 = () => 3): ProtocolEvent[] => {
  const s = new Session(id);
  return specs.map((x) =>
    s.ev(
      x.start !== undefined ? "session.started" : (x.machine ?? "turn.started"),
      x.start !== undefined ? { source: x.start } : x.machine ? { ...MACHINE[x.machine] } : {},
      {
        seq: x.seq,
        tier: tier(x.seq),
        ...(x.name ? by(x.name) : {}),
      },
    ),
  );
};

/** What the reading must say, worked out the plain way: the events in seq order but what
 *  the machine wrote on its own with no name, the last one that names a rule, the stretch
 *  of that name around it, its first start. */
function oracle(specs: Spec[]): { by: string; from: string } | null {
  const list = specs.filter((x) => !(x.machine && !x.name)).sort((a, b) => a.seq - b.seq);
  let top = -1;
  for (let i = 0; i < list.length; i++) if (list[i]!.name) top = i;
  if (top < 0) return null;
  const name = list[top]!.name!;
  let lo = top;
  while (lo > 0 && list[lo - 1]!.name === name) lo--;
  // A session.started with an empty source is the run's first start all the same.
  const first = list.slice(lo, top + 1).find((x) => x.start !== undefined);
  const from = first?.start === "startup" ? "start" : first?.start === "resume" ? "continue" : "unknown";
  return { by: name, from };
}

/** Every order of `list` (a fixture of a few events). */
function orders<T>(list: T[]): T[][] {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest]));
}

/** The reading of `specs` read one event at a time in `order` (indexes into specs), and
 *  again once the lowest-seq event is read a second time at a higher tier, upgraded in
 *  place: the store then rebuilds the session from its records. */
async function readThrough(id: string, specs: Spec[], order: number[]) {
  const low = Math.min(...specs.map((x) => x.seq));
  const evs = events(id, specs, (seq) => (seq === low ? 1 : 3));
  for (const i of order) store.ingest([evs[i]!], "http");
  const live = reading(id);
  const before = read(id);
  const up = evs[specs.findIndex((x) => x.seq === low)]!;
  store.ingest([{ ...up, tier: 3 }], "outbox");
  // The upgrade rebuilt the session from its records: a summary of its own.
  expect(read(id), "rebuilt").not.toBe(before);
  const rebuilt = reading(id);
  return { live, rebuilt };
}

describe("triggered_by on the wire", () => {
  it("is taken by the receiver as sent and filed whole: no pinned schema refuses or strips it", () => {
    const s = new Session("wire");
    const ev = s.ev("session.started", { source: "startup" }, by("card-todo"));
    expect(eventProblem(ev)).toBeNull();
    store.ingest([ev], "http");
    const detail = store.sessionDetail(sessionKey("claude-code", "wire"))!;
    expect(detail.events[0]!.session.triggered_by).toBe("card-todo");
  });

  it("keeps a rule's name only in the protocol's shape", () => {
    const names = ["card-todo", "0", "a_b-9", "x".repeat(40), "9lives"];
    for (const [i, name] of names.entries()) {
      store.ingest([new Session(`ok-${i}`).ev("session.started", { source: "startup" }, by(name))], "http");
      expect(reading(`ok-${i}`), name).toEqual({ by: name, from: "start" });
    }
    const bad = ["Card-Todo", "x".repeat(41), "card todo", "card:todo", "-card", "_card", " card-todo", "", "café"];
    for (const [i, name] of bad.entries()) {
      store.ingest([new Session(`bad-${i}`).ev("session.started", { source: "startup" }, by(name))], "http");
      expect(reading(`bad-${i}`), name).toBeNull();
    }
    const odd = new Session("odd");
    store.ingest([odd.ev("session.started", {}, { session: { triggered_by: 7 as unknown as string } })], "http");
    expect(reading("odd")).toBeNull();
  });

  it("reads a bad name as no name: it ends the rule's stretch, and the rule stays the newest; never a launcher", () => {
    const s = new Session("then-bad");
    store.ingest([s.ev("session.started", { source: "startup" }, by("card-todo"))], "http");
    store.ingest([s.ev("turn.started", {}, by("Card:TODO"))], "http");
    expect(reading("then-bad")).toEqual({ by: "card-todo", from: "start" });
    expect(read("then-bad").launchedBy).toBeUndefined();
    expect(read("then-bad").delegatedBy).toBeUndefined();
  });
});

describe("the word: from the run's own first session.started", () => {
  it("says started for a run that opens on a startup, and a person's later turns leave it", () => {
    const s = new Session("started");
    store.ingest([s.ev("session.started", { source: "startup" }, by("card-todo"))], "http");
    store.ingest([s.ev("turn.started", { turn_id: "t1" }, by("card-todo"))], "http");
    expect(reading("started")).toEqual({ by: "card-todo", from: "start" });
    store.ingest([s.ev("session.started", { source: "resume" }), s.ev("turn.started", { turn_id: "t2" })], "http");
    expect(reading("started")).toEqual({ by: "card-todo", from: "start" });
  });

  it("says continued for a run that opens on a resume, after a person's run or a backfill", () => {
    const s = new Session("continued");
    store.ingest([s.ev("session.started", { source: "startup" }), s.ev("turn.started", { turn_id: "t1" })], "http");
    expect(reading("continued")).toBeNull();
    store.ingest([s.ev("session.started", { source: "resume" }, by("monday-report"))], "http");
    expect(reading("continued")).toEqual({ by: "monday-report", from: "continue" });
    const b = new Session("backfilled");
    store.ingest([b.ev("session.backfill", { turns: 3 })], "outbox");
    store.ingest([b.ev("session.started", { source: "resume" }, by("monday-report"))], "http");
    expect(reading("backfilled")).toEqual({ by: "monday-report", from: "continue" });
  });

  it("says continued for a resume that is the first thing read here, never started", () => {
    // A receiver that joined late, or an outbox that pruned the session's beginning.
    const s = new Session("joined-late");
    store.ingest([s.ev("session.started", { source: "resume" }, { seq: 50, ...by("monday-report") })], "http");
    expect(reading("joined-late")).toEqual({ by: "monday-report", from: "continue" });
  });

  it("says it does not know for a run with no start read, or one that opens on another source", () => {
    const s = new Session("no-start");
    store.ingest([s.ev("turn.started", {}, { seq: 7, ...by("card-todo") })], "http");
    expect(reading("no-start")).toEqual({ by: "card-todo", from: "unknown" });
    for (const source of ["compact", "clear", "fork", "unknown", ""]) {
      const t = new Session(`src-${source || "none"}`);
      store.ingest([t.ev("session.started", { source }, by("card-todo"))], "http");
      expect(reading(`src-${source || "none"}`), source).toEqual({ by: "card-todo", from: "unknown" });
    }
    // A compaction inside a run that opened on a startup is not where it began.
    const c = new Session("compacted");
    store.ingest(
      [
        c.ev("session.started", { source: "startup" }, by("card-todo")),
        c.ev("session.started", { source: "compact" }, by("card-todo")),
      ],
      "http",
    );
    expect(reading("compacted")).toEqual({ by: "card-todo", from: "start" });
    // The start arrives after the compaction: from then on the reading knows how it began.
    const d = new Session("compact-first");
    const start = d.ev("session.started", { source: "startup" }, by("card-todo"));
    const compact = d.ev("session.started", { source: "compact" }, by("card-todo"));
    store.ingest([compact], "http");
    expect(reading("compact-first")).toEqual({ by: "card-todo", from: "unknown" });
    store.ingest([start], "http");
    expect(reading("compact-first")).toEqual({ by: "card-todo", from: "start" });
  });
});

describe("the run: the newest unbroken stretch, in seq order", () => {
  it("A@0 A@1 B@2 A@3: the run at 3 continued the session, in every order of arrival", async () => {
    const specs: Spec[] = [
      { seq: 0, name: "aaa", start: "startup" },
      { seq: 1, name: "aaa" },
      { seq: 2, name: "bbb", start: "resume" },
      { seq: 3, name: "aaa", start: "resume" },
    ];
    expect(oracle(specs)).toEqual({ by: "aaa", from: "continue" });
    const all = orders([0, 1, 2, 3]);
    for (const [n, order] of all.entries()) {
      const got = await readThrough(`aba-${n}`, specs, order);
      expect(got, order.join(",")).toEqual({ live: oracle(specs), rebuilt: oracle(specs) });
    }
    await restart();
    for (let n = 0; n < all.length; n++) expect(reading(`aba-${n}`), `boot ${n}`).toEqual(oracle(specs));
  });

  it("A@5, then an unmarked event @3, then A@0: the run at 5 is a run of its own, a resume", async () => {
    const specs: Spec[] = [
      { seq: 5, name: "aaa", start: "resume" },
      { seq: 3 },
      { seq: 0, name: "aaa", start: "startup" },
    ];
    expect(oracle(specs)).toEqual({ by: "aaa", from: "continue" });
    const evs = events("flip", specs);
    for (const ev of evs) {
      store.ingest([ev], "http");
      expect(reading("flip"), `after seq ${ev.session.seq}`).toEqual({ by: "aaa", from: "continue" });
    }
    await restart();
    expect(reading("flip")).toEqual({ by: "aaa", from: "continue" });
  });

  it("two rules taking turns: the newest names the rule, its own start the word", async () => {
    const specs: Spec[] = [
      { seq: 0, name: "card-todo", start: "startup" },
      { seq: 1, name: "card-todo" },
      { seq: 2, name: "monday-report", start: "resume" },
      { seq: 3, name: "monday-report" },
      { seq: 4, name: "card-todo", start: "resume" },
    ];
    expect(oracle(specs)).toEqual({ by: "card-todo", from: "continue" });
    const some = [
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
      [2, 0, 4, 1, 3],
      [0, 4, 1, 3, 2],
    ];
    for (const [n, order] of some.entries())
      expect(await readThrough(`alt-${n}`, specs, order), order.join(",")).toEqual({
        live: oracle(specs),
        rebuilt: oracle(specs),
      });
    await restart();
    for (let n = 0; n < some.length; n++) expect(reading(`alt-${n}`)).toEqual(oracle(specs));
  });

  it("a person resuming after the rule's run leaves the rule and its word, in every order", async () => {
    const specs: Spec[] = [
      { seq: 0, name: "card-todo", start: "startup" },
      { seq: 1, name: "card-todo" },
      { seq: 2, start: "resume" },
      { seq: 3 },
    ];
    expect(oracle(specs)).toEqual({ by: "card-todo", from: "start" });
    for (const [n, order] of orders([0, 1, 2, 3]).entries())
      expect(await readThrough(`person-${n}`, specs, order), order.join(",")).toEqual({
        live: oracle(specs),
        rebuilt: oracle(specs),
      });
  });

  it("reads the same live, after a rebuild and after a restart, for any events in any order", async () => {
    const rng = new Rng(20261125);
    const names = ["aaa", "bbb", undefined] as const;
    const sources = ["startup", "resume", "compact", "", undefined, undefined, undefined, undefined] as const;
    const machine = [...Object.keys(MACHINE), undefined, undefined, undefined, undefined] as (
      | MachineType
      | undefined
    )[];
    const cases: { id: string; specs: Spec[] }[] = [];
    for (let c = 0; c < 150; c++) {
      const n = rng.int(1, 9);
      // Seqs with holes, as a sink that joined late or a batch still on its way leaves them.
      const seqs = new Set<number>();
      while (seqs.size < n) seqs.add(rng.int(0, 14));
      const specs = [...seqs].map((seq): Spec => {
        const start = rng.pick(sources);
        return { seq, name: rng.pick(names), start, machine: start === undefined ? rng.pick(machine) : undefined };
      });
      const order = specs.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      const id = `prop-${c}`;
      const want = oracle(specs);
      expect(await readThrough(id, specs, order), `${JSON.stringify(specs)} in ${order.join(",")}`).toEqual({
        live: want,
        rebuilt: want,
      });
      cases.push({ id, specs });
    }
    await restart();
    for (const { id, specs } of cases) expect(reading(id), `boot ${JSON.stringify(specs)}`).toEqual(oracle(specs));
  });

  it("keeps the field in the index's slim copy, which a boot and a rebuild read from", () => {
    const a = new Session("slim");
    const ev = a.ev("turn.ended", {}, by("card-todo"));
    expect(slimEvent({ ...ev, arrivedAt: ev.time, source: "http" }).session.triggered_by).toBe("card-todo");
  });

  it("shares the name in the slim copy as every short string of the session block is", () => {
    // Every field of the block, so one added to ProtocolSession is added here too: each
    // string but the session's own id and link is one every event repeats.
    const block: Required<ProtocolSession> = {
      id: "s",
      seq: 0,
      machine: "m",
      cwd: "~/c",
      repo: "r",
      branch: "b",
      model: "o",
      title: "t",
      title_source: "custom",
      url: "https://example.test/s",
      account_id: "a",
      attended: false,
      parent_id: "p",
      launched_by: "claude-code:l",
      delegated_by: "codex:d",
      triggered_by: "card-todo",
    };
    const strings = Object.keys(block).filter(
      (k) => k !== "id" && k !== "url" && typeof block[k as keyof ProtocolSession] === "string",
    );
    expect([...SESSION_SHARED].sort()).toEqual(strings.sort());
  });
});

describe("what the machine writes into a rule's run on its own", () => {
  // The pool's numbers for a request the run made, an ask the run made (the daemon writes
  // delegation.* on the asking session) and a backfill sent again: no hook writes them, so
  // they carry no name, with seqs between the run's own.
  for (const machine of Object.keys(MACHINE) as MachineType[])
    it(`${machine} with no name inside the run leaves the rule and its word, in every order`, async () => {
      const specs: Spec[] = [
        { seq: 0, name: "card-todo", start: "startup" },
        { seq: 1, name: "card-todo" },
        { seq: 2, name: "card-todo" },
        { seq: 3, machine },
        { seq: 4, name: "card-todo" },
      ];
      expect(oracle(specs)).toEqual({ by: "card-todo", from: "start" });
      const all = orders([0, 1, 2, 3, 4]);
      for (const [n, order] of all.entries())
        expect(await readThrough(`${machine}-${n}`, specs, order), order.join(",")).toEqual({
          live: { by: "card-todo", from: "start" },
          rebuilt: { by: "card-todo", from: "start" },
        });
      await restart();
      for (let n = 0; n < all.length; n++)
        expect(reading(`${machine}-${n}`)).toEqual({ by: "card-todo", from: "start" });
    });

  it("one that carries a name is read as any event", () => {
    const s = new Session("named-pool");
    store.ingest([s.ev("session.started", { source: "resume" }, by("monday-report"))], "http");
    store.ingest([s.ev("limits.observed", { ...MACHINE["limits.observed"] }, by("card-todo"))], "http");
    expect(reading("named-pool")).toEqual({ by: "card-todo", from: "unknown" });
  });

  it("the person's own events still end the rule's run around it, and a later rule's run is its own", () => {
    const s = new Session("then-person");
    store.ingest(
      [
        s.ev("session.started", { source: "startup" }, by("card-todo")),
        s.ev("turn.started", {}, by("card-todo")),
        s.ev("delegation.ended", { ...MACHINE["delegation.ended"] }),
        s.ev("session.started", { source: "resume" }),
        s.ev("limits.observed", { ...MACHINE["limits.observed"] }),
        s.ev("session.started", { source: "resume" }, by("card-todo")),
      ],
      "http",
    );
    expect(reading("then-person")).toEqual({ by: "card-todo", from: "continue" });
  });
});

describe("the reading itself: every order, every prefix", () => {
  /** The reading of `specs` read one at a time in `order`, through the store's own filter
   *  (triggers.ts noteTrigger), checked against the oracle after every event read. */
  function direct(specs: Spec[], order: number[]): string | null {
    const t = newTriggerTrack();
    const read: Spec[] = [];
    for (const i of order) {
      const x = specs[i]!;
      noteTrigger(t, {
        type: x.start !== undefined ? "session.started" : (x.machine ?? "turn.started"),
        session: { seq: x.seq, ...(x.name ? { triggered_by: x.name } : {}) },
        data: x.start !== undefined ? { source: x.start } : {},
      });
      read.push(x);
      const r = triggerReading(t);
      const got = r ? { by: r.name, from: r.from } : null;
      const want = oracle(read);
      if (JSON.stringify(got) !== JSON.stringify(want))
        return `${JSON.stringify(read)}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`;
    }
    return null;
  }

  it("two starts in one stretch, the earlier read last: the earlier is how the run began", async () => {
    // A@0, then A@4 resume, then A@2 startup: the stretch 0..4 began at its startup.
    const specs: Spec[] = [
      { seq: 0, name: "aaa" },
      { seq: 4, name: "aaa", start: "resume" },
      { seq: 2, name: "aaa", start: "startup" },
    ];
    expect(oracle(specs)).toEqual({ by: "aaa", from: "start" });
    expect(await readThrough("two-starts", specs, [0, 1, 2])).toEqual({ live: oracle(specs), rebuilt: oracle(specs) });
    for (const order of orders([0, 1, 2])) expect(direct(specs, order), order.join(",")).toBeNull();
  });

  it("a stretch split where seqs were never read keeps to the seqs read", async () => {
    // null@8 resume, null@20 startup, bbb@14 resume, bbb@10 compact: bbb's stretch is
    // 10..14 and began on a compaction, so how it began is not known.
    const specs: Spec[] = [
      { seq: 8, start: "resume" },
      { seq: 20, start: "startup" },
      { seq: 14, name: "bbb", start: "resume" },
      { seq: 10, name: "bbb", start: "compact" },
    ];
    expect(oracle(specs)).toEqual({ by: "bbb", from: "unknown" });
    expect(await readThrough("split-gaps", specs, [0, 1, 2, 3])).toEqual({
      live: oracle(specs),
      rebuilt: oracle(specs),
    });
    for (const order of orders([0, 1, 2, 3])) expect(direct(specs, order), order.join(",")).toBeNull();
  });

  it("an event that is no start copies no stretch's starts", () => {
    const tool = (t: TriggerTrack, seq: number) =>
      noteTrigger(t, { type: "tool.started", session: { seq, triggered_by: "aaa" }, data: {} });
    const started = (t: TriggerTrack, seq: number, source: string) =>
      noteTrigger(t, { type: "session.started", session: { seq, triggered_by: "aaa" }, data: { source } });
    // Extended at its newest end, seq after seq.
    const up = newTriggerTrack();
    started(up, 0, "startup");
    const upStarts = up.stretches[0]!.starts;
    for (let seq = 1; seq < 50; seq++) tool(up, seq);
    expect(up.stretches).toHaveLength(1);
    expect(up.stretches[0]!.starts).toBe(upStarts);
    expect(upStarts).toEqual([{ seq: 0, source: "startup" }]);
    // Extended at its oldest end, read newest first; then a start there is put first, in place.
    const down = newTriggerTrack();
    started(down, 50, "resume");
    const downStarts = down.stretches[0]!.starts;
    for (let seq = 49; seq > 0; seq--) tool(down, seq);
    expect(down.stretches).toHaveLength(1);
    expect(down.stretches[0]!.starts).toBe(downStarts);
    expect(downStarts).toEqual([{ seq: 50, source: "resume" }]);
    started(down, 0, "startup");
    expect(down.stretches).toHaveLength(1);
    expect(down.stretches[0]!.starts).toBe(downStarts);
    expect(downStarts).toEqual([
      { seq: 0, source: "startup" },
      { seq: 50, source: "resume" },
    ]);
    expect(triggerReading(down)).toEqual({ name: "aaa", from: "start" });
    // Filled in from inside: its first and last read, then what lies between, in any order.
    const inside = newTriggerTrack();
    started(inside, 0, "startup");
    tool(inside, 50);
    const insideStarts = inside.stretches[0]!.starts;
    for (const seq of [25, 1, 49, 12, 37, 2, 48]) tool(inside, seq);
    expect(inside.stretches).toHaveLength(1);
    expect(inside.stretches[0]!.starts).toBe(insideStarts);
    expect(insideStarts).toEqual([{ seq: 0, source: "startup" }]);
  });

  it("matches the oracle after every event of 20 000 generated sessions read in shuffled orders", () => {
    const rng = new Rng(20261126);
    const names = ["aaa", "bbb", undefined] as const;
    const sources = ["startup", "resume", "compact", "", undefined, undefined, undefined, undefined] as const;
    const machine = [...Object.keys(MACHINE), undefined, undefined, undefined, undefined] as (
      | MachineType
      | undefined
    )[];
    const wrong: string[] = [];
    for (let c = 0; c < 20_000 && wrong.length < 5; c++) {
      const n = rng.int(1, 14);
      const seqs = new Set<number>();
      while (seqs.size < n) seqs.add(rng.int(0, 24));
      const specs = [...seqs].map((seq): Spec => {
        const start = rng.pick(sources);
        return { seq, name: rng.pick(names), start, machine: start === undefined ? rng.pick(machine) : undefined };
      });
      const order = specs.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      const bad = direct(specs, order);
      if (bad) wrong.push(bad);
    }
    expect(wrong).toEqual([]);
  });
});
