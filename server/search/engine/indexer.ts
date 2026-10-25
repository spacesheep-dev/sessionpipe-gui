// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The one writer (SEARCH-SPEC §3.2 "Indexer", D12): discover → detect
// change → read → build → commit (segment, then MANIFEST) → tombstone → merge. Runs in the
// niced child (`sessionpipe-gui index --ipc`), in the foreground (`index`, mode "once"), or
// in-process when forking fails (it then yields every few ms).
//
//   first build   newest files first; the first commit lands within about a second, so the
//                 first results show while the backlog is read; one merge at the end.
//   watch         the hot set (changed in the last 15 min, or hinted) every 1 s, a full sweep
//                 every 30 s or when a root folder's mtime moves; commit at ≥ 1 MB of text,
//                 when the oldest uncommitted byte is 60 s old, on `commit`, on shutdown;
//                 exits after 2 min with nothing to do (the service respawns it).
//   changes       a new inode, a shrink, a changed head (append) or a changed (size, mtime)
//                 (whole): the file's docs are tombstoned (its id dies, a new id is never a
//                 reused one) and it is read again from 0. A file gone from disk: tombstoned.
import { closeSync, fstatSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  DocSink,
  IndexerOptions,
  IndexerStatus,
  SearchDoc,
  SearchSource,
  SessionFacts,
  SourceAdapter,
  SourceFile,
  ToIndexer,
} from "../types.js";
import { Builder } from "./builder.js";
import { crc32 } from "./codec.js";
import {
  acquireLock,
  delName,
  emptyManifest,
  ensureDir,
  type FileEntry,
  indexDir,
  type Manifest,
  readDel,
  readManifest,
  recover,
  removeIndexDir,
  type SegEntry,
  unlinkLater,
  writeDel,
  writeManifest,
} from "./manifest.js";
import { mergeSegments } from "./merge.js";
import { MAGIC, ROW, SECTIONS, Segment } from "./segment.js";

/** Commit when this much text is uncommitted (watch mode). */
const COMMIT_CHARS = 1 << 20;
/** … or when the oldest uncommitted doc is this old. */
const COMMIT_AGE_MS = 60_000;
/** First build: the first commit after this long, then one per FLUSH_CHARS or FLUSH_MS. */
const FIRST_COMMIT_MS = 900;
const FLUSH_CHARS = 24 << 20;
const FLUSH_CHARS_INPROC = 4 << 20;
const FLUSH_MS = 8_000;
/** A pass reading less than this skips the early commit (it ends within about a second). */
const SMALL_PASS = 16 << 20;
const HOT_MS = 15 * 60_000;
const TICK_MS = 1_000;
const SWEEP_MS = 30_000;
const IDLE_EXIT_MS = 120_000;
const STATUS_MS = 250;
const SLICE_BYTES = 4 << 20;
const SLICE_BYTES_INPROC = 1 << 20;
const HEAD_BYTES = 4096;
/** Merge policy. */
const MAX_SEGMENTS = 10;
const MERGE_WINDOW = 8;
const MAX_MERGED_DOCS = 512 * 1024;
const DELETED_REWRITE = 0.2;

export interface IndexerInternals {
  /** Running inside the server: yield every few ms, smaller slices. */
  inProcess?: boolean;
  idleExitMs?: number;
  tickMs?: number;
  sweepMs?: number;
}

interface Known {
  file: SourceFile;
  adapter: SourceAdapter;
}

/** One index being written (history or events). */
class Writer {
  m: Manifest;
  builder = new Builder();
  /** File entries as read so far (they reach the manifest at the next commit). */
  pending = new Map<string, FileEntry>();
  deadFiles = new Set<number>();
  deadKeys = new Set<string>();
  removedPaths = new Set<string>();
  /** When the oldest uncommitted change was made (0: none). */
  since = 0;
  segs = new Map<string, Segment>();
  /** Rebuilding: the manifest under construction (published in one commit at the end). */
  next: Manifest | null = null;
  constructor(
    readonly source: SearchSource,
    readonly dir: string,
  ) {
    ensureDir(dir);
    const m = readManifest(dir);
    this.m = m ?? emptyManifest(source);
    recover(dir, this.m);
    // an unreadable segment is dropped and its files read again
    const good: SegEntry[] = [];
    let dropped = false;
    for (const e of this.m.segments) {
      // a cheap check now (footer and section table); opened when a tombstone or merge needs it
      if (segmentLooksWhole(join(dir, e.name), e.bytes)) good.push(e);
      else dropped = true;
    }
    if (dropped) {
      // which files lost docs is unknown: read everything again (a rebuild, in place)
      this.m.segments = good;
      for (const s of this.segs.values()) s.close();
      this.segs.clear();
      this.m.segments = [];
      this.m.files = {};
      this.m.built = false;
      writeManifest(dir, this.m);
      recover(dir, this.m);
    }
  }

