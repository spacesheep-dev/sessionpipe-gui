// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. The page's reading of the session search: one client per transport
// (arriving with this chunk), a query per keystroke with no debounce (the previous one is
// aborted, every answer is stamped with a sequence number and a stale one is dropped, the
// last 50 answers are kept so backspace is instant), the index status as its own small
// store (fed by GET /status and `searchIndex` frames, never through the app store, so a
// frame re-renders only what shows the status), and the facets for the chips.
import type { SearchFacets, SearchIndexStatus, SearchSort, SessionSearchPage } from "@shared/api";
import { isEmptySearch, parseSearch } from "@shared/searchQuery";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "../data/hooks";
import type { Store } from "../data/store";
import type { SearchClient } from "./types";

// ---------- the client ----------

const clients = new WeakMap<Store, Promise<SearchClient>>();
const ready = new WeakMap<Store, SearchClient>();

export function searchClient(store: Store): Promise<SearchClient> {
  let p = clients.get(store);
  if (!p) {
    p = store.transport.sessionSearch().then((c) => {
      ready.set(store, c);
      return c;
    });
    p.catch(() => clients.delete(store));
    clients.set(store, p);
  }
  return p;
}

/** The client once it is here (the first render of the page usually has it already). */
export function useSearchClient(): SearchClient | null {
  const store = useStore();
  const [c, setC] = useState<SearchClient | null>(() => ready.get(store) ?? null);
  useEffect(() => {
    if (c) return;
    let live = true;
    searchClient(store).then(
      (x) => live && setC(x),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [store, c]);
  return c;
}

// ---------- the query ----------

/** The page asks for this many sessions at a time (D19). */
export const PAGE_SIZE = 30;
const LRU_MAX = 50;
/** No skeleton unless this long passes with nothing ever shown (UX §12). */
const SKELETON_MS = 150;

const lru = new Map<string, SessionSearchPage>();
const remember = (k: string, p: SessionSearchPage) => {
  lru.delete(k);
  lru.set(k, p);
  if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value as string);
};
const tz = () => new Date().getTimezoneOffset();

/** Keystroke → paint, for the budget (UX §12, S5): the moment an input changed the query. */
let typedAt = 0;
export function markTyped(): void {
  typedAt = performance.now();
  try {
    performance.mark("sp-search-typed");
  } catch {
    // marks are a nicety
  }
}
/** Each measured keystroke → first paint of its results, in ms (read by the e2e). */
const paints: number[] = [];
(globalThis as { __spSearchPaints?: number[] }).__spSearchPaints = paints;

export interface SearchState {
  /** The answer on screen: the newest one that arrived, kept while a newer one is asked. */
  page: SessionSearchPage | null;
  /** The answer is for exactly the query in the field. */
  fresh: boolean;
  /** A query is out. */
  busy: boolean;
  /** 150 ms passed on this visit with nothing ever shown. */
  skeleton: boolean;
  error: string | null;
  loadMore: () => void;
  retry: () => void;
  loadingMore: boolean;
}

export function useSessionSearch(client: SearchClient | null, q: string, sort: SearchSort): SearchState {
  const empty = isEmptySearch(parseSearch(q, { live: true }));
  const key = `${sort}\u0000${q}`;
  const [page, setPage] = useState<SessionSearchPage | null>(() => (empty ? null : (lru.get(key) ?? null)));
  const [pageKey, setPageKey] = useState<string | null>(() => (page ? key : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skeleton, setSkeleton] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const shownOnce = useRef(page !== null);
  const seq = useRef(0);
  const ctl = useRef<AbortController | null>(null);
  const painted = useRef<number>(0);

  useEffect(() => {
    if (empty) {
      ctl.current?.abort();
      setBusy(false);
      setError(null);
      setPage(null);
      setPageKey(null);
      return;
    }
    const cached = lru.get(key);
    if (cached) {
      ctl.current?.abort();
      seq.current++;
      painted.current = typedAt;
      setPage(cached);
      setPageKey(key);
      setBusy(false);
      setError(null);
      shownOnce.current = true;
      return;
    }
    if (!client) return;
    ctl.current?.abort();
    const ac = new AbortController();
    ctl.current = ac;
    const mine = ++seq.current;
    const asked = typedAt;
    setBusy(true);
    setError(null);
    const t = shownOnce.current ? 0 : window.setTimeout(() => setSkeleton(true), SKELETON_MS);
    client
      .sessions({ q, sort, live: true, limit: PAGE_SIZE, tz: tz(), hits: 3 }, ac.signal)
      .then((p) => {
        remember(key, p);
        if (mine !== seq.current) return;
        painted.current = asked;
        shownOnce.current = true;
        setPage(p);
        setPageKey(key);
        setBusy(false);
        setSkeleton(false);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current || (e as { name?: string })?.name === "AbortError") return;
        setBusy(false);
        setSkeleton(false);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => window.clearTimeout(t));
    return () => window.clearTimeout(t);
  }, [client, key, q, sort, empty, attempt]);

  // The frame that shows an answer closes its keystroke's measure.
  useLayoutEffect(() => {
    const at = painted.current;
    if (!at || !page) return;
    painted.current = 0;
    requestAnimationFrame(() => {
      const ms = performance.now() - at;
      if (paints.length < 2000) paints.push(Math.round(ms * 10) / 10);
      try {
        performance.measure("sp-search-paint", { start: at, end: performance.now() });
      } catch {
        // older engines
      }
    });
  }, [page]);

  const loadMore = useCallback(() => {
    if (!client || !page?.cursor || loadingMore || pageKey !== key) return;
    setLoadingMore(true);
    const base = page;
    client
      .sessions({ q, sort, live: true, limit: PAGE_SIZE, tz: tz(), hits: 3, cursor: page.cursor })
      .then((next) => {
        const seen = new Set(base.sessions.map((s) => s.key));
        const merged: SessionSearchPage = {
          ...next,
          sessions: [...base.sessions, ...next.sessions.filter((s) => !seen.has(s.key))],
        };
        remember(key, merged);
        setPage((cur) => (cur === base ? merged : cur));
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [client, page, pageKey, key, q, sort, loadingMore]);

  const retry = useCallback(() => {
    lru.delete(key);
    setAttempt((n) => n + 1);
  }, [key]);

  return {
    page: empty ? null : page,
    fresh: pageKey === key,
    busy,
    skeleton: skeleton && !shownOnce.current,
    error,
    loadMore,
    retry,
    loadingMore,
  };
}

/** Forgets the kept answers (after a rebuild or the history switch). */
export const forgetAnswers = (): void => lru.clear();

// ---------- the index status ----------

let status: SearchIndexStatus | null = null;
let local: boolean | undefined;
const statusSubs = new Set<() => void>();
let statusClient: SearchClient | null = null;
let offFrames: (() => void) | null = null;
const emitStatus = () => {
  for (const s of statusSubs) s();
};

/** Sets the status from an answer that carries it (a query page, a POST). */
export function noteStatus(s: SearchIndexStatus): void {
  if (s.local !== undefined) local = s.local;
  const next = { ...s, local: s.local ?? local };
  if (
    status &&
    status.state === next.state &&
    status.sessions === next.sessions &&
    status.progress === next.progress &&
    status.bytes === next.bytes &&
    status.history === next.history &&
    status.updatedAt === next.updatedAt &&
    status.local === next.local &&
    status.error === next.error
  )
    return;
  status = next;
  emitStatus();
}

function attachStatus(c: SearchClient): void {
  if (statusClient === c) return;
  offFrames?.();
  statusClient = c;
  offFrames = c.onStatus((s) => noteStatus(s));
  c.status().then(noteStatus, () => {});
}

export function useSearchStatus(client: SearchClient | null): SearchIndexStatus | null {
  useEffect(() => {
    if (client) attachStatus(client);
  }, [client]);
  return useSyncExternalStore(
    (l) => {
      statusSubs.add(l);
      return () => {
        statusSubs.delete(l);
      };
    },
    () => status,
    () => status,
  );
}

// ---------- the facets ----------

let facets: SearchFacets | null = null;
let facetsFor = -1;

/** The values present in the index (the chips, the completion): once per visit, and again
 *  when the number of sessions changes. */
export function useFacets(client: SearchClient | null, sessions: number | undefined): SearchFacets | null {
  const [f, setF] = useState<SearchFacets | null>(facets);
  useEffect(() => {
    if (!client) return;
    const n = sessions ?? -1;
    if (facets && facetsFor === n) {
      setF(facets);
      return;
    }
    const ac = new AbortController();
    client.facets(ac.signal).then(
      (x) => {
        facets = x;
        facetsFor = n;
        setF(x);
      },
      () => {},
    );
    return () => ac.abort();
  }, [client, sessions]);
  return f;
}
