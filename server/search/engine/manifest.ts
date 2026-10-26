// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The commit point of one index (`<stateDir>/search/<history|events>/
// MANIFEST`), recovery and the writer's LOCK.
//
//   commit    segment tmp → fsync → rename, then MANIFEST.tmp → fsync → rename → fsync(dir);
//             superseded files are unlinked after (a reader holding an fd keeps reading;
//             a failed unlink on Windows goes into `trash` and is retried next commit).
//   recovery  every *.tmp and every seg-* / *.del-* the manifest does not name is deleted;
//             an unreadable segment is dropped and its files' offsets reset to 0.
//   LOCK      `search/LOCK`, created by link (atomic, never half-written), {pid, host,
//             startedAt}; stale when the pid is gone.
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { AdapterState, SearchSource, SourceId } from "../types.js";
import { DIR_MODE, FILE_MODE, writeFileAtomic } from "./codec.js";

export const FORMAT = 2;

/** One source file the index has read. */
export interface FileEntry {
  /** Never reused within an index: a replaced file gets a new id (its old docs are dead). */
  id: number;
  adapter: SourceId;
  kind: "append" | "whole";
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** append: the byte after the last committed line. whole: the records read. */
  offset: number;
  /** crc32 of the first `headLen` bytes (a same-inode rewrite changes it). */
  head: number;
  headLen: number;
  state?: AdapterState;
  key?: string;
  /** The newest doc time seen in the file (a record with no time inherits it). */
  lastAt: number;
  skipped?: "zstd" | "unreadable";
}

export interface SegEntry {
  name: string;
  docs: number;
  bytes: number;
  crc: number;
  /** The tombstone file, when some docs are deleted. */
  del?: string;
  dels: number;
}

export interface Manifest {
  format: number;
  source: SearchSource;
  gen: number;
  nextSeg: number;
  nextFile: number;
  segments: SegEntry[];
  /** By absolute path. */
  files: Record<string, FileEntry>;
  /** True once the first full pass has committed. */
  built: boolean;
  updatedAt: number;
  trash?: string[];
}

export const indexDir = (dir: string, source: SearchSource): string =>
  join(dir, source === "history" ? "history" : "events");

export function emptyManifest(source: SearchSource): Manifest {
  return {
    format: FORMAT,
    source,
    gen: 0,
    nextSeg: 1,
    nextFile: 1,
    segments: [],
    files: {},
    built: false,
    updatedAt: 0,
  };
}

export function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(d, DIR_MODE);
  } catch {}
}

/** The manifest of an index, or null when there is none (or it is unreadable). */
export function readManifest(idx: string): Manifest | null {
  let raw: string;
  try {
    raw = readFileSync(join(idx, "MANIFEST"), "utf8");
  } catch {
    return null;
  }
  try {
    const m = JSON.parse(raw) as Manifest;
    if (m.format !== FORMAT || !Array.isArray(m.segments) || typeof m.files !== "object") return null;
    return m;
  } catch {
    return null;
  }
}

/** The commit point. */
export function writeManifest(idx: string, m: Manifest): void {
  m.updatedAt = Date.now();
  writeFileAtomic(join(idx, "MANIFEST"), JSON.stringify(m));
}

/** Identity of the MANIFEST for `refresh()`: one stat. */
export function manifestStamp(idx: string): string {
  try {
    const s = statSync(join(idx, "MANIFEST"));
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
}

/** Delete what the manifest does not name (writer only, under the LOCK). */
export function recover(idx: string, m: Manifest): { removed: number } {
  const named = new Set<string>(["MANIFEST"]);
  for (const s of m.segments) {
    named.add(s.name);
    if (s.del) named.add(s.del);
  }
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(idx);
  } catch {
    return { removed };
  }
  for (const f of names) {
    if (named.has(f)) continue;
    if (f.endsWith(".tmp") || f.startsWith("seg-")) {
      try {
        unlinkSync(join(idx, f));
        removed++;
      } catch {}
    }
  }
  m.trash = [];
  return { removed };
}

/** Unlink files no longer named (after a commit). Failures go to `m.trash`. */
export function unlinkLater(idx: string, m: Manifest, names: string[]): void {
  const keep: string[] = [];
  for (const n of [...(m.trash ?? []), ...names]) {
    try {
      unlinkSync(join(idx, n));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") keep.push(n);
    }
  }
  m.trash = keep;
}

// ───────────────────────────── LOCK ─────────────────────────────

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class LockedError extends Error {
  constructor(readonly pid: number) {
    super(`the search index is being written by process ${pid}`);
  }
}

/** Take `<dir>/LOCK`: the content goes to a private temp file first, then `link` creates the
 *  LOCK atomically (it fails when one exists), so a LOCK is never half-written. A lock whose
 *  pid is gone (or is this process) is stale and taken over. */
export function acquireLock(dir: string): () => void {
  ensureDir(dir);
  const path = join(dir, "LOCK");
  const tmp = join(dir, `LOCK.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() }), {
    mode: FILE_MODE,
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, path);
        for (const f of readdirSync(dir)) {
          const m = /^LOCK\.(\d+)\.\d+\.tmp$/.exec(f);
          if (m && Number(m[1]) !== process.pid && !pidAlive(Number(m[1]))) {
            try {
              unlinkSync(join(dir, f));
            } catch {}
          }
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            const cur = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
            if (cur.pid === process.pid) unlinkSync(path);
          } catch {}
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let pid = 0;
        try {
          pid = Number((JSON.parse(readFileSync(path, "utf8")) as { pid?: number }).pid) || 0;
        } catch {
          // unreadable (an old writer's half-written lock): stale
        }
        if (pid && pid !== process.pid && pidAlive(pid)) throw new LockedError(pid);
        try {
          unlinkSync(path);
        } catch {}
      }
    }
    throw new LockedError(0);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/** Who holds the LOCK (a live pid), or 0. */
export function lockHolder(dir: string): number {
  try {
    const pid = Number((JSON.parse(readFileSync(join(dir, "LOCK"), "utf8")) as { pid?: number }).pid) || 0;
    return pidAlive(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

/** Delete one index (history off). */
export function removeIndexDir(dir: string, source: SearchSource): void {
  rmSync(indexDir(dir, source), { recursive: true, force: true });
}

// ───────────────────────────── tombstones ─────────────────────────────

export const delName = (seg: string, v: number): string => `${seg.replace(/\.sps$/, "")}.del-${v}`;

export function readDel(idx: string, name: string, docs: number): Uint8Array | null {
  try {
    const b = readFileSync(join(idx, name));
    if (b.length !== Math.ceil(docs / 8)) return null;
    return new Uint8Array(b.buffer, b.byteOffset, b.length);
  } catch {
    return null;
  }
}

export function writeDel(idx: string, name: string, bits: Uint8Array): void {
  writeFileAtomic(join(idx, name), bits);
}
