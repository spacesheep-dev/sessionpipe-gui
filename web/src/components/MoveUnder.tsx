// SPDX-License-Identifier: Apache-2.0
// Owned by: web. "Move under…": the session to put this one under, picked from a short
// list. A 400 px dialog on a desktop, a sheet on a phone (the confirm's and Edit labels'
// frames). A field filters as it is typed in (lib/fuzzy.ts, on the title and the
// computer); the list is every session the tree holds but this one, the sessions under it
// and the one it is under now, in the sidebar's order (lib/arrange.ts moveTargets). ↑ and
// ↓ move the choice, Enter or a click takes it, Esc closes. Mounted once, in the shell;
// any session's menu opens it through `requestMoveUnder`. The move is the person's view of
// the tree only: it is never sent to a machine.
import type { SessionKey, SessionSummary } from "@shared/api";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAppState, useStore } from "../data/hooks";
import { arrange, type MoveUnderRequest, moveTargets, onMoveUnder, personTree } from "../lib/arrange";
import { usePhoneLayout } from "../lib/device";
import { useFocusTrap } from "../lib/focus";
import { sessionTitle } from "../lib/format";
import { fuzzy } from "../lib/fuzzy";
import { HarnessGlyph } from "./bits";
import "../styles/pick.css";

/** Rows the list draws at most; the field narrows the rest. */
const PICK_MAX = 60;

export function MoveUnderHost() {
  const [req, setReq] = useState<MoveUnderRequest | null>(null);
  useEffect(() => onMoveUnder(setReq), []);
  useEffect(() => {
    const close = () => setReq(null);
    window.addEventListener("popstate", close);
    return () => window.removeEventListener("popstate", close);
  }, []);
  if (!req) return null;
  return <Picker key={req.key} moving={req.key} fromTree={!!req.fromTree} onClose={() => setReq(null)} />;
}

/** The sessions that match `q`, best first; all of them, in order, with nothing typed. */
export function pickMatches(list: readonly SessionSummary[], q: string): SessionSummary[] {
  const words = q.trim();
  if (!words) return list.slice(0, PICK_MAX);
  return list
    .map((s, i) => {
      const t = fuzzy(words, sessionTitle(s));
      const m = fuzzy(words, s.machine ?? "");
      const score = Math.max(t?.score ?? -1, (m?.score ?? -1) - 1);
      return { s, i, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, PICK_MAX)
    .map((x) => x.s);
}

function Picker({ moving, fromTree, onClose }: { moving: SessionKey; fromTree: boolean; onClose: () => void }) {
  const store = useStore();
  const state = useAppState();
  const ref = useRef<HTMLDivElement>(null);
  const phone = usePhoneLayout();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const list = useMemo(() => moveTargets(personTree(state).tree, moving), [state, moving]);
  const shown = useMemo(() => pickMatches(list, q), [list, q]);
  const choice = Math.min(at, Math.max(0, shown.length - 1));
  const s = state.sessions.get(moving);
  const id = useId();
  useFocusTrap(ref, true, { onClose, initial: "input" });
  useEffect(() => {
    ref.current?.querySelector(`[data-pick="${choice}"]`)?.scrollIntoView({ block: "nearest" });
  }, [choice]);
  const take = (p: SessionSummary | undefined) => {
    if (!p) return;
    onClose();
    arrange(store, moving, { kind: "under", parent: p.key }, fromTree ? { source: "picker" } : undefined);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") setAt(Math.min(choice + 1, shown.length - 1));
    else if (e.key === "ArrowUp") setAt(Math.max(choice - 1, 0));
    else if (e.key === "Enter") take(shown[choice]);
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
  };
  if (!s) return null;
  const title = (
    <h2 className={phone ? "menu-sheet-title" : "confirm-title"} id={`${id}-title`}>
      Move under…
    </h2>
  );
  return (
    <>
      <button
        type="button"
        className={phone ? "menu-scrim" : "menu-scrim menu-scrim--dialog"}
        aria-label="Close"
        onClick={onClose}
        data-dismiss
      />
      <div
        className={phone ? "menu-sheet pick-sheet" : "confirm pick-dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-what`}
        ref={ref}
        tabIndex={-1}
      >
        {phone && <span className="menu-grab" aria-hidden="true" />}
        {phone ? <div className="menu-sheet-head">{title}</div> : title}
        <p className="pick-what" id={`${id}-what`}>
          Where “{sessionTitle(s)}” shows in your tree. Nothing is sent to its computer.
        </p>
        <input
          className="field pick-field"
          type="text"
          value={q}
          placeholder="Find a session"
          aria-label="Find a session"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={shown.length ? `${id}-opt-${choice}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={onKey}
        />
        {shown.length === 0 ? (
          <p className="pick-list pick-none" id={`${id}-list`} role="status">
            {list.length === 0 ? "No other session to put it under" : `No session matches “${q.trim()}”`}
          </p>
        ) : (
          <div className="pick-list" role="listbox" id={`${id}-list`} aria-label="Sessions">
            {shown.map((p, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the field above has the keys (↑ ↓ Enter), as a combobox's list does
              <div
                key={p.key}
                id={`${id}-opt-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === choice}
                className="pick-row"
                data-pick={i}
                onPointerMove={() => i !== choice && setAt(i)}
                onClick={() => take(p)}
              >
                <HarnessGlyph name={p.harness} size="sm" />
                <span className="pick-title" dir="auto">
                  {sessionTitle(p)}
                </span>
                {p.machine && <span className="pick-where">{p.machine}</span>}
              </div>
            ))}
          </div>
        )}
        <div className={phone ? "menu-sheet-group" : "confirm-actions"}>
          <button type="button" className={phone ? "menu-sheet-item menu-sheet-cancel" : "btn"} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
