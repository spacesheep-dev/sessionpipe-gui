// SPDX-License-Identifier: Apache-2.0
// The motion layer every surface shares (POLISH-PLAN.md §2): live lists that hold still
// under the pointer, rows that slide to their new place instead of jumping (FLIP), an
// overlay that stays mounted for its exit, a phone sheet that follows the finger, and a
// section header that grows its hairline once content scrolls under it. Every piece
// turns into an instant state change under `prefers-reduced-motion`.
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMenuOpen } from "../components/ContextMenu";

/** Whether the person asked for less motion, read live. */
export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A token's duration in ms ("--dur-exit" → 140), read from the document. */
export function tokenMs(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = Number.parseFloat(v);
  if (Number.isNaN(n)) return fallback;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n;
}

// ----- presence: stay mounted for the exit -----

/** An overlay's life with an exit: `mounted` stays true for `ms` after `open` turns
 *  false, with `closing` set, so the element can play its exit (`[data-closing]`) before
 *  it unmounts. No wait under reduced motion. */
export function usePresence(open: boolean, ms = tokenMs("--dur-exit", 140)): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  // Opened (again, even mid-exit): mounted from this very render.
  if (open && !mounted) setMounted(true);
  // `mounted` is read, not followed: only `open` starts or stops an exit.
  useEffect(() => {
    if (open || !mounted) return;
    if (reducedMotion() || ms <= 0) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  // Closing from the render in which `open` turns false, and focus leaves in that same
  // commit: the next key belongs to the page (Esc then `c`, or `g f`), never to a field
  // fading out (an overlay that keeps its keys to itself would swallow it).
  const closing = !open && mounted;
  useLayoutEffect(() => {
    if (!closing) return;
    const a = document.activeElement;
    if (a instanceof HTMLElement && a.closest("[data-closing]")) a.blur();
  }, [closing]);
  return { mounted: open || mounted, closing };
}

// ----- live lists that hold still -----

/** How long after the pointer leaves (or a menu closes) held changes land. */
const RELEASE_MS = 300;
/** A pointer resting this long without moving is no longer reading the list: let it live. */
const IDLE_MS = 2500;

/** A finger lifted off a list is still reading it for this long (a scroll still settling). */
const TOUCH_SETTLE_MS = 1200;

/** Whether a live list should hold its order right now: the pointer is over it in a
 *  focused window, a finger is on it (or its scroll is settling), focus (the keyboard
 *  cursor) is inside it, or a menu is open on one of its rows. Turns false RELEASE_MS
 *  after the last of those ends. By default a pointer resting IDLE_MS without moving lets
 *  the list live; `{ idle: false }` holds for as long as the pointer stays over it (the
 *  board: a row must never move under a resting hand). */
export function useListHold(ref: RefObject<HTMLElement | null>, o: { idle?: boolean } = {}): boolean {
  const idleRelease = o.idle ?? true;
  const menuOpen = useMenuOpen();
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let idle: number | undefined;
    let settle: number | undefined;
    const over = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      setPointer(document.hasFocus());
      if (!idleRelease) return;
      window.clearTimeout(idle);
      idle = window.setTimeout(() => setPointer(false), IDLE_MS);
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      window.clearTimeout(idle);
      setPointer(false);
    };
    const blur = () => {
      window.clearTimeout(idle);
      setPointer(false);
    };
    const touch = () => {
      window.clearTimeout(settle);
      setPointer(true);
      settle = window.setTimeout(() => setPointer(false), TOUCH_SETTLE_MS);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "touch") touch();
    };
    const fin = () => setFocus(el.matches(":focus-within") && !!document.activeElement?.matches(":focus-visible"));
    const fout = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setFocus(false);
    };
    el.addEventListener("pointerover", over, { passive: true });
    if (idleRelease) el.addEventListener("pointermove", over, { passive: true });
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", down, { passive: true });
    el.addEventListener("touchmove", touch, { passive: true });
    el.addEventListener("focusin", fin);
    el.addEventListener("focusout", fout);
    window.addEventListener("blur", blur);
    return () => {
      window.clearTimeout(idle);
      window.clearTimeout(settle);
      el.removeEventListener("pointerover", over);
      el.removeEventListener("pointermove", over);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("touchmove", touch);
      el.removeEventListener("focusin", fin);
      el.removeEventListener("focusout", fout);
      window.removeEventListener("blur", blur);
    };
  }, [ref, idleRelease]);
  const menuHere = menuOpen && !!ref.current?.querySelector("[data-menu-open]");
  const want = pointer || focus || menuHere;
  useEffect(() => {
    if (want) {
      setHeld(true);
      return;
    }
    const t = window.setTimeout(() => setHeld(false), RELEASE_MS);
    return () => window.clearTimeout(t);
  }, [want]);
  return want || held;
}

