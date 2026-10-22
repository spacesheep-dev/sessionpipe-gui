// SPDX-License-Identifier: Apache-2.0
// Our own right-click menu, app-wide, in place of the browser's: one shared menu (the
// WAI-ARIA menu pattern: arrows, Home/End, type-ahead, → and ← for submenus, Enter,
// Esc, Tab) that opens at the pointer, flips to stay inside the window and closes at
// once; on touch the same items as an action sheet from the bottom edge, opened by a
// long-press. An element gets a menu by spreading `useContextMenu(build)` on itself; the
// builder runs only when the menu opens. One listener (MenuHost, in the shell) decides
// what a right-click does: text fields, a selection outside a menu'd element, a view's
// own page and a held Shift keep the browser's menu; anything else without a menu gets
// nothing, as in a native app. `confirmAction` is the confirm sheet a destructive item
// asks through. Item builders shared across surfaces live in lib/menus.ts.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { copyText } from "../lib/clipboard";
import { usePath } from "../lib/router";
import { hintFor } from "../lib/shortcuts";
import "../styles/menu.css";

export type MenuItem =
  | {
      label: string;
      run: () => void | Promise<void>;
      /** A keymap action id: its live binding shows at the right ("⌘W", "G B"). */
      action?: string;
      /** A literal shortcut hint, where no keymap action applies ("⌘C"). */
      keys?: string;
      /** Red, and last in its menu. */
      danger?: boolean;
      /** Shown and inert; a string is the reason (its tooltip and description). */
      disabled?: string | boolean;
      /** A check (or, with `radio`, a bullet) in the lead column. */
      checked?: boolean;
      radio?: boolean;
    }
  | { label: string; items: MenuList; disabled?: string | boolean }
  | { sep: true }
  | { heading: string };

/** A builder's list: falsy entries drop out, so items can be written `cond && {…}`. */
export type MenuList = readonly (MenuItem | false | null | undefined | "" | 0)[];

type Leaf = Extract<MenuItem, { run: unknown }>;
type Sub = Extract<MenuItem, { items: unknown }>;
const isLeaf = (i: MenuItem): i is Leaf => "run" in i;
const isSub = (i: MenuItem): i is Sub => "items" in i;
const isAction = (i: MenuItem): i is Leaf | Sub => isLeaf(i) || isSub(i);

/** Falsy entries out, separators never doubled or at an edge. */
export function tidy(list: MenuList): MenuItem[] {
  const out: MenuItem[] = [];
  for (const i of list) {
    if (!i) continue;
    if ("sep" in i && (out.length === 0 || "sep" in out[out.length - 1]!)) continue;
    out.push(i);
  }
  while (out.length && "sep" in out[out.length - 1]!) out.pop();
  return out;
}

type Source = "mouse" | "keyboard" | "touch";

interface MenuRequest {
  items: MenuItem[];
  x: number;
  y: number;
  /** A rect to open under (a "⋯" button, Shift+F10 on a row): left edge, 4 px below. */
  anchor?: DOMRect;
  title?: string;
  subtitle?: string;
  source: Source;
  sheet: boolean;
  invoker: HTMLElement | null;
  owner: HTMLElement | null;
}

export interface MenuOptions {
  title?: string;
  subtitle?: string;
  source?: Source;
  /** Where focus goes back to when the menu closes. */
  invoker?: HTMLElement | null;
  /** The element the menu is about: it carries `data-menu-open` while the menu is up, so
   *  a row can keep its selected fill under its own menu (Finder, Mail). */
  owner?: HTMLElement | null;
}

// ----- the one open menu (or confirm), as a tiny store -----

interface ConfirmRequest {
  title: string;
  body?: string;
  action: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
  sheet: boolean;
  invoker: HTMLElement | null;
}

let menu: MenuRequest | null = null;
let confirmReq: ConfirmRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getMenu = () => menu;
const getConfirm = () => confirmReq;
const getMenuOpen = () => menu !== null;

/** Whether any menu (or action sheet) is open, for chrome that dims or holds a state
 *  while one is up. The element a menu is about also carries `data-menu-open`. */
export function useMenuOpen(): boolean {
  return useSyncExternalStore(subscribe, getMenuOpen, getMenuOpen);
}

const PHONE = "(max-width: 839px)";
const isPhone = () => typeof matchMedia === "function" && matchMedia(PHONE).matches;
let lastOpenAt = 0;

