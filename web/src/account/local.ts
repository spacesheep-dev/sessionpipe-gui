// SPDX-License-Identifier: Apache-2.0
// Owned by: web. What the page itself keeps outside an account's cache: the app's one
// origin has one localStorage and one sessionStorage, shared by whatever this window shows.
// Some of it is the app's own settings (the theme, text size, what was dismissed). The rest
// was written while sessions were on screen and says something of them: a draft not yet
// sent, the recent searches, the folders a session was last started in, which sessions
// are hidden or open beside. When an account is disconnected, that rest goes.
//
// It is an allow-list: a key is kept only when it is named here as a setting. A key added
// tomorrow and not named goes with a disconnect, which is the safe way to be wrong.
// Nothing here is React's or the backend's: a window that shows no account runs it too
// (gone.ts), so it stays small.

/** The app's own settings: all that stays in localStorage when an account is disconnected. */
export const KEPT_LOCAL: ReadonlySet<string> = new Set([
  "sessionpipe-gui.settings",
  "sessionpipe-gui.theme",
  "sessionpipe-gui.colorTheme",
  "sessionpipe-gui.skin",
  "sessionpipe-gui.textSize",
  "sessionpipe-gui.splitWidth",
  "sessionpipe-gui.sounds",
  "sessionpipe-gui.shortcuts",
  "sessionpipe-gui.shortcuts.preset",
  "sessionpipe-gui.notify",
  "sessionpipe-gui.editor",
  "sessionpipe-gui.setup.seen",
  "sessionpipe-gui.rail.setup",
  "sessionpipe-gui.native.rail",
  "sessionpipe-gui.native.firstRun",
  "sessionpipe-gui.board.counts",
  "sessionpipe-gui.board.hiddenOpen",
  "sessionpipe-gui.board.firstRow",
  "sessionpipe-gui.board.offlineSeen",
  "sessionpipe-gui.agentsOpen",
]);

/** Whose sessions the rest was written beside: the id of the account this origin last showed. */
export const OWNER_KEY = "sessionpipe-gui.account.owner";

type Kept = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const storage = (which: "localStorage" | "sessionStorage"): Kept | null => {
  try {
    return (globalThis as unknown as Record<string, Kept | undefined>)[which] ?? null;
  } catch {
    // A browser that refuses storage altogether keeps nothing to remove.
    return null;
  }
};

/** Removes everything this origin keeps that is not one of the app's settings; all of
 *  sessionStorage. The keys that went, for whoever wants to say so. */
export function wipeLocal(
  local: Kept | null = storage("localStorage"),
  session: Kept | null = storage("sessionStorage"),
): string[] {
  const gone: string[] = [];
  const empty = (s: Kept | null, keep: (key: string) => boolean): void => {
    if (!s) return;
    try {
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k !== null && !keep(k)) keys.push(k);
      }
      for (const k of keys) {
        s.removeItem(k);
        gone.push(k);
      }
    } catch {
      // What could not be read could not be removed either.
    }
  };
  empty(local, (k) => KEPT_LOCAL.has(k));
  empty(session, () => false);
  return gone;
}

export function ownerOf(local: Kept | null = storage("localStorage")): string | null {
  try {
    return local?.getItem(OWNER_KEY) ?? null;
  } catch {
    return null;
  }
}

/** A window opens on account `id`: what another account left here goes first, and from
 *  now what is written here is beside this account's sessions. */
export function claimLocal(id: string, local: Kept | null = storage("localStorage")): string[] {
  const owner = ownerOf(local);
  const gone = owner !== null && owner !== id ? wipeLocal(local) : [];
  try {
    local?.setItem(OWNER_KEY, id);
  } catch {
    // Not marked: the next disconnect still removes it all.
  }
  return gone;
}
