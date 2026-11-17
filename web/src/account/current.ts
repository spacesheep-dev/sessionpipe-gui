// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The backend of the account this window shows, where the rest of the page
// can find it without loading it: start.ts sets it once it is up. Nothing here but a
// variable and the hooks that read it, so a page that shows no account pays nothing for
// asking.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
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

/** The relay's states in which it is read: offline, limited and refused are said elsewhere. */
const READING: ReadonlySet<AccountView["relay"]["state"]> = new Set(["starting", "ok", "gap"]);
const unheld = () => () => {};

/** The account is reading a backlog of history and the read is going: the page keeps the
 *  board it has (or its skeleton) until the history is in. False with no account, and
 *  while the read is stalled. Renders again only when it turns. */
export function useBehind(): boolean {
  const b = accountBackend();
  const read = useCallback(() => {
    const v = b?.view();
    return !!v && v.behind && READING.has(v.relay.state);
  }, [b]);
  return useSyncExternalStore(b ? b.subscribe : unheld, read, read);
}

/** How long the account is behind before a page says so: a launch that reads a page or
 *  two is over before it, and never flashes "Catching up…". */
export const BEHIND_SAID_AFTER_MS = 1000;

/** Behind for BEHIND_SAID_AFTER_MS: the page bar says "Catching up…". */
export function useCatchingUp(): boolean {
  const behind = useBehind();
  const [long, setLong] = useState(false);
  useEffect(() => {
    setLong(false);
    if (!behind) return;
    const t = window.setTimeout(() => setLong(true), BEHIND_SAID_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [behind]);
  return behind && long;
}