/** Opens a menu at a point, under a rect, or under an element (a "⋯" button). */
export function openMenu(list: MenuList, at: { x: number; y: number } | DOMRect | HTMLElement, o: MenuOptions = {}) {
  const items = tidy(list);
  if (items.length === 0) return;
  const el = at instanceof HTMLElement ? at : null;
  const rect = el ? el.getBoundingClientRect() : at instanceof DOMRect ? at : undefined;
  const point = rect ? { x: rect.left, y: rect.bottom + 4 } : (at as { x: number; y: number });
  const source = o.source ?? "mouse";
  lastOpenAt = Date.now();
  menu?.owner?.removeAttribute("data-menu-open");
  const owner = o.owner ?? el;
  owner?.setAttribute("data-menu-open", "");
  menu = {
    items,
    x: point.x,
    y: point.y,
    anchor: rect,
    title: o.title,
    subtitle: o.subtitle,
    source,
    sheet: source === "touch" || isPhone(),
    invoker: o.invoker ?? el ?? (document.activeElement as HTMLElement | null),
    owner,
  };
  emit();
}

export function closeMenu(restoreFocus = true) {
  if (!menu) return;
  const inv = menu.invoker;
  menu.owner?.removeAttribute("data-menu-open");
  menu = null;
  emit();
  if (restoreFocus && inv?.isConnected) inv.focus({ preventScroll: true });
}

/** Asks before a destructive or weighty action: an alert on a desktop, an action sheet
 *  on a phone. Resolves true for the action, false for Cancel, Esc or the scrim. */
export function confirmAction(o: { title: string; body?: string; action: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    confirmReq?.resolve(false);
    confirmReq = {
      ...o,
      resolve,
      sheet: isPhone(),
      invoker: document.activeElement as HTMLElement | null,
    };
    emit();
  });
}
function settleConfirm(ok: boolean) {
  const c = confirmReq;
  if (!c) return;
  confirmReq = null;
  emit();
  if (c.invoker?.isConnected) c.invoker.focus({ preventScroll: true });
  c.resolve(ok);
}

// ----- an element's menu -----

interface Claim {
  build: () => MenuList | null;
  title?: () => string;
  subtitle?: () => string;
  el: HTMLElement;
}
type MenuEvent = MouseEvent & { __menu?: Claim; __touch?: boolean; __kbd?: boolean };

/** Props for an element with a right-click menu (and a long-press sheet on touch). The
 *  builder runs when the menu opens and reads through a ref, so the props are stable and
 *  safe on memo'd rows. The innermost element with a menu wins. */
export function useContextMenu(
  build: () => MenuList | null,
  o: { title?: () => string; subtitle?: () => string } = {},
): { onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void; "data-menu": "" } {
  const ref = useRef({ build, o });
  ref.current = { build, o };
  const onContextMenu = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    const ne = e.nativeEvent as MenuEvent;
    if (ne.__menu) return;
    ne.__menu = {
      build: () => ref.current.build(),
      title: ref.current.o.title && (() => ref.current.o.title!()),
      subtitle: ref.current.o.subtitle && (() => ref.current.o.subtitle!()),
      el: e.currentTarget,
    };
  }, []);
  return { onContextMenu, "data-menu": "" };
}

const editable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el?.closest) return false;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
};

const selectionIn = (target: Node): string => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  const text = sel.toString();
  if (!text.trim()) return "";
  return sel.getRangeAt(0).intersectsNode(target) ? text : "";
};