export interface Held<T> {
  key: string;
  item: T;
  /** The group (a board section) the row was in when the hold began. */
  group: string;
  /** Gone from the data while held: render it dimmed and inert; it leaves on release. */
  gone: boolean;
}

/** A live list's order, held while `hold` is true (useListHold): every row keeps its
 *  place and its group, and shows its fresh data in place (text, time, glyph); a row that
 *  left the data stays, marked `gone`; a new row joins the end of its group, so nothing
 *  above it moves. When the hold ends, the list takes its real order in one step, which
 *  useFlip animates. `groupOf` is the section a row sorts into (its state on the board). */
export function useHeldOrder<T>(
  items: readonly T[],
  keyOf: (t: T) => string,
  hold: boolean,
  groupOf: (t: T) => string = () => "",
): Held<T>[] {
  const last = useRef<Held<T>[]>([]);
  const fresh = items.map((item) => ({ key: keyOf(item), item, group: groupOf(item), gone: false }));
  if (!hold) {
    last.current = fresh;
    return fresh;
  }
  const byKey = new Map(fresh.map((h) => [h.key, h]));
  const out: Held<T>[] = last.current.map((h) => {
    const now = byKey.get(h.key);
    return now ? { ...h, item: now.item, gone: false } : { ...h, gone: true };
  });
  const known = new Set(out.map((h) => h.key));
  for (const h of fresh) {
    if (known.has(h.key)) continue;
    let at = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.group === h.group) {
        at = i;
        break;
      }
    }
    if (at < 0) out.push(h);
    else out.splice(at + 1, 0, h);
  }
  last.current = out;
  return out;
}

// ----- FLIP: rows slide to their new place -----

/** The vertical translate an element is drawn with right now (a running animation's). */
function drawnY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 0;
  const m = t.match(/^matrix(3d)?\((.+)\)$/);
  if (!m) return 0;
  const v = m[2]!.split(",").map(Number);
  return (m[1] ? v[13] : v[5]) ?? 0;
}

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Animates the children of `ref` that carry `data-flip="<key>"` from where they are
 *  drawn now to their new place (a translate over --dur-slow); a new one fades and drops
 *  in over --dur. Measured so it never compounds on a live list: a row's last place is its
 *  layout place (its rect minus the transform playing on it), a move starts from where the
 *  row is drawn right now, and the playing move is cancelled before the new one starts,
 *  so a row that moves twice glides on without a jump. A row inside another FLIP row (a
 *  subagent under its parent) is its own list's to move, never this one's. Positions are
 *  container-relative, so a scroll is not a move. Off under reduced motion, and past
 *  `max` rows (a long list just snaps). */
export function useFlip(ref: RefObject<HTMLElement | null>, max = 80): void {
  /** Each row's layout top (no transform), relative to the container, at the last commit. */
  const prev = useRef<Map<string, number> | null>(null);
  const moving = useRef(new Map<string, Animation>());
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const els = [...box.querySelectorAll<HTMLElement>("[data-flip]")].filter((el) => {
      const outer = el.parentElement?.closest("[data-flip]");
      return !outer || !box.contains(outer);
    });
    const top = box.getBoundingClientRect().top;
    // A hidden page (an occluded or minimised window, a background tab) draws nothing and
    // WebKit holds its animation clock: a row would wait there, transparent or half-moved,
    // until the window is seen again. Nobody can see a move then, so it just snaps.
    const motion =
      !reducedMotion() &&
      document.visibilityState === "visible" &&
      els.length <= max &&
      typeof Element.prototype.animate === "function";
    const now = new Map<string, number>();
    const drawn = new Map<string, number>();
    for (const el of els) {
      const k = el.dataset.flip!;
      const y = drawnY(el);
      // Where it is laid out: its drawn rect minus what is playing on it.
      now.set(k, el.getBoundingClientRect().top - top - y);
      drawn.set(k, y);
    }
    const before = prev.current;
    prev.current = now;
    if (!before || !motion) return;
    const slow = tokenMs("--dur-slow", 280);
    const dur = tokenMs("--dur", 200);
    const live = new Map<string, Animation>();
    for (const el of els) {
      const k = el.dataset.flip!;
      const was = before.get(k);
      const is = now.get(k)!;
      const playing = moving.current.get(k);
      if (was === undefined) {
        el.animate(
          [
            { opacity: 0, transform: "translateY(-4px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: dur, easing: EASE },
        );
        continue;
      }
      // Laid out where it was: a move still playing just goes on.
      if (Math.abs(was - is) <= 0.5) {
        if (playing && playing.playState === "running") live.set(k, playing);
        continue;
      }
      // Where it is drawn now, relative to its new place: its old place plus the move
      // still playing (that move was anchored to the old place).
      const from = was + (playing ? drawn.get(k)! : 0) - is;
      playing?.cancel();
      const a = el.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], {
        duration: slow,
        easing: EASE,
      });
      // While it travels it is drawn opaque and above the rows it passes (a native list's
      // moving cell), so two rows crossing never read as one garbled line.
      el.setAttribute("data-flip-moving", "");
      const done = () => {
        if (moving.current.get(k) === a || !moving.current.has(k)) el.removeAttribute("data-flip-moving");
      };
      a.addEventListener("finish", done);
      a.addEventListener("cancel", done);
      live.set(k, a);
    }
    moving.current = live;
  });
}

