// SPDX-License-Identifier: Apache-2.0
// Owned by: web. What a page on a spacesheep account keeps of the relay between launches
// (docs/rfcs/08, "The documents": the events are the page's to cache, and losing the cache
// costs one read of the relay). One IndexedDB database per receiver id, so another
// person's account on the same phone is another database: the relay's pages as they were
// ingested, one record a page under the cursor after it, and the reader's two small values
// (`cursor`, `reads`). A page and the cursor after it are one write, so the two can never
// disagree. It is bounded as the relay is (CACHE_EVENTS_MAX events, CACHE_KEEP_MS of age),
// read once at the start, and deleted when the account is disconnected (or found at a later
// start to belong to an account that is no longer on this phone). A session the account
// forgot (`session.forgotten`) is taken out of every page it is in, so nothing of it stays
// on the phone and a later start does not bring it back. Where IndexedDB cannot be opened,
// the same thing in memory: nothing survives the launch, and the backend says so.
import { type SessionKey, type StoredEvent, sessionKey } from "@shared/api";
import type { RelayKept } from "../../../server/sources/relay";

/** The relay itself holds 50 000 events at most; the cache keeps as many, newest last. */
export const CACHE_EVENTS_MAX = 50_000;
/** The relay drops an event a week after it took it; so does the cache, by the event's own
 *  time (the relay's is not in what it hands over), a page at a time, at each start. */
export const CACHE_KEEP_MS = 7 * 86_400_000;
/** Past this many events over the bound the oldest pages go, in one write. */
export const CACHE_SLACK = 2_000;
/** A live page is often one event: past this many records they are rewritten as full ones. */
export const CACHE_COMPACT_PAGES = 400;
export const CACHE_PAGE = 500;

export const cacheName = (receiverId: string): string => `sessionpipe.account.${receiverId}`;

export interface CacheLoad {
  /** Every kept event, in the order the relay gave them. */
  events: StoredEvent[];
  /** The reader's values as they were kept (undefined with none). */
  kept: Partial<Record<RelayKept, unknown>>;
  pages: number;
  ms: number;
}

export interface EventCache {
  /** `indexeddb`: kept between launches. `memory`: gone with the page. */
  readonly kind: "indexeddb" | "memory";
  load(): Promise<CacheLoad>;
  /** One relay page and the cursor after it, as one write. `events` may be empty (the
   *  cursor moved over events the store already had). */
  page(cursor: number, events: StoredEvent[], cursorDoc: unknown): void;
  /** One of the reader's small values. */
  put(name: RelayKept, value: unknown): void;
  /** These sessions were forgotten by the account: every event of theirs goes, from every
   *  page written so far. */
  forget(sessions: readonly SessionKey[]): void;
  /** Everything kept for this account goes (a disconnect). */
  destroy(): Promise<void>;
  /** Resolves when everything handed over so far is written. */
  flushed(): Promise<void>;
  /** Bytes the browser says this origin's storage holds, when it says. */
  bytes(): Promise<number | null>;
}

/** The events of `page` that belong to none of `gone` (the same array when none does). */
export function withoutSessions<E extends Pick<StoredEvent, "harness" | "session">>(
  page: readonly E[],
  gone: ReadonlySet<SessionKey>,
): readonly E[] {
  if (!gone.size || !page.some((e) => gone.has(sessionKey(e.harness.name, e.session.id)))) return page;
  return page.filter((e) => !gone.has(sessionKey(e.harness.name, e.session.id)));
}

/** Which records go so that at most `max` events stay: the oldest whole pages. */
export function pagesToDrop(pages: readonly { key: number; n: number }[], max: number): number[] {
  let total = 0;
  for (const p of pages) total += p.n;
  const out: number[] = [];
  for (const p of pages) {
    if (total <= max) break;
    out.push(p.key);
    total -= p.n;
  }
  return out;
}

/** The pages at the front whose every event is older than `keepMs` at `now`: the ones a
 *  read of the relay from its start would no longer bring. Stops at the first page that
 *  holds a newer event; a page with no event at all goes with the old ones before it. */
