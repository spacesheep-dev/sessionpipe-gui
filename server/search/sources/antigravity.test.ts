// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TITLE_RANK } from "../types.js";
import { antigravityAdapter, antigravityRequest, antigravityToolLine } from "./antigravity.js";
import { geminiAdapter } from "./gemini.js";
import { Collect, fixtureHome, readAll, testEnv } from "./testkit.js";

const G1 = "antigravity:d0000000-0000-4000-8000-000000000021";
const G2 = "antigravity:d0000000-0000-4000-8000-000000000022";
const GM = "gemini-cli:e0000000-0000-4000-8000-000000000031";
const GJ = "gemini-cli:e0000000-0000-4000-8000-000000000032";

let fx: ReturnType<typeof fixtureHome>;
beforeEach(() => {
  fx = fixtureHome();
});
afterEach(() => fx.done());

describe("antigravity", () => {
  it("discovers both layouts and never a .pb, a .resolved snapshot or a step's output", async () => {
    const files = await antigravityAdapter().discover(testEnv(fx.home, fx.state));
    const rel = files.map((f) => [path.relative(path.join(fx.home, ".gemini"), f.path), f.kind, f.key]).sort();
    expect(rel).toEqual([
      [`antigravity-cli/brain/${G2.slice(12)}/.system_generated/logs/transcript.jsonl`, "append", G2],
      [`antigravity/brain/${G1.slice(12)}/.system_generated/messages/m1.json`, "whole", G1],
      [`antigravity/brain/${G1.slice(12)}/implementation_plan.md`, "whole", G1],
      [`antigravity/brain/${G1.slice(12)}/implementation_plan.md.metadata.json`, "whole", G1],
      [`antigravity/brain/${G1.slice(12)}/task.md`, "whole", G1],
      [`antigravity/brain/${G1.slice(12)}/task.md.metadata.json`, "whole", G1],
    ]);
  });

  it("artifacts layout: the artifacts and summaries, titled by task.md's heading", async () => {
    const sink = new Collect();
    await readAll(antigravityAdapter(), testEnv(fx.home, fx.state), sink);
    expect(sink.texts().join("\n")).not.toMatch(/never_indexed|PB_never_read/);
    expect(sink.texts(G1).sort()).toEqual([
      "# Plan: progress ring\n\nUse an SVG circle with stroke-dashoffset.",
      "# Ship the onboarding checklist\n\n- [x] Draft the copy\n- [ ] Wire the progress ring",
      "Checklist for onboarding",
      "Progress ring plan",
    ]);
    const f = sink.folded(G1);
    expect(f.title).toEqual({ text: "Ship the onboarding checklist", rank: TITLE_RANK.firstAsk });
    expect(f.firstAt).toBe(Date.parse("2026-10-05T12:00:00Z"));
    expect(f.lastAt).toBe(Date.parse("2026-10-05T12:30:00Z"));
    expect(f.resume).toBeUndefined();
  });

  it("transcript layout: the request inside USER_REQUEST, replies, tool lines; hidden steps and results skipped", async () => {
    const sink = new Collect();
    await readAll(antigravityAdapter(), testEnv(fx.home, fx.state), sink);
    expect(sink.docs.filter((d) => d.key === G2).map((d) => [d.field, d.text])).toEqual([
      ["prompt", "Add a retry budget to the uploader"],
      ["reply", "I'll cap retries at five with jitter."],
      ["tool", "view_file /Users/dev/acme/uploader/src/upload.ts"],
      ["tool", "run_command npm test"],
    ]);
    expect(sink.folded(G2)).toMatchObject({
      title: { text: "Add a retry budget to the uploader", rank: TITLE_RANK.firstAsk },
      cwd: "/Users/dev/acme/uploader",
    });
  });

  it("helpers", () => {
    expect(antigravityRequest("<USER_REQUEST>fix it</USER_REQUEST><META>x</META>")).toBe("fix it");
    expect(antigravityRequest("plain ask <META>m</META>")).toBe("plain ask");
    expect(antigravityToolLine("grep_search", { Query: "retry", SearchPath: "/a" })).toBe("grep_search /a");
  });
});

describe("gemini cli", () => {
  it("reads the .jsonl and the older whole .json chats", async () => {
    const sink = new Collect();
    const r = await readAll(geminiAdapter(), testEnv(fx.home, fx.state), sink);
    expect(sink.texts().join("\n")).not.toMatch(/never_indexed/);
    expect(sink.docs.filter((d) => d.key === GM).map((d) => [d.field, d.text])).toEqual([
      ["prompt", "Why does the CLI print the banner twice?"],
      ["reply", "The banner renders in both the preAction hook and main()."],
      ["tool", "read_file /Users/dev/acme/cli/src/main.ts"],
    ]);
    expect(sink.docs.filter((d) => d.key === GJ).map((d) => [d.field, d.text, d.offset])).toEqual([
      ["prompt", "Rename the config flag --verbose to --debug", 0],
      ["reply", "Renamed in args.ts and the README.", 1],
      ["tool", "replace src/args.ts", 1],
    ]);
    expect(sink.folded(GM)).toMatchObject({ cwd: "/Users/dev/acme/cli", title: { rank: TITLE_RANK.firstAsk } });
    expect(sink.folded(GM).resume).toBeUndefined();
    const whole = [...r.entries()].find(([p]) => p.endsWith(".json"));
    expect(whole?.[1].offset).toBe(2);
  });
});
