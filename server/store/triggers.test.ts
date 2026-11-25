// SPDX-License-Identifier: Apache-2.0
// The trigger reading (shared/api.ts SessionSummary.triggeredBy / triggeredFrom): the name
// of the rule a machine's daemon started or resumed a run for (sessionpipe CONTROL.md
// §14.9), and how that run began. The run is the newest unbroken stretch, in seq order, of
// events carrying one name; the word is that stretch's own first session.started. It is a
// function of the events in their own order and of nothing else: every order of arrival,
// a rebuild and a restart read the same.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ProtocolEvent, sessionKey } from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { Rng } from "../demo/rng.js";
import { eventProblem } from "../receiver/validate.js";
import { slimEvent } from "./slim.js";
import { Store } from "./store.js";

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

/** One event of a fixture: its seq, the rule it names (or none) and, for a start, its source. */
interface Spec {
  seq: number;
  name?: string;
  start?: string;
}
const events = (id: string, specs: Spec[], tier: (seq: number) => 1 | 3 = () => 3): ProtocolEvent[] => {
  const s = new Session(id);
  return specs.map((x) =>
    s.ev(x.start ? "session.started" : "turn.started", x.start ? { source: x.start } : {}, {
      seq: x.seq,
      tier: tier(x.seq),
      ...(x.name ? by(x.name) : {}),
    }),
  );
};

/** What the reading must say, worked out the plain way: the events in seq order, the last
 *  one that names a rule, the stretch of that name around it, its first start. */
function oracle(specs: Spec[]): { by: string; from: string } | null {
  const list = [...specs].sort((a, b) => a.seq - b.seq);
  let top = -1;
  for (let i = 0; i < list.length; i++) if (list[i]!.name) top = i;
  if (top < 0) return null;
  const name = list[top]!.name!;
  let lo = top;
  while (lo > 0 && list[lo - 1]!.name === name) lo--;
  const first = list.slice(lo, top + 1).find((x) => x.start);
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
  const up = evs[specs.findIndex((x) => x.seq === low)]!;
  store.ingest([{ ...up, tier: 3 }], "outbox");
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
    const sources = ["startup", "resume", "compact", undefined, undefined, undefined] as const;
    const cases: { id: string; specs: Spec[] }[] = [];
    for (let c = 0; c < 150; c++) {
      const n = rng.int(1, 9);
      // Seqs with holes, as a sink that joined late or a batch still on its way leaves them.
      const seqs = new Set<number>();
      while (seqs.size < n) seqs.add(rng.int(0, 14));
      const specs = [...seqs].map((seq) => ({ seq, name: rng.pick(names), start: rng.pick(sources) }));
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
});