export function pagesTooOld(
  pages: readonly { key: number; events: readonly Pick<StoredEvent, "time">[] }[],
  now: number,
  keepMs = CACHE_KEEP_MS,
): number[] {
  const out: number[] = [];
  for (const p of pages) {
    let newest = Number.NEGATIVE_INFINITY;
    for (const e of p.events) {
      const t = Date.parse(e.time);
      // An event with no readable time is never called old.
      newest = Math.max(newest, Number.isFinite(t) ? t : Number.POSITIVE_INFINITY);
    }
    if (p.events.length && now - newest < keepMs) break;
    out.push(p.key);
  }
  // The last page is the cursor's: it stays, whatever it holds.
  if (out.length === pages.length) out.pop();
  return out;
}

/** The databases of accounts that are no longer on this phone (disconnected while no window
 *  showed them) are deleted: `keep` is every account id the hub lists now. */
export async function sweepCaches(
  keep: readonly string[],
  idb: IDBFactory | undefined = globalThis.indexedDB,
): Promise<string[]> {
  const gone: string[] = [];
  try {
    const prefix = cacheName("");
    const names = new Set(keep.map(cacheName));
    for (const d of (await idb?.databases?.()) ?? []) {
      if (!d.name?.startsWith(prefix) || names.has(d.name)) continue;
      idb!.deleteDatabase(d.name);
      gone.push(d.name);
    }
  } catch {
    // A browser that will not list them: nothing to sweep by.
  }
  return gone;
}

/** Many small pages as full ones, each under the cursor of its last. */
export function compacted(
  pages: readonly { key: number; events: StoredEvent[] }[],
  size = CACHE_PAGE,
): { key: number; events: StoredEvent[] }[] {
  const out: { key: number; events: StoredEvent[] }[] = [];
  let cur: StoredEvent[] = [];
  let key = 0;
  for (const p of pages) {
    key = p.key;
    for (const e of p.events) cur.push(e);
    if (cur.length >= size) {
      out.push({ key, events: cur });
      cur = [];
    }
  }
  if (cur.length || (pages.length && !out.length)) out.push({ key, events: cur });
  else if (out.length) out[out.length - 1]!.key = key;
  return out;
}

export function memoryCache(): EventCache {
  return {
    kind: "memory",
    load: async () => ({ events: [], kept: {}, pages: 0, ms: 0 }),
    page: () => {},
    put: () => {},
    forget: () => {},
    destroy: async () => {},
    flushed: async () => {},
    bytes: async () => null,
  };
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });

