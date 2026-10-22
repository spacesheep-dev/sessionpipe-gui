// SPDX-License-Identifier: Apache-2.0
// "Edit labels…": the seven colour labels and what the person calls them, as one grouped
// form (ORGANIZE-SPEC.md §3.3). A 400 px dialog on a desktop, a sheet on a phone. Each row
// is the colour's dot and a field holding its name (the colour's own name is the
// placeholder); a field saves when it loses focus or on Enter, and an empty one goes back
// to the colour's own name. Mounted once, in the shell; any "Edit labels…" item opens it
// through `requestLabelRename`, at one colour's field or at the list.
import { LABEL_COLORS, LABEL_DEFAULT_NAMES, LABEL_NAME_MAX, type LabelColor } from "@shared/api";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useLabels, useStore } from "../data/hooks";
import { useFocusTrap } from "../lib/focus";
import { onLabelRename, renameLabel } from "../lib/labels";

const TOO_LONG = `Up to ${LABEL_NAME_MAX} characters`;

export function LabelsDialog() {
  const [open, setOpen] = useState<{ color?: LabelColor } | null>(null);
  useEffect(() => onLabelRename((color) => setOpen({ color })), []);
  // A route change closes it, as the other dialogs do.
  useEffect(() => {
    const close = () => setOpen(null);
    window.addEventListener("popstate", close);
    return () => window.removeEventListener("popstate", close);
  }, []);
  if (!open) return null;
  return <Dialog focus={open.color} onClose={() => setOpen(null)} />;
}

function Dialog({ focus, onClose }: { focus?: LabelColor; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Read once, at open: a sheet on a phone, a dialog elsewhere.
  const [phone] = useState(() => window.matchMedia?.("(max-width: 839px)").matches ?? false);
  useFocusTrap(ref, true, { onClose, initial: focus ? `[data-label="${focus}"] input` : "input" });
  const rows = (
    <ul className="labels-rows">
      {LABEL_COLORS.map((c) => (
        <LabelField key={c} color={c} />
      ))}
    </ul>
  );
  const done = (
    <button
      type="button"
      className={phone ? "menu-sheet-item menu-sheet-cancel" : "btn btn--primary"}
      onClick={onClose}
    >
      Done
    </button>
  );
  if (phone)
    return (
      <>
        <button type="button" className="menu-scrim" aria-label="Close" onClick={onClose} data-dismiss />
        <div
          className="menu-sheet labels-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="labels-title"
          ref={ref}
          tabIndex={-1}
        >
          <span className="menu-grab" aria-hidden="true" />
          <div className="menu-sheet-head">
            <h2 className="menu-sheet-title" id="labels-title">
              Labels
            </h2>
          </div>
          <div className="menu-sheet-group">{rows}</div>
          <div className="menu-sheet-group">{done}</div>
        </div>
      </>
    );
  return (
    <>
      <button
        type="button"
        className="menu-scrim menu-scrim--dialog"
        aria-label="Close"
        onClick={onClose}
        data-dismiss
      />
      <div
        className="confirm labels-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="labels-title"
        ref={ref}
        tabIndex={-1}
      >
        <h2 className="confirm-title" id="labels-title">
          Labels
        </h2>
        {rows}
        <div className="confirm-actions">{done}</div>
      </div>
    </>
  );
}

/** One label: its dot and its name, saved on blur or Enter; the server's refusal (or a name
 *  over the limit) shows under it and the field keeps the text. */
function LabelField({ color }: { color: LabelColor }) {
  const store = useStore();
  const labels = useLabels();
  const saved = labels.names[color] ?? "";
  const [text, setText] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  // Another device renamed it while this field was not being edited: show that.
  useEffect(() => {
    if (!editing.current) setText(saved);
  }, [saved]);
  const save = async () => {
    editing.current = false;
    const name = text.trim();
    if (name.length > LABEL_NAME_MAX) {
      setError(TOO_LONG);
      return;
    }
    setError(null);
    if (name === saved) return;
    try {
      await renameLabel(store, color, name || null);
      if (!name) setText("");
    } catch (e) {
      setError((e as Error).message === "bad_name" ? TOO_LONG : "Not saved; try again");
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  };
  const id = `label-${color}`;
  return (
    <li className="labels-row" data-label={color}>
      <span className={`label-dot label-dot--${color} labels-dot`} aria-hidden="true" />
      <input
        id={id}
        className="field labels-field"
        value={text}
        placeholder={LABEL_DEFAULT_NAMES[color]}
        aria-label={`${LABEL_DEFAULT_NAMES[color]} label name`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        maxLength={LABEL_NAME_MAX * 2}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(e) => {
          editing.current = true;
          setText(e.target.value);
          if (error && e.target.value.trim().length <= LABEL_NAME_MAX) setError(null);
        }}
        onBlur={() => void save()}
        onKeyDown={onKey}
      />
      {error && (
        <p className="labels-err" id={`${id}-err`} role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
