// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. The module's surface, over the whole synthetic home.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventsAdapter, historyAdapters, sourceEnv } from "./index.js";
import { Collect, fixtureHome, readAll } from "./testkit.js";

let fx: ReturnType<typeof fixtureHome>;
beforeEach(() => {
  fx = fixtureHome();
});
afterEach(() => fx.done());

describe("sources index", () => {
  it("sourceEnv: a synthetic home never inherits the real harness homes", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/real/claude";
    try {
      const env = sourceEnv({ home: fx.home, stateDir: fx.state, hostname: "m" });
      expect(env).toMatchObject({ home: fx.home, stateDir: fx.state, hostname: "m", platform: process.platform });
      expect(env.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(sourceEnv({ stateDir: fx.state, hostname: "m" }).env.CLAUDE_CONFIG_DIR).toBe("/real/claude");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it("every history adapter over the home: the sessions, their harness keys, nothing secret or excluded", async () => {
    const env = sourceEnv({ home: fx.home, stateDir: fx.state, hostname: "m" });
    const sink = new Collect();
    const adapters = historyAdapters();
    expect(adapters.map((a) => [a.id, a.source])).toEqual([
      ["claude", "history"],
      ["codex", "history"],
      ["antigravity", "history"],
      ["gemini", "history"],
    ]);
    for (const a of adapters) await readAll(a, env, sink);
    expect(sink.keys().map((k) => k.replace(/:.*-0+/, ":…"))).toEqual([
      "antigravity:…21",
      "antigravity:…22",
      "claude-code:…1",
      "claude-code:…2",
      "claude-code:…3",
      "codex:…11",
      "codex:…12",
      "codex:…15",
      "gemini-cli:…31",
      "gemini-cli:…32",
    ]);
    const bytes = JSON.stringify([sink.docs, sink.got]);
    expect(bytes).not.toMatch(/never_indexed|never indexed|never_read|Tr0ub4dor|x-oauth/);
    for (const d of sink.docs) {
      expect(d.text.length).toBeGreaterThan(0);
      expect(Number.isInteger(d.offset) && d.offset >= 0).toBe(true);
      expect(["prompt", "reply", "tool"]).toContain(d.field);
    }
    // History leaves the machine to the service.
    expect(sink.got.some((f) => f.machine)).toBe(false);
    // Every adapter's roots exist or are harmless paths under the home.
    for (const a of adapters) for (const r of a.roots(env)) expect(r.startsWith(fx.home)).toBe(true);
  });

  it("the events adapter reads the state dir only", () => {
    const env = sourceEnv({ home: fx.home, stateDir: fx.state, hostname: "m" });
    expect(eventsAdapter().roots(env)).toEqual([path.join(fx.state, "events")]);
  });
});
