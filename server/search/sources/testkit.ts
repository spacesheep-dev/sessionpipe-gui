// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. Test helpers: a private copy of the synthetic fixture home,
// a collecting DocSink, and a read loop that drives an adapter the way the engine does.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DocSink,
  ReadCursor,
  ReadOptions,
  SearchDoc,
  SessionFacts,
  SourceAdapter,
  SourceEnv,
  SourceFile,
} from "../types.js";

export const FIXTURE_HOME = fileURLToPath(new URL("./fixtures/home", import.meta.url));

/** A writable copy of the fixture home (tests append to it), removed by `done()`. */
export function fixtureHome(): { home: string; state: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "spgui-sources-"));
  const home = path.join(dir, "home");
  cpSync(FIXTURE_HOME, home, { recursive: true, preserveTimestamps: true });
  return { home, state: path.join(dir, "state"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testEnv(home: string, stateDir: string, env: Record<string, string | undefined> = {}): SourceEnv {
  return { home, stateDir, hostname: "test-mac", env: { PATH: process.env.PATH, ...env }, platform: process.platform };
}

export class Collect implements DocSink {
  docs: SearchDoc[] = [];
  got: SessionFacts[] = [];
  doc(d: SearchDoc): void {
    this.docs.push(d);
  }
  facts(f: SessionFacts): void {
    this.got.push(structuredClone(f));
  }
  /** The engine's fold: newest wins per field, title by rank, firstAt min, lastAt max. */
  folded(key: string): Partial<SessionFacts> {
    const out: Partial<SessionFacts> = {};
    for (const f of this.got) {
      if (f.key !== key) continue;
      for (const [k, v] of Object.entries(f)) {
        if (v === undefined) continue;
        if (k === "title") {
          const t = v as { text: string; rank: number };
          if (!out.title || t.rank >= out.title.rank) out.title = t;
        } else if (k === "firstAt") out.firstAt = Math.min(out.firstAt ?? Number.POSITIVE_INFINITY, v as number);
        else if (k === "lastAt") out.lastAt = Math.max(out.lastAt ?? 0, v as number);
        else (out as Record<string, unknown>)[k] = v;
      }
    }
    return out;
  }
  texts(key?: string): string[] {
    return this.docs.filter((d) => !key || d.key === key).map((d) => d.text);
  }
  keys(): string[] {
    return [...new Set([...this.docs.map((d) => d.key), ...this.got.map((f) => f.key)])].sort();
  }
}

export interface Pass {
  file: SourceFile;
  cursor: ReadCursor;
}

/** Discover, then read every file from 0 (or from the cursors given), like a first build. */
export async function readAll(
  a: SourceAdapter,
  env: SourceEnv,
  sink: DocSink,
  cursors = new Map<string, ReadCursor>(),
  opts: ReadOptions = {},
): Promise<Map<string, ReadCursor & { skipped?: string; bad?: number }>> {
  const files = await a.discover(env);
  const out = new Map<string, ReadCursor & { skipped?: string; bad?: number }>();
  for (const f of files) {
    let cur = cursors.get(f.path) ?? { offset: 0 };
    for (let guard = 0; guard < 10_000; guard++) {
      const r = await a.read(f, cur, sink, opts);
      const next = { offset: r.offset, state: r.state };
      const done = f.kind === "whole" || r.offset === cur.offset || !opts.maxBytes || r.offset >= f.size;
      cur = next;
      if (done) {
        out.set(f.path, { ...next, ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.bad ? { bad: r.bad } : {}) });
        break;
      }
    }
  }
  return out;
}
