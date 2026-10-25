// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventFiles } from "../../store/files.js";
import { TITLE_RANK } from "../types.js";
import { eventsAdapter } from "./events.js";
import { eventsPath } from "./index.js";
import { Collect, testEnv } from "./testkit.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "spgui-events-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
const ev = (
  type: string,
  data: Record<string, unknown>,
  o: { tier?: number; session?: Record<string, unknown>; seq?: number } = {},
) => ({
  protocol: 1,
  id: `01J${String(++seq).padStart(23, "0")}`,
  type,
  time: new Date(Date.parse("2026-10-10T10:00:00Z") + seq * 1000).toISOString(),
  tier: o.tier ?? 3,
  harness: { name: "claude-code" },
  session: {
    id: "s-1",
    seq: o.seq ?? seq,
    machine: "build-box",
    cwd: "/srv/acme/api",
    repo: "acme/api",
    branch: "main",
    ...o.session,
  },
  privacy: { rulesets: ["secrets@1"], pii: false },
  data,
  arrivedAt: "2026-10-10T10:00:00Z",
  source: "http",
});
const write = (events: unknown[], harness = "claude-code", id = "s-1") => {
  const p = path.join(dir, "events", harness, `${id}.jsonl`);
  mkdirSync(path.dirname(p), { recursive: true });
  appendFileSync(p, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return p;
};

describe("events source", () => {
  it("eventsPath is the store's own file for a key", () => {
    const files = new EventFiles(dir);
    expect(eventsPath(dir, "claude-code:s-1")).toBe(files.file("claude-code", "s-1"));
    expect(eventsPath(dir, "codex:a/b:c")).toBe(files.file("codex", "a/b:c"));
  });

  it("reads prompts, replies, tool lines and attention messages, each with its seq", async () => {
    write([
      ev(
        "session.started",
        { source: "startup" },
        { session: { title: "Ship the webhook fix", title_source: "custom" } },
      ),
      ev("turn.transcript", {
        turn: 1,
        user: "Why do retries 409?",
        assistant: "The key is reused.",
        at: "2026-10-10T10:00:05Z",
      }),
      ev("tool.ended", { tool: "Bash", ok: true, input: { command: "npm test" }, output: "OUTPUT_never_indexed" }),
      ev("attention.needed", { attention_id: "a1", kind: "permission", tool: "Bash", message: "Allow rm -rf dist?" }),
      ev("session.heartbeat", {}),
    ]);
    const a = eventsAdapter();
    const env = testEnv(dir, dir);
    const [f] = await a.discover(env);
    expect(f).toMatchObject({ adapter: "events", kind: "append", key: "claude-code:s-1" });
    const sink = new Collect();
    await a.read(f!, { offset: 0 }, sink);
    expect(sink.docs.map((d) => [d.field, d.text, d.seq])).toEqual([
      ["prompt", "Why do retries 409?", 2],
      ["reply", "The key is reused.", 2],
      ["tool", "Bash npm test", 3],
      ["prompt", "Allow rm -rf dist?", 4],
    ]);
    expect(sink.texts().join()).not.toContain("never_indexed");
    expect(sink.folded("claude-code:s-1")).toMatchObject({
      machine: "build-box",
      cwd: "/srv/acme/api",
      repo: "acme/api",
      branch: "main",
      title: { text: "Ship the webhook fix", rank: TITLE_RANK.custom },
    });
  });

  it("never reads above the tier an event arrived at", async () => {
    write([
      ev("turn.transcript", { turn: 1, user: "TIER1_never_indexed", assistant: "x" }, { tier: 1 }),
      ev("tool.ended", { tool: "Read", ok: true, input: { file_path: "TIER2_never_indexed" } }, { tier: 2 }),
      ev("attention.needed", { attention_id: "a", kind: "question", message: "TIER0_never_indexed" }, { tier: 0 }),
    ]);
    const sink = new Collect();
    const a = eventsAdapter();
    const [f] = await a.discover(testEnv(dir, dir));
    await a.read(f!, { offset: 0 }, sink);
    expect(sink.docs.map((d) => d.text)).toEqual(["Read"]);
  });

  it("progress pieces and the final transcript never repeat a word", async () => {
    write([
      ev("turn.progress", { turn: 3, user: "Refactor the queue", assistant: "" }),
      ev("turn.progress", { turn: 3, user: "Refactor the queue", assistant: "Step one: split the worker." }),
      ev("turn.progress", {
        turn: 3,
        user: "Refactor the queue",
        assistant: "Step one: split the worker. Step two: add backpressure.",
      }),
      ev("turn.transcript", {
        turn: 3,
        user: "Refactor the queue",
        assistant: "Step one: split the worker. Step two: add backpressure. Done.",
      }),
      ev("turn.transcript", { turn: 4, user: "Thanks", assistant: "Anytime." }),
    ]);
    const sink = new Collect();
    const a = eventsAdapter();
    const [f] = await a.discover(testEnv(dir, dir));
    await a.read(f!, { offset: 0 }, sink);
    expect(sink.docs.map((d) => [d.field, d.text])).toEqual([
      ["prompt", "Refactor the queue"],
      ["reply", "Step one: split the worker."],
      ["reply", "Step two: add backpressure."],
      ["reply", "Done."],
      ["prompt", "Thanks"],
      ["reply", "Anytime."],
    ]);
  });

  it("a tier upgrade of the same seq adds only what the lower copy lacked", async () => {
    const p = write([ev("turn.transcript", { turn: 1, user: "hidden", assistant: "hidden" }, { tier: 0, seq: 7 })]);
    write([ev("turn.transcript", { turn: 1, user: "Now visible", assistant: "Yes" }, { tier: 2, seq: 7 })]);
    write([ev("turn.transcript", { turn: 1, user: "Now visible", assistant: "Yes" }, { tier: 2, seq: 7 })]);
    const sink = new Collect();
    const a = eventsAdapter();
    const [f] = await a.discover(testEnv(dir, dir));
    await a.read(f!, { offset: 0 }, sink);
    expect(sink.docs.map((d) => [d.text, d.seq])).toEqual([
      ["Now visible", 7],
      ["Yes", 7],
    ]);
    expect(f!.path).toBe(p);
  });

  it("a child session's words join its parent's row, without the child's seq", async () => {
    write(
      [
        ev(
          "turn.transcript",
          { turn: 1, user: "child ask", assistant: "child answer" },
          { session: { id: "kid", parent_id: "s-1", machine: "other" } },
        ),
      ],
      "codex",
      "kid",
    );
    const sink = new Collect();
    const a = eventsAdapter();
    const [f] = await a.discover(testEnv(dir, dir));
    await a.read(f!, { offset: 0 }, sink);
    expect(sink.docs.map((d) => [d.key, d.agent, d.seq])).toEqual([
      ["claude-code:s-1", "kid", undefined],
      ["claude-code:s-1", "kid", undefined],
    ]);
    expect(sink.folded("claude-code:s-1").machine).toBeUndefined();
  });

  it("subagent tool calls inside the parent carry their agent id; secrets are redacted again", async () => {
    write([
      ev("tool.ended", { tool: "Bash", ok: true, agent_id: "ag1", input: { command: "export API_KEY=Zq81mLkP0vXy" } }),
    ]);
    const sink = new Collect();
    const a = eventsAdapter();
    const [f] = await a.discover(testEnv(dir, dir));
    await a.read(f!, { offset: 0 }, sink);
    expect(sink.docs[0]).toMatchObject({ agent: "ag1", field: "tool" });
    expect(sink.docs[0]!.text).not.toContain("Zq81mLkP0vXy");
  });

  it("files.changed paths make a tier-1 session findable by file", async () => {
    write([ev("files.changed", { paths: ["src/webhooks/retry.ts", "README.md"] }, { tier: 1 })]);
    write([ev("files.changed", { paths: ["TIER0_never_indexed"] }, { tier: 0 })]);
    const sink = new Collect();
    const a = eventsAdapter();
    const [f] = await a.discover(testEnv(dir, dir));
    await a.read(f!, { offset: 0 }, sink);
    expect(sink.docs.map((d) => [d.field, d.tool, d.text])).toEqual([
      ["tool", "files.changed", "Changed src/webhooks/retry.ts README.md"],
    ]);
  });

  it("is empty without an events folder", async () => {
    expect(await eventsAdapter().discover(testEnv(dir, path.join(dir, "none")))).toEqual([]);
  });
});