  /** A named segment, opened on first use (with its tombstones). */
  seg(e: SegEntry): Segment | undefined {
    let s = this.segs.get(e.name);
    if (s) return s;
    try {
      s = new Segment(join(this.dir, e.name), e.name);
      if (e.del) s.setDeleted(readDel(this.dir, e.del, s.N));
      this.segs.set(e.name, s);
      return s;
    } catch {
      return undefined;
    }
  }

  /** The manifest being written to (the rebuild's, while rebuilding). */
  get target(): Manifest {
    return this.next ?? this.m;
  }

  entry(path: string): FileEntry | undefined {
    return this.pending.get(path) ?? this.target.files[path];
  }

  /** The manifest itself changed (first written, `built` flipped). */
  metaDirty = false;

  get dirty(): boolean {
    return (
      this.metaDirty ||
      !this.builder.empty ||
      this.pending.size > 0 ||
      this.deadFiles.size > 0 ||
      this.deadKeys.size > 0 ||
      this.removedPaths.size > 0
    );
  }

  close(): void {
    for (const s of this.segs.values()) s.close();
    this.segs.clear();
  }
}

export class Indexer {
  private writers = new Map<SearchSource, Writer>();
  private known = new Map<string, Known>();
  private hot = new Map<string, number>();
  private history: boolean;
  private release: (() => void) | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;
  private wantCommit = false;
  private wantRebuild = false;
  private wantSweep = true;
  private rootStamps = new Map<string, number>();
  private lastSweep = 0;
  private lastWork = Date.now();
  private status: IndexerStatus;
  private lastStatusAt = 0;
  private statusTimer: NodeJS.Timeout | null = null;
  private passStart = 0;
  private firstCommitDone = false;
  private lastFlush = 0;
  private lastYield = performance.now();
  private passSmall = false;
  /** Reads with docs in the builder ahead of their entry (see readFile). */
  private busy = 0;
  private readonly inProcess: boolean;
  private readonly idleExitMs: number;
  private readonly tickMs: number;
  private readonly sweepMs: number;

  constructor(
    private readonly o: IndexerOptions,
    x: IndexerInternals = {},
  ) {
    this.history = o.history;
    this.inProcess = !!x.inProcess;
    this.idleExitMs = x.idleExitMs ?? IDLE_EXIT_MS;
    this.tickMs = x.tickMs ?? TICK_MS;
    this.sweepMs = x.sweepMs ?? SWEEP_MS;
    this.wantRebuild = !!o.rebuild;
    this.status = { phase: "scanning", doneBytes: 0, totalBytes: 0, firstRun: true, gen: {} };
    o.signal?.addEventListener("abort", () => this.stop());
  }

  /** A message from the server (ToIndexer). */
  send(m: ToIndexer): void {
    switch (m.t) {
      case "hint":
        this.hot.set(m.path, Date.now());
        if (!this.known.has(m.path)) this.wantSweep = true;
        break;
      case "commit":
        this.wantCommit = true;
        break;
      case "rebuild":
        this.wantRebuild = true;
        break;
      case "history":
        if (m.on !== this.history) {
          this.history = m.on;
          if (!m.on) this.dropHistory();
          this.wantSweep = true;
        }
        break;
      case "forget":
        for (const w of this.writers.values()) w.deadKeys.add(m.key);
        this.wantCommit = true;
        break;
      case "stop":
        this.stop();
        return;
    }
    this.poke();
  }

  stop(): void {
    this.stopping = true;
    this.poke();
  }

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private adapters(): SourceAdapter[] {
    return this.o.adapters.filter((a) => a.source !== "history" || this.history);
  }

  private writer(source: SearchSource): Writer {
    let w = this.writers.get(source);
    if (!w) {
      w = new Writer(source, indexDir(this.o.dir, source));
      this.writers.set(source, w);
    }
    return w;
  }

  private dropHistory(): void {
    const w = this.writers.get("history");
    if (w) {
      w.close();
      this.writers.delete("history");
    }
    removeIndexDir(this.o.dir, "history");
    for (const [p, k] of this.known) if (k.adapter.source === "history") this.known.delete(p);
  }

