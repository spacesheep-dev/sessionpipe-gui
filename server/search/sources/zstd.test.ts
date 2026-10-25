// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexAdapter } from "./codex.js";
import { Collect, testEnv } from "./testkit.js";
import { ZstdBatcher, zstdContentSize, zstdWay } from "./zstd.js";

const way = zstdWay(testEnv("/", "/", { SPGUI_SEARCH_ZSTD: "cli" }));
const hasCli = way.kind === "cli";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "spgui-zstd-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const zst = (name: string, text: string, flags: string[] = []): string => {
  const p = path.join(dir, name);
  writeFileSync(p, text);
  execFileSync("zstd", ["-q", "-f", "--rm", ...flags, p]);
  return `${p}.zst`;
};

describe.skipIf(!hasCli)("zstd", () => {
  it("reads the content size from the frame headers, across concatenated frames", () => {
    const a = zst("a.jsonl", "x".repeat(1000));
    const b = zst("b.jsonl", "hello\n".repeat(50));
    expect(zstdContentSize(readFileSync(a))).toBe(1000);
    const both = path.join(dir, "both.zst");
    writeFileSync(both, Buffer.concat([readFileSync(a), readFileSync(b)]));
    expect(zstdContentSize(readFileSync(both))).toBe(1300);
    expect(zstdContentSize(Buffer.from("not zstd"))).toBeUndefined();
    expect(zstdContentSize(readFileSync(zst("n.jsonl", "abc\n".repeat(10), ["--no-content-size"])))).toBeUndefined();
  });

  it("serves a walked plan from a few processes, the bytes exact", async () => {
    const files = Array.from({ length: 40 }, (_, i) => {
      const p = zst(`f${i}.jsonl`, `{"n":${i}}\n`.repeat(i + 1));
      const t = new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000);
      utimesSync(p, t, t);
      const st = statSync(p);
      return { path: p, size: st.size, mtimeMs: st.mtimeMs };
    });
    const z = new ZstdBatcher();
    z.setPlan(files);
    const newest = [...files].reverse();
    for (const f of newest) {
      const data = await z.whole(f, way);
      const n = Number(path.basename(f.path).slice(1, -10));
      expect(data?.toString()).toBe(`{"n":${n}}\n`.repeat(n + 1));
    }
    expect(z.stats.runs).toBeLessThan(10);
    expect(z.stats.hits).toBeGreaterThan(30);
  });

  it("a single read decodes only that file; a changed file is never served stale", async () => {
    const a = zst("a.jsonl", "one\n");
    const b = zst("b.jsonl", "two\n");
    const plan = [a, b].map((p) => ({ path: p, size: statSync(p).size, mtimeMs: statSync(p).mtimeMs }));
    const z = new ZstdBatcher();
    z.setPlan(plan);
    expect((await z.whole(plan[0]!, way))?.toString()).toBe("one\n");
    expect(z.stats.runs).toBe(1);
    expect((await z.whole(plan[1]!, way))?.toString()).toBe("two\n");
    // b was not prefetched by a lone read: no held copy to go stale.
    appendFileSync(b, Buffer.alloc(0));
    expect(z.stats.hits).toBe(0);
  });

  it("a corrupt file in a batch falls back to the per-file read, and the adapter calls it unreadable", async () => {
    const home = path.join(dir, "home");
    const day = path.join(home, ".codex/sessions/2026/10/01");
    mkdirSync(day, { recursive: true });
    const ids = ["11", "12", "13"].map((n) => `c0000000-0000-4000-8000-0000000000${n}`);
    for (const [i, id] of ids.entries()) {
      const p = path.join(day, `rollout-2026-10-01T00-00-0${i}-${id}.jsonl`);
      writeFileSync(
        p,
        `${JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", type: "session_meta", payload: { id, cwd: "/w" } })}\n${JSON.stringify({ timestamp: "2026-10-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `ask ${i}` }] } })}\n`,
      );
      execFileSync("zstd", ["-q", "-f", "--rm", p]);
    }
    const bad = path.join(day, `rollout-2026-10-01T00-00-01-${ids[1]}.jsonl.zst`);
    const bytes = readFileSync(bad);
    bytes[bytes.length - 6] = bytes[bytes.length - 6]! ^ 0xff; // same size, broken data
    writeFileSync(bad, bytes);
    const a = codexAdapter();
    const env = testEnv(home, dir, { SPGUI_SEARCH_ZSTD: "cli" });
    const sink = new Collect();
    const out: (string | undefined)[] = [];
    for (const f of await a.discover(env)) out.push((await a.read(f, { offset: 0 }, sink)).skipped);
    expect(out.filter((x) => x === "unreadable")).toHaveLength(1);
    expect(sink.texts().sort()).toEqual(["ask 0", "ask 2"]);
  });
});