/** The policy for every right-click, and the keyboard and touch ways in. */
function useMenuPolicy() {
  useEffect(() => {
    let kbdAt = 0;
    let touch: { x: number; y: number; t: number; target: EventTarget | null } | null = null;
    let timer: number | null = null;
    let lastTouchDown = 0;
    const clear = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      touch = null;
    };

    const onCtx = (ev: MouseEvent) => {
      const e = ev as MenuEvent;
      const t = e.target as HTMLElement | null;
      // A keyboard-made menu we already opened, or Android's own long-press after ours.
      if (!e.__kbd && !e.__touch && Date.now() - lastOpenAt < 400) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey && !e.__kbd) return;
      if (editable(t)) return;
      if (t?.closest?.(".theme-page")) return;
      const claim = e.__menu;
      if (e.defaultPrevented && !claim) return;
      const touchSrc = e.__touch || Date.now() - lastTouchDown < 1000;
      const source: Source = e.__kbd || Date.now() - kbdAt < 400 ? "keyboard" : touchSrc ? "touch" : "mouse";
      if (source === "touch") clear();
      const selected = source !== "touch" && t ? selectionIn(t) : "";
      // A selection with no menu'd element under it keeps the browser's own menu.
      if (selected && !claim) return;
      e.preventDefault();
      let items: MenuItem[] = claim ? tidy(claim.build() ?? []) : [];
      if (selected)
        items = tidy([{ label: "Copy", keys: "⌘C", run: () => copyText(selected) }, { sep: true }, ...items]);
      if (!claim && !selected) {
        const a = t?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (a && !a.closest("nav, [role=menu]")) {
          items = [
            { label: "Open link in new window", run: () => void window.open(a.href, "_blank", "noopener") },
            { label: "Copy link", run: () => copyText(a.href) },
          ];
        }
      }
      if (items.length === 0) return;
      // A right-click selects the row first (Finder, Mail): the list cursor follows focus.
      // Only a row, though: the row under the pointer, or a claimed element that is one
      // row (it holds a single list item). A page or list background selects nothing.
      if (claim && source === "mouse") {
        const under = t?.closest?.<HTMLElement>("[data-nav-item]");
        const rows = claim.el.matches("[data-nav-item]")
          ? [claim.el]
          : Array.from(claim.el.querySelectorAll<HTMLElement>("[data-nav-item]"));
        const item = under && claim.el.contains(under) ? under : rows.length === 1 ? rows[0] : null;
        item?.focus({ preventScroll: true });
      }
      const invoker = claim?.el ?? t;
      openMenu(
        items,
        source === "keyboard" && claim ? claim.el.getBoundingClientRect() : { x: e.clientX, y: e.clientY },
        {
          source,
          title: claim?.title?.(),
          subtitle: claim?.subtitle?.(),
          invoker: (document.activeElement as HTMLElement | null) ?? invoker,
          owner: claim?.el ?? null,
        },
      );
    };

    // Shift+F10 and the ContextMenu key: the focused element's menu, under it.
    const onKey = (e: KeyboardEvent) => {
      const isMenuKey = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
      if (!isMenuKey || menu) return;
      const t = document.activeElement as HTMLElement | null;
      if (!t || editable(t)) return;
      e.preventDefault();
      kbdAt = Date.now();
      const r = t.getBoundingClientRect();
      const ce = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: r.left,
        clientY: r.bottom,
      }) as MenuEvent;
      ce.__kbd = true;
      t.dispatchEvent(ce);
    };

    // A long-press on touch: the same event, marked, after 450 ms held still.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      lastTouchDown = Date.now();
      clear();
      const el = (e.target as HTMLElement | null)?.closest?.("[data-menu]");
      if (!el || editable(e.target)) return;
      touch = { x: e.clientX, y: e.clientY, t: Date.now(), target: e.target };
      timer = window.setTimeout(() => {
        const at = touch;
        clear();
        if (!at?.target) return;
        const ce = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: at.x,
          clientY: at.y,
        }) as MenuEvent;
        ce.__touch = true;
        (at.target as HTMLElement).dispatchEvent(ce);
        navigator.vibrate?.(8);
        // The finger lifting after a long-press is not a tap on the row.
        const swallow = (c: Event) => {
          c.preventDefault();
          c.stopPropagation();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 800);
      }, 450);
    };
    const onMove = (e: PointerEvent) => {
      if (touch && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 8) clear();
    };
    document.addEventListener("contextmenu", onCtx);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", clear, true);
    document.addEventListener("pointercancel", clear, true);
    window.addEventListener("scroll", clear, true);
    return () => {
      clear();
      document.removeEventListener("contextmenu", onCtx);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", clear, true);
      document.removeEventListener("pointercancel", clear, true);
      window.removeEventListener("scroll", clear, true);
    };
  }, []);
}

// ----- rendering -----

const EDGE = 8;

function shortcutOf(i: Leaf): string {
  if (i.keys) return i.keys;
  return i.action ? hintFor(i.action) : "";
}
const reason = (d: string | boolean | undefined): string | undefined => (typeof d === "string" ? d : undefined);

/** A menu row's ARIA and pointer props in one object: menuitem, or the checkbox and
 *  radio forms when the item carries a check, a submenu's popup state, and its mouse
 *  handlers. The keys are the menu's own (MenuPanel's onKeyDown roves focus). */
