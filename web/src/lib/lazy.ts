// SPDX-License-Identifier: Apache-2.0
// Code a person reaches only through a dialog (the palette, New session, the shortcut
// help) stays out of the first load: its module is fetched once the page is idle after
// load, so the first ⌘K is as instant as the tenth, and on demand if it is asked for
// sooner. No Suspense: a component reads the module once it is there (a store), and
// renders its own stand-in until then, so nothing flashes and no key is lost.
import { useEffect, useSyncExternalStore } from "react";

export interface LazyModule<T> {
  /** Starts the fetch (once; again after a failure). */
  preload: () => Promise<T>;
  /** The module once it is loaded, else null; starts the fetch when it isn't. */
  use: () => T | null;
}

export function lazyModule<T>(load: () => Promise<T>): LazyModule<T> {
  let mod: T | null = null;
  let pending: Promise<T> | null = null;
  const subs = new Set<() => void>();
  const preload = (): Promise<T> => {
    pending ??= load().then(
      (m) => {
        mod = m;
        for (const s of subs) s();
        return m;
      },
      (e: unknown) => {
        // A failed fetch (offline, a new build) is tried again on the next ask.
        pending = null;
        throw e;
      },
    );
    return pending;
  };
  const subscribe = (l: () => void) => {
    subs.add(l);
    return () => {
      subs.delete(l);
    };
  };
  const get = () => mod;
  const use = (): T | null => {
    const m = useSyncExternalStore(subscribe, get, get);
    useEffect(() => {
      if (!m) preload().catch(() => {});
    }, [m]);
    return m;
  };
  return { preload, use };
}

/** Runs `fn` once the page has loaded and the main thread is idle (within 2 s). */
export function whenIdle(fn: () => void): void {
  if (typeof window === "undefined") return;
  const go = () => {
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) ric(fn, { timeout: 2000 });
    else window.setTimeout(fn, 200);
  };
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}
