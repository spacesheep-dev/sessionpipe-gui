// SPDX-License-Identifier: Apache-2.0
// The app's one tooltip, as the OS draws it: the control's name and, when it has one, its
// key in a key cap. It waits --tip-delay (600 ms) under a resting pointer; once one has
// shown, a neighbour's shows at once for the next 1.5 s (the macOS "warm" tooltip), so
// sweeping across a toolbar reads every name. It shows at once on keyboard focus, never
// on touch, never over its own open popover, and hides on a press, a key or a scroll.
//
// What it reads, on the element or its nearest ancestor that has one:
//   data-tip="Settings"             the name (a "Name   G S" with three spaces is split);
//   data-tip-keys="⌘,"              the key, drawn as a cap;
//   data-tip-side="top|right|bottom" where it sits (below by default, flipped to fit).
// Every icon-only button (`.icon-btn` / `.theme-btn` with an aria-label) gets one for
// free: its aria-label is the name, and its native `title` is held back while the tip is
// up so the browser's own never shows beside it. Mounted once, by the Shell.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const WARM_MS = 1500;
const EDGE = 8;
const GAP = 6;

const TARGET = "[data-tip], .icon-btn[aria-label], .theme-btn[aria-label], .bar-back[aria-label]";

interface Tip {
  name: string;
  keys: string;
  rect: DOMRect;
  side: "top" | "right" | "bottom";
}

function read(el: HTMLElement): Omit<Tip, "rect"> | null {
  const raw = el.getAttribute("data-tip") ?? el.getAttribute("aria-label") ?? "";
  if (!raw.trim()) return null;
  // A labelled button's own visible text already names it: no tip.
  if (!el.hasAttribute("data-tip") && (el.textContent ?? "").trim() && !el.querySelector(".sr-only")) return null;
  const [name, inline] = raw.split(/\s{3,}/);
  const side = (el.getAttribute("data-tip-side") as Tip["side"] | null) ?? "bottom";
  return { name: name ?? raw, keys: el.getAttribute("data-tip-keys") ?? inline ?? "", side };
}

export function TipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const warmUntil = useRef(0);
  useEffect(() => {
    const root = document.documentElement;
    // The CSS-only tips (keyboard.css) stand down while this host runs.
    root.setAttribute("data-tips", "");
    let timer: number | undefined;
    let current: HTMLElement | null = null;
    let heldTitle: string | null = null;
    let pressed: HTMLElement | null = null;
    /** The last press was a finger or a pen (no tips on focus until a key is pressed). */
    let touched = false;
    const restore = () => {
      if (current && heldTitle !== null) current.setAttribute("title", heldTitle);
      heldTitle = null;
    };
    const hide = () => {
      window.clearTimeout(timer);
      restore();
      current = null;
      setTip((t) => {
        if (t) warmUntil.current = Date.now() + WARM_MS;
        return null;
      });
    };
    const show = (el: HTMLElement, now: boolean) => {
      const t = read(el);
      if (!t) return;
      if (el.getAttribute("aria-expanded") === "true") return;
      window.clearTimeout(timer);
      // Hold the native title back while ours is pending or up.
      if (el.hasAttribute("title")) {
        heldTitle = el.getAttribute("title");
        el.removeAttribute("title");
      }
      const go = () => {
        if (current !== el || !el.isConnected) return;
        setTip({ ...t, rect: el.getBoundingClientRect() });
      };
      const delay = now || Date.now() < warmUntil.current ? 0 : readDelay();
      if (delay === 0) go();
      else timer = window.setTimeout(go, delay);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(TARGET) ?? null;
      if (el === current) return;
      if (current) hide();
      // A pressed control shows no tip again until the pointer has left it.
      if (el === pressed) return;
      pressed = null;
      if (!el) return;
      current = el;
      show(el, false);
    };
    const focus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      // Focus that a finger caused (a tap, or a sheet handing focus back to its trigger)
      // can still read as :focus-visible; a tip then would stay up where the finger was.
      if (touched) return;
      if (!t?.matches?.(":focus-visible")) return;
      const el = t.closest<HTMLElement>(TARGET);
      if (!el || el !== t) return;
      if (current) hide();
      current = el;
      show(el, true);
    };
    const blur = (e: FocusEvent) => {
      if (e.target === current) hide();
    };
    const press = (e: Event) => {
      if (e.type === "pointerdown") touched = (e as PointerEvent).pointerType !== "mouse";
      else if (e.type === "keydown") touched = false;
      if (!current) return;
      pressed = current;
      hide();
    };
    document.addEventListener("pointerover", over, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", blur, true);
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", press, true);
    window.addEventListener("scroll", press, true);
    window.addEventListener("blur", press);
    return () => {
      hide();
      root.removeAttribute("data-tips");
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", blur, true);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", press, true);
      window.removeEventListener("scroll", press, true);
      window.removeEventListener("blur", press);
    };
  }, []);
  if (!tip) return null;
  return createPortal(<TipView tip={tip} />, document.body);
}

const readDelay = (): number => {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--tip-delay").trim();
  const n = Number.parseFloat(v);
  return Number.isNaN(n) ? 600 : v.endsWith("ms") ? n : n * 1000;
};

function TipView({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const r = tip.rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (tip.side === "right") {
      left = r.right + GAP + 2;
      top = r.top + r.height / 2 - h / 2;
      if (left + w > vw - EDGE) left = r.left - GAP - w;
    } else {
      left = r.left + r.width / 2 - w / 2;
      top = tip.side === "top" ? r.top - GAP - h : r.bottom + GAP;
      if (top + h > vh - EDGE) top = r.top - GAP - h;
      if (top < EDGE) top = r.bottom + GAP;
    }
    left = Math.min(Math.max(EDGE, left), vw - EDGE - w);
    setPos({ left, top });
  }, [tip]);
  return (
    <div
      ref={ref}
      className="tip"
      aria-hidden="true"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      <span className="tip-name">{tip.name}</span>
      {tip.keys ? (
        <span className="tip-keys">
          {tip.keys.split(/\s+/).map((k, i) => (
            <kbd key={`${k}${i}`} className="kbd kbd--tip">
              {k}
            </kbd>
          ))}
        </span>
      ) : null}
    </div>
  );
}