  // ───────────────────────────── the loop ─────────────────────────────

  async run(): Promise<void> {
    ensureDir(this.o.dir);
    this.release = acquireLock(this.o.dir);
    try {
      if (!this.history) removeIndexDir(this.o.dir, "history");
      for (const s of new Set(this.adapters().map((a) => a.source))) this.writer(s);
      this.status.firstRun = this.firstRun();
      this.status.gen = this.gens();
      // first pass (or rebuild)
      await this.pass(true);
      if (this.o.mode === "once" || this.stopping) {
        await this.commitAll(true);
        await this.maybeMerge();
        return;
      }
      while (!this.stopping) {
        if (this.wantRebuild) {
          await this.pass(true);
          continue;
        }
        const now = Date.now();
        const full = this.wantSweep || now - this.lastSweep >= this.sweepMs || this.rootsMoved();
        const worked = full ? await this.pass(false) : await this.hotPass();
        if (worked) this.lastWork = Date.now();
        await this.maybeCommit();
        await this.maybeMerge();
        this.setStatus({ phase: "idle" });
        if (Date.now() - this.lastWork >= this.idleExitMs && !this.dirtyAny()) break;
        await this.sleep(this.tickMs);
      }
      await this.commitAll(true);
    } catch (e) {
      this.setStatus({ phase: "error", error: (e as Error).message }, true);
      throw e;
    } finally {
      for (const w of this.writers.values()) w.close();
      if (this.statusTimer) clearTimeout(this.statusTimer);
      this.release?.();
      this.release = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  private async pause(): Promise<void> {
    if (!this.inProcess) return;
    if (performance.now() - this.lastYield < 8) return;
    await new Promise<void>((r) => setImmediate(r));
    this.lastYield = performance.now();
  }

  private firstRun(): boolean {
    const w = this.writers.get(this.history ? "history" : "sessionpipe");
    return !(w?.m.built ?? false);
  }

  private gens(): IndexerStatus["gen"] {
    const g: IndexerStatus["gen"] = {};
    for (const [s, w] of this.writers) g[s] = w.m.gen;
    return g;
  }

  private dirtyAny(): boolean {
    for (const w of this.writers.values()) if (w.dirty) return true;
    return false;
  }

  private rootsMoved(): boolean {
    let moved = false;
    for (const a of this.adapters()) {
      for (const r of a.roots(this.o.env)) {
        let m = 0;
        try {
          m = statSync(r).mtimeMs;
        } catch {}
        const was = this.rootStamps.get(r);
        if (was !== undefined && was !== m) moved = true;
        this.rootStamps.set(r, m);
      }
    }
    return moved;
  }

  // ───────────────────────────── status ─────────────────────────────

  private setStatus(p: Partial<IndexerStatus>, now = false): void {
    Object.assign(this.status, p);
    if (p.phase && p.phase !== "error") delete this.status.error;
    if (!this.o.onStatus) return;
    const emit = () => {
      this.statusTimer = null;
      this.lastStatusAt = Date.now();
      this.status.gen = this.gens();
      this.status.firstRun = this.firstRun();
      const sk = this.skippedNow();
      if (sk.length) this.status.skipped = sk;
      else delete this.status.skipped;
      this.o.onStatus?.({ ...this.status, gen: { ...this.status.gen } });
    };
    if (now || Date.now() - this.lastStatusAt >= STATUS_MS) {
      if (this.statusTimer) clearTimeout(this.statusTimer);
      emit();
    } else if (!this.statusTimer) {
      this.statusTimer = setTimeout(emit, STATUS_MS - (Date.now() - this.lastStatusAt));
      this.statusTimer.unref?.();
    }
  }

  // ───────────────────────────── passes ─────────────────────────────

  /** A full pass: discover everything, read what changed (newest first). */
  private async pass(first: boolean): Promise<boolean> {
    const rebuild = this.wantRebuild;
    this.wantRebuild = false;
    this.wantSweep = false;
    this.lastSweep = Date.now();
    this.passStart = Date.now();
    this.rootsMoved();
    if (rebuild) for (const w of this.writers.values()) this.beginRebuild(w);
    this.setStatus({ phase: "scanning", doneBytes: 0, totalBytes: 0 }, first);
    const files: Known[] = [];
    const seen = new Set<string>();
    for (const a of this.adapters()) {
      let list: SourceFile[] = [];
      try {
        list = await a.discover(this.o.env);
      } catch {
        continue;
      }
      this.writer(a.source);
      for (const f of list) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        const k = { file: f, adapter: a };
        this.known.set(f.path, k);
        files.push(k);
        if (Date.now() - f.mtimeMs < HOT_MS) this.hot.set(f.path, f.mtimeMs);
      }
    }
    // files gone from disk
    for (const w of this.writers.values()) {
      for (const [p, e] of Object.entries(w.target.files)) {
        if (seen.has(p) || w.removedPaths.has(p)) continue;
        let gone = false;
        try {
          statSync(p);
        } catch (err) {
          gone = (err as NodeJS.ErrnoException).code === "ENOENT";
        }
        if (gone) {
          w.deadFiles.add(e.id);
          w.removedPaths.add(p);
          w.pending.delete(p);
          this.known.delete(p);
        }
      }
    }
    // newest first; ties by path (the order the sources' zstd batcher prefetches in)
    files.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs || (a.file.path < b.file.path ? -1 : 1));
    let total = 0;
    const plan: { k: Known; from: number }[] = [];
    for (const k of files) {
      const from = this.changed(k);
      if (from < 0) continue;
      plan.push({ k, from });
      total += Math.max(0, k.file.size - from);
    }
    this.setStatus({ phase: plan.length ? "building" : "idle", doneBytes: 0, totalBytes: total });
    // a pass that reads little ends about as soon as an early commit would land: skip it
    this.passSmall = total < SMALL_PASS;
    // One file at a time, newest first: the order the sources' zstd batcher prefetches in
    // (two readers at once measured slower: the batcher stops batching).
    let done = 0;
    for (const { k, from } of plan) {
      if (this.stopping) break;
      const before = done;
      done += await this.readFile(
        k,
        (n) => {
          this.setStatus({ doneBytes: Math.min(total, before + n) });
        },
        from,
      );
      this.setStatus({ doneBytes: Math.min(total, done) });
      await this.maybeFlush();
    }
    // the end of a first build (or a rebuild): commit, publish, merge everything
    const firstBuild = [...this.writers.values()].some((w) => !w.m.built || w.next);
    if (!this.stopping) {
      for (const w of this.writers.values()) {
        if (!w.target.built || w.target.gen === 0) w.metaDirty = true;
        w.target.built = true;
      }
      if (firstBuild || this.o.mode === "once") {
        await this.commitAll(true);
        // one merge at the end of a first build, when it left more than a few segments
        if (firstBuild && [...this.writers.values()].some((w) => w.m.segments.length > 4)) await this.mergeAll(true);
      }
    }
    this.setStatus({ phase: "idle", doneBytes: total, totalBytes: total }, true);
    return plan.length > 0 || this.dirtyAny();
  }

