// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The live tail (arch-engine.md §8): bytes nobody has committed yet.
// A pure function of the reader's manifest offsets and the bytes on disk, never a second index
// that can drift: complete lines past the committed offset of each hot file are read into a
// RAM builder per index, and on the next query that builder is encoded and read as one more
// segment (the same reader as on disk). After a commit the reader resets it from the new
// offsets. Bounded: at most 4 MB of text; past that it asks for a commit.
import { statSync } from "node:fs";
import type {
  AdapterState,
  DocSink,
  SearchDoc,
  SearchSource,
  SessionFacts,
  SourceAdapter,
  SourceEnv,
  SourceFile,
} from "../types.js";
import { Builder } from "./builder.js";
import type { FileEntry } from "./manifest.js";
import { provisionalId } from "./refs.js";
import { Segment } from "./segment.js";

export const TAIL_MAX_CHARS = 4 * 1024 * 1024;
/** Small tail segments kept before they are folded into one. */
const TAIL_SEGMENTS = 6;
/** A file changed within this long is hot (stat'ed on every tick). */
export const HOT_MS = 15 * 60_000;
/** At most one discovery per this long (it costs the adapters a walk). */
const DISCOVER_MS = 1_000;
const WHOLE_MAX = 4 * 1024 * 1024;

interface TailFile {
  file: SourceFile;
  adapter: SourceAdapter;
  source: SearchSource;
  fileId: number;
  offset: number;
  state?: AdapterState;
  lastAt: number;
  /** A whole file read once (it is not re-read until the next reset). */
  done: boolean;
  /** Not something the tail can read (replaced, rewritten, too big): the writer will. */
  skip: boolean;
}

export interface Committed {
  /** The committed entry of a path in one index. */
  entry(source: SearchSource, path: string): FileEntry | undefined;
  /** Every committed path with its entry. */
  each(fn: (source: SearchSource, path: string, e: FileEntry) => void): void;
}

export class LiveTail {
  private files = new Map<string, TailFile>();
  private hot = new Set<string>();
  private known = new Map<string, { file: SourceFile; adapter: SourceAdapter }>();
  /** Everything the tail read since the last reset, and what arrived since the last encode. */
  private builders = new Map<SearchSource, Builder>();
  private deltas = new Map<SearchSource, Builder>();
  private segs: { source: SearchSource; seg: Segment }[] = [];
  private dirty = false;
  private running: Promise<void> | null = null;
  private lastDiscover = 0;
  private discoverSoon = true;
  private rootStamps = new Map<string, number>();
  private rootsPending = false;
  private epoch = 0;
  /** True when the tail hit its bound: the writer should commit. */
  wantsCommit = false;
  /** ms of the last pass (the budget: < 50 ms on a quiet machine). */
  lastPassMs = 0;

  constructor(
    private readonly env: SourceEnv,
    private readonly adapters: readonly SourceAdapter[],
    private readonly sources: readonly SearchSource[],
    private readonly committed: Committed,
    private readonly onChange: () => void,
  ) {}

  private enabled(a: SourceAdapter): boolean {
    return this.sources.includes(a.source);
  }

  hint(path: string): void {
    this.hot.add(path);
    if (!this.known.has(path) && !this.files.has(path)) this.discoverSoon = true;
  }

  /** Forget every tail doc (the committed offsets moved). Hot files stay hot. */
  reset(): void {
    this.epoch++;
    for (const f of this.files.values()) this.hot.add(f.file.path);
    this.files.clear();
    for (const b of this.builders.values()) b.reset();
    for (const b of this.deltas.values()) b.reset();
    for (const s of this.segs) s.seg.close();
    this.segs = [];
    this.dirty = false;
    this.wantsCommit = false;
  }

  /** Start a pass unless one is running; resolves when it ends. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const p = this.pass().finally(() => {
      if (this.running === p) this.running = null;
    });
    this.running = p;
    return p;
  }

  get chars(): number {
    let n = 0;
    for (const b of this.builders.values()) n += b.textChars;
    return n;
  }

  /** The tail as segments (encoded on demand when it changed). Only what arrived since the
   *  last call is encoded, as one more small segment; past TAIL_SEGMENTS of them they are
   *  replaced by one encoding of the whole tail. */
  segments(): { source: SearchSource; seg: Segment }[] {
    if (!this.dirty) return this.segs;
    for (const [source, d] of this.deltas) {
      if (d.empty) continue;
      const mine = this.segs.filter((x) => x.source === source);
      const whole = mine.length >= TAIL_SEGMENTS;
      const r = (whole ? this.builder(source) : d).encode();
      const seg = { source, seg: new Segment(r.buffer!, `tail-${source}-${this.segs.length}`) };
      if (whole) {
        for (const x of mine) x.seg.close();
        this.segs = [...this.segs.filter((x) => x.source !== source), seg];
      } else this.segs = [...this.segs, seg];
      d.reset();
    }
    this.dirty = false;
    return this.segs;
  }

  /** Path of a provisional (tail-only) file id. */
  pathOf(fileId: number): string | undefined {
    for (const f of this.files.values()) if (f.fileId === fileId) return f.file.path;
    return undefined;
  }

