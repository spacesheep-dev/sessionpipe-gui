// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The query side against a brute-force scan, plus ranking, snippets,
// transcripts, overlays, forget, browse and the history-over-events rule.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseSearch } from "../../../shared/searchQuery.js";
import type { EngineQuery } from "../types.js";
import { Reader } from "./reader.js";
import { bruteMatch, type GenDoc, randomDocs, rng, VOCAB, writeIndex } from "./testkit.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "spe-reader-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const q = (text: string, over: Partial<EngineQuery> = {}): EngineQuery => ({
  parsed: parseSearch(text, { live: false }),
  sources: ["history", "sessionpipe"],
  sort: "best",
  offset: 0,
  limit: 1000,
  hits: 3,
  ...over,
});

function randomQuery(r: () => number): string {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
  const n = 1 + Math.floor(r() * 3);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = pick(VOCAB);
    const k = r();
    if (k < 0.15) parts.push(`-${w.split(/[/\s]/)[0]}`);
    else if (k < 0.3) parts.push(`"${w} ${pick(VOCAB)}"`);
    else if (k < 0.45 && w.length > 3) parts.push(`${w.slice(0, 3)}*`);
    else parts.push(w);
  }
  return parts.join(" ");
}

describe("Reader vs brute force", () => {
  const { docs, facts } = randomDocs(3, 4000, 120);
  const dead = (_d: GenDoc, i: number) => i % 11 === 5;
  const dirA = tmp();
  writeIndex(dirA, "history", docs, facts, 1);
  const dirB = tmp();
  writeIndex(dirB, "history", docs, facts, 7);
  const dirC = tmp();
  writeIndex(dirC, "history", docs, facts, 5, dead);
  const one = new Reader({ dir: dirA, sources: ["history"] });
  const many = new Reader({ dir: dirB, sources: ["history"] });
  const tomb = new Reader({ dir: dirC, sources: ["history"] });
  const r = rng(99);
  const queries = Array.from({ length: 150 }, () => randomQuery(r));

  it("matches exactly the sessions and docs a scan finds (1 and 7 segments)", { timeout: 120_000 }, () => {
    for (const text of queries) {
      const want = bruteMatch(docs, parseSearch(text));
      for (const rd of [one, many]) {
        const got = rd.search(q(text));
        const keys = new Set(got.matches.map((m) => m.session.key));
        if (parseSearch(text).clauses.some((c) => !c.not))
          expect([text, [...keys].sort()]).toEqual([text, [...want.sessions].sort()]);
        expect(got.total).toBe(got.matches.length);
        for (const m of got.matches) {
          if (!want.docs.has(m.session.key)) continue;
          expect(m.matched).toBe(want.docs.get(m.session.key)!.size);
        }
      }
    }
  });

  it("ranks the same whether the docs sit in one segment or seven", () => {
    for (const text of queries.slice(0, 80)) {
      const a = one.search(q(text));
      const b = many.search(q(text));
      expect(b.matches.map((m) => m.session.key)).toEqual(a.matches.map((m) => m.session.key));
      // equal up to the recency's drift between the two calls (and the 3-decimal rounding)
      b.matches.forEach((m, i) => {
        expect(Math.abs(m.score - a.matches[i]!.score)).toBeLessThanOrEqual(0.0011);
      });
    }
  });

  it("never returns a tombstoned doc", { timeout: 120_000 }, () => {
    for (const text of queries) {
      const want = bruteMatch(docs, parseSearch(text), (d) => !dead(d, docs.indexOf(d)));
      const got = tomb.search(q(text));
      if (parseSearch(text).clauses.some((c) => !c.not))
        expect([text, got.matches.map((m) => m.session.key).sort()]).toEqual([text, [...want.sessions].sort()]);
    }
  });

  it("returns hits in transcript order, at most q.hits, with marks inside the text", () => {
    const res = many.search(q("webhook retry", { hits: 3 }));
    expect(res.matches.length).toBeGreaterThan(0);
    for (const m of res.matches) {
      expect(m.hits.length).toBeLessThanOrEqual(3);
      for (let i = 1; i < m.hits.length; i++) expect(m.hits[i]!.at).toBeGreaterThanOrEqual(m.hits[i - 1]!.at);
      for (const h of m.hits) {
        expect(h.text.length).toBeLessThanOrEqual(160);
        expect(h.ref).toMatch(/^[A-Za-z0-9_-]+$/);
        for (const [s, e] of h.marks) {
          expect(e).toBeGreaterThan(s);
          expect(["webhook", "retry", "webhooks", "retries"]).toContain(h.text.slice(s, e).toLowerCase());
        }
      }
    }
  });

  it("pages with offset/limit over a stable order", () => {
    const all = many.search(q("build", { limit: 1000 }));
    const p1 = many.search(q("build", { limit: 10 }));
    const p2 = many.search(q("build", { offset: 10, limit: 10 }));
    expect(p1.more).toBe(all.total > 10);
    expect([...p1.matches, ...p2.matches].map((m) => m.session.key)).toEqual(
      all.matches.slice(0, 20).map((m) => m.session.key),
    );
  });

  it("reports unknown words", () => {
    const res = many.search(q("build xyzzyplugh"));
    expect(res.total).toBe(0);
    expect(res.unknownWords).toEqual(["xyzzyplugh"]);
  });

  it("browses newest first with the first prompt as the only hit when there is no word", () => {
    const res = many.search(
      q("", {
        parsed: { clauses: [], filters: { agent: ["codex"] }, notFilters: {}, unknown: [] },
        allow: (s) => s.harness === "codex",
      }),
    );
    expect(res.total).toBeGreaterThan(0);
    for (let i = 1; i < res.matches.length; i++)
      expect(res.matches[i - 1]!.session.lastAt).toBeGreaterThanOrEqual(res.matches[i]!.session.lastAt);
    for (const m of res.matches) {
      expect(m.session.harness).toBe("codex");
      expect(m.hits.length).toBeLessThanOrEqual(1);
      if (m.hits[0]) expect(m.hits[0].marks).toEqual([]);
    }
  });

  it("calls allow at most once per session per query", () => {
    const seen = new Map<string, number>();
    const allow = (s: { key: string }) => {
      seen.set(s.key, (seen.get(s.key) ?? 0) + 1);
      return true;
    };
    many.search(q("build server -staging", { allow }));
    expect(Math.max(...seen.values())).toBe(1);
  });
});