  /** The hot set: files changed recently or hinted, stat'ed every tick. */
  private async hotPass(): Promise<boolean> {
    let worked = false;
    const now = Date.now();
    for (const [p, at] of this.hot) {
      if (this.stopping) break;
      const k = this.known.get(p);
      if (!k) continue;
      let st: { size: number; mtimeMs: number };
      try {
        st = statSync(p);
      } catch {
        this.hot.delete(p);
        this.wantSweep = true;
        continue;
      }
      if (now - Math.max(at, st.mtimeMs) > HOT_MS) {
        this.hot.delete(p);
        continue;
      }
      k.file = { ...k.file, size: st.size, mtimeMs: st.mtimeMs };
      const from = this.changed(k);
      if (from < 0) continue;
      await this.readFile(k, () => {}, from);
      worked = true;
    }
    return worked;
  }

  /** Where to read `k` from: −1 nothing changed; 0 new or replaced (old docs tombstoned). */
  private changed(k: Known): number {
    const w = this.writer(k.adapter.source);
    const f = k.file;
    const e = w.entry(f.path);
    if (!e) return 0;
    if (e.skipped && e.size === f.size && e.mtimeMs === f.mtimeMs) return -1;
    if (f.kind === "whole" || e.kind === "whole") {
      if (e.size === f.size && e.mtimeMs === f.mtimeMs && !e.skipped) return -1;
      return 0;
    }
    // discovery stat'ed it: unchanged size and mtime is unchanged (a same-size, same-mtime
    // replace is not a thing harnesses do), so a quiet sweep costs no syscall per file
    if (f.size === e.size && f.mtimeMs === e.mtimeMs && f.size === e.offset) return -1;
    let st: { dev: number; ino: number; size: number };
    try {
      st = statSync(f.path);
    } catch {
      return -1;
    }
    if (st.ino !== e.ino || st.dev !== e.dev || st.size < e.offset) return 0;
    if (st.size === e.offset && f.mtimeMs === e.mtimeMs) return -1;
    if (e.headLen > 0 && headCrc(f.path, e.headLen) !== e.head) return 0;
    if (st.size === e.offset) {
      // touched, not grown: remember the mtime
      if (!w.since) w.since = Date.now();
      w.pending.set(f.path, { ...e, mtimeMs: f.mtimeMs });
      return -1;
    }
    return e.offset;
  }

