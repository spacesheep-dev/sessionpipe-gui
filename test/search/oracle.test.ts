// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. The oracle's own rules (SEARCH-SPEC.md §3.2), so that when the engine
// is compared against it, the reference itself is known to be right.
import { describe, expect, it } from "vitest";
import {
  foldTerm,
  fromDocs,
  type OracleDoc,
  type OracleFacts,
  oracleTokens,
  snippet,
} from "../../server/search/oracle.js";
import type { EngineQuery, SearchSource } from "../../server/search/types.js";
import { parseSearch } from "../../shared/searchQuery.js";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const DAY = 86_400_000;

const terms = (s: string): string[] => oracleTokens(s).map((t) => (t.whole ? `=${t.term}` : t.term));

function q(text: string, extra: Partial<EngineQuery> = {}): EngineQuery {
  return {
    parsed: parseSearch(text),
    sources: ["history", "sessionpipe"],
    sort: "best",
    offset: 0,
    limit: 50,
    hits: 3,
    ...extra,
  };
}
const live = (text: string, extra: Partial<EngineQuery> = {}): EngineQuery =>
  q(text, { ...extra, parsed: parseSearch(text, { live: true }) });

let off = 0;
const doc = (key: string, field: OracleDoc["field"], text: string, extra: Partial<OracleDoc> = {}): OracleDoc => ({
  key,
  field,
  text,
  at: NOW - DAY + off * 1000,
  offset: off++ * 100,
  ...extra,
});
const facts = (key: string, extra: Partial<OracleFacts> = {}): OracleFacts => {
  const [harness, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  return { key, harness: harness!, id: id!, ...extra };
};
const keys = (r: { matches: { session: { key: string } }[] }): string[] => r.matches.map((m) => m.session.key).sort();

describe("oracle tokenizer", () => {
  it("splits identifiers, keeps digits, joins the whole", () => {
    expect(terms("getUserName")).toEqual(["get", "user", "name", "=getusername"]);
    expect(terms("get_user_name")).toEqual(["get", "user", "name", "=get_user_name"]);
    expect(terms("base64Encode ship🚀it")).toEqual(["base64", "encode", "=base64encode", "ship", "it"]);
    expect(terms("HTTPServer sha256 utf8 v8")).toEqual(["http", "server", "=httpserver", "sha256", "utf8", "v8"]);
    expect(terms("_private")).toEqual(["private"]);
    expect(terms("src/store/review.ts")).toEqual(["src", "store", "review", "ts"]);
    expect(oracleTokens("a getUserName").find((t) => t.whole)?.pos).toBe(1);
  });
  it("folds case and diacritics", () => {
    expect(terms("Café Größe naïve façade")).toEqual(["cafe", "grosse", "naive", "facade"]);
    expect(foldTerm("ÉCOLE")).toBe("ecole");
    expect(terms("Ошибка сборки")).toEqual(["ошибка", "сборки"]);
  });
  it("one CJK character per token, at consecutive positions", () => {
    const t = oracleTokens("検索インデックス ok");
    // Kana keep their voicing (デ stays デ) and Hangul syllables stay whole.
    expect(t.map((x) => x.term)).toEqual(["検", "索", "イ", "ン", "デ", "ッ", "ク", "ス", "ok"]);
    expect(oracleTokens("한국어").map((x) => x.term)).toEqual(["한", "국", "어"]);
    expect(t.map((x) => x.pos)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("drops long runs and long parts", () => {
    expect(terms(`a ${"x".repeat(201)} b`)).toEqual(["a", "b"]);
    expect(terms(`a ${"y".repeat(41)}Z b`)).toEqual(["a", "z", "b"]);
  });
  it("offsets point into the original text", () => {
    const s = "Fix the Größe bug in getUserName";
    for (const t of oracleTokens(s)) expect(foldTerm(s.slice(t.start, t.end))).toBe(t.term);
  });
});

describe("oracle matching", () => {
  const A = "claude-code:aaaa";
  const B2 = "codex:bbbb";
  const C = "claude-code:cccc";
  const r = fromDocs(
    [
      doc(A, "prompt", "Please fix the webhook retry in src/store/review.ts"),
      doc(A, "reply", "The rate limiter returns 409 when the webhook retries too fast."),
      doc(A, "tool", "Bash pnpm test", { tool: "Bash" }),
      doc(B2, "prompt", "deploy to staging, then call getUserName"),
      doc(B2, "reply", "Deployed. The rate is fine; limiter untouched."),
      doc(C, "prompt", "検索インデックスの更新 and café"),
      doc(C, "reply", "Subagent says hello", { agent: "a1", agentType: "Explore" }),
    ],
    [facts(A, { title: { text: "Webhook retries", rank: 25 }, cwd: "/x/app" }), facts(B2), facts(C)],
    { now: () => NOW },
  );

  it("ANDs words at the session level, plural variants included", () => {
    expect(keys(r.search(q("webhook retry")))).toEqual([A]);
    expect(keys(r.search(q("rate limiter")))).toEqual([A, B2].sort());
    expect(keys(r.search(q("retries")))).toEqual([A]); // a plural of "retry"? no: "retries" itself
    expect(keys(r.search(q("webhooks")))).toEqual([A]); // -s variant
  });
  it("phrases need consecutive positions", () => {
    expect(keys(r.search(q('"rate limiter"')))).toEqual([A]);
    expect(keys(r.search(q('"limiter rate"')))).toEqual([]);
  });
  it("paths and identifiers are phrases of their parts", () => {
    expect(keys(r.search(q("src/store/review.ts")))).toEqual([A]);
    expect(keys(r.search(q("review.ts")))).toEqual([A]);
    expect(keys(r.search(q("getUserName")))).toEqual([B2]);
    expect(keys(r.search(q("getusername")))).toEqual([B2]);
    expect(keys(r.search(q("get_user_name")))).toEqual([B2]);
    expect(keys(r.search(q("user")))).toEqual([B2]);
  });
  it("negation drops a session that has it anywhere", () => {
    expect(keys(r.search(q("rate -staging")))).toEqual([A]);
    expect(keys(r.search(q("rate -webhook")))).toEqual([B2]);
    expect(keys(r.search(q('rate -"rate limiter"')))).toEqual([B2]);
  });
  it("prefixes: typed and live", () => {
    expect(keys(r.search(q("webh*")))).toEqual([A]);
    expect(keys(r.search(live("deplo")))).toEqual([B2]);
    expect(keys(r.search(live("rate lim")))).toEqual([A, B2].sort());
    expect(keys(r.search(live("getUs")))).toEqual([B2]);
  });
  it("CJK and diacritics", () => {
    expect(keys(r.search(q("検索")))).toEqual([C]);
    expect(keys(r.search(q("Cafe")))).toEqual([C]);
    expect(keys(r.search(q("CAFÉ")))).toEqual([C]);
  });
  it("titles answer clauses and carry marks", () => {
    const res = r.search(q("webhook"));
    expect(res.matches[0]!.titleMarks).toEqual([[0, 7]]);
    expect(keys(r.search(q("webhook", { fields: ["title"] })))).toEqual([A]);
    expect(keys(r.search(q("retries", { fields: ["title"] })))).toEqual([A]);
    expect(keys(r.search(q("deploy", { fields: ["title"] })))).toEqual([]);
  });
  it("fields restrict every clause", () => {
    expect(keys(r.search(q("pnpm", { fields: ["tool"] })))).toEqual([A]);
    expect(keys(r.search(q("pnpm", { fields: ["prompt"] })))).toEqual([]);
    expect(keys(r.search(q("rate -limiter", { fields: ["prompt", "reply"] })))).toEqual([]);
  });
  it("hits: in transcript order, marks over the matched words", () => {
    const m = r.search(q("webhook")).matches[0]!;
    expect(m.matched).toBe(2);
    expect(m.hits.map((h) => h.field)).toEqual(["prompt", "reply"]);
    for (const h of m.hits) for (const [s, e] of h.marks) expect(h.text.slice(s, e).toLowerCase()).toContain("webhook");
    expect(r.search(q("webhook", { hits: 1 })).matches[0]!.hits).toHaveLength(1);
    expect(r.search(q("webhook", { hits: 0 })).matches[0]!.hits).toHaveLength(0);
  });
  it("subagent hits carry the agent", () => {
    const h = r.search(q("hello")).matches[0]!.hits[0]!;
    expect(h.agent).toBe("a1");
    expect(h.agentType).toBe("Explore");
  });
  it("browse: filters only, newest first, first prompt unmarked", () => {
    const res = r.search(q("agent:codex"));
    expect(res.matches.map((m) => m.session.key)).toEqual([C, B2, A]);
    expect(res.matches[0]!.hits[0]!.marks).toEqual([]);
    expect(res.matches[0]!.hits[0]!.field).toBe("prompt");
    expect(keys(r.search(q("-webhook")))).toEqual([B2, C].sort());
    expect(r.search(q("")).matches).toEqual([]);
    expect(r.search(q("!!!")).matches).toEqual([]);
  });
  it("allow is asked at most once per session", () => {
    const res = r.search(q("rate", { allow: (s) => s.harness === "codex" }));
    expect(keys(res)).toEqual([B2]);
    for (const n of r.allowCalls.values()) expect(n).toBe(1);
  });
  it("unknown words", () => {
    expect(r.search(q("webhook zzzqx")).unknownWords).toEqual(["zzzqx"]);
    expect(r.search(q("webhooks")).unknownWords).toEqual([]);
  });
  it("paging: total, more, offset", () => {
    const all = r.search(q("agent:x", { limit: 2 }));
    expect(all.total).toBe(3);
    expect(all.more).toBe(true);
    const p2 = r.search(q("agent:x", { limit: 2, offset: 2 }));
    expect(p2.matches).toHaveLength(1);
    expect(p2.more).toBe(false);
  });
  it("refs are URL-safe and unique", () => {
    const seen = new Set<string>();
    for (const s of r.sessions())
      for (const m of r.transcript(s.key, { limit: 100 })!.messages) {
        expect(m.ref).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(seen.has(m.ref)).toBe(false);
        seen.add(m.ref);
      }
  });
});

describe("oracle sources, overlay, forget, transcript", () => {
  const K = "claude-code:dup";
  const E = "codex:events-only";
  const mk = (sources?: readonly SearchSource[]) =>
    fromDocs(
      [
        doc(K, "prompt", "history words alpha", { file: "/h/dup.jsonl" }),
        doc(K, "prompt", "events words alpha beta", { seq: 1 }),
        doc(E, "prompt", "events only alpha", { seq: 4 }),
      ],
      [facts(K, { source: "history", title: { text: "From history", rank: 25 } }), facts(K, { machine: "box" })],
      { now: () => NOW, sources },
    );

  it("history beats events for the same key (D6)", () => {
    const r = mk();
    expect(keys(r.search(q("beta")))).toEqual([]);
    expect(keys(r.search(q("alpha")))).toEqual([E, K].sort());
    expect(r.session(K)!.messages).toBe(1);
    expect(r.session(K)!.sources).toEqual(["history", "sessionpipe"]);
    // Reading sessionpipe only: the events docs answer.
    expect(keys(r.search(q("beta", { sources: ["sessionpipe"] })))).toEqual([K]);
  });
  it("history off: only events", () => {
    const r = mk(["sessionpipe"]);
    expect(keys(r.search(q("beta")))).toEqual([K]);
    expect(r.session(K)!.title).toBeUndefined();
  });
  it("overlay title wins at an equal or higher rank; forget hides", () => {
    const r = mk();
    expect(r.session(K)!.title).toBe("From history");
    r.setOverlay(K, { title: "Renamed by store", titleRank: 50, machine: "studio" });
    expect(r.session(K)!.title).toBe("Renamed by store");
    expect(r.session(K)!.machine).toBe("studio");
    expect(keys(r.search(q("renamed")))).toEqual([K]);
    r.setOverlay(K, { title: "weak", titleRank: 10 });
    expect(r.session(K)!.title).toBe("From history");
    r.forget(K);
    expect(r.session(K)).toBeUndefined();
    expect(keys(r.search(q("alpha")))).toEqual([E]);
  });
  it("transcript windows and hitsIn", () => {
    const S = "claude-code:long";
    const docs = Array.from({ length: 25 }, (_, i) =>
      doc(S, i % 2 ? "reply" : "prompt", `message ${i} ${i % 5 === 0 ? "needle" : ""}`),
    );
    const r = fromDocs(docs, [], { now: () => NOW });
    const all = r.transcript(S, { limit: 100 })!.messages;
    expect(all.map((m) => m.text)).toEqual(docs.map((d) => d.text));
    const mid = r.transcript(S, { around: all[12]!.ref, limit: 5 })!;
    expect(mid.messages.map((m) => m.ref)).toEqual(all.slice(10, 15).map((m) => m.ref));
    expect(mid.before).toBe(all[10]!.ref);
    expect(mid.after).toBe(all[14]!.ref);
    const next = r.transcript(S, { after: mid.after!, limit: 5 })!;
    expect(next.messages[0]!.ref).toBe(all[15]!.ref);
    const prev = r.transcript(S, { before: mid.before!, limit: 5 })!;
    expect(prev.messages.map((m) => m.ref)).toEqual(all.slice(5, 10).map((m) => m.ref));
    expect(r.transcript(S, { limit: 5 })!.before).toBeUndefined();
    expect(r.transcript("x:none", { limit: 5 })).toBeUndefined();
    const hits = r.hitsIn(S, parseSearch("needle"));
    expect(hits.map((h) => h.ref)).toEqual([0, 5, 10, 15, 20].map((i) => all[i]!.ref));
    const t = all[5]!.text;
    expect(t.slice(hits[1]!.marks[0]![0], hits[1]!.marks[0]![1])).toBe("needle");
  });
  it("sort newest orders by last activity", () => {
    const r = fromDocs(
      [doc("a:1", "prompt", "same", { at: NOW - 5 * DAY }), doc("a:2", "prompt", "same same same", { at: NOW - DAY })],
      [],
      { now: () => NOW },
    );
    expect(r.search(q("same", { sort: "newest" })).matches.map((m) => m.session.key)).toEqual(["a:2", "a:1"]);
  });
});

describe("snippet", () => {
  it("windows long text around the marks, folds whitespace, marks stay on the word", () => {
    const words = Array.from({ length: 200 }, (_, i) => `w${i}`);
    words[150] = "needle";
    const text = words.join("  \n ");
    const at = text.indexOf("needle");
    const s = snippet(text, [[at, at + 6]], 160);
    expect(s.text.length).toBeLessThanOrEqual(160);
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.text).not.toMatch(/\s\s/);
    expect(s.text.slice(s.marks[0]![0], s.marks[0]![1])).toBe("needle");
  });
  it("short text is returned whole", () => {
    expect(snippet("a  b", [], 160)).toEqual({ text: "a b", marks: [] });
  });
});
