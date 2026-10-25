// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TITLE_RANK } from "../types.js";
import { codexAdapter, codexToolLine, patchFiles } from "./codex.js";
import { Collect, fixtureHome, readAll, testEnv } from "./testkit.js";
import { zstdWay } from "./zstd.js";

const C1 = "codex:c0000000-0000-4000-8000-000000000011";
const C2 = "codex:c0000000-0000-4000-8000-000000000012";
const CG = "codex:c0000000-0000-4000-8000-000000000013";
const CS = "codex:c0000000-0000-4000-8000-000000000014";
const CF = "codex:c0000000-0000-4000-8000-000000000015";

let fx: ReturnType<typeof fixtureHome>;
beforeEach(() => {
  fx = fixtureHome();
});
afterEach(() => fx.done());

const hasCli = zstdWay(testEnv("/", "/", { SPGUI_SEARCH_ZSTD: "cli" })).kind === "cli";

describe("codex discover", () => {
  it("finds .jsonl and .jsonl.zst rollouts, the plain copy winning over a .zst of the same id", async () => {
    const files = await codexAdapter().discover(testEnv(fx.home, fx.state));
    const rel = files.map((f) => [path.relative(path.join(fx.home, ".codex/sessions"), f.path), f.kind]).sort();
    expect(rel).toEqual([
      ["../session_index.jsonl", "append"],
      ["2026/10/03/rollout-2026-10-03T07-00-00-c0000000-0000-4000-8000-000000000011.jsonl", "append"],
      ["2026/10/03/rollout-2026-10-03T08-00-00-c0000000-0000-4000-8000-000000000013.jsonl", "append"],
      ["2026/10/03/rollout-2026-10-03T09-00-00-c0000000-0000-4000-8000-000000000014.jsonl", "append"],
      ["2026/10/03/rollout-2026-10-03T10-00-00-c0000000-0000-4000-8000-000000000015.jsonl", "append"],
      ["2026/10/03/rollout-2026-10-04T07-00-00-c0000000-0000-4000-8000-000000000012.jsonl.zst", "whole"],
    ]);
  });
  it("honours CODEX_HOME and is empty without one", async () => {
    const env = testEnv(path.join(fx.home, "x"), fx.state, { CODEX_HOME: path.join(fx.home, ".codex") });
    expect(await codexAdapter().discover(env)).toHaveLength(6);
    expect(await codexAdapter().discover(testEnv(path.join(fx.home, "x"), fx.state))).toEqual([]);
  });
});