  /** Read one file (from its committed offset, or from 0 when new or replaced). Returns
   *  the bytes read. */
  private async readFile(k: Known, progress: (n: number) => void, from: number): Promise<number> {
    if (k.adapter.source === "history" && !this.history) return 0;
    const w = this.writer(k.adapter.source);
    const f = k.file;
    let e = w.entry(f.path);
    if (from < 0) return 0;
    let st: { dev: number; ino: number; size: number; mtimeMs: number };
    try {
      st = statSync(f.path);
    } catch {
      return 0;
    }
    if (from === 0 && e) {
      // replaced, shrunk or rewritten: its old docs die with its id
      w.deadFiles.add(e.id);
      e = undefined;
    }
    const t = w.target;
    const entry: FileEntry = e
      ? { ...e }
      : {
          id: t.nextFile++,
          adapter: k.adapter.id,
          kind: f.kind,
          dev: st.dev,
          ino: st.ino,
          size: 0,
          mtimeMs: 0,
          offset: 0,
          head: 0,
          headLen: 0,
          lastAt: 0,
        };
    if (f.key) entry.key = f.key;
    w.removedPaths.delete(f.path);
    const b = w.builder;
    let emitted = 0;
    const sink: DocSink = {
      doc: (d: SearchDoc) => {
        emitted++;
        if (d.at > 0) {
          if (d.at > entry.lastAt) entry.lastAt = d.at;
          b.add(d, entry.id);
        } else b.add({ ...d, at: entry.lastAt }, entry.id);
      },
      facts: (x: SessionFacts) => {
        emitted++;
        b.facts(x, entry.id);
      },
    };
    const file: SourceFile = { ...f, size: st.size, mtimeMs: st.mtimeMs };
    let read = 0;
    let offset = entry.offset;
    let state = entry.state;
    const slice = this.inProcess ? SLICE_BYTES_INPROC : SLICE_BYTES;
    // busy: this file's docs are in the builder ahead of its entry (no flush may commit them)
    this.busy++;
    try {
      for (;;) {
        let r: Awaited<ReturnType<SourceAdapter["read"]>>;
        try {
          r = await k.adapter.read(file, state !== undefined ? { offset, state } : { offset }, sink, {
            maxBytes: slice,
          });
        } catch {
          r = { offset, skipped: "unreadable" };
        }
        if (r.skipped) {
          entry.skipped = r.skipped;
          break;
        }
        delete entry.skipped;
        if (r.state !== undefined) state = r.state;
        if (file.kind === "whole") {
          offset = r.offset;
          read = st.size;
          break;
        }
        const moved = r.offset - offset;
        read += Math.max(0, moved);
        offset = r.offset;
        progress(read);
        if (moved <= 0 || offset >= st.size) break;
        // between slices: keep the entry current, so a flush commits exactly what was read
        this.store(w, f.path, entry, st, offset, state);
        this.busy--;
        try {
          await this.maybeFlush();
          await this.pause();
        } finally {
          this.busy++;
        }
        if (this.stopping) break;
      }
      // a known file that gave nothing new (a partial last line still being written) is left
      // as committed: no MANIFEST write for it; the next pass looks again
      const nothing =
        e !== undefined &&
        !emitted &&
        offset === e.offset &&
        (state === e.state || JSON.stringify(state) === JSON.stringify(e.state)) &&
        !!entry.skipped === !!e.skipped &&
        f.kind === "append";
      if (!nothing) this.store(w, f.path, entry, st, offset, state);
    } finally {
      this.busy--;
    }
    await this.pause();
    return read;
  }

  private store(
    w: Writer,
    path: string,
    entry: FileEntry,
    st: { dev: number; ino: number; size: number; mtimeMs: number },
    offset: number,
    state: FileEntry["state"],
  ): void {
    entry.offset = offset;
    entry.size = st.size;
    entry.mtimeMs = st.mtimeMs;
    entry.dev = st.dev;
    entry.ino = st.ino;
    if (state !== undefined) entry.state = state;
    if (entry.kind === "append" && entry.headLen < HEAD_BYTES && offset > entry.headLen) {
      entry.headLen = Math.min(HEAD_BYTES, offset);
      entry.head = headCrc(path, entry.headLen);
    }
    if (!w.since) w.since = Date.now();
    w.pending.set(path, { ...entry });
  }

