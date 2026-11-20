// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The pictures this page sent where no receiver keeps them to show
// (a spacesheep account, a computer reached through spacesheep): the very bytes it uploaded
// (the shrunk picture), kept in IndexedDB by their SHA-256 so a sent message draws them as
// thumbnails. 30 days and 50 MB at most, the oldest out first. Where IndexedDB cannot be
// opened, the same in memory for the page's life. Another device has none of them: there a
// sent picture is a chip. On an account they are the account's: a database named after it,
// deleted with the rest of it (account/backend.ts `drop`, account/gone.ts); on a board one
// for the origin.
import { useEffect, useState } from "react";
import { sentPicturesName } from "../account/cache";
import { accountMode } from "../lib/net";

/** The board's database: one for the origin. */
export const SENT_PICTURES_DB = "sent-pictures";
const STORE = "pictures";
/** How long a sent picture is kept to be shown. */
export const SENT_PICTURES_KEEP_MS = 30 * 86_400_000;
/** The most the kept pictures may hold together. */
export const SENT_PICTURES_MAX_BYTES = 50 * 1024 * 1024;

/** One kept picture: its bytes (an ArrayBuffer: every engine stores one), type, size, when. */
interface KeptPicture {
  sha: string;
  type: string;
  bytes: ArrayBuffer;
  size: number;
  at: number;
}

/** The pictures that go so what stays is within the bounds: every one older than `keepMs`,
 *  then the oldest until the rest are `maxBytes` or less together. By hash. */
export function picturesToDrop(
  kept: readonly Pick<KeptPicture, "sha" | "size" | "at">[],
  now: number,
  maxBytes = SENT_PICTURES_MAX_BYTES,
  keepMs = SENT_PICTURES_KEEP_MS,
): string[] {
  const drop: string[] = [];
  const left = [...kept].sort((a, b) => a.at - b.at);
  let total = 0;
  for (const p of left) total += p.size;
  for (const p of left) {
    if (now - p.at <= keepMs && total <= maxBytes) break;
    drop.push(p.sha);
    total -= p.size;
  }
  return drop;
}

/** Object URLs of the pictures this page has drawn or kept, by hash: a sent message shows
 *  its thumbnail at once, with no read of the database. The last URLS_MAX used; an older
 *  one is let go of, and read again from the database when it is drawn again. */
const urls = new Map<string, string>();
export const URLS_MAX = 200;
/** The URL of `sha` this page holds, now the last one used; undefined for none. */
function urlOf(sha: string): string | undefined {
  const url = urls.get(sha);
  if (url === undefined) return undefined;
  urls.delete(sha);
  urls.set(sha, url);
  return url;
}
/** Hold `url` for `sha`, letting go of the least recently used past URLS_MAX. */
function holdUrl(sha: string, url: string): string {
  urls.delete(sha);
  urls.set(sha, url);
  while (urls.size > URLS_MAX) {
    const [old, oldUrl] = urls.entries().next().value as [string, string];
    urls.delete(old);
    URL.revokeObjectURL(oldUrl);
  }
  return url;
}
/** The picture of `sha` this page kept and holds drawn already, with no read: a board draws
 *  what it just sent to a computer reached through spacesheep from it, not from the receiver. */
export const heldSentPicture = (sha: string): string | undefined => urlOf(sha);
/** Where IndexedDB cannot be opened: the pictures, for the page's life. */
const memory = new Map<string, KeptPicture>();
let useMemory = typeof indexedDB === "undefined";
/** The account this page showed has left the phone: nothing more is kept. */
let forgotten = false;

/** The account this window shows, on a spacesheep account; else null. */
const accountId = (): string | null => {
  if (!accountMode()) return null;
  const id = (globalThis as { sessionpipeShell?: { receiver?: { id?: unknown } | null } }).sessionpipeShell?.receiver
    ?.id;
  return typeof id === "string" && id ? id : null;
};
/** This page's database. */
export const sentPicturesDb = (account = accountId()): string =>
  account ? sentPicturesName(account) : SENT_PICTURES_DB;