  /** A root folder's mtime moved (a new session or subagent file): discover again. */
  private rootsMoved(): boolean {
    let moved = false;
    for (const a of this.adapters) {
      if (!this.enabled(a)) continue;
      for (const r of a.roots(this.env)) {
        let m = 0;
        try {
          m = statSync(r).mtimeMs;
        } catch {}
        const was = this.rootStamps.get(r);
        if (was !== m) {
          if (was !== undefined) moved = true;
          this.rootStamps.set(r, m);
        }
      }
    }
    return moved;
  }

  private async discover(): Promise<void> {
    this.lastDiscover = Date.now();
    this.discoverSoon = false;
    const now = Date.now();
    for (const a of this.adapters) {
      if (!this.enabled(a)) continue;
      let list: SourceFile[] = [];
      try {
        list = await a.discover(this.env);
      } catch {
        continue;
      }
      for (const f of list) {
        this.known.set(f.path, { file: f, adapter: a });
        const e = this.committed.entry(a.source, f.path);
        if (now - f.mtimeMs > HOT_MS && !this.hot.has(f.path)) continue;
        // Changed lately: hot even when fully committed, so the session someone is in right
        // now is read on the next tick after its next line (nothing hints a history file).
        if (!e || f.kind === "append") this.hot.add(f.path);
      }
    }
  }

  private async pass(): Promise<void> {
    const t0 = performance.now();
    const epoch = this.epoch;
    // discovery only at first, when a root folder moved, or for a hinted unknown file; the
    // hot files themselves are one stat each
    const moved = this.rootsMoved();
    if (!this.lastDiscover || this.discoverSoon || (moved && Date.now() - this.lastDiscover >= DISCOVER_MS))
      await this.discover();
    else if (moved) this.rootsPending = true;
    if (this.rootsPending && Date.now() - this.lastDiscover >= DISCOVER_MS) {
      this.rootsPending = false;
      await this.discover();
    }
    let changed = false;
    for (const path of this.hot) {
      if (epoch !== this.epoch) break;
      if (this.chars >= TAIL_MAX_CHARS) {
        this.wantsCommit = true;
        break;
      }
      const k = this.known.get(path);
      if (!k) continue;
      let tf = this.files.get(path);
      let st: { size: number; mtimeMs: number; ino: number };
      try {
        st = statSync(path);
      } catch {
        this.hot.delete(path);
        continue;
      }
      if (Date.now() - st.mtimeMs > HOT_MS && !tf) {
        // cooled down with nothing for us to read
        const e = this.committed.entry(k.adapter.source, path);
        if (e && st.size <= e.offset) this.hot.delete(path);
      }
      if (!tf) {
        const e = this.committed.entry(k.adapter.source, path);
        tf = {
          file: k.file,
          adapter: k.adapter,
          source: k.adapter.source,
          fileId: e ? e.id : provisionalId(path),
          offset: 0,
          lastAt: e?.lastAt ?? 0,
          done: false,
          skip: false,
        };
        if (e) {
          if (e.kind === "whole" || e.ino !== st.ino || st.size < e.offset || e.skipped) tf.skip = true;
          else {
            tf.offset = e.offset;
            if (e.state !== undefined) tf.state = e.state;
          }
        } else if (k.file.kind === "whole" && st.size > WHOLE_MAX) tf.skip = true;
        this.files.set(path, tf);
      }
      if (tf.skip || tf.done) continue;
      if (st.size <= tf.offset) continue;
      const b = this.builder(tf.source);
      const delta = this.delta(tf.source);
      const fileId = tf.fileId;
      const sink: DocSink = {
        doc: (d: SearchDoc) => {
          if (epoch !== this.epoch) return;
          if (d.at > 0) tf!.lastAt = Math.max(tf!.lastAt, d.at);
          const doc = d.at > 0 ? d : { ...d, at: tf!.lastAt };
          b.add(doc, fileId);
          delta.add(doc, fileId);
        },
        facts: (f: SessionFacts) => {
          if (epoch !== this.epoch) return;
          b.facts(f, fileId);
          delta.facts(f, fileId);
        },
      };
      const file: SourceFile = { ...tf.file, size: st.size, mtimeMs: st.mtimeMs };
      try {
        const cursor = tf.state !== undefined ? { offset: tf.offset, state: tf.state } : { offset: tf.offset };
        const r = await tf.adapter.read(file, cursor, sink, file.kind === "append" ? { endOffset: st.size } : {});
        if (epoch !== this.epoch) break;
        if (r.skipped) tf.skip = true;
        if (file.kind === "whole") tf.done = true;
        else tf.offset = r.offset;
        if (r.state !== undefined) tf.state = r.state;
        changed = true;
      } catch {
        tf.skip = true;
      }
    }
    if (changed && epoch === this.epoch) {
      this.dirty = true;
      this.onChange();
    }
    this.lastPassMs = performance.now() - t0;
  }

  private delta(source: SearchSource): Builder {
    let b = this.deltas.get(source);
    if (!b) {
      b = new Builder();
      this.deltas.set(source, b);
    }
    return b;
  }

  private builder(source: SearchSource): Builder {
    let b = this.builders.get(source);
    if (!b) {
      b = new Builder();
      this.builders.set(source, b);
    }
    return b;
  }

  close(): void {
    this.epoch++;
    for (const s of this.segs) s.seg.close();
    this.segs = [];
  }
}
