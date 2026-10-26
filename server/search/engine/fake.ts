// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. A fake SourceAdapter for the indexer's tests (never imported by the
// server): `<home>/fake/<id>.jsonl` (append: one {k, text, at} per line) and
// `<home>/fake/<id>.json` (whole: an array of the same), one session per file.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  DocSink,
  ReadCursor,
  ReadOptions,
  ReadResult,
  SearchSource,
  SourceAdapter,
  SourceEnv,
  SourceFile,
} from "../types.js";

export interface FakeLine {
  k: "p" | "r" | "t";
  text: string;
  at?: number;
  title?: string;
}

export const fakeLine = (l: FakeLine): string => `${JSON.stringify(l)}\n`;

export function fakeAdapter(
  source: SearchSource = "history",
  harness = "claude-code",
  sub = "fake",
): SourceAdapter & { reads: number } {
  const a = {
    id: (source === "history" ? "claude" : "events") as SourceAdapter["id"],
    source,
    reads: 0,
    async discover(env: SourceEnv): Promise<SourceFile[]> {
      const dir = join(env.home, sub);
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const out: SourceFile[] = [];
      for (const n of names) {
        if (!n.endsWith(".jsonl") && !n.endsWith(".json")) continue;
        const p = join(dir, n);
        const st = statSync(p);
        out.push({
          path: p,
          adapter: a.id,
          kind: n.endsWith(".jsonl") ? "append" : "whole",
          size: st.size,
          mtimeMs: st.mtimeMs,
          key: `${harness}:${n.replace(/\.jsonl?$/, "")}`,
        });
      }
      return out;
    },
    roots(env: SourceEnv): string[] {
      return [join(env.home, sub)];
    },
    async read(file: SourceFile, from: ReadCursor, sink: DocSink, opts: ReadOptions = {}): Promise<ReadResult> {
      a.reads++;
      const key = file.key!;
      const id = key.slice(key.indexOf(":") + 1);
      const emit = (l: FakeLine, offset: number) => {
        if (l.k === "t") {
          sink.facts({ key, harness, id, title: { text: l.title ?? l.text, rank: 50 } });
          return;
        }
        sink.doc({ key, field: l.k === "p" ? "prompt" : "reply", at: l.at ?? 0, text: l.text, offset });
        sink.facts({ key, harness, id, path: file.path, ...(l.at ? { lastAt: l.at, firstAt: l.at } : {}) });
      };
      if (file.kind === "whole") {
        let arr: FakeLine[] = [];
        try {
          arr = JSON.parse(readFileSync(file.path, "utf8")) as FakeLine[];
        } catch {
          return { offset: 0, bad: 1 };
        }
        for (let i = 0; i < arr.length; i++) emit(arr[i]!, i);
        return { offset: arr.length };
      }
      const size = statSync(file.path).size;
      const end = Math.min(size, opts.endOffset ?? size);
      const fd = openSync(file.path, "r");
      try {
        const len = Math.max(0, end - from.offset);
        const buf = Buffer.alloc(len);
        let r = 0;
        while (r < len) {
          const n = readSync(fd, buf, r, len - r, from.offset + r);
          if (n <= 0) break;
          r += n;
        }
        let pos = 0;
        let bad = 0;
        let consumed = 0;
        while (pos < r) {
          const nl = buf.indexOf(10, pos);
          if (nl < 0 || nl >= r) break; // a partial last line waits
          const line = buf.subarray(pos, nl).toString("utf8");
          try {
            emit(JSON.parse(line) as FakeLine, from.offset + pos);
          } catch {
            bad++;
          }
          pos = nl + 1;
          consumed = pos;
          if (opts.maxBytes && consumed >= opts.maxBytes) break;
        }
        return { offset: from.offset + consumed, bad };
      } finally {
        closeSync(fd);
      }
    },
  };
  return a;
}

export function fakeEnv(home: string, stateDir: string): SourceEnv {
  mkdirSync(join(home, "fake"), { recursive: true });
  return { home, stateDir, hostname: "test-host", env: {}, platform: process.platform };
}