  /** Files an adapter could not read here, from the entries (each file once). */
  private skippedNow(): NonNullable<IndexerStatus["skipped"]> {
    const by = new Map<string, { harness: string; files: number; why: "zstd" | "unreadable" }>();
    for (const w of this.writers.values()) {
      const count = (e: FileEntry) => {
        if (!e.skipped) return;
        const harness = HARNESS_OF[e.adapter] ?? e.adapter;
        const k = `${harness}\u0000${e.skipped}`;
        const x = by.get(k) ?? { harness, files: 0, why: e.skipped };
        x.files++;
        by.set(k, x);
      };
      for (const [p, e] of Object.entries(w.target.files)) if (!w.pending.has(p)) count(e);
      for (const e of w.pending.values()) count(e);
    }
    return [...by.values()];
  }

  // ───────────────────────────── commits ─────────────────────────────

  /** Mid-pass flushes: the first commit within a second, then by size or time. */
  private async maybeFlush(): Promise<void> {
    if (this.busy > 0) return; // another file is between its docs and its entry
    const now = Date.now();
    const limit = this.inProcess ? FLUSH_CHARS_INPROC : FLUSH_CHARS;
    for (const w of this.writers.values()) {
      const chars = w.builder.textChars;
      const firstDue =
        !this.firstCommitDone && !this.passSmall && now - this.passStart >= FIRST_COMMIT_MS && !w.builder.empty;
      const sizeDue = chars >= limit;
      const timeDue = !w.builder.empty && now - this.lastFlush >= FLUSH_MS && now - this.passStart >= FLUSH_MS;
      if (firstDue || sizeDue || timeDue) {
        await this.commit(w, false);
        this.firstCommitDone = true;
        this.lastFlush = Date.now();
      }
    }
  }

  private async maybeCommit(): Promise<void> {
    const now = Date.now();
    for (const w of this.writers.values()) {
      if (!w.dirty) continue;
      const b = w.builder;
      const since = Math.min(b.since || now, w.since || now);
      if (
        this.wantCommit ||
        b.textChars >= COMMIT_CHARS ||
        now - since >= COMMIT_AGE_MS ||
        // tombstones (a forget, a deleted file) show soon
        w.deadFiles.size > 0 ||
        w.deadKeys.size > 0 ||
        w.removedPaths.size > 0
      )
        await this.commit(w, true);
    }
    this.wantCommit = false;
  }

  private async commitAll(force: boolean): Promise<void> {
    for (const w of this.writers.values()) if (w.dirty || force) await this.commit(w, true);
  }

  private beginRebuild(w: Writer): void {
    w.builder.reset();
    w.pending.clear();
    w.deadFiles.clear();
    w.deadKeys.clear();
    w.removedPaths.clear();
    w.next = { ...emptyManifest(w.source), gen: w.m.gen, nextSeg: w.m.nextSeg, nextFile: w.m.nextFile };
  }

  /** Write the builder as a segment, apply tombstones, then the MANIFEST (the commit point).
   *  While rebuilding, segments go into the rebuild's manifest, published only at the end. */
  private async commit(w: Writer, final: boolean): Promise<void> {
    if (!w.dirty && !(final && w.next)) return;
    const t = w.target;
    const superseded: string[] = [];
    if (!w.builder.empty) {
      const name = `seg-${t.nextSeg++}.sps`;
      const path = join(w.dir, name);
      const r = w.builder.encode(`${path}.tmp`);
      renameSync(`${path}.tmp`, path);
      w.builder.reset();
      t.segments.push({ name, docs: r.docs, bytes: r.bytes, crc: r.crc, dels: 0 });
      await this.pause();
    }
    for (const [p, e] of w.pending) t.files[p] = e;
    w.pending.clear();
    w.since = 0;
    for (const p of w.removedPaths) delete t.files[p];
    w.removedPaths.clear();
    if (w.deadFiles.size || w.deadKeys.size) {
      superseded.push(...this.tombstone(w, t));
      w.deadFiles.clear();
      w.deadKeys.clear();
    }
    if (w.next && !final) return; // a rebuild publishes once, at the end
    if (w.next) {
      // publish the rebuild: the old generation's files go
      const keep = new Set(w.next.segments.map((s) => s.name));
      for (const s of w.m.segments) {
        if (!keep.has(s.name)) {
          superseded.push(s.name);
          if (s.del) superseded.push(s.del);
          w.segs.get(s.name)?.close();
          w.segs.delete(s.name);
        }
      }
      w.next.trash = w.m.trash ?? [];
      w.m = w.next;
      w.next = null;
    }
    w.m.gen++;
    writeManifest(w.dir, w.m);
    w.metaDirty = false;
    unlinkLater(w.dir, w.m, superseded);
    this.o.onCommit?.(w.source, w.m.gen);
    this.setStatus({}, false);
  }

