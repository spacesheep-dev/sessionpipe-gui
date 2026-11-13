// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. What the person has seen (shared/api.ts Marks): one small
// document, the same on every device. A session is read up to the
// `newsAt` it had when it was on screen, and may be marked unread by hand; `since` is when
// the file was made, so news from before this receiver kept marks is read. Like labels it
// is the person's, not a reading, so it lives beside the store: GET reads it, PATCH merges
// into it, and every change goes to every page as one `marks` stream frame. Forgetting a
// session forgets its marks. It also keeps each session's own "Notify me" when it is not
// the default (`notify`), so a muted session is muted on every device. Where the document
// is kept is its opener's (docKeep.ts): the receiver's is <stateDir>/marks.json (marks.ts
// MarkStore). Nothing here is Node's.
import {
  MARKS_MAX,
  type Marks,
  type MarksPatch,
  type NotifyLevel,
  type SessionKey,
  type StreamMessage,
} from "../../shared/api.js";
import { utf8Bytes } from "../store/log.js";
import type { DocKeep } from "./docKeep.js";

/** The file's ceiling, like labels.json. */
export const MARKS_FILE_MAX = 256 * 1024;
/** What `Date.toISOString` writes, the only time the store writes. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The levels a session may be set to; the default, "needs", is stored as nothing. */
const isLevel = (v: unknown): v is Exclude<NotifyLevel, "needs"> => v === "finishes" || v === "never";

/** The document as this server keeps it: `since` set and `notify` always present. */
type Doc = Marks & { since: string; notify: NonNullable<Marks["notify"]> };

/** Why a patch was refused, as the route's `reason`. */
export class MarksError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

export class MarksCore {
  private doc: Doc;
  private readonly listeners = new Set<(m: StreamMessage) => void>();

  /** `keep`: where the document is kept. `known`: whether the store has a session (a key
   *  it does not know is skipped, so no orphan keys). `now` for tests. */
  constructor(
    private readonly keep: DocKeep,
    private readonly known: (key: SessionKey) => boolean,
    now: () => number = Date.now,
  ) {
    const had = this.load();
    // The first run makes the document, so `since` is set once, when its keeper began to
    // keep marks, and never moves.
    this.doc = had ?? { rev: 0, since: new Date(now()).toISOString(), read: {}, unread: {}, notify: {} };
    if (!had) {
      try {
        this.write(this.doc);
      } catch (e) {
        console.error("[marks] %s", (e as Error).message);
      }
    }
  }

  get(): Marks {
    return this.doc;
  }

  /** Apply a merge; returns the document after it. Throws MarksError. */
  patch(p: MarksPatch): Marks {
    if (!isMap(p)) throw new MarksError(400, "malformed");
    for (const k of Object.keys(p))
      if (k !== "read" && k !== "unread" && k !== "notify") throw new MarksError(400, "malformed");
    if (p.read !== undefined && !isMap(p.read)) throw new MarksError(400, "malformed");
    if (p.unread !== undefined && !isMap(p.unread)) throw new MarksError(400, "malformed");
    if (p.notify !== undefined && !isMap(p.notify)) throw new MarksError(400, "malformed");
    const reads = Object.entries(p.read ?? {}) as [SessionKey, unknown][];
    const unreads = Object.entries(p.unread ?? {}) as [SessionKey, unknown][];
    const levels = Object.entries(p.notify ?? {}) as [SessionKey, unknown][];
    // Every value first: a refused patch changes nothing.
    for (const [, v] of reads) if (v !== null && !isIso(v)) throw new MarksError(400, "bad_read");
    for (const [, v] of unreads) if (v !== null && v !== true) throw new MarksError(400, "bad_unread");
    for (const [, v] of levels) if (v !== null && !isLevel(v)) throw new MarksError(400, "bad_notify");
    const read = { ...this.doc.read };
    const unread = { ...this.doc.unread };
    const notify = { ...this.doc.notify };
    let changed = false;
    // A read mark only moves on: a second device sending the older `newsAt` it saw (its
    // PATCH late, or held in its 2 s queue) never makes news already seen unread again.
    for (const [key, at] of reads as [SessionKey, string | null][]) {
      if (at === null) {
        if (key in read) {
          delete read[key];
          changed = true;
        }
      } else if (!(read[key] && read[key] >= at) && this.known(key)) {
        read[key] = at;
        changed = true;
      }
    }
    for (const [key, on] of unreads) {
      if (on === null) {
        if (key in unread) {
          delete unread[key];
          changed = true;
        }
      } else if (!unread[key] && this.known(key)) {
        unread[key] = true;
        changed = true;
      }
    }
    for (const [key, level] of levels as [SessionKey, Doc["notify"][SessionKey] | null][]) {
      if (level === null) {
        if (key in notify) {
          delete notify[key];
          changed = true;
        }
      } else if (notify[key] !== level && this.known(key)) {
        notify[key] = level;
        changed = true;
      }
    }
    if (!changed) return this.doc;
    this.commit({ ...this.doc, rev: this.doc.rev + 1, read, unread, notify });
    return this.doc;
  }