describe("codex read", () => {
  it("indexes the person's asks, replies and tool lines; never injections, output, reasoning or compaction", async () => {
    const sink = new Collect();
    await readAll(codexAdapter(), testEnv(fx.home, fx.state, { SPGUI_SEARCH_ZSTD: "cli" }), sink);
    expect(sink.texts().join("\n")).not.toMatch(/never_indexed/);
    const d = sink.docs.filter((x) => x.key === C1 && !x.agent);
    expect(d.map((x) => [x.field, x.text])).toEqual([
      ["prompt", "Round invoice totals to the cent before tax\n(files: invoice.ts)"],
      ["tool", "exec_command rg -n roundTotal src"],
      ["tool", "apply_patch src/invoice.ts src/round.ts"],
      ["tool", "shell npm test -- invoice"],
      ["tool", "update_plan Round per line; Add tax test"],
      ["tool", "web_search banker's rounding javascript"],
      ["reply", "Checking where totals are summed."],
      ["reply", expect.stringContaining("Totals now round half-even per line.")],
    ]);
    expect(d.at(-1)!.text).not.toContain("Tr0ub4dor");
  });

  it("skips guardian reviews entirely and joins a spawned subagent to its parent after the replay", async () => {
    const sink = new Collect();
    await readAll(codexAdapter(), testEnv(fx.home, fx.state, { SPGUI_SEARCH_ZSTD: "cli" }), sink);
    expect(sink.keys()).not.toContain(CG);
    expect(sink.keys()).not.toContain(CS);
    const sub = sink.docs.filter((x) => x.agent);
    expect(sub.map((x) => [x.key, x.agent, x.field, x.text])).toEqual([
      [C1, CS.slice(6), "prompt", "Audit the tax table for rounding drift"],
      [C1, CS.slice(6), "reply", "Tax table drift found in the EU rates"],
    ]);
  });

  it("a fork is its own session from its replay boundary on, and names what it continues", async () => {
    const sink = new Collect();
    await readAll(codexAdapter(), testEnv(fx.home, fx.state, { SPGUI_SEARCH_ZSTD: "cli" }), sink);
    expect(sink.texts(CF)).toEqual(["In this fork, try integer cents everywhere", "Integer cents version compiles"]);
    expect(sink.folded(CF).forkOf).toBe(C1);
  });

  it("facts: session_index title (last wins), cwd, branch, repo without credentials, model, resume", async () => {
    const sink = new Collect();
    await readAll(codexAdapter(), testEnv(fx.home, fx.state, { SPGUI_SEARCH_ZSTD: "cli" }), sink);
    const f = sink.folded(C1);
    expect(f).toMatchObject({
      harness: "codex",
      id: C1.slice(6),
      title: { text: "Invoice rounding to cents", rank: TITLE_RANK.harness },
      cwd: "/Users/dev/acme/billing",
      branch: "feat/invoices",
      repo: "acme/billing",
      model: "gpt-5-codex",
      resume: { argv: ["codex", "resume", C1.slice(6)] },
      firstAt: Date.parse("2026-10-03T07:00:00.000Z"),
    });
    expect(JSON.stringify(sink.got)).not.toContain("x-oauth");
    expect(f.machine).toBeUndefined();
  });

  it("a rename in session_index.jsonl reaches even an archived session, as a newer title", async () => {
    const env = testEnv(fx.home, fx.state, { SPGUI_SEARCH_ZSTD: "cli" });
    const a = codexAdapter();
    const index = (await a.discover(env)).find((f) => f.path.endsWith("session_index.jsonl"))!;
    const s1 = new Collect();
    const r1 = await a.read(index, { offset: 0 }, s1);
    expect(s1.docs).toEqual([]);
    expect(s1.folded(C2).title).toEqual({ text: "Archived rounding run", rank: TITLE_RANK.harness });
    appendFileSync(
      index.path,
      `${JSON.stringify({ id: C2.slice(6), thread_name: "Rounding, final", updated_at: "x" })}\n`,
    );
    const s2 = new Collect();
    await a.read(index, { offset: r1.offset }, s2);
    expect(s2.got).toEqual([
      { key: C2, harness: "codex", id: C2.slice(6), title: { text: "Rounding, final", rank: TITLE_RANK.harness } },
    ]);
  });

  it.skipIf(!hasCli)("reads .zst through the zstd command: offset is the record count", async () => {
    const env = testEnv(fx.home, fx.state, { SPGUI_SEARCH_ZSTD: "cli" });
    const a = codexAdapter();
    const z = (await a.discover(env)).find((f) => f.kind === "whole")!;
    const sink = new Collect();
    const r = await a.read(z, { offset: 0 }, sink);
    expect(r.skipped).toBeUndefined();
    expect(r.offset).toBe(17);
    expect(sink.texts(C2)).toContain("Round invoice totals to the cent before tax\n(files: invoice.ts)");
    expect(sink.docs.every((d) => d.offset < 17)).toBe(true);
    expect(sink.folded(C2).title?.text).toBe("Archived rounding run");
  });

  it("without any zstd a .zst is skipped and said so", async () => {
    const env = testEnv(fx.home, fx.state, { SPGUI_SEARCH_ZSTD: "none" });
    const a = codexAdapter();
    const z = (await a.discover(env)).find((f) => f.kind === "whole")!;
    const sink = new Collect();
    expect(await a.read(z, { offset: 0 }, sink)).toEqual({ offset: 0, skipped: "zstd" });
    expect(sink.docs).toEqual([]);
  });

  it("a broken .zst is unreadable, never a throw", async () => {
    const env = testEnv(fx.home, fx.state, { SPGUI_SEARCH_ZSTD: "cli" });
    const a = codexAdapter();
    const z = (await a.discover(env)).find((f) => f.kind === "whole")!;
    writeFileSync(z.path, "not zstd at all");
    const r = await a.read(z, { offset: 0 }, new Collect());
    expect(r.skipped).toBe(hasCli ? "unreadable" : "zstd");
  });

  it("appends resume from the cursor; a subagent keeps its boundary across reads", async () => {
    const env = testEnv(fx.home, fx.state);
    const a = codexAdapter();
    const files = await a.discover(env);
    const sub = files.find((f) => f.path.includes(CS.slice(6)))!;
    // First read stops inside the replay (before the boundary event).
    const bytes = readFileSync(sub.path);
    let nl = -1;
    for (let i = 0; i < 3; i++) nl = bytes.indexOf(10, nl + 1);
    const s1 = new Collect();
    const r1 = await a.read(sub, { offset: 0 }, s1, { endOffset: nl + 1 });
    expect(s1.docs).toEqual([]);
    const s2 = new Collect();
    const r2 = await a.read(sub, { offset: r1.offset, state: r1.state }, s2);
    expect(s2.texts()).toEqual(["Audit the tax table for rounding drift", "Tax table drift found in the EU rates"]);
    appendFileSync(
      sub.path,
      `${JSON.stringify({ timestamp: "2026-10-03T09:01:00Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "One more finding" }] } })}\n`,
    );
    const s3 = new Collect();
    await a.read(sub, { offset: r2.offset, state: r2.state }, s3);
    expect(s3.docs.map((d) => [d.key, d.agent, d.text])).toEqual([[C1, CS.slice(6), "One more finding"]]);
  });

  it("reads a rollout from before the envelope: bare header, bare items", async () => {
    const id = "c0000000-0000-4000-8000-0000000000ee";
    const p = path.join(fx.home, `.codex/sessions/2025/03/01/rollout-2025-03-01T10-00-00-${id}.jsonl`);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(
      p,
      [
        {
          id,
          timestamp: "2025-03-01T10:00:00Z",
          instructions: null,
          git: { branch: "main", repository_url: "git@github.com:acme/old.git" },
        },
        { record_type: "state" },
        {
          type: "message",
          id: null,
          role: "user",
          content: [{ type: "input_text", text: "legacy ask about caching" }],
        },
        {
          type: "function_call",
          name: "shell",
          arguments: JSON.stringify({ command: ["bash", "-lc", "ls"] }),
          call_id: "c1",
        },
        { type: "function_call_output", call_id: "c1", output: "OUTPUT_never_indexed" },
        { type: "message", id: null, role: "assistant", content: [{ type: "output_text", text: "legacy answer" }] },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")
        .concat("\n"),
    );
    const sink = new Collect();
    await readAll(codexAdapter(), testEnv(fx.home, fx.state), sink);
    const key = `codex:${id}`;
    expect(sink.docs.filter((d) => d.key === key).map((d) => [d.field, d.text])).toEqual([
      ["prompt", "legacy ask about caching"],
      ["tool", "shell ls"],
      ["reply", "legacy answer"],
    ]);
    expect(sink.folded(key)).toMatchObject({
      repo: "acme/old",
      branch: "main",
      resume: { argv: ["codex", "resume", id] },
    });
  });

  it("tool lines by name", () => {
    expect(codexToolLine("exec_command", JSON.stringify({ cmd: ["bash", "-lc", "make"] }))).toBe("exec_command make");
    expect(codexToolLine("spawn_agent", JSON.stringify({ message: "check the tests" }))).toBe(
      "spawn_agent check the tests",
    );
    expect(codexToolLine("request_user_input", JSON.stringify({ questions: [{ question: "Ship it?" }] }))).toBe(
      "request_user_input Ship it?",
    );
    expect(codexToolLine("js", JSON.stringify({ title: "Count rows", code: "x" }))).toBe("js Count rows");
    expect(codexToolLine("exec", "ls -la")).toBe("exec ls -la");
    expect(patchFiles("*** Begin Patch\n*** Delete File: a.ts\n*** Update File: b.ts\n*** Move to: c.ts\n")).toBe(
      "a.ts b.ts c.ts",
    );
  });
});
