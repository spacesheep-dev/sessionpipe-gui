// SPDX-License-Identifier: Apache-2.0
// The page come back. A tab hidden for a long time, a page out of the back/forward cache,
// a laptop awake again, a network that returned: each can leave the stream open in name
// only (its socket died and nobody said so), or waiting out a backoff nobody needs any
// more. So each ends the same way, with the stream opened again (Store.resync): a fresh
// snapshot, and with it everything a page reads again after one (AppState.resyncs). The
// native shell hears "wake" from the system itself (native/stream.ts resyncAll); these
// are a browser's own signs.
import type { Store } from "./store";

/** Hidden at least this long, a tab asks again when it is shown. */
export const HIDDEN_LONG_MS = 60_000;
/** The page looks at its own clock this often… */
export const BEAT_MS = 5_000;
/** …and a beat this late means the page was not running: the machine slept, or the
 *  browser froze the tab. A hidden tab's timers are slowed to a minute at most, which
 *  HIDDEN_LONG_MS covers. */
export const SLEPT_MS = 20_000;
/** Signs that come together (a restored page is shown, and is online, and its beat is
 *  late) ask once. */
export const ONCE_MS = 2_000;

/** Whether a page shown again should ask: it was hidden `hiddenMs`, and its last beat
 *  was `beatAgoMs` ago. */
export const cameBack = (hiddenMs: number, beatAgoMs: number): boolean =>
  hiddenMs >= HIDDEN_LONG_MS || beatAgoMs >= SLEPT_MS;

/** What `watchResume` needs of a page; a test stands in for it. */
export interface PageSigns {
  hidden(): boolean;
  now(): number;
  /** `visibilitychange` on the document; `pageshow` and `online` on the window. */
  on(kind: "visibilitychange" | "pageshow" | "online", fn: (e: { persisted?: boolean }) => void): () => void;
  every(ms: number, fn: () => void): () => void;
}

const browser = (): PageSigns => ({
  hidden: () => document.visibilityState === "hidden",
  now: () => Date.now(),
  on(kind, fn) {
    const target: EventTarget = kind === "visibilitychange" ? document : window;
    const l = (e: Event) => fn(e as { persisted?: boolean });
    target.addEventListener(kind, l);
    return () => target.removeEventListener(kind, l);
  },
  every(ms, fn) {
    const t = window.setInterval(fn, ms);
    return () => window.clearInterval(t);
  },
});

/** Watch for the page coming back and ask the store for a fresh stream each time.
 *  Returns the function that stops watching. */
export function watchResume(store: Pick<Store, "resync">, page: PageSigns = browser()): () => void {
  let hiddenAt: number | null = page.hidden() ? page.now() : null;
  let beat = page.now();
  let asked = Number.NEGATIVE_INFINITY;
  const ask = () => {
    const now = page.now();
    beat = now;
    if (now - asked < ONCE_MS) return;
    asked = now;
    store.resync();
  };
  const offs = [
    page.on("visibilitychange", () => {
      const now = page.now();
      if (page.hidden()) {
        hiddenAt ??= now;
        return;
      }
      const away = hiddenAt === null ? 0 : now - hiddenAt;
      hiddenAt = null;
      if (cameBack(away, now - beat)) ask();
    }),
    // Out of the back/forward cache: the page is as it was when it was put away.
    page.on("pageshow", (e) => {
      if (e.persisted) ask();
    }),
    page.on("online", ask),
    page.every(BEAT_MS, () => {
      const now = page.now();
      const late = now - beat;
      beat = now;
      // Awake again with the tab in front; a hidden one asks when it is shown.
      if (late >= SLEPT_MS && !page.hidden()) ask();
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
