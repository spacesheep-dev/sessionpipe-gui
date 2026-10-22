// SPDX-License-Identifier: Apache-2.0
// `?` on any page: a read-only cheat sheet in the palette's frame, every active binding in
// two columns of groups with the keys as quiet strings, a search, and one way on to the
// editor ("Customize…"); a view plugin's own keys (ThemeApi.shortcuts) are listed too. Also
// the small chip that shows the first key of a sequence while the second is awaited
// ("g …"). Mounted once, in the shell; the help's own key and the palette's are attached here.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../lib/focus";
import { Link, navigate } from "../lib/router";
import {
  type Action,
  allActions,
  browserTakes,
  formatBinding,
  usePendingChord,
  useShortcut,
  useShortcutMap,
} from "../lib/shortcuts";
import { noContextMenu } from "./QuickSettings";

/** One binding as chips: <kbd>g</kbd> <kbd>f</kbd>. */
export function Keys({ binding, className = "" }: { binding: string; className?: string }) {
  const parts = formatBinding(binding);
  return (
    <span className={`keys ${className}`}>
      {parts.map((p, i) => (
        <kbd key={`${p}-${i}`}>{p}</kbd>
      ))}
    </span>
  );
}

/** Actions grouped in the order they are declared, the views' groups last. */
export function groupActions(actions: readonly Action[]): { group: string; actions: Action[] }[] {
  const out: { group: string; actions: Action[] }[] = [];
  for (const a of actions) {
    let g = out.find((x) => x.group === a.group);
    if (!g) {
      g = { group: a.group, actions: [] };
      out.push(g);
    }
    g.actions.push(a);
  }
  return out;
}

export function ChordHint() {
  const pending = usePendingChord();
  if (!pending) return null;
  return (
    <div className="chord-hint" role="status" aria-live="polite">
      <kbd>{pending}</kbd> <span>then…</span>
    </div>
  );
}

export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  useShortcut("help.toggle", () => setOpen((o) => !o));
  // A route change closes it.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("popstate", close);
    return () => window.removeEventListener("popstate", close);
  }, []);
  return (
    <>
      <ChordHint />
      {open && <HelpDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const map = useShortcutMap();
  useFocusTrap(ref, true, { onClose, initial: "input" });
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
    return groupActions(list);
  }, [q, map]);
  // The nine "view n" keys read as one row while they are the defaults and nothing is searched.
  const collapseViews =
    !q.trim() &&
    Array.from({ length: 9 }, (_, i) => i + 1).every((i) => (map[`nav.view${i}`] ?? []).join() === `g ${i}`);
  return (
    <>
      <button type="button" className="pal-scrim" aria-label="Close" onClick={onClose} data-dismiss />
      <div
        className="pal sc-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
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
        <section className="sc-help-list" tabIndex={0} aria-label="Bindings">
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
                      <li key="nav.views" className="sc-row" data-action="nav.view1-9">
                        <span className="sc-row-label">View 1–9</span>
                        <span className="sc-row-keys">
                          <span className="keys">
                            <kbd>g</kbd>
                            <kbd>1–9</kbd>
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
                            <Keys binding={k} className={browserTakes(k) === "soft" ? "keys--soft" : ""} />
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
          <span>Two keys in a row within 1.2 s</span>
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