  /** Everything up to `at` is read: `since` moves up to it, never back, and the read marks
   *  it passes go (they say no more than it does). For an opener whose history arrives
   *  after the document was made: a page's read of a relay from its start is all of it
   *  history, and none of it news. The receiver, whose events arrive as they happen, never
   *  calls it. */
  sinceAtLeast(at: string): Marks {
    if (!isIso(at) || at <= this.doc.since) return this.doc;
    const read: Marks["read"] = {};
    for (const [k, v] of Object.entries(this.doc.read)) if (v > at) read[k] = v;
    this.commit({ ...this.doc, rev: this.doc.rev + 1, since: at, read });
    return this.doc;
  }

  /** The session is gone (the UI's forget, or a session.forgotten): so are its marks. */
  forget(key: SessionKey): void {
    if (!(key in this.doc.read) && !(key in this.doc.unread) && !(key in this.doc.notify)) return;
    const read = { ...this.doc.read };
    const unread = { ...this.doc.unread };
    const notify = { ...this.doc.notify };
    delete read[key];
    delete unread[key];
    delete notify[key];
    this.commit({ ...this.doc, rev: this.doc.rev + 1, read, unread, notify });
  }

  /** Follow the store: a `forgotten` message drops that session's marks. */
  follow(store: { subscribe(l: (m: StreamMessage) => void): () => void }): () => void {
    return store.subscribe((m) => {
      if (m.kind === "forgotten") this.forget(m.key);
    });
  }

  subscribe(l: (m: StreamMessage) => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private commit(next: Doc): void {
    const kept = fit(next);
    this.write(kept);
    this.doc = kept;
    for (const l of this.listeners) {
      try {
        l({ kind: "marks", marks: kept });
      } catch (e) {
        console.error("[marks] listener: %s", (e as Error).message);
      }
    }
  }

  private write(doc: Marks): void {
    this.keep.save({ v: 1, ...doc });
  }

  /** What was kept, as it is, or null with nothing kept; a broken one is set aside (never
   *  lost) and the marks start again. Entries that do not validate are dropped. */
  private load(): Doc | null {
    try {
      const raw = this.keep.load() as Partial<Marks> | undefined;
      if (raw === undefined) return null;
      if (!isIso(raw.since)) throw new Error("no since");
      const read: Marks["read"] = {};
      const unread: Marks["unread"] = {};
      const notify: Doc["notify"] = {};
      for (const [k, v] of Object.entries(isMap(raw.read) ? raw.read : {})) if (isIso(v)) read[k] = v;
      for (const [k, v] of Object.entries(isMap(raw.unread) ? raw.unread : {})) if (v === true) unread[k] = true;
      for (const [k, v] of Object.entries(isMap(raw.notify) ? raw.notify : {})) if (isLevel(v)) notify[k] = v;
      const rev = typeof raw.rev === "number" && Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;
      return fit({ rev, since: raw.since, read, unread, notify });
    } catch {
      this.keep.setAside?.();
      return null;
    }
  }
}

/** Within the caps: MARKS_MAX keys a map and MARKS_FILE_MAX for the file, the oldest read
 *  values going first (`since` moves up to the newest dropped, so they stay read), then the earliest unread; past
 *  MARKS_MAX, the earliest notify levels go back to the default. */
function fit<T extends Marks>(doc: T): T {
  const size = (d: Marks) => utf8Bytes(JSON.stringify({ v: 1, ...d }));
  if (
    Object.keys(doc.read).length <= MARKS_MAX &&
    Object.keys(doc.unread).length <= MARKS_MAX &&
    Object.keys(doc.notify ?? {}).length <= MARKS_MAX &&
    size(doc) <= MARKS_FILE_MAX
  )
    return doc;
  let read = Object.entries(doc.read)
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .slice(-MARKS_MAX);
  let unread = Object.keys(doc.unread).slice(-MARKS_MAX);
  const build = (): T => ({
    ...doc,
    read: Object.fromEntries(read),
    unread: Object.fromEntries(unread.map((k) => [k, true])),
    ...(doc.notify && { notify: Object.fromEntries(Object.entries(doc.notify).slice(-MARKS_MAX)) }),
  });
  let next = build();
  // A twentieth at a time: a few passes even for a file far over.
  while (size(next) > MARKS_FILE_MAX && (read.length || unread.length)) {
    if (read.length) read = read.slice(Math.ceil(read.length / 20));
    else unread = unread.slice(Math.ceil(unread.length / 20));
    next = build();
  }
  // A session whose read mark went falls back to `since`; left where it was, every one
  // of them with news after it came back unread, and Mark all as read put the same old
  // values back to be dropped again. The oldest marks are the ones dropped, so `since`
  // moves up to the newest of them: news up to there stays read, as it was marked.
  const kept = new Set(read.map(([k]) => k));
  let dropped: string | undefined;
  for (const [k, at] of Object.entries(doc.read)) if (!kept.has(k) && (!dropped || at > dropped)) dropped = at;
  if (dropped && doc.since !== undefined && dropped > doc.since) next.since = dropped;
  return next;
}
