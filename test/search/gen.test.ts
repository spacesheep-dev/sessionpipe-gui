// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. The generator itself: deterministic for a seed, every format present,
// secrets planted where the sources must redact them, and the demo profile small and plausible.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generate } from "../../bench/search/gen.mjs";
import { tempDir } from "../events.js";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const tmp = tempDir("spgui-gen-");
afterAll(() => tmp.cleanup());

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
const digest = (dir: string): string => {
  const h = createHash("sha256");
  for (const f of files(dir)) {
    h.update(path.relative(dir, f));
    // .zst bytes depend on the zstd build; the plain files and names are what must repeat
    if (!f.endsWith(".zst")) h.update(readFileSync(f));
  }
  return h.digest("hex");
};

describe("bench/search/gen.mjs", () => {
  it("is deterministic for a seed", () => {
    const a = generate({ out: path.join(tmp.dir, "a"), size: 400_000, seed: 77, now: NOW });
    const b = generate({ out: path.join(tmp.dir, "b"), size: 400_000, seed: 77, now: NOW });
    generate({ out: path.join(tmp.dir, "c"), size: 400_000, seed: 78, now: NOW });
    expect(a.bytes).toBe(b.bytes);
    expect(a.needles).toEqual(b.needles);
    expect(digest(path.join(tmp.dir, "a", "home"))).toBe(digest(path.join(tmp.dir, "b", "home")));
    expect(digest(path.join(tmp.dir, "a", "home"))).not.toBe(digest(path.join(tmp.dir, "c", "home")));
  });

  it("writes every format the sources read", () => {
    const m = generate({ out: path.join(tmp.dir, "f"), size: 300_000, seed: 1, now: NOW });
    const home = path.join(tmp.dir, "f", "home");
    const rel = files(home).map((f) => path.relative(home, f));
    const has = (re: RegExp) => rel.some((f) => re.test(f));
    expect(has(/^\.claude\/projects\/[^/]+\/[0-9a-f-]{36}\.jsonl$/)).toBe(true);
    expect(has(/^\.claude\/projects\/[^/]+\/[0-9a-f-]{36}\/subagents\/agent-[0-9a-f]+\.jsonl$/)).toBe(true);
    expect(has(/\/subagents\/workflows\/wf_[^/]+\/agent-[0-9a-f]+\.jsonl$/)).toBe(true);
    expect(has(/^\.claude-work\/projects\//)).toBe(true);
    expect(has(/^\.codex\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-.+\.jsonl$/)).toBe(true);
    if (m.zstd !== "off") expect(has(/^\.codex\/sessions\/.+\.jsonl\.zst$/)).toBe(true);
    expect(has(/^\.codex\/session_index\.jsonl$/)).toBe(true);
    expect(has(/^\.gemini\/antigravity\/brain\/[^/]+\/\.system_generated\/logs\/transcript\.jsonl$/)).toBe(true);
    expect(has(/^\.gemini\/antigravity-ide\/brain\/[^/]+\/task\.md$/)).toBe(true);
    expect(has(/^\.gemini\/tmp\/[^/]+\/chats\/session-.+\.jsonl$/)).toBe(true);
    expect(has(/^\.gemini\/tmp\/[0-9a-f]{64}\/chats\/session-.+\.json$/)).toBe(true);
    const events = files(path.join(tmp.dir, "f", "state", "events"));
    expect(events.length).toBeGreaterThan(0);
    // One partial last line, on purpose; every other line of every JSONL parses.
    let partial = 0;
    for (const f of files(home).filter((x) => x.endsWith(".jsonl"))) {
      const text = readFileSync(f, "utf8");
      if (!text.endsWith("\n")) partial++;
      for (const line of text.split("\n").slice(0, -1)) if (line) JSON.parse(line);
    }
    expect(partial).toBe(1);
    expect(m.secrets.length).toBe(4);
    const all = files(home)
      .filter((f) => !f.endsWith(".zst") && statSync(f).size < 5e6)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const s of m.secrets) expect(all).toContain(s);
    expect(m.needles.filter((n) => n.kind === "must").length).toBeGreaterThan(30);
    expect(m.needles.filter((n) => n.kind === "never").length).toBeGreaterThan(25);
  });

  it("the demo profile is about 40 sessions of invented, readable work", () => {
    const m = generate({ out: path.join(tmp.dir, "d"), profile: "demo", seed: 42, now: NOW });
    const n = Object.values(m.sessions).reduce((a, b) => a + b, 0);
    expect(n).toBeGreaterThanOrEqual(40);
    expect(n).toBeLessThanOrEqual(60);
    expect(m.secrets).toEqual([]);
    expect(m.bytes).toBeLessThan(2_000_000);
  });
});