// ----- the phone sheet that follows the finger -----

/** Lets a bottom sheet be dragged down by its grabber or head (`handle`, a selector
 *  inside the sheet; the whole sheet while it is scrolled to its top): it follows the
 *  finger 1:1, rubber-bands upward, and on release dismisses past 40 % of its height or
 *  above 500 px/s downward, else springs back. The scrim behind reads `--sheet-drag`
 *  (0 → 1) from the sheet's parent to fade with the drag. */
export function useSheetDrag(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  o: { handle?: string; enabled?: boolean } = {},
): void {
  const { handle = ".sheet-grab, .menu-grab, [data-sheet-handle]", enabled = true } = o;
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const sheet = ref.current;
    if (!sheet || !enabled) return;
    let startY = 0;
    let dy = 0;
    let samples: { y: number; t: number }[] = [];
    let dragging = false;
    let armed = false;
    const set = (y: number, animate: boolean) => {
      // The entrance's fill would hold the transform: the finger owns it from here.
      sheet.style.animation = "none";
      sheet.style.transition = animate ? `transform ${tokenMs("--dur", 200)}ms cubic-bezier(0.22, 1, 0.36, 1)` : "none";
      sheet.style.transform = y ? `translateY(${y}px)` : "";
      const p = Math.max(0, Math.min(1, y / Math.max(1, sheet.offsetHeight)));
      sheet.parentElement?.style.setProperty("--sheet-drag", String(p));
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const t = e.target as HTMLElement;
      const onHandle = !!t.closest(handle);
      const atTop = sheet.scrollTop <= 0 && !t.closest("input, textarea, [contenteditable], .no-drag");
      if (!onHandle && !atTop) return;
      armed = true;
      dragging = onHandle;
      startY = e.clientY;
      dy = 0;
      samples = [{ y: e.clientY, t: e.timeStamp }];
      // Releasing over a sheet's row must not run that row once a drag began.
      if (onHandle) sheet.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!armed) return;
      const d = e.clientY - startY;
      if (!dragging) {
        // A content touch becomes a drag only once it clearly goes down.
        if (d < 6) {
          if (d < -6) armed = false;
          return;
        }
        dragging = true;
        sheet.setPointerCapture?.(e.pointerId);
      }
      dy = d >= 0 ? d : -Math.sqrt(-d) * 2;
      samples.push({ y: e.clientY, t: e.timeStamp });
      if (samples.length > 6) samples.shift();
      set(dy, false);
    };
    const up = () => {
      if (!armed) return;
      armed = false;
      if (!dragging) return;
      dragging = false;
      const a = samples[0];
      const b = samples[samples.length - 1];
      const v = a && b && b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
      if (dy > sheet.offsetHeight * 0.4 || v > 0.5) {
        if (reducedMotion()) {
          dismiss.current();
          return;
        }
        set(sheet.offsetHeight, true);
        window.setTimeout(() => dismiss.current(), tokenMs("--dur", 200));
      } else set(0, true);
    };
    sheet.addEventListener("pointerdown", down);
    sheet.addEventListener("pointermove", move);
    sheet.addEventListener("pointerup", up);
    sheet.addEventListener("pointercancel", up);
    return () => {
      sheet.removeEventListener("pointerdown", down);
      sheet.removeEventListener("pointermove", move);
      sheet.removeEventListener("pointerup", up);
      sheet.removeEventListener("pointercancel", up);
    };
  }, [ref, handle, enabled]);
}

// ----- the header that grows its hairline once content is under it -----

/** Sets `data-stuck` on a sticky element while it is pinned with content scrolled under
 *  it (a section header under the page bar), for its hairline. */
export function useStuck(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const check = () => {
      raf = 0;
      const top = Number.parseFloat(getComputedStyle(el).top) || 0;
      const stuck = window.scrollY > 0 && el.getBoundingClientRect().top <= top + 0.5;
      el.toggleAttribute("data-stuck", stuck);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, [ref]);
}
