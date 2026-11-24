// SPDX-License-Identifier: Apache-2.0
// The search reader that runs in the page (mock mode, and a page on a spacesheep account),
// over sessions handed to it: what a query finds, how it is marked, and what a row says.
import type { Labels, SearchIndexStatus } from "@shared/api";
import { describe, expect, it } from "vitest";
import { eventDocs, pageSearch, type Sess } from "./inPage";

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const at = (min: number) => T0 + min * 60_000;

const sessions = (): Sess[] => [
  {
    harness: "claude-code",
    id: "aaaa1111",
    source: "sessionpipe",
    title: "Fix the invoice webhook",
    machine: "lab-mac",
    repo: "acme/billing",
    cwd: "/home/me/billing",
    docs: [
      {
        field: "prompt",
        text: "The invoice webhook retries forever on a 409. Find the retry loop.",
        at: at(0),
        seq: 1,
      },
      { field: "tool", tool: "Read", text: "Read src/webhooks/retry.ts", at: at(1), seq: 2 },
      { field: "reply", text: "The retry loop never checks for a conflict, so it retries.", at: at(2), seq: 3 },
    ],
  },
  {
    harness: "codex",
    id: "bbbb2222",
    source: "sessionpipe",
    title: "",
    machine: "attic-linux",
    repo: "acme/web",
    cwd: "/srv/web",
    docs: [
      { field: "prompt", text: "Add a login test for the refund page.", at: at(60), seq: 1 },
      { field: "reply", text: "Added the test; the refund page logs in first.", at: at(61), seq: 2 },
    ],
  },
];

const client = (labels: Labels = { rev: 0, names: {}, sessions: {} }) => {
  const status = (): SearchIndexStatus => ({
    state: "ready",
    sessions: 2,
    messages: 5,
    bytes: 0,
    history: false,
    sources: [],
    local: false,
  });
  return pageSearch({ all: sessions, status, labels: () => labels, here: "", listeners: new Set() });
};