  /** Mark dead files' and forgotten sessions' docs; returns the files superseded. */
  private tombstone(w: Writer, t: Manifest): string[] {
    const superseded: string[] = [];
    const keep: SegEntry[] = [];
    for (const e of t.segments) {
      const seg = w.seg(e);
      if (!seg) {
        keep.push(e);
        continue;
      }
      const files = seg.meta.files;
      let fileHit = false;
      for (const id of files) if (w.deadFiles.has(id)) fileHit = true;
      const sessHit = seg.meta.sessions.some((s) => w.deadKeys.has(s.key));
      if (!fileHit && !sessHit) {
        keep.push(e);
        continue;
      }
      const bits = seg.del ? seg.del.slice() : new Uint8Array(Math.ceil(seg.N / 8));
      const deadLocal = new Uint8Array(seg.meta.sessions.length);
      seg.meta.sessions.forEach((s, i) => {
        if (w.deadKeys.has(s.key)) deadLocal[i] = 1;
      });
      const deadOrd = new Uint8Array(files.length);
      files.forEach((id, i) => {
        if (w.deadFiles.has(id)) deadOrd[i] = 1;
      });
      let count = 0;
      const chunk = 8192;
      for (let from = 0; from < seg.N; from += chunk) {
        const to = Math.min(seg.N, from + chunk);
        const rows = fileHit ? seg.rows(from, to) : null;
        for (let d = from; d < to; d++) {
          let dead = deadLocal[seg.dsess[d]!] === 1;
          if (!dead && rows) {
            const p = (d - from) * ROW + 28;
            const ord = rows[p]! | (rows[p + 1]! << 8) | (rows[p + 2]! << 16) | (rows[p + 3]! << 24);
            dead = deadOrd[ord >>> 0] === 1;
          }
          if (dead) bits[d >> 3]! |= 1 << (d & 7);
        }
      }
      for (let d = 0; d < seg.N; d++) if (bits[d >> 3]! & (1 << (d & 7))) count++;
      if (count === e.dels) {
        keep.push(e);
        continue;
      }
      if (count >= seg.N) {
        // every doc gone: drop the segment
        superseded.push(e.name);
        if (e.del) superseded.push(e.del);
        seg.close();
        w.segs.delete(e.name);
        continue;
      }
      const name = delName(e.name, t.gen + 1);
      writeDel(w.dir, name, bits);
      if (e.del && e.del !== name) superseded.push(e.del);
      seg.setDeleted(bits);
      keep.push({ ...e, del: name, dels: count });
    }
    t.segments = keep;
    return superseded;
  }

  // ───────────────────────────── merges ─────────────────────────────

  private async maybeMerge(): Promise<void> {
    for (const w of this.writers.values()) {
      if (this.stopping) return;
      const segs = w.m.segments;
      // a heavily deleted segment is rewritten alone
      const heavy = segs.findIndex((s) => s.docs > 0 && s.dels / s.docs > DELETED_REWRITE);
      if (heavy >= 0) {
        await this.merge(w, heavy, heavy + 1);
        continue;
      }
      if (segs.length <= MAX_SEGMENTS) continue;
      // the contiguous window with the fewest docs (keeps commit order for the facts)
      let best = 0;
      let bestDocs = Number.POSITIVE_INFINITY;
      for (let i = 0; i + MERGE_WINDOW <= segs.length; i++) {
        let n = 0;
        for (let k = i; k < i + MERGE_WINDOW; k++) n += segs[k]!.docs - segs[k]!.dels;
        if (n < bestDocs) {
          bestDocs = n;
          best = i;
        }
      }
      if (bestDocs <= MAX_MERGED_DOCS) await this.merge(w, best, best + MERGE_WINDOW);
    }
  }

