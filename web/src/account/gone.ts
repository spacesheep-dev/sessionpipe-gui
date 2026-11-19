// SPDX-License-Identifier: Apache-2.0
// Owned by: web. What is left on this phone of an account that is no longer on it. An
// account is disconnected in its own window, which removes what the page kept (backend.ts
// `drop`); but one can also go while no window shows it (replaced by another connect at
// the same origin, disconnected from another window, a restored backup with no key), and
// then nothing runs to clean up after it. So every window of the app that knows of
// accounts asks the hub, as it opens, which accounts are here, and removes what belongs to
// any other: its cached sessions (one IndexedDB database an account id) and what the
// page's own storage keeps of those sessions and under that id (local.ts).
//
// One answer is not enough to remove anything by: an account is gone when two answers,
// each a list, taken a few seconds apart, both leave it out. An answer that fails, or is
// no list, removes nothing; neither does the account this window itself shows.
import { cacheName, cacheSessions, sweepCaches } from "./cache";
import { accountsKept, sessionsSeen, wipeAccount } from "./local";
import type { AccountStatus } from "./shell";

/** How long after the first answer the hub is asked again. */
export const SWEEP_AGAIN_MS = 3000;

export interface Swept {
  /** The cache databases deleted, by name. */
  caches: string[];
  /** The storage keys removed or rewritten. */
  local: string[];
}

/** The ids an answer lists, or null when it is no list of accounts. */
export const listed = (s: unknown): string[] | null => {
  const a = (s as AccountStatus | null)?.accounts;
  if (!Array.isArray(a) || !a.every((x) => x && typeof x.id === "string")) return null;
  return a.map((x) => x.id);
};

export async function sweepGone(
  status: () => Promise<AccountStatus>,
  o: {
    idb?: IDBFactory;
    /** The account this window shows: never swept from here. */
    showing?: string | null;
    sleep?: (ms: number) => Promise<void>;
    /** The sessions a cache database holds, before it is deleted. */
    sessions?: (name: string) => Promise<string[]>;
    /** What the storage keeps under account ids, and the removal of one account's. */
    kept?: () => string[];
    wipe?: (id: string, sessions: string[]) => string[];
    /** Every session the account has shown on this phone (local.ts `sessionsSeen`). */
    seen?: (id: string) => string[];
  } = {},
): Promise<Swept> {
  const none: Swept = { caches: [], local: [] };
  const idb = o.idb ?? globalThis.indexedDB;
  const ask = async (): Promise<string[] | null> => {
    try {
      return listed(await status());
    } catch {
      return null;
    }
  };
  const prefix = cacheName("");
  /** The accounts something is kept of here that an answer leaves out. */
  const absent = async (here: readonly string[]): Promise<string[]> => {
    const ids = new Set((o.kept ?? accountsKept)());
    try {
      for (const d of (await idb?.databases?.()) ?? [])
        if (d.name?.startsWith(prefix)) ids.add(d.name.slice(prefix.length));
    } catch {
      // A browser that will not list them: only what the storage names.
    }
    return [...ids].filter((id) => id && id !== o.showing && !here.includes(id));
  };
  const first = await ask();
  if (!first) return none;
  // Nothing an answer could remove: nothing to ask twice for.
  if (!(await absent(first)).length) return none;
  await (o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(SWEEP_AGAIN_MS);
  const second = await ask();
  if (!second) return none;
  const here = [...new Set([...first, ...second, ...(o.showing ? [o.showing] : [])])];
  const local: string[] = [];
  for (const id of await absent(here)) {
    // Its sessions are read from what was kept of them, before that is deleted, and from
    // the list of every session it has shown here (one may have aged out of the cache).
    const kept = await (o.sessions ?? ((name: string) => cacheSessions(name, idb)))(cacheName(id)).catch(() => []);
    const sessions = [...new Set([...kept, ...(o.seen ?? sessionsSeen)(id)])];
    local.push(...(o.wipe ?? ((i: string, s: string[]) => wipeAccount(i, s)))(id, sessions));
  }
  return { caches: await sweepCaches(here, idb), local };
}