describe("the search reader in the page", () => {
  it("finds a word where it is, marks it, and says the session it is in", async () => {
    const page = await client().sessions({ q: "webhook" });
    expect(page.sessions.map((s) => s.key)).toEqual(["claude-code:aaaa1111"]);
    const m = page.sessions[0]!;
    expect(m).toMatchObject({ title: "Fix the invoice webhook", machine: "lab-mac", thisMachine: false });
    expect(m.titleMarks).toEqual([[16, 23]]);
    const hit = m.hits[0]!;
    expect(hit).toMatchObject({ field: "prompt", seq: 1 });
    for (const [a, b] of hit.marks) expect(hit.text.slice(a, b).toLowerCase()).toContain("webhook");
    expect(page.index.state).toBe("ready");
  });

  it("reads a phrase, a prefix while typing, an exclusion and a filter", async () => {
    const c = client();
    expect((await c.sessions({ q: '"retry loop"' })).sessions.map((s) => s.id)).toEqual(["aaaa1111"]);
    expect((await c.sessions({ q: "refu", live: true })).sessions.map((s) => s.id)).toEqual(["bbbb2222"]);
    expect((await c.sessions({ q: "refu" })).sessions).toEqual([]);
    expect((await c.sessions({ q: "test -login" })).sessions).toEqual([]);
    expect((await c.sessions({ q: "agent:codex" })).sessions.map((s) => s.id)).toEqual(["bbbb2222"]);
    expect((await c.sessions({ q: "repo:billing retry" })).sessions.map((s) => s.id)).toEqual(["aaaa1111"]);
    expect((await c.sessions({ q: "machine:attic-linux" })).sessions.map((s) => s.id)).toEqual(["bbbb2222"]);
    // `machine:this` means no machine where the page runs on none of them.
    expect((await c.sessions({ q: "machine:this" })).sessions).toEqual([]);
  });

  it("handles in: and -in: field restrictions, empty field sets, and browse prompts consistently", async () => {
    const c = client();
    // Contradictory in: clauses search no field (not even titles) and offer to drop filters.
    const empty = await c.sessions({ q: "webhook in:prompt -in:prompt" });
    expect(empty.sessions).toEqual([]);
    expect(empty.hint).toEqual({ kind: "filters", query: "webhook" });
    expect((await c.sessions({ q: "retry in:prompt -in:prompt" })).sessions).toEqual([]);
    // -in:prompt excludes prompts while keeping replies, tools, and titles.
    const noPrompt = await c.sessions({ q: "retry -in:prompt" });
    expect(noPrompt.sessions.map((s) => s.id)).toEqual(["aaaa1111"]);
    expect(noPrompt.sessions[0]!.hits.map((h) => h.field)).toEqual(["tool", "reply"]);
    const titleAndTool = await c.sessions({ q: "webhook -in:prompt" });
    expect(titleAndTool.sessions.map((s) => s.id)).toEqual(["aaaa1111"]);
    expect(titleAndTool.sessions[0]!.titleMarks).toEqual([[16, 23]]);
    expect(titleAndTool.sessions[0]!.hits.map((h) => h.field)).toEqual(["tool"]);
    const titleOnlyMatch = await c.sessions({ q: "invoice -in:prompt" });
    expect(titleOnlyMatch.sessions.map((s) => s.id)).toEqual(["aaaa1111"]);
    expect(titleOnlyMatch.sessions[0]!.titleMarks).toEqual([[8, 15]]);
    expect(titleOnlyMatch.sessions[0]!.hits).toEqual([]);
    // Title matches do not satisfy a query whose in: excludes "title".
    expect((await c.sessions({ q: "webhook in:reply" })).sessions).toEqual([]);
    // A browse query with an in: filter that leaves out prompts attaches no prompt hit.
    const browseReply = await c.sessions({ q: "agent:codex in:reply" });
    expect(browseReply.sessions.map((s) => s.id)).toEqual(["bbbb2222"]);
    expect(browseReply.sessions[0]!.hits).toEqual([]);
  });

  it("leaves out a date that does not read, also when it is excluded", async () => {
    const c = client();
    const ids = async (q: string) => (await c.sessions({ q: `${q} the` })).sessions.map((s) => s.id).sort();
    // 2026-11-31 is not a day: it was read as Dec 1, and `-until:` of it hid every session.
    expect(await ids("since:2026-11-31")).toEqual(["aaaa1111", "bbbb2222"]);
    expect(await ids("-until:2026-11-31")).toEqual(["aaaa1111", "bbbb2222"]);
    expect(await ids("-since:2026-13-01")).toEqual(["aaaa1111", "bbbb2222"]);
    expect(await ids("-until:2026-11-30")).toEqual([]);
    expect(await ids("since:2026-11-11")).toEqual([]);
  });

  it("with nothing found says the first thing that would help", async () => {
    const c = client();
    expect((await c.sessions({ q: "agent:codex webhook" })).hint).toMatchObject({ kind: "filters", query: "webhook" });
    expect((await c.sessions({ q: "zzzz" })).hint).toEqual({ kind: "none" });
  });

  it("a session with no title is never shown by its id", async () => {
    const m = (await client().sessions({ q: "login" })).sessions[0]!;
    expect(m.title).toBe("Untitled session");
  });

  it("filters by the person's own labels, by colour or by the name they gave it", async () => {
    const c = client({ rev: 1, names: { red: "Urgent" }, sessions: { "codex:bbbb2222": "red" } });
    expect((await c.sessions({ q: "label:red" })).sessions.map((s) => s.id)).toEqual(["bbbb2222"]);
    expect((await c.sessions({ q: "label:urgent" })).sessions.map((s) => s.id)).toEqual(["bbbb2222"]);
    expect((await c.facets()).labels).toEqual([{ value: "red", count: 1, label: "Urgent" }]);
  });

  it("gives a session's transcript with every hit of the query in it", async () => {
    const t = await client().transcript("claude-code", "aaaa1111", { q: "retry" });
    expect(t.messages.map((m) => m.field)).toEqual(["prompt", "tool", "reply"]);
    expect(t.hits.map((h) => h.ref)).toEqual(t.messages.map((m) => m.ref));
    await expect(client().transcript("codex", "nope", {})).rejects.toThrow("not_found");
  });

  it("reads of an event its prompt, its reply and the tool it ended", () => {
    const base = { time: new Date(T0).toISOString(), session: { id: "s", seq: 7 } };
    expect(eventDocs({ ...base, type: "turn.transcript", data: { user: "hello", assistant: "hi" } })).toEqual([
      { field: "prompt", text: "hello", at: T0, seq: 7 },
      { field: "reply", text: "hi", at: T0, seq: 7 },
    ]);
    expect(eventDocs({ ...base, type: "tool.ended", data: { tool: "Bash", input: { command: "ls -la" } } })).toEqual([
      { field: "tool", tool: "Bash", text: "Bash ls -la", at: T0, seq: 7 },
    ]);
    expect(eventDocs({ ...base, type: "tool.started", data: { tool: "Bash" } })).toEqual([]);
  });
});
