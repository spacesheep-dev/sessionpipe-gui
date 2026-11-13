// SPDX-License-Identifier: Apache-2.0
// Owned by: web. What the page itself keeps outside an account's cache: the app's one
// origin has one localStorage, shared by every window of the app, whatever each shows
// (this account, another one, a GUI server). So nothing here is removed by whose window
// last wrote: each thing is the account's or it is not, and is decided by itself.
//
// - Keyed by a session (a draft not yet sent; an entry of the hidden list, or of the
//   list of opened agents): the account's when the session is one of its sessions. It
//   goes with that account, or with that session when the account forgets it, and with
//   nothing else.
// - Keyed by the account's id (the reader's read times): that account's.
// - Of no session (the recent searches, what the new-session and handoff sheets remember,
//   the tabs open beside): conveniences that may hold what was typed on an account. They
//   go when an account is disconnected in its own window, and at no other time.
// - Everything else (the app's settings, a receiver's signing marks, a view's own state)
//   is never touched here.
//
// Nothing here is React's or the backend's: a window that shows no account runs it too
// (gone.ts), so it stays small.

/** One value per session: the key is this and the session's key. */
export const SESSION_KEYED: readonly string[] = ["sessionpipe-gui.draft:"];
/** One value for many sessions: an object keyed by session, or a list of `[session, …]`. */
export const SESSION_LISTS: readonly string[] = ["sessionpipe-gui.hidden", "sessionpipe-gui.agentsOpen"];
/** One value per account: the key is this, a name, a dot and the account's id. */
export const ACCOUNT_KEYED = "sessionpipe-gui.account.";
/** Of no session: exact keys, and prefixes (ending in a dot). */
export const CONVENIENCES: readonly string[] = [
  "sp.search.recent",
  "sp.newSession.",
  "sp.handoff.",
  "sessionpipe-gui.splitTabs",
];

type Kept = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const storage = (): Kept | null => {
  try {
    return (globalThis as unknown as { localStorage?: Kept }).localStorage ?? null;
  } catch {
    // A browser that refuses storage altogether keeps nothing to remove.
    return null;
  }
};

const keysOf = (s: Kept): string[] => {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
};

/** Removes what is kept here of these sessions, and of no other: their drafts, and their
 *  entries in the lists. What was removed or rewritten, by key. */
export function forgetLocal(sessions: Iterable<string>, local: Kept | null = storage()): string[] {
  const mine = new Set(sessions);
  const gone: string[] = [];
  if (!local || !mine.size) return gone;
  try {
    for (const k of keysOf(local)) {
      const prefix = SESSION_KEYED.find((p) => k.startsWith(p));
      if (prefix && mine.has(k.slice(prefix.length))) {
        local.removeItem(k);
        gone.push(k);
      }
    }
    for (const k of SESSION_LISTS) {
      const text = local.getItem(k);
      if (text === null) continue;
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch {
        // Not a list anybody reads: it holds no session to remove.
        continue;
      }
      let next: unknown;
      let left = 0;
      if (Array.isArray(v)) {
        next = v.filter((x) => !(Array.isArray(x) ? mine.has(String(x[0])) : mine.has(String(x))));
        left = (next as unknown[]).length;
        if (left === v.length) continue;
      } else if (v && typeof v === "object") {
        const entries = Object.entries(v as Record<string, unknown>);
        const kept = entries.filter(([key]) => !mine.has(key));
        if (kept.length === entries.length) continue;
        next = Object.fromEntries(kept);
        left = kept.length;
      } else continue;
      if (left) local.setItem(k, JSON.stringify(next));
      else local.removeItem(k);
      gone.push(k);
    }
  } catch {
    // What could not be read could not be removed either.
  }
  return gone;
}

/** An account goes from this phone: what is kept here of its sessions, and under its id.
 *  `conveniences`: it was disconnected in this window, by the person, so what belongs to
 *  no session goes too. The keys that went or were rewritten. */
export function wipeAccount(
  id: string,
  sessions: Iterable<string>,
  o: { conveniences?: boolean } = {},
  local: Kept | null = storage(),
): string[] {
  const gone = forgetLocal(sessions, local);
  if (!local) return gone;
  try {
    for (const k of keysOf(local)) {
      const account = k.startsWith(ACCOUNT_KEYED) && k.endsWith(`.${id}`);
      const convenience = !!o.conveniences && CONVENIENCES.some((c) => (c.endsWith(".") ? k.startsWith(c) : k === c));
      if (!account && !convenience) continue;
      local.removeItem(k);
      gone.push(k);
    }
  } catch {
    // as above
  }
  return gone;
}

/** The ids that have something kept under them here (`ACCOUNT_KEYED`). */
export function accountsKept(local: Kept | null = storage()): string[] {
  const ids = new Set<string>();
  try {
    if (local)
      for (const k of keysOf(local))
        if (k.startsWith(ACCOUNT_KEYED)) {
          const dot = k.lastIndexOf(".");
          if (dot >= ACCOUNT_KEYED.length) ids.add(k.slice(dot + 1));
        }
  } catch {
    // none that can be read
  }
  return [...ids];
}

/** Where the reader's read times of account `id` are kept (backend.ts): a small value that
 *  must survive a page killed without a word, so it is written here, where a write is done
 *  when it returns. It goes with the account (a new connect is a new key). */
export const readsKey = (id: string): string => `${ACCOUNT_KEYED}reads.${id}`;

/** Where the keys of every session an account has shown on this phone are kept (backend.ts):
 *  a session ages out of the cache after a week, and what the page's storage keeps of it is
 *  the account's all the same. It goes with the account. */
export const seenKey = (id: string): string => `${ACCOUNT_KEYED}sessions.${id}`;
/** At most this many are remembered; the oldest go first. */
export const SEEN_MAX = 2000;
/** Those keys, read with `read` (the page's storage by default); none when it holds none. */
export function sessionsSeen(id: string, read: (key: string) => string | null = (k) => readLocal(k)): string[] {
  try {
    const v = JSON.parse(read(seenKey(id)) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Where an account's sends are kept while the hub's `sends` document cannot be written
 *  (backend.ts). It goes with the account. */
export const sendsKey = (id: string): string => `${ACCOUNT_KEYED}sends.${id}`;

export function readLocal(key: string, local: Kept | null = storage()): string | null {
  try {
    return local?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** False when it could not be kept (no storage, or it is full). */
export function writeLocal(key: string, value: string, local: Kept | null = storage()): boolean {
  try {
    if (!local) return false;
    local.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