/** The database, or null when it is not there and `create` is false: a read creates none. */
function openDb(create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let absent = false;
    const req = indexedDB.open(sentPicturesDb(), 1);
    req.onupgradeneeded = () => {
      if (!create) {
        absent = true;
        req.transaction?.abort();
        return;
      }
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "sha" });
    };
    req.onsuccess = () => {
      // Deleted from here or another window (the account left the phone): let go.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => (absent ? resolve(null) : reject(req.error ?? new Error("IndexedDB failed")));
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore, done: (v: T) => void) => void,
): Promise<T | undefined> {
  const db = await openDb(mode === "readwrite");
  if (!db) return undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let value: T;
      fn(tx.objectStore(STORE), (v) => {
        value = v;
      });
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB request failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

/** Keep a picture this page sent, by the hash it was signed under; then trim to the bounds.
 *  Never throws: a picture not kept is a chip later, nothing more. */
export async function keepSentPicture(sha: string, bytes: ArrayBuffer, type: string, now = Date.now()): Promise<void> {
  if (forgotten) return;
  const p: KeptPicture = { sha, type, bytes, size: bytes.byteLength, at: now };
  if (!urls.has(sha)) holdUrl(sha, URL.createObjectURL(new Blob([bytes], { type })));
  if (!useMemory) {
    try {
      await withStore<void>("readwrite", (s) => {
        s.put(p);
        // What is kept, without the bytes read: the cursor's values are read one at a time.
        const all: Pick<KeptPicture, "sha" | "size" | "at">[] = [];
        const c = s.openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (cur) {
            const v = cur.value as KeptPicture;
            all.push({ sha: v.sha, size: v.size, at: v.at });
            cur.continue();
            return;
          }
          for (const sha of picturesToDrop(all, now)) s.delete(sha);
        };
      });
      return;
    } catch {
      useMemory = true;
    }
  }
  memory.set(sha, p);
  for (const gone of picturesToDrop([...memory.values()], now)) memory.delete(gone);
}

/** A kept picture as an object URL, or null when this page has none of it. */
export async function sentPictureUrl(sha: string, now = Date.now()): Promise<string | null> {
  const known = urlOf(sha);
  if (known) return known;
  let p: KeptPicture | undefined;
  if (useMemory) p = memory.get(sha);
  else {
    try {
      p = await withStore<KeptPicture | undefined>("readonly", (s, done) => {
        const r = s.get(sha);
        r.onsuccess = () => done(r.result as KeptPicture | undefined);
      });
    } catch {
      useMemory = true;
      p = memory.get(sha);
    }
  }
  if (!p || now - p.at > SENT_PICTURES_KEEP_MS) return null;
  return holdUrl(sha, URL.createObjectURL(new Blob([p.bytes], { type: p.type })));
}

/** Every picture kept of an account goes, when it leaves the phone: its database, and, when
 *  it is the one this page shows, what the page holds of them in memory (and nothing more is
 *  kept). Never throws. */
export function forgetSentPictures(account: string, idb: IDBFactory | undefined = globalThis.indexedDB): void {
  if (sentPicturesDb() === sentPicturesName(account)) {
    forgotten = true;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    memory.clear();
  }
  try {
    idb?.deleteDatabase(sentPicturesName(account));
  } catch {
    // no IndexedDB to delete from
  }
}

/** `sentPictureUrl` of each of `shas`, for a component: a hash is absent while it is read,
 *  then its URL, or null where this page kept none of it. */
export function useSentPictureUrls(shas: readonly string[]): ReadonlyMap<string, string | null> {
  const key = shas.join(" ");
  const held = (list: readonly string[]) => {
    const m = new Map<string, string | null>();
    for (const sha of list) {
      const url = urlOf(sha);
      if (url) m.set(sha, url);
    }
    return m;
  };
  const [got, setGot] = useState<ReadonlyMap<string, string | null>>(() => held(shas));
  useEffect(() => {
    const list = key ? key.split(" ") : [];
    const now = held(list);
    setGot(now);
    const rest = list.filter((sha) => !now.has(sha));
    if (!rest.length) return;
    let on = true;
    void Promise.all(
      rest.map((sha) =>
        sentPictureUrl(sha).then(
          (u) => [sha, u] as const,
          () => [sha, null] as const,
        ),
      ),
    ).then((read) => on && setGot(new Map([...now, ...read])));
    return () => {
      on = false;
    };
  }, [key]);
  return got;
}
