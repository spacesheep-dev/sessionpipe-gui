// SPDX-License-Identifier: Apache-2.0
// Pull down to refresh on the phone's list pages, as a native list does. A touch that
// starts with the page at its top and moves down pulls the page: the content follows the
// finger (rubber-banded, lib/pull.ts), a 28 px ring emerges under the nav bar and draws
// its arc with the pull, and past the arm distance letting go reopens the stream for a
// fresh snapshot (Store.reconnect), the ring spinning until it lands. While the stream
// is down the same pull is the retry: the dropped-stream pill (Shell.tsx PhoneConn)
// rides along with the content. The gesture is one window-level touch handler, and it
// defers to anything that owns the touch: a sheet or dialog, a field being typed in, a
// row that scrolls sideways, the tab bar. The DOM side is a few custom properties on
// <html> (`--pull-y`, `--pull`, `data-pull`) that styles/pull.css draws from; React
// state is only the phase, so a move never re-renders anything.
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../data/hooks";
import { haptic } from "../lib/haptics";
import { reducedMotion, tokenMs } from "../lib/motion";
import {
  ARM_PX,
  arc,
  begin,
  holdFor,
  IDLE,
  landed,
  move,
  outcome,
  type Phase,
  type Pull,
  release,
  settle,
  settled,
  TIMEOUT_MS,
} from "../lib/pull";

/** The pages that refresh this way: the lists. A session or a document page does not. */
export const PULL_PAGES: ReadonlySet<string> = new Set(["board", "inbox", "search", "feed", "review", "machines"]);

/** What the touch would land on that is not the page's: a dialog, a sheet or a menu
 *  open anywhere; a text field with focus; a start on a field, a row of filters that
 *  scrolls sideways, or the tab bar. A second finger is never a pull either. */
function ownedElsewhere(e: TouchEvent): boolean {
  if (e.touches.length !== 1) return true;
  if (document.querySelector("[role=dialog], .menu-sheet, [data-new-session], .panel--open")) return true;
  const a = document.activeElement;
  if (a instanceof HTMLElement && a.matches("input, textarea, [contenteditable]:not([contenteditable=false])"))
    return true;
  const t = e.target;
  return t instanceof Element && !!t.closest(".bar-filters, input, textarea, select, [contenteditable], .tabbar");
}

const root = () => document.documentElement;

/** Draws the page at `y`: the content's translate and the ring's arc, read by pull.css. */
function draw(y: number): void {
  root().style.setProperty("--pull-y", `${y}px`);
  root().style.setProperty("--pull", String(arc(y)));
}

export function PullRefresh({ main }: { main: RefObject<HTMLElement | null> }) {
  const store = useStore();
  const pull = useRef<Pull>(IDLE);
  const [phase, setPhase] = useState<Phase>("idle");
  const [armed, setArmed] = useState(false);
  const [say, setSay] = useState("");
  /** The snapshot the page had as the refresh began: the fresh one must differ. */
  const before = useRef<string | null>(null);

  // The state lives in a ref (the touch handlers read it between renders); React sees a
  // phase or an arming, never a move.
  const commit = useCallback((next: Pull) => {
    const prev = pull.current;
    pull.current = next;
    if (next.phase !== prev.phase) setPhase(next.phase);
    if (next.armed !== prev.armed) setArmed(next.armed);
  }, []);

  useEffect(() => {
    const atTop = () => window.scrollY <= 0;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      commit(begin(pull.current, t.clientX, t.clientY, atTop() && !ownedElsewhere(e)));
    };
    const moved = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const { state, arm } = move(pull.current, t.clientX, t.clientY, atTop());
      // One tick as the pull arms, as a native list's; none on the way back.
      if (arm === "arm") haptic("selection");
      if (state.phase === "pulling") draw(state.y);
      commit(state);
    };
    const end = () => {
      const next = release(pull.current, Date.now());
      if (next.phase === "refreshing") {
        before.current = store.get().snapshotAt;
        store.reconnect();
      }
      commit(next);
    };
    // Passive: the page never scrolls under a pull (it is at its top and the shell has
    // the bounce off), so there is nothing to prevent and the scroll thread stays free.
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", moved, { passive: true });
    window.addEventListener("touchend", end, { passive: true });
    window.addEventListener("touchcancel", end, { passive: true });
    return () => {
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchmove", moved);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
    };
  }, [store, commit]);

  // Arming is said once, by the live region; the finger's own tick is the haptic above.
  useEffect(() => {
    if (armed) setSay("Release to refresh");
  }, [armed]);

  // Each phase on the document: the attribute pull.css keys on, where the content rests,
  // the wait for the snapshot, and the ease back.
  useEffect(() => {
    const el = root();
    const page = main.current;
    if (phase === "idle") {
      delete el.dataset.pull;
      el.style.removeProperty("--pull-y");
      el.style.removeProperty("--pull");
      return;
    }
    el.dataset.pull = phase;
    if (phase === "refreshing") {
      draw(ARM_PX);
      page?.setAttribute("aria-busy", "true");
      setSay("Refreshing…");
      let hold = 0;
      // Done: the words, then the ease back. The snapshot's own arrival is what
      // ends it; the hard stop only says how the stream stood then.
      const done = (live: boolean) => {
        setSay(outcome(live));
        commit(settle(pull.current));
      };
      const check = () => {
        const s = store.get();
        if (!landed(before.current, s.snapshotAt, s.connection)) return;
        unsub();
        window.clearTimeout(stop);
        hold = window.setTimeout(() => done(true), holdFor(pull.current, Date.now()));
      };
      const unsub = store.subscribe(check);
      const stop = window.setTimeout(() => {
        unsub();
        done(store.get().connection === "live");
      }, TIMEOUT_MS);
      check();
      return () => {
        unsub();
        window.clearTimeout(stop);
        window.clearTimeout(hold);
        page?.removeAttribute("aria-busy");
      };
    }
    if (phase === "settling") {
      draw(0);
      const t = window.setTimeout(
        () => commit(settled(pull.current)),
        reducedMotion() ? 0 : tokenMs("--dur-slow", 280),
      );
      return () => window.clearTimeout(t);
    }
  }, [phase, main, store, commit]);

  const spinning = phase === "refreshing" || phase === "settling";
  return (
    // Always in the document, so the live region exists before it has anything to say.
    <div className="pull" role="status" aria-live="polite" data-phase={phase} data-armed={armed ? "" : undefined}>
      {spinning ? (
        <span className="spinner pull-spin" aria-hidden="true" />
      ) : (
        <svg className="pull-ring" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
          <circle className="pull-track" cx="14" cy="14" r="13.25" />
          <circle className="pull-arc" cx="14" cy="14" r="13.25" pathLength="1" />
        </svg>
      )}
      <span className="sr-only">{say}</span>
    </div>
  );
}