/** The cache for `receiverId`: IndexedDB where it opens, else memory. */
export async function openCache(
  receiverId: string,
  idb: IDBFactory | undefined = globalThis.indexedDB,
): Promise<EventCache> {
  if (!idb) return memoryCache();
  const name = cacheName(receiverId);
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((res, rej) => {
      const o = idb.open(name, 1);
      o.onupgradeneeded = () => {
        o.result.createObjectStore("pages");
        o.result.createObjectStore("meta");
      };
      o.onsuccess = () => res(o.result);
      o.onerror = () => rej(o.error);
      o.onblocked = () => rej(new Error("blocked"));
    });
  } catch {
    return memoryCache();
  }
  // Another window of the app asks to delete or upgrade it: let go.
  db.onversionchange = () => db.close();
  /** Each record's key and how many events it holds, oldest first. */
  let index: { key: number; n: number }[] = [];
  let total = 0;
  let last: Promise<void> = Promise.resolve();
  let dead = false;
  const write = (f: (tx: IDBTransaction) => void): void => {
    if (dead) return;
    try {
      const tx = db.transaction(["pages", "meta"], "readwrite");
      f(tx);
      const p = done(tx).catch((e) => console.warn("[account] cache write:", e));
      last = last.then(() => p);
    } catch (e) {
      console.warn("[account] cache write:", e);
    }
  };
  return {
    kind: "indexeddb",
    async load() {
      const t0 = performance.now();
      const tx = db.transaction(["pages", "meta"], "readonly");
      const os = tx.objectStore("pages");
      const [keys, values, cursor, reads] = await Promise.all([
        req(os.getAllKeys()),
        req(os.getAll()),
        req(tx.objectStore("meta").get("cursor")),
        req(tx.objectStore("meta").get("reads")),
      ]);
      let pages = keys.map((k, i) => ({ key: Number(k), events: (values[i] ?? []) as StoredEvent[] }));
      // As the relay trims: what is older than its week, then what is past its count.
      const drop = new Set(pagesTooOld(pages, Date.now()));
      for (const key of pagesToDrop(
        pages.filter((p) => !drop.has(p.key)).map((p) => ({ key: p.key, n: p.events.length })),
        CACHE_EVENTS_MAX,
      ))
        drop.add(key);
      const small = pages.length > CACHE_COMPACT_PAGES;
      if (drop.size || small) {
        const kept = pages.filter((p) => !drop.has(p.key));
        const next = small ? compacted(kept) : kept;
        write((w) => {
          const s = w.objectStore("pages");
          if (small) {
            s.clear();
            for (const p of next) s.put(p.events, p.key);
          } else for (const k of drop) s.delete(k);
        });
        pages = next;
      }
      index = pages.map((p) => ({ key: p.key, n: p.events.length }));
      total = index.reduce((n, p) => n + p.n, 0);
      const events: StoredEvent[] = [];
      for (const p of pages) for (const e of p.events) events.push(e);
      return {
        events,
        kept: { ...(cursor !== undefined ? { cursor } : {}), ...(reads !== undefined ? { reads } : {}) },
        pages: pages.length,
        ms: performance.now() - t0,
      };
    },
    page(cursor, events, cursorDoc) {
      index.push({ key: cursor, n: events.length });
      total += events.length;
      let drop: number[] = [];
      if (total > CACHE_EVENTS_MAX + CACHE_SLACK) {
        drop = pagesToDrop(index, CACHE_EVENTS_MAX);
        const gone = new Set(drop);
        index = index.filter((p) => !gone.has(p.key));
        total = index.reduce((n, p) => n + p.n, 0);
      }
      write((tx) => {
        const s = tx.objectStore("pages");
        if (events.length) s.put(events, cursor);
        for (const k of drop) s.delete(k);
        tx.objectStore("meta").put(cursorDoc, "cursor");
      });
    },
    put: (n, value) => write((tx) => void tx.objectStore("meta").put(value, n)),
    forget(sessions) {
      const gone = new Set(sessions);
      if (!gone.size) return;
      // One transaction over every page, after the writes already asked for and before any
      // asked for later: each page is put back without those sessions' events, or deleted
      // when nothing else was in it.
      write((tx) => {
        const walk = tx.objectStore("pages").openCursor();
        walk.onsuccess = () => {
          const at = walk.result;
          if (!at) return;
          const events = at.value as StoredEvent[];
          const kept = withoutSessions(events, gone);
          if (kept !== events) {
            const i = index.findIndex((p) => p.key === Number(at.key));
            total -= events.length - kept.length;
            if (kept.length) {
              at.update(kept);
              if (i >= 0) index[i] = { key: index[i]!.key, n: kept.length };
            } else {
              at.delete();
              if (i >= 0) index.splice(i, 1);
            }
          }
          at.continue();
        };
      });
    },
    async destroy() {
      await last;
      dead = true;
      db.close();
      await new Promise<void>((res) => {
        const d = idb.deleteDatabase(name);
        d.onsuccess = () => res();
        d.onerror = () => res();
        d.onblocked = () => res();
      });
    },
    flushed: () => last,
    async bytes() {
      try {
        const e = await navigator.storage?.estimate?.();
        return typeof e?.usage === "number" ? e.usage : null;
      } catch {
        return null;
      }
    },
  };
}