  /** After a first build or `once`: merge contiguous runs up to the 512k-doc cap. */
  private async mergeAll(always: boolean): Promise<void> {
    for (const w of this.writers.values()) {
      if (this.stopping) return;
      if (!always && w.m.segments.length <= 1) continue;
      let i = 0;
      while (i < w.m.segments.length) {
        let j = i;
        let n = 0;
        while (j < w.m.segments.length && n + (w.m.segments[j]!.docs - w.m.segments[j]!.dels) <= MAX_MERGED_DOCS) {
          n += w.m.segments[j]!.docs - w.m.segments[j]!.dels;
          j++;
        }
        if (j === i) j = i + 1;
        const run = w.m.segments.slice(i, j);
        if (run.length > 1 || (run.length === 1 && run[0]!.dels > 0)) await this.merge(w, i, j);
        i++;
      }
    }
  }

  /** Merge segments [i, j) of `w` into one, in place in the list. */
  private async merge(w: Writer, i: number, j: number): Promise<void> {
    const entries = w.m.segments.slice(i, j);
    const inputs = entries.map((e) => w.seg(e)).filter((s): s is Segment => !!s);
    if (inputs.length !== entries.length || !inputs.length) return;
    this.setStatus({ phase: "merging" });
    const name = `seg-${w.m.nextSeg++}.sps`;
    const path = join(w.dir, name);
    const live = new Set<number>();
    for (const e of Object.values(w.m.files)) live.add(e.id);
    for (const e of w.pending.values()) live.add(e.id);
    const r = await mergeSegments(inputs, `${path}.tmp`, () => this.yieldNow(), live);
    renameSync(`${path}.tmp`, path);
    // tombstones that arrived while merging are applied at the next commit (ids are stable)
    const superseded: string[] = [];
    for (const e of entries) {
      superseded.push(e.name);
      if (e.del) superseded.push(e.del);
      w.segs.get(e.name)?.close();
      w.segs.delete(e.name);
    }
    const out = { name, docs: r.docs, bytes: r.bytes, crc: r.crc, dels: 0 };
    w.m.segments.splice(i, j - i, ...(r.docs > 0 ? [out] : []));
    w.m.gen++;
    writeManifest(w.dir, w.m);
    unlinkLater(w.dir, w.m, superseded);
    this.o.onCommit?.(w.source, w.m.gen);
    this.setStatus({ phase: "idle" });
  }

  private async yieldNow(): Promise<void> {
    if (this.inProcess) await new Promise<void>((r) => setImmediate(r));
  }
}

const HARNESS_OF: Record<string, string> = {
  claude: "claude-code",
  codex: "codex",
  antigravity: "antigravity",
  gemini: "gemini-cli",
  events: "sessionpipe",
};

/** A segment file is whole: its footer is sane and its crc32 holds (19 MB: ~3 ms with
 *  zlib.crc32). Flipped or lost bytes anywhere are caught here, at the writer's start. */
function segmentLooksWhole(path: string, bytes: number): boolean {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size < 16 || (bytes && size !== bytes)) return false;
    const t = Buffer.allocUnsafe(12);
    readSync(fd, t, 0, 12, size - 12);
    if (t.readUInt32LE(8) !== MAGIC || t.readUInt32LE(0) !== SECTIONS) return false;
    const want = t.readUInt32LE(4);
    const buf = Buffer.allocUnsafe(1 << 20);
    let acc = 0;
    const total = size - 8;
    for (let p = 0; p < total; ) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, total - p), p);
      if (n <= 0) return false;
      acc = crc32(buf.subarray(0, n), acc);
      p += n;
    }
    return acc === want;
  } catch {
    return false;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

const HEAD = Buffer.allocUnsafe(HEAD_BYTES);
function headCrc(path: string, len: number): number {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const n = readSync(fd, HEAD, 0, len, 0);
    return crc32(HEAD.subarray(0, n));
  } catch {
    return -1;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** The writer loop (SEARCH-SPEC §3.2). In-process callers (tests, the service's fallback)
 *  get yields every few ms. */
export async function runIndexer(o: IndexerOptions, x?: IndexerInternals): Promise<void> {
  // `once` owns its process (the CLI, the bench): full speed. `watch` in-process shares the
  // server's loop: small slices and yields.
  await new Indexer(o, x ?? { inProcess: o.mode === "watch" }).run();
}

/** An indexer and a way to talk to it, in this process. */
export function startIndexer(
  o: IndexerOptions,
  x: IndexerInternals = { inProcess: true },
): { send(m: ToIndexer): void; done: Promise<void> } {
  const ix = new Indexer(o, x);
  return { send: (m) => ix.send(m), done: ix.run() };
}