describe("ranking", () => {
  const base = Date.now() - 2 * 86_400_000;
  const mk = (s: string, field: GenDoc["field"], text: string, at = base, file = 1): GenDoc => ({
    key: `claude-code:${s}`,
    field,
    text,
    at,
    offset: Math.floor(Math.random() * 1e6),
    file,
  });
  const facts = ["a", "b", "c", "d", "e"].map((s) => ({ key: `claude-code:${s}`, harness: "claude-code", id: s }));

  it("prefers a prompt over a reply over a tool line, and co-occurrence over scattered words", () => {
    const dir = tmp();
    writeIndex(
      dir,
      "history",
      [
        mk("a", "tool", "deploy the staging release now", base, 1),
        mk("b", "reply", "deploy the staging release now", base, 2),
        mk("c", "prompt", "deploy the staging release now", base, 3),
        mk("d", "prompt", "deploy the other box", base, 4),
        mk("d", "prompt", "the staging box is big", base, 4),
        mk("e", "prompt", "nothing to see here", base, 5),
      ],
      facts,
      2,
    );
    const rd = new Reader({ dir, sources: ["history"] });
    const deploy = rd.search(q("deploy")).matches.map((m) => m.session.id);
    expect(deploy.indexOf("c")).toBeLessThan(deploy.indexOf("b"));
    expect(deploy.indexOf("b")).toBeLessThan(deploy.indexOf("a"));
    expect(rd.search(q("deploy staging")).matches.map((m) => m.session.id)).toEqual(["c", "b", "a", "d"]);
    rd.close();
  });

  it("lets a strong title match win, and blends recency as a tie-breaker", () => {
    const dir = tmp();
    const old = Date.now() - 200 * 86_400_000;
    writeIndex(
      dir,
      "history",
      [
        mk("a", "reply", "rate limiter design notes", old, 1),
        mk("b", "reply", "rate limiter design notes", base, 2),
        mk("c", "reply", "unrelated", base, 3),
      ],
      [
        { key: "claude-code:a", harness: "claude-code", id: "a", lastAt: old },
        { key: "claude-code:b", harness: "claude-code", id: "b", lastAt: base },
        {
          key: "claude-code:c",
          harness: "claude-code",
          id: "c",
          title: { text: "Rate limiter rollout", rank: 50 },
          lastAt: base,
        },
      ],
      1,
    );
    const rd = new Reader({ dir, sources: ["history"] });
    const res = rd.search(q("rate limiter"));
    expect(res.matches.map((m) => m.session.id)).toEqual(["c", "b", "a"]);
    expect(res.matches[0]!.titleMarks).toEqual([
      [0, 4],
      [5, 12],
    ]);
    expect(rd.search(q("rate limiter", { fields: ["title"] })).matches.map((m) => m.session.id)).toEqual(["c"]);
    expect(rd.search(q("rate limiter", { fields: ["reply"] })).matches.map((m) => m.session.id)).toEqual(["b", "a"]);
    expect(rd.search(q("rate limiter", { sort: "newest" })).matches.map((m) => m.session.id)[2]).toBe("a");
    rd.close();
  });

  it("finds identifiers, paths, phrases, prefixes and plurals", () => {
    const dir = tmp();
    writeIndex(
      dir,
      "history",
      [
        mk("a", "reply", "call getUserName() from src/store/review.ts", base, 1),
        mk("b", "reply", "the getusername helper", base, 2),
        mk("c", "prompt", "run the tests twice", base, 3),
        mk("d", "prompt", "the store review is in another file", base, 4),
      ],
      facts,
      1,
    );
    const rd = new Reader({ dir, sources: ["history"] });
    const ids = (s: string, live = false) =>
      rd
        .search({ ...q(s), parsed: parseSearch(s, { live }) })
        .matches.map((m) => m.session.id)
        .sort();
    expect(ids("getUserName")).toEqual(["a", "b"]);
    expect(ids("get_user_name")).toEqual(["a"]);
    expect(ids("src/store/review.ts")).toEqual(["a"]);
    expect(ids('"store review"')).toEqual(["a", "d"]);
    expect(ids("review.ts")).toEqual(["a"]);
    expect(ids("test")).toEqual(["c"]);
    expect(ids("revi", true)).toEqual(["a", "d"]);
    expect(ids("store/rev", true)).toEqual(["a", "d"]);
    expect(ids("src/sto", true)).toEqual(["a"]);
    expect(ids("getuser*")).toEqual(["a", "b"]);
    rd.close();
  });
});

