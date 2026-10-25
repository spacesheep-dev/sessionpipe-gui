// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOC_TEXT_MAX, TITLE_RANK } from "../types.js";
import { claudeAdapter, parseClaudePath } from "./claude.js";
import { Collect, fixtureHome, readAll, testEnv } from "./testkit.js";

const A = "claude-code:a0000000-0000-4000-8000-000000000001";
const F = "claude-code:a0000000-0000-4000-8000-000000000002";
const WK = "claude-code:b0000000-0000-4000-8000-000000000003";
const SLUG = "-Users-dev-acme-api";

let fx: ReturnType<typeof fixtureHome>;
beforeEach(() => {
  fx = fixtureHome();
});
afterEach(() => fx.done());

describe("claude discover", () => {
  it("finds every home's sessions and subagents, largest copy wins, never memory or tool results", async () => {
    const files = await claudeAdapter().discover(testEnv(fx.home, fx.state));
    const rel = files.map((f) => path.relative(fx.home, f.path)).sort();
    expect(rel).toEqual([
      `.claude-work/projects/-Users-dev-acme-web/b0000000-0000-4000-8000-000000000003.jsonl`,
      `.claude/projects/${SLUG}/a0000000-0000-4000-8000-000000000001.jsonl`,
      `.claude/projects/${SLUG}/a0000000-0000-4000-8000-000000000001/subagents/agent-a1b2c3.jsonl`,
      `.claude/projects/${SLUG}/a0000000-0000-4000-8000-000000000001/subagents/workflows/wf_01/agent-d4e5f6.jsonl`,
      `.claude/projects/${SLUG}/a0000000-0000-4000-8000-000000000002.jsonl`,
    ]);
    expect(files.every((f) => f.kind === "append" && f.adapter === "claude")).toBe(true);
    expect(files.filter((f) => f.path.includes("subagents")).map((f) => f.key)).toEqual([A, A]);
  });

  it("is an empty list for a home with no Claude", async () => {
    const files = await claudeAdapter().discover(testEnv(path.join(fx.home, "nowhere"), fx.state));
    expect(files).toEqual([]);
  });

  it("picks up CLAUDE_CONFIG_DIR outside the home", async () => {
    const env = testEnv(path.join(fx.home, ".gemini"), fx.state, {
      CLAUDE_CONFIG_DIR: path.join(fx.home, ".claude-work"),
    });
    const files = await claudeAdapter().discover(env);
    expect(files.map((f) => f.key).sort()).toEqual([A, WK]);
  });

  it("parses paths", () => {
    expect(parseClaudePath("/h/.claude/projects/s/x.jsonl")).toMatchObject({ id: "x", home: "/h/.claude" });
    expect(parseClaudePath("/h/.claude/projects/s/x/subagents/workflows/w/agent-ab.jsonl")).toMatchObject({
      id: "x",
      agentId: "ab",
    });
    expect(parseClaudePath("/h/.claude/projects/s/x/tool-results/a.jsonl")).toBeUndefined();
  });
});

