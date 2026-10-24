// SPDX-License-Identifier: Apache-2.0
// The `?` help's dialog (ShortcutHelp.tsx opens it, and loads this module once the page is
// idle): a read-only cheat sheet in the palette's frame, every active binding in two
// columns of groups (in the order the menus group them: everywhere, go to, lists, the
// session…) with each key a cap, a search, and one way on to the editor ("Customize…"); a
// view plugin's own keys (ThemeApi.shortcuts) are listed too. It zooms out as it closes.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../lib/focus";
import { Link, navigate } from "../lib/router";
import { allActions, browserTakes, formatBinding, useShortcutMap } from "../lib/shortcuts";
import { Kbd } from "./bits";
import { noContextMenu } from "./QuickSettings";
import { groupActions, Keys } from "./ShortcutHelp";
import "../styles/palette.css";

/** The help's group order: as the menus and the rail group things, the common first. */
const GROUP_ORDER = [
  "Everywhere",
  "Go to",
  "Lists",
  "Labels",
  "Session",
  "Inbox",
  "Feed",
  "Side panel",
  "New session",
  "Command palette",
];
const groupRank = (g: string) => {
  const i = GROUP_ORDER.indexOf(g);
  return i < 0 ? GROUP_ORDER.length : i;
};

export function HelpDialog({ onClose, closing }: { onClose: () => void; closing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const [q, setQ] = useState("");
  const map = useShortcutMap();
  useFocusTrap(ref, !closing, { onClose, initial: "input" });
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = allActions().filter((a) => {
      const keys = map[a.id] ?? [];
      if (keys.length === 0 && !needle) return false;
      if (!needle) return true;
      return (
        a.label.toLowerCase().includes(needle) ||
        a.group.toLowerCase().includes(needle) ||
        keys.some((k) => k.includes(needle) || formatBinding(k).join(" ").toLowerCase().includes(needle))
      );
    });
    // Stable: within a rank the declared order holds.
    return groupActions(list).sort((a, b) => groupRank(a.group) - groupRank(b.group));
  }, [q, map]);
  // More below the fold: the list's bottom edge fades instead of cutting a row in half.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let raf = 0;
    const edge = () => {
      raf = 0;
      el.toggleAttribute("data-more", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(edge);
    };
    edge();
    el.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, [groups]);
  // The nine "view n" keys read as one row while they are the defaults and nothing is searched.
  const collapseViews =
    !q.trim() &&
    Array.from({ length: 9 }, (_, i) => i + 1).every((i) => (map[`nav.view${i}`] ?? []).join() === `g ${i}`);
  return (
    <>
      <button
        type="button"
        className="pal-scrim"
        aria-label="Close"
        onClick={onClose}
        data-dismiss
        data-closing={closing ? "" : undefined}
      />
      <div
        className="pal sc-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        aria-hidden={closing || undefined}
        data-closing={closing ? "" : undefined}
        ref={ref}
        onContextMenu={noContextMenu}
        onKeyDown={(e) => {
          // Nothing here reaches the page's own keys; `?` closes it again.
          e.stopPropagation();
          if (e.key === "?" && !(e.target as HTMLElement).matches("input")) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="pal-head">
          <svg className="pal-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search shortcuts"
            aria-label="Search shortcuts"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="pal-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard (axe scrollable-region-focusable) */}
        <section className="sc-help-list" tabIndex={0} aria-label="Bindings" ref={listRef}>
          {groups.length === 0 && <p className="pal-empty">Nothing matches “{q.trim()}”.</p>}
          {groups.map((g) => (
            <section key={g.group} className="sc-help-group" aria-label={g.group}>
              <h2 className="pal-section">{g.group}</h2>
              <ul>
                {g.actions.map((a) => {
                  const keys = map[a.id] ?? [];
                  const view = /^nav\.view([1-9])$/.exec(a.id);
                  if (view && collapseViews) {
                    if (view[1] !== "1") return null;
                    return (
                      <li key="nav.view1-9" className="sc-row" data-action="nav.view1-9">
                        <span className="sc-row-label">View 1–9</span>
                        <span className="sc-row-keys">
                          <span className="kbd-row">
                            <Kbd>g</Kbd>
                            <Kbd>1–9</Kbd>
                          </span>
                        </span>
                      </li>
                    );
                  }
                  return (
                    <li key={a.id} className="sc-row" data-action={a.id}>
                      <span className="sc-row-label">{a.label}</span>
                      <span className="sc-row-keys">
                        {keys.length === 0 && <span className="sc-unbound">None</span>}
                        {keys.map((k) => (
                          <span
                            key={k}
                            title={browserTakes(k) === "soft" ? "The browser may take this key first" : undefined}
                          >
                            <Keys caps binding={k} className={browserTakes(k) === "soft" ? "keys--soft" : ""} />
                          </span>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </section>
        <div className="pal-foot sc-help-foot">
          <span className="sc-help-seq">
            <span className="kbd-row">
              <Kbd>g</Kbd>
              <Kbd>b</Kbd>
            </span>
            one after the other
          </span>
          <Link
            to="/shortcuts"
            className="sc-help-link"
            plainClick={() => {
              onClose();
              navigate("/shortcuts");
            }}
          >
            Customize…
          </Link>
        </div>
      </div>
    </>
  );
}