const rowProps = (o: {
  role: string;
  checked?: boolean;
  sub?: boolean;
  expanded?: boolean;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseUp?: (e: ReactMouseEvent) => void;
}) => ({
  role: o.role,
  "aria-checked": o.checked,
  "aria-haspopup": o.sub ? ("menu" as const) : undefined,
  "aria-expanded": o.sub ? o.expanded : undefined,
  onClick: o.onClick,
  onMouseEnter: o.onMouseEnter,
  onMouseUp: o.onMouseUp,
});

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function Check({ radio }: { radio?: boolean }) {
  if (radio)
    return (
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <circle cx="6" cy="6" r="2.5" fill="currentColor" />
      </svg>
    );
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path
        d="M2.5 6.5 5 9l4.5-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One level of the desktop menu; a submenu is another level beside its row. */
function MenuPanel({
  items,
  x,
  y,
  anchor,
  side,
  keyboard,
  label,
  onClose,
  onCloseAll,
  depth,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  /** A submenu's parent row: open beside it. */
  anchor?: DOMRect;
  side?: "right" | "left";
  keyboard: boolean;
  label?: string;
  onClose: () => void;
  onCloseAll: (restore?: boolean) => void;
  depth: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const actionable = items.map((i, n) => (isAction(i) ? n : -1)).filter((n) => n >= 0);
  const [active, setActive] = useState<number>(keyboard ? (actionable[0] ?? -1) : -1);
  const [open, setOpen] = useState<{ index: number; keyboard: boolean } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const hoverTimer = useRef<number | null>(null);

  // Place: at the point, flipped left or up when it would overflow, 8 px inside.
  useLayoutEffect(() => {
    const m = el.current;
    if (!m) return;
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (anchor && side) {
      left = side === "right" ? anchor.right - 2 : anchor.left - w + 2;
      if (left + w > vw - EDGE) left = anchor.left - w + 2;
      if (left < EDGE) left = Math.min(anchor.right - 2, vw - EDGE - w);
      top = anchor.top - 4;
    } else {
      left = x + w > vw - EDGE ? Math.max(EDGE, x - w) : x;
      top = y + h > vh - EDGE ? Math.max(EDGE, y - h) : y;
    }
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - EDGE - h));
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - EDGE - w));
    setPos({ left, top });
  }, [x, y, anchor, side]);

  // Focus: the menu itself on a mouse open (nothing highlighted), else the item. In a
  // layout effect, so a key pressed right after the menu opens already lands in it.
  useLayoutEffect(() => {
    if (!pos) return;
    const m = el.current;
    if (!m) return;
    const target = active >= 0 ? m.querySelector<HTMLElement>(`[data-i="${active}"]`) : m;
    if (!open) target?.focus({ preventScroll: true });
  }, [active, pos, open]);

  const run = (n: number, viaKeyboard: boolean) => {
    const i = items[n];
    if (!i || !isAction(i) || i.disabled) return;
    if (isSub(i)) {
      setActive(n);
      setOpen({ index: n, keyboard: viaKeyboard });
      return;
    }
    onCloseAll(true);
    try {
      const r = i.run();
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
    } catch {
      // the item's own error handling shows what went wrong
    }
  };

  const move = (delta: 1 | -1) => {
    if (actionable.length === 0) return;
    const at = actionable.indexOf(active);
    const next =
      at < 0
        ? delta === 1
          ? actionable[0]!
          : actionable[actionable.length - 1]!
        : actionable[(at + delta + actionable.length) % actionable.length]!;
    setActive(next);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (open) return; // the submenu has focus and its own keys
    const k = e.key;
    let handled = true;
    if (k === "ArrowDown") move(1);
    else if (k === "ArrowUp") move(-1);
    else if (k === "Home") setActive(actionable[0] ?? -1);
    else if (k === "End") setActive(actionable[actionable.length - 1] ?? -1);
    else if (k === "Enter" || k === " ") {
      if (active >= 0) run(active, true);
    } else if (k === "ArrowRight") {
      const i = items[active];
      if (i && isSub(i) && !i.disabled) setOpen({ index: active, keyboard: true });
    } else if (k === "ArrowLeft" && depth > 0) onClose();
    else if (k === "Escape") {
      if (depth > 0) onClose();
      else onCloseAll(true);
    } else if (k === "Tab") onCloseAll(false);
    else if (k.length === 1 && /\S/.test(k) && !e.metaKey && !e.ctrlKey) {
      const now = Date.now();
      const t = typed.current;
      t.text = now - t.at < 500 ? t.text + k.toLowerCase() : k.toLowerCase();
      t.at = now;
      const from = Math.max(0, actionable.indexOf(active));
      const order = [...actionable.slice(from + (t.text.length === 1 ? 1 : 0)), ...actionable.slice(0, from + 1)];
      const hit = order.find((n) => (items[n] as Leaf).label.toLowerCase().startsWith(t.text));
      if (hit !== undefined) setActive(hit);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const sub = open ? (items[open.index] as Sub | undefined) : undefined;
  const subRow = open ? el.current?.querySelector<HTMLElement>(`[data-i="${open.index}"]`) : null;

  return (
    <>
      <div
        ref={el}
        className="menu"
        role="menu"
        aria-label={label ?? "Actions"}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseLeave={() => !open && setActive(-1)}
        // Unplaced for one layout pass: transparent, not hidden, so focus can land in it.
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, opacity: 0, pointerEvents: "none" }}
        data-depth={depth}
      >
        {items.map((i, n) => {
          if ("sep" in i) return <hr key={`s${n}`} className="menu-sep" />;
          if ("heading" in i)
            return (
              <div key={`h${n}`} className="menu-heading" role="presentation">
                {i.heading}
              </div>
            );
          const leaf = isLeaf(i) ? i : null;
          const keys = leaf ? shortcutOf(leaf) : "";
          const role = leaf?.checked !== undefined ? (leaf.radio ? "menuitemradio" : "menuitemcheckbox") : "menuitem";
          return (
            <div
              key={`${i.label}${n}`}
              data-i={n}
              tabIndex={-1}
              className={`menu-item ${n === active ? "menu-item--active" : ""} ${leaf?.danger ? "menu-item--danger" : ""}`}
              aria-disabled={i.disabled ? true : undefined}
              aria-description={reason(i.disabled)}
              title={reason(i.disabled)}
              {...rowProps({
                role,
                checked: leaf?.checked,
                sub: isSub(i),
                expanded: open?.index === n,
                onClick: () => run(n, false),
                onMouseEnter: () => {
                  setActive(n);
                  if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
                  if (isSub(i) && !i.disabled) {
                    hoverTimer.current = window.setTimeout(() => setOpen({ index: n, keyboard: false }), 120);
                  } else if (open && open.index !== n) {
                    hoverTimer.current = window.setTimeout(() => setOpen(null), 250);
                  }
                },
                // A right-press dragged onto an item runs it, as a native menu does.
                onMouseUp: (e) => {
                  if (e.button === 2) run(n, false);
                },
              })}
            >
              <span className="menu-check" aria-hidden="true">
                {leaf?.checked ? <Check radio={leaf.radio} /> : null}
              </span>
              <span className="menu-label">{i.label}</span>
              {keys ? (
                <span className="menu-keys" aria-hidden="true">
                  {keys}
                </span>
              ) : null}
              {isSub(i) ? (
                <span className="menu-chev" aria-hidden="true">
                  <Chevron />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {sub && subRow && (
        <MenuPanel
          items={tidy(sub.items)}
          x={0}
          y={0}
          anchor={subRow.getBoundingClientRect()}
          side="right"
          keyboard={open!.keyboard}
          label={sub.label}
          depth={depth + 1}
          onClose={() => {
            setOpen(null);
            subRow.focus({ preventScroll: true });
          }}
          onCloseAll={onCloseAll}
        />
      )}
    </>
  );
}

/** The touch presentation: an action sheet with the same items, groups split at the
 *  separators, destructive items last, Cancel apart; a submenu pushes into the sheet. */
function ActionSheet({ req, onCloseAll }: { req: MenuRequest; onCloseAll: (restore?: boolean) => void }) {
  const [stack, setStack] = useState<{ label: string; items: MenuItem[] }[]>([]);
  const level = stack[stack.length - 1];
  const items = level ? level.items : req.items;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [stack.length]);
  const groups: MenuItem[][] = [[]];
  for (const i of items) {
    if ("sep" in i) groups.push([]);
    else groups[groups.length - 1]!.push(i);
  }
  const shown = groups.filter((g) => g.some(isAction));
  const pick = (i: MenuItem) => {
    if (!isAction(i) || i.disabled) return;
    if (isSub(i)) {
      setStack((s) => [...s, { label: i.label, items: tidy(i.items) }]);
      return;
    }
    onCloseAll(true);
    void Promise.resolve()
      .then(() => i.run())
      .catch(() => {});
  };
  return (
    <>
      <button type="button" className="menu-scrim" aria-label="Close" onClick={() => onCloseAll(true)} />
      <div
        className="menu-sheet"
        role="menu"
        aria-label={level?.label ?? req.title ?? "Actions"}
        tabIndex={-1}
        ref={ref}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (stack.length) setStack((s) => s.slice(0, -1));
            else onCloseAll(true);
          }
        }}
      >
        <span className="menu-grab" aria-hidden="true" />
        {(req.title || level) && (
          <div className="menu-sheet-head">
            {level ? (
              <button type="button" className="menu-sheet-back" onClick={() => setStack((s) => s.slice(0, -1))}>
                <span aria-hidden="true">‹</span> Back
              </button>
            ) : null}
            <div className="menu-sheet-title ellipsis">{level?.label ?? req.title}</div>
            {!level && req.subtitle ? <div className="menu-sheet-sub ellipsis">{req.subtitle}</div> : null}
          </div>
        )}
        {shown.map((g, gi) => (
          <div className="menu-sheet-group" key={gi}>
            {g.map((i, n) =>
              "heading" in i ? (
                <div key={`h${n}`} className="menu-heading" role="presentation">
                  {i.heading}
                </div>
              ) : isAction(i) ? (
                <button
                  type="button"
                  key={`${i.label}${n}`}
                  {...rowProps({
                    role:
                      isLeaf(i) && i.checked !== undefined
                        ? i.radio
                          ? "menuitemradio"
                          : "menuitemcheckbox"
                        : "menuitem",
                    checked: isLeaf(i) ? i.checked : undefined,
                  })}
                  className={`menu-sheet-item ${isLeaf(i) && i.danger ? "menu-item--danger" : ""}`}
                  disabled={!!i.disabled}
                  aria-description={reason(i.disabled)}
                  onClick={() => pick(i)}
                >
                  <span className="menu-label">{i.label}</span>
                  {isLeaf(i) && i.checked ? (
                    <span className="menu-check">
                      <Check radio={i.radio} />
                    </span>
                  ) : null}
                  {isSub(i) ? (
                    <span className="menu-chev" aria-hidden="true">
                      <Chevron />
                    </span>
                  ) : null}
                </button>
              ) : null,
            )}
          </div>
        ))}
        <div className="menu-sheet-group">
          <button type="button" className="menu-sheet-item menu-sheet-cancel" onClick={() => onCloseAll(true)}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

function ConfirmView({ c }: { c: ConfirmRequest }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(c.danger ? "[data-cancel]" : "[data-ok]");
    first?.focus({ preventScroll: true });
  }, [c]);
  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      settleConfirm(false);
    }
    if (e.key === "Tab") {
      // Two buttons: keep focus between them.
      const b = [...(ref.current?.querySelectorAll<HTMLElement>("button") ?? [])];
      const i = b.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      b[(i + (e.shiftKey ? -1 : 1) + b.length) % b.length]?.focus();
    }
  };
  if (c.sheet)
    return (
      <>
        <button type="button" className="menu-scrim" aria-label="Cancel" onClick={() => settleConfirm(false)} />
        <div
          className="menu-sheet"
          role="alertdialog"
          aria-modal="true"
          aria-label={c.title}
          ref={ref}
          onKeyDown={keys}
          tabIndex={-1}
        >
          <span className="menu-grab" aria-hidden="true" />
          <div className="menu-sheet-head menu-sheet-head--confirm">
            <div className="menu-sheet-title">{c.title}</div>
            {c.body ? <div className="menu-sheet-sub">{c.body}</div> : null}
          </div>
          <div className="menu-sheet-group">
            <button
              type="button"
              className={`menu-sheet-item ${c.danger ? "menu-item--danger" : ""}`}
              data-ok
              onClick={() => settleConfirm(true)}
            >
              {c.action}
            </button>
          </div>
          <div className="menu-sheet-group">
            <button
              type="button"
              className="menu-sheet-item menu-sheet-cancel"
              data-cancel
              onClick={() => settleConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </>
    );
  return (
    <>
      <button
        type="button"
        className="menu-scrim menu-scrim--dialog"
        aria-label="Cancel"
        onClick={() => settleConfirm(false)}
      />
      <div
        className="confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={c.body ? "confirm-body" : undefined}
        ref={ref}
        onKeyDown={keys}
        tabIndex={-1}
      >
        <h2 className="confirm-title" id="confirm-title">
          {c.title}
        </h2>
        {c.body ? (
          <p className="confirm-body" id="confirm-body">
            {c.body}
          </p>
        ) : null}
        <div className="confirm-actions">
          <button type="button" className="btn" data-cancel onClick={() => settleConfirm(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${c.danger ? "btn--danger" : "btn--primary"}`}
            data-ok
            onClick={() => settleConfirm(true)}
          >
            {c.action}
          </button>
        </div>
      </div>
    </>
  );
}

/** Mounted once, in the shell: the policy, and whatever menu or confirm is open. */
export function MenuHost() {
  useMenuPolicy();
  const req = useSyncExternalStore(subscribe, getMenu, getMenu);
  const conf = useSyncExternalStore(subscribe, getConfirm, getConfirm);
  const path = usePath();
  // A route change, a resize, the window losing focus or a scroll of the wheel closes it.
  useEffect(() => {
    closeMenu(false);
  }, [path]);
  useEffect(() => {
    if (!req) return;
    const off = () => closeMenu(false);
    // Esc closes it even when focus is elsewhere (a click outside the window and back),
    // before the page's own Esc (back) sees the key.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inside = (e.target as HTMLElement | null)?.closest?.(".menu, .menu-sheet");
      if (inside) return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    };
    document.addEventListener("keydown", onEsc, true);
    // The person scrolling closes it; the page scrolling itself (a followed session that
    // keeps to its newest line) does not, or a live row's menu would vanish under you.
    const onWheel = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".menu, .menu-sheet")) return;
      if (!req.sheet) off();
    };
    window.addEventListener("resize", off);
    window.addEventListener("blur", off);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener("keydown", onEsc, true);
      window.removeEventListener("resize", off);
      window.removeEventListener("blur", off);
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [req]);
  if (!req && !conf) return null;
  return createPortal(
    <>
      {req &&
        (req.sheet ? (
          <ActionSheet key={lastOpenAt} req={req} onCloseAll={(r) => closeMenu(r ?? true)} />
        ) : (
          <>
            {/* The click outside closes and is swallowed, as on macOS; a right-click there
                opens that element's menu instead. */}
            <div
              className="menu-catch"
              onPointerDown={(e) => {
                if (e.button === 2) return;
                e.preventDefault();
                closeMenu(false);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const { clientX: x, clientY: y } = e;
                closeMenu(false);
                requestAnimationFrame(() => {
                  const under = document.elementFromPoint(x, y);
                  under?.dispatchEvent(
                    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
                  );
                });
              }}
              aria-hidden="true"
            />
            <MenuPanel
              key={lastOpenAt}
              items={req.items}
              x={req.x}
              y={req.y}
              keyboard={req.source === "keyboard"}
              label={req.title}
              depth={0}
              onClose={() => closeMenu(true)}
              onCloseAll={(r) => closeMenu(r ?? true)}
            />
          </>
        ))}
      {conf && <ConfirmView c={conf} />}
    </>,
    document.body,
  );
}

/** The "⋯" button: the same menu as the element's right-click, under the button (an
 *  action sheet on a phone). */
export function MoreButton({
  build,
  label = "More actions",
  title,
  className = "",
  children,
}: {
  build: () => MenuList;
  label?: string;
  /** The sheet's head on a phone. */
  title?: () => string;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const req = useSyncExternalStore(subscribe, getMenu, getMenu);
  const open = !!req && req.invoker === ref.current && !!ref.current;
  return (
    <button
      type="button"
      ref={ref}
      className={`icon-btn ${className}`}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      title={label}
      onClick={(e) => {
        if (open) return closeMenu(true);
        const el = e.currentTarget;
        openMenu(build(), el, { source: e.detail === 0 ? "keyboard" : "mouse", invoker: el, title: title?.() });
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          openMenu(build(), e.currentTarget, { source: "keyboard", invoker: e.currentTarget, title: title?.() });
        }
      }}
    >
      {children ?? (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.5" />
          <circle cx="10" cy="10" r="1.5" />
          <circle cx="15.5" cy="10" r="1.5" />
        </svg>
      )}
    </button>
  );
}