describe("claude read", () => {
  it("indexes prompts, replies and tool lines — never tool output, thinking, payloads or notices", async () => {
    const sink = new Collect();
    await readAll(claudeAdapter(), testEnv(fx.home, fx.state), sink);
    const all = sink.docs.map((d) => d.text).join("\n");
    expect(all).not.toMatch(/never_indexed|never indexed/i);
    const a = sink.docs.filter((d) => d.key === A && !d.agent);
    const prompts = a.filter((d) => d.field === "prompt").map((d) => d.text);
    expect(prompts).toEqual([
      "The webhook retries return 409 on duplicate deliveries. Find out why.",
      "Now make the retry use a fresh delivery id",
      "/review src/webhooks",
      expect.stringContaining("Here is the staging config"),
      "also check the dead letter queue",
      "Paste:  what is this?",
    ]);
    const replies = a.filter((d) => d.field === "reply").map((d) => d.text);
    expect(replies).toEqual([
      "Looking at the idempotency middleware first.",
      "Fixed: the retry now mints a fresh delivery id, so the 409 is gone.",
    ]);
    const tools = a.filter((d) => d.field === "tool").map((d) => [d.tool, d.text]);
    expect(tools).toEqual([
      ["Bash", "Bash rg -n idempotencyKey src/"],
      ["Edit", "Edit src/webhooks/retry.ts"],
      ["Pasted", "Pasted stack trace line one\nat retry (retry.ts:40)"],
      ["mcp__github__search_issues", "mcp__github__search_issues 409 duplicate delivery repo:acme/api"],
      ["TodoWrite", "TodoWrite Add delivery id; Write the test"],
      ["Agent", "Agent Explore retry paths"],
    ]);
  });

  it("redacts secrets and drops image placeholders", async () => {
    const sink = new Collect();
    await readAll(claudeAdapter(), testEnv(fx.home, fx.state), sink);
    const t = sink.texts(A).find((x) => x.includes("staging config"))!;
    expect(t).not.toContain("Tr0ub4dor");
    expect(t).toContain("[redacted]");
    expect(t).not.toContain("[Image #1]");
  });

  it("offsets are the byte of each record's line; a partial last line waits", async () => {
    const env = testEnv(fx.home, fx.state);
    const files = await claudeAdapter().discover(env);
    const main = files.find((f) => f.key === A && !f.path.includes("subagents"))!;
    const sink = new Collect();
    const r = await claudeAdapter().read(main, { offset: 0 }, sink);
    const bytes = readFileSync(main.path);
    expect(r.offset).toBe(bytes.lastIndexOf(10) + 1);
    expect(r.offset).toBeLessThan(main.size);
    expect(r.bad).toBeUndefined(); // "{not json" never passes the prefilter, so it is never parsed
    for (const d of sink.docs) {
      expect(d.offset === 0 || bytes[d.offset - 1] === 10).toBe(true);
      expect(bytes.toString("utf8", d.offset, d.offset + 1)).toBe("{");
    }
    expect(sink.texts().join()).not.toContain("partial line waits");
    // The rest of the line arrives: the next read starts where the last stopped.
    appendFileSync(main.path, "\n");
    const more = new Collect();
    const r2 = await claudeAdapter().read(main, { offset: r.offset, state: r.state }, more);
    expect(more.texts()).toEqual(["partial line waits"]);
    expect(r2.offset).toBe(statSync(main.path).size);
  });

  it("honours endOffset and maxBytes on whole lines", async () => {
    const env = testEnv(fx.home, fx.state);
    const files = await claudeAdapter().discover(env);
    const main = files.find((f) => f.key === A && !f.path.includes("subagents"))!;
    const full = new Collect();
    const r = await claudeAdapter().read(main, { offset: 0 }, full);
    const half = new Collect();
    const h = await claudeAdapter().read(main, { offset: 0 }, half, { endOffset: Math.floor(r.offset / 2) });
    expect(h.offset).toBeLessThanOrEqual(Math.floor(r.offset / 2));
    expect(half.docs.length).toBeLessThan(full.docs.length);
    // Sliced reads add up to the same docs.
    const sliced = new Collect();
    let cur = { offset: 0 } as { offset: number; state?: never };
    for (let i = 0; i < 1000 && cur.offset < r.offset; i++) {
      const x = await claudeAdapter().read(main, cur, sliced, { maxBytes: 200 });
      cur = { offset: x.offset, state: x.state as never };
    }
    expect(sliced.docs.map((d) => [d.offset, d.text])).toEqual(full.docs.map((d) => [d.offset, d.text]));
  });

  it("folds titles by rank, keeps the first cwd for resume, and the repo from a PR link", async () => {
    const sink = new Collect();
    await readAll(claudeAdapter(), testEnv(fx.home, fx.state), sink);
    const a = sink.folded(A);
    expect(a.title).toEqual({ text: "Fix webhook 409s", rank: TITLE_RANK.custom });
    expect(a).toMatchObject({
      harness: "claude-code",
      id: "a0000000-0000-4000-8000-000000000001",
      cwd: "/Users/dev/acme/api",
      branch: "main",
      repo: "acme/api",
      model: "claude-opus-4",
      resume: { argv: ["claude", "--resume", "a0000000-0000-4000-8000-000000000001"], cwd: "/Users/dev/acme/api" },
      firstAt: Date.parse("2026-10-01T09:00:00.000Z"),
    });
    expect(a.lastAt).toBeGreaterThanOrEqual(Date.parse("2026-10-01T09:21:00.000Z")); // subagent activity
    expect(a.account).toBeUndefined();
    expect(a.machine).toBeUndefined();
    expect(a.path?.endsWith("a0000000-0000-4000-8000-000000000001.jsonl")).toBe(true);
  });

  it("labels a non-default home and resumes it with CLAUDE_CONFIG_DIR", async () => {
    const sink = new Collect();
    await readAll(claudeAdapter(), testEnv(fx.home, fx.state), sink);
    const w = sink.folded(WK);
    expect(w.account).toBe("work");
    expect(w.title).toEqual({ text: "Dark mode toggle flickers on first paint", rank: TITLE_RANK.firstAsk });
    expect(w.resume).toEqual({
      argv: ["claude", "--resume", "b0000000-0000-4000-8000-000000000003"],
      cwd: "/Users/dev/acme/web",
      env: { CLAUDE_CONFIG_DIR: path.join(fx.home, ".claude-work") },
    });
  });

  it("joins subagents to the parent with agent id and type", async () => {
    const sink = new Collect();
    await readAll(claudeAdapter(), testEnv(fx.home, fx.state), sink);
    const sub = sink.docs.filter((d) => d.agent);
    expect(sub.map((d) => [d.key, d.agent, d.agentType, d.field, d.text])).toEqual([
      [A, "a1b2c3", "Explore", "prompt", "Map every retry path in src/webhooks and report back"],
      [A, "a1b2c3", "Explore", "tool", "Grep scheduleRetry"],
      [A, "a1b2c3", "Explore", "reply", "Three retry paths: scheduleRetry, backoffQueue and the cron sweeper."],
      [A, "d4e5f6", undefined, "prompt", "Write the regression test for duplicate deliveries"],
      [A, "d4e5f6", undefined, "reply", "Regression test added: duplicateDelivery.spec.ts"],
    ]);
    // A subagent never names the session.
    expect(sink.got.filter((f) => f.title && f.key === A).map((f) => f.title?.text)).not.toContain(
      "Map every retry path in src/webhooks and report back",
    );
  });

  it("a fork indexes only its own records and names the session it continues", async () => {
    const sink = new Collect();
    await readAll(claudeAdapter(), testEnv(fx.home, fx.state), sink);
    expect(sink.texts(F)).toEqual(["Fork: try the outbox pattern instead", "Outbox pattern drafted in the fork."]);
    expect(sink.folded(F).forkOf).toBe(A);
    expect(sink.folded(A).forkOf).toBeUndefined();
    expect(sink.folded(F).firstAt).toBe(Date.parse("2026-10-02T10:00:00.000Z"));
  });

  it("older sidechain records inside the main file are the subagent's, never the person's", async () => {
    const p = path.join(fx.home, ".claude/projects/-old/c0000000-0000-4000-8000-0000000000bb.jsonl");
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(
      p,
      [
        {
          type: "user",
          uuid: "1",
          isSidechain: true,
          cwd: "/w",
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "subagent task text" },
        },
        {
          type: "user",
          uuid: "2",
          isSidechain: false,
          cwd: "/w",
          timestamp: "2026-01-01T00:00:01Z",
          message: { content: "the person asks" },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")
        .concat("\n"),
    );
    const sink = new Collect();
    await readAll(claudeAdapter(), testEnv(fx.home, fx.state), sink);
    const key = "claude-code:c0000000-0000-4000-8000-0000000000bb";
    expect(sink.docs.filter((d) => d.key === key).map((d) => [d.agent, d.text])).toEqual([
      ["sidechain", "subagent task text"],
      [undefined, "the person asks"],
    ]);
    expect(sink.folded(key).title?.text).toBe("the person asks");
  });

  it("cuts a huge prompt to DOC_TEXT_MAX on a word and never throws on junk", async () => {
    const env = testEnv(fx.home, fx.state);
    const p = path.join(fx.home, ".claude/projects/-x/c0000000-0000-4000-8000-0000000000aa.jsonl");
    mkdirSync(path.dirname(p), { recursive: true });
    const big = "word ".repeat(20_000);
    writeFileSync(
      p,
      [
        JSON.stringify({ type: "user", uuid: "1", timestamp: "2026-10-01T00:00:00Z", message: { content: big } }),
        "[1,2,3]",
        '{"type":"user","message":',
        "\u0000\u0001garbage",
        JSON.stringify({ type: "user", uuid: "2", message: { content: 42 } }),
        JSON.stringify({ type: "assistant", uuid: "3", message: { content: "not a list" } }),
        "",
      ].join("\n"),
    );
    const sink = new Collect();
    const r = await readAll(claudeAdapter(), env, sink);
    const docs = sink.docs.filter((d) => d.key.endsWith("aa"));
    expect(docs).toHaveLength(1);
    expect(docs[0]!.text.length).toBeLessThanOrEqual(DOC_TEXT_MAX);
    expect(docs[0]!.text.endsWith("word")).toBe(true);
    expect(r.get(p)?.bad).toBe(1); // the cut user line; junk without an allowed key is never parsed
  });
});