describe("transcript, overlay, forget, D6", () => {
  const base = Date.parse("2026-10-20T10:00:00Z");
  const docs: GenDoc[] = Array.from({ length: 150 }, (_, i) => ({
    key: "claude-code:x",
    field: i % 3 === 0 ? "prompt" : i % 3 === 1 ? "reply" : "tool",
    text: i === 77 ? "the needle is here" : `message number ${i}`,
    at: base + i * 1000,
    offset: i * 500,
    file: 1,
  }));
  const evDocs: GenDoc[] = [
    { key: "claude-code:x", field: "prompt", text: "the needle twice needle", at: base, offset: 0, file: 9, seq: 4 },
    {
      key: "codex:y",
      field: "prompt",
      text: "a needle in sessionpipe only",
      at: base + 5000,
      offset: 0,
      file: 10,
      seq: 1,
    },
  ];
  const dir = tmp();
  writeIndex(
    dir,
    "history",
    docs,
    [{ key: "claude-code:x", harness: "claude-code", id: "x", title: { text: "Haystack", rank: 25 } }],
    3,
  );
  writeIndex(dir, "sessionpipe", evDocs, [{ key: "codex:y", harness: "codex", id: "y", machine: "build-box" }], 1);
  const rd = new Reader({ dir, sources: ["history", "sessionpipe"] });

  it("history beats events for the same key; the source filter picks the index", () => {
    const res = rd.search(q("needle"));
    const x = res.matches.find((m) => m.session.key === "claude-code:x")!;
    expect(x.session.sources).toEqual(["history", "sessionpipe"]);
    expect(x.matched).toBe(1);
    expect(x.hits[0]!.text).toBe("the needle is here");
    expect(res.matches.find((m) => m.session.key === "codex:y")!.hits[0]!.seq).toBe(1);
    const ev = rd.search(q("needle", { sources: ["sessionpipe"] }));
    expect(ev.matches.find((m) => m.session.key === "claude-code:x")!.hits[0]!.seq).toBe(4);
    expect(rd.search(q("needle", { sources: ["history"] })).matches.map((m) => m.session.key)).toEqual([
      "claude-code:x",
    ]);
  });

  it("serves a transcript window around a ref and pages before/after", () => {
    const hit = rd.search(q("needle", { sources: ["history"] })).matches[0]!.hits[0]!;
    const w = rd.transcript("claude-code:x", { around: hit.ref, limit: 20 })!;
    expect(w.messages.length).toBe(20);
    expect(w.messages.map((m) => m.text)).toContain("the needle is here");
    expect(w.messages[10]!.text).toBe("the needle is here");
    const prev = rd.transcript("claude-code:x", { before: w.before!, limit: 20 })!;
    expect(prev.messages.at(-1)!.text).toBe("message number 66");
    const next = rd.transcript("claude-code:x", { after: w.after!, limit: 200 })!;
    expect(next.messages[0]!.text).toBe("message number 87");
    expect(next.after).toBeUndefined();
    const first = rd.transcript("claude-code:x", { limit: 5 })!;
    expect(first.messages.map((m) => m.text)[0]).toBe("message number 0");
    expect(first.before).toBeUndefined();
    expect(rd.transcript("claude-code:nope", { limit: 5 })).toBeUndefined();
  });

  it("finds every match of a session for the find bar, with marks into the whole text", () => {
    const hits = rd.hitsIn("claude-code:x", parseSearch("needle"));
    expect(hits.length).toBe(1);
    expect(hits[0]!.marks).toEqual([[4, 10]]);
    const many = rd.hitsIn("claude-code:x", parseSearch("number"));
    expect(many.length).toBe(149);
  });

  it("applies an overlay title at once and forgets a session at once", () => {
    expect(rd.session("claude-code:x")!.title).toBe("Haystack");
    rd.setOverlay("claude-code:x", { title: "Zebra crossing", titleRank: 50, machine: "studio" });
    expect(rd.session("claude-code:x")!.title).toBe("Zebra crossing");
    expect(rd.session("claude-code:x")!.machine).toBe("studio");
    expect(rd.search(q("zebra")).matches.map((m) => m.session.key)).toEqual(["claude-code:x"]);
    expect(rd.search(q("haystack")).total).toBe(0);
    rd.setOverlay("claude-code:x", null);
    expect(rd.search(q("haystack")).total).toBe(1);
    rd.forget("codex:y");
    expect(rd.search(q("needle")).matches.map((m) => m.session.key)).toEqual(["claude-code:x"]);
    expect(rd.session("codex:y")).toBeUndefined();
  });

  it("reports stats", () => {
    const s = rd.stats();
    expect(s.sessions).toBe(1);
    expect(s.messages).toBe(150);
    expect(s.gen).toEqual({ history: 1, sessionpipe: 1 });
    expect(s.bytes).toBeGreaterThan(0);
  });
});

describe("a damaged segment", () => {
  it("is left out; the rest of the index still answers", async () => {
    const { writeFileSync } = await import("node:fs");
    const dir = tmp();
    const docs: GenDoc[] = [
      { key: "claude-code:a", field: "prompt", text: "alpha words", at: 1, offset: 0, file: 1 },
      { key: "claude-code:b", field: "prompt", text: "bravo words", at: 2, offset: 0, file: 2 },
    ];
    const m = writeIndex(dir, "history", docs, [], 2);
    writeFileSync(join(dir, "history", m.segments[0]!.name), "garbage");
    const rd = new Reader({ dir, sources: ["history"] });
    expect(rd.search(q("words")).matches.map((x) => x.session.key)).toEqual(["claude-code:b"]);
    rd.close();
  });
});
