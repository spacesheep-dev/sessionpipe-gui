// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The backend of the account this window shows, where the rest of the page
// can find it without loading it: start.ts sets it once it is up. Nothing here but a
// variable and the hooks that read it, so a page that shows no account pays nothing for
// asking.
import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from "react";
import type { AccountBackend, AccountView } from "./backend";

let current: AccountBackend | null = null;

/** The backend of the account this window shows, once it is up; null anywhere else. */
export const accountBackend = (): AccountBackend | null => current;
export const setAccountBackend = (b: AccountBackend | null): void => {
  current = b;
};

/** How the account stands, as the backend says it, for a component. */
export function useAccountView(): AccountView | null {
  const b = accountBackend();
  const [v, setV] = useState<AccountView | null>(() => b?.view() ?? null);
  useEffect(() => {
    if (!b) return;
    setV(b.view());
    return b.subscribe(() => setV(b.view()));
  }, [b]);
  return v;
}

const unheld = () => () => {};

/** The account has history still to come: a page of it came back full and its end is not
 *  read yet, whether or not spacesheep can be read just now. The page keeps the board it
 *  has (or its loading rows) until the history is in. False with no account. Renders again
 *  only when it turns. */
export function useBehind(): boolean {
  const b = accountBackend();
  const read = useCallback(() => !!b?.view().behind, [b]);
  return useSyncExternalStore(b ? b.subscribe : unheld, read, read);
}

/** History is still being read (AccountView `catching`): the backend holds what it reads of
 *  a computer meanwhile, its pairing included, so a computer the page has no pairing for is
 *  not known yet, not unpaired. False with no account. Renders again only when it turns. */
export function useCatching(): boolean {
  const b = accountBackend();
  const read = useCallback(() => !!b?.view().catching, [b]);
  return useSyncExternalStore(b ? b.subscribe : unheld, read, read);
}

/** How long the account is behind before a page says so: a launch that reads a page or
 *  two is over before it, and never flashes "Catching up…". */
export const BEHIND_SAID_AFTER_MS = 1000;

/** Behind for BEHIND_SAID_AFTER_MS, and the history coming: read, or held by spacesheep's
 *  limit, after which it is read on by itself. Not while spacesheep cannot be reached: the
 *  page says that instead. The page bar then says "Catching up…". The wait is counted from
 *  when the account fell behind, so a page opened later (another tab) says it at once. */
export function useCatchingUp(): boolean {
  const b = accountBackend();
  const read = useCallback(() => {
    const v = b?.view();
    return v && v.relay.state !== "offline" ? v.behindSince : null;
  }, [b]);
  const since = useSyncExternalStore(b ? b.subscribe : unheld, read, read);
  const [, wake] = useReducer((n: number) => n + 1, 0);
  const said = since !== null && performance.now() - since >= BEHIND_SAID_AFTER_MS;
  useEffect(() => {
    if (since === null || said) return;
    const t = window.setTimeout(wake, since + BEHIND_SAID_AFTER_MS - performance.now());
    return () => window.clearTimeout(t);
  }, [since, said]);
  return said;
}
