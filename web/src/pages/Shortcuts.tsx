// SPDX-License-Identifier: Apache-2.0
// /shortcuts: the whole keymap, grouped under section headers (Go to, Everywhere, Lists,
// Session…), each row an action and its keys as caps; a cap is a button that records a
// new binding in place (a chord, or two within 1.2 s; Esc cancels, Backspace unbinds),
// with the conflicts named and refused: another action in a scope that can be live at the
// same time, a prefix clash ("g" against "g b"), or a key the browser owns. "Add another"
// shows on the row's hover and in its menu; Reset per row, Export / Import / Reset all in
// the bar's menu, and two presets as examples (Vim-style, Emacs-ish). A view plugin's
// registered keys are listed under its name. Settings › Keyboard shows the short form.
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchInput, Toggle } from "../components/bits";
import { MoreButton, useContextMenu } from "../components/ContextMenu";
import { PageBar } from "../components/PageBar";
import { groupActions, Keys } from "../components/ShortcutHelp";
import {
  type Action,
  activeKeys,
  allActions,
  applyPreset,
  bindingString,
  browserTakes,
  type Chord,
  type Conflict,
  chordOf,
  conflictFor,
  conflictWords,
  exportJson,
  formatBinding,
  getPreset,
  importJson,
  isOverridden,
  PRESETS,
  resetAll,
  resetBinding,
  SEQUENCE_MS,
  setBinding,
  sharedWith,
  useShortcutMap,
} from "../lib/shortcuts";

export function Shortcuts() {
  const map = useShortcutMap();
  const preset = getPreset();
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [q, setQ] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const overridden = Object.keys(map).filter(isOverridden).length;
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = allActions().filter(
      (a) =>
        !needle ||
        a.label.toLowerCase().includes(needle) ||
        a.group.toLowerCase().includes(needle) ||
        (map[a.id] ?? []).some((k) => formatBinding(k).join(" ").toLowerCase().includes(needle)),
    );
    return groupActions(list);
  }, [map, q]);

  const download = () => {
    const blob = new Blob([exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sessionpipe-gui-shortcuts.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const r = importJson(await f.text());
      setNote({
        text:
          r.skipped.length === 0
            ? `Imported ${r.applied} ${r.applied === 1 ? "override" : "overrides"}.`
            : `Imported ${r.applied}; skipped ${r.skipped.length}: ${r.skipped
                .slice(0, 4)
                .map((s) => `${s.id} (${s.reason})`)
                .join(", ")}${r.skipped.length > 4 ? ", …" : ""}`,
      });
    } catch (e) {
      setNote({ text: `Not imported: ${e instanceof Error ? e.message : String(e)}`, err: true });
    }
    if (fileRef.current) fileRef.current.value = "";
  };
  const nothingToReset = overridden === 0 && !preset;
  const doReset = () => {
    resetAll();
    setNote({ text: "Every shortcut is back to its default." });
  };

  return (
    <div className="page page--doc sc-page">
      <PageBar
        title="Keyboard shortcuts"
        meta={overridden > 0 ? `${overridden} changed` : undefined}
        tools={<SearchInput value={q} onChange={setQ} label="Search shortcuts" />}
        actions={
          <MoreButton
            label="Shortcut actions"
            title={() => "Keyboard shortcuts"}
            build={() => [
              { label: "Export…", run: download },
              { label: "Import…", run: () => fileRef.current?.click() },
              { sep: true },
              {
                label: "Reset all",
                danger: true,
                disabled: nothingToReset ? "Nothing is changed" : undefined,
                run: doReset,
              },
            ]}
          />
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <p className="caption sc-lede">
        Click a key to change it, then press the new one, or two in a row. Esc cancels, ⌫ unbinds; mod is ⌘ on a Mac.
      </p>
      {note && (
        <p className={`page-note sc-note ${note.err ? "is-err" : ""}`} role="status">
          {note.text}
        </p>
      )}

      <Presets onNote={(t, err) => setNote({ text: t, err })} />

      {groups.length === 0 && (
        <div className="state">
          <span className="state-title">No shortcut matches “{q.trim()}”</span>
          <span className="state-text">Search by an action's name or by its keys.</span>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.group} className="sc-group" aria-label={g.group}>
          <h2 className="sc-group-head">
            {g.group}
            {g.actions[0]?.view && <span className="sc-group-tag">view</span>}
          </h2>
          <ul className="sc-table">
            {g.actions.map((a, i) => (
              <Row
                key={a.id}
                action={a}
                keys={map[a.id] ?? []}
                // "The n-th installed view" once, not nine times.
                hint={a.hint && a.hint !== g.actions[i - 1]?.hint ? a.hint : undefined}
              />
            ))}
          </ul>
        </section>
      ))}
      <div className="sc-foot">
        <button type="button" className="btn" disabled={nothingToReset} onClick={doReset}>
          Reset all
        </button>
        <span className="caption">
          A view plugin lists its own keys here through <code>api.shortcuts.register</code>.
        </span>
      </div>
    </div>
  );
}

/** The two presets as switch rows; one on turns the other off. */
export function Presets({ onNote }: { onNote?: (text: string, err?: boolean) => void }) {
  useShortcutMap();
  const current = getPreset();
  const pick = (id: string, on: boolean) => {
    const r = applyPreset(on ? id : null);
    if (!onNote) return;
    if (!on) onNote(`${PRESETS[id]?.name} is off; its keys are back to the defaults.`);
    else if (r.skipped.length === 0) onNote(`${PRESETS[id]?.name} is on.`);
    else onNote(`${PRESETS[id]?.name} is on; skipped ${r.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}.`);
  };
  return (
    <section className="form-group sc-presets" aria-label="Presets">
      <div className="form-head">
        <h2 className="section-label">Presets</h2>
      </div>
      <ul className="form-list">
        {Object.values(PRESETS).map((p) => (
          <li key={p.id} className="form-row sc-preset" data-preset={p.id}>
            <span className="form-row-text">
              <span className="form-label">{p.name}</span>
              <span className="form-caption">{p.hint.charAt(0).toUpperCase() + p.hint.slice(1)}.</span>
            </span>
            <Toggle on={current === p.id} onChange={(v) => pick(p.id, v)} label={`${p.name} preset`} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ action: a, keys, hint }: { action: Action; keys: string[]; hint?: string }) {
  /** Which chip is being re-recorded (its index), or `keys.length` for a new one. */
  const [recording, setRecording] = useState<number | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const start = (i: number, from: HTMLElement) => {
    returnTo.current = from;
    setRecording(i);
  };
  const stop = () => {
    setRecording(null);
    const el = returnTo.current;
    returnTo.current = null;
    // The chip that was clicked, if it still exists, else the row's add button.
    requestAnimationFrame(() => {
      if (el?.isConnected) el.focus();
      else document.querySelector<HTMLElement>(`.sc-row[data-action="${CSS.escape(a.id)}"] .sc-add`)?.focus();
    });
  };
  const commit = (binding: string | null, i: number) => {
    const next = [...keys];
    if (binding === null) next.splice(i, 1);
    else if (i < next.length) next[i] = binding;
    else next.push(binding);
    setBinding(a.id, next.length === 0 ? null : [...new Set(next)]);
  };
  const shared = keys.flatMap((k) => sharedWith(a.id, k).map((o) => o.label));
  const changed = isOverridden(a.id);
  const menu = useContextMenu(
    () => {
      const row = rowRef.current;
      const first = row?.querySelector<HTMLElement>("button.sc-key");
      const add = row?.querySelector<HTMLElement>(".sc-add");
      return [
        first && { label: "Change key…", run: () => first.click() },
        add && { label: "Add a key…", run: () => add.click() },
        { sep: true },
        {
          label: "Reset to default",
          disabled: isOverridden(a.id) ? undefined : "Already the default",
          run: () => resetBinding(a.id),
        },
      ];
    },
    { title: () => a.label },
  );
  return (
    <li
      ref={rowRef}
      className="sc-row"
      data-action={a.id}
      data-overridden={changed || undefined}
      data-recording={recording !== null || undefined}
      {...menu}
    >
      <span className="sc-row-label">
        <span className="sc-row-name">{a.label}</span>
        {hint && <span className="sc-row-hint">{hint.charAt(0).toUpperCase() + hint.slice(1)}</span>}
        {shared.length > 0 && <span className="sc-row-hint">Also {[...new Set(shared)].join(", ")} elsewhere</span>}
      </span>
      <span className="sc-row-keys">
        {keys.map((k, i) =>
          recording === i ? (
            <Recorder
              key={`rec-${k}`}
              action={a}
              replacing={k}
              onDone={(b) => {
                commit(b, i);
                stop();
              }}
              onCancel={stop}
            />
          ) : (
            <button
              key={k}
              type="button"
              className={`sc-key ${browserTakes(k) === "soft" ? "sc-key--soft" : ""}`}
              onClick={(e) => start(i, e.currentTarget)}
              aria-label={`${a.label}: ${k}. Press to change`}
              title={browserTakes(k) === "soft" ? "The browser may take this key first" : "Change this key"}
            >
              <Keys binding={k} />
            </button>
          ),
        )}
        {keys.length === 0 && recording === null && <span className="sc-unbound">None</span>}
        {recording === keys.length ? (
          <Recorder
            action={a}
            onDone={(b) => {
              if (b) commit(b, keys.length);
              stop();
            }}
            onCancel={stop}
          />
        ) : (
          <button
            type="button"
            className="sc-add"
            onClick={(e) => start(keys.length, e.currentTarget)}
            aria-label={`Add a key for ${a.label}`}
            title="Add another key"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="icon-btn sc-reset"
          onClick={() => resetBinding(a.id)}
          aria-label={`Reset ${a.label} to its default`}
          title="Reset to default"
          hidden={!changed}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" />
            <path d="M3.5 2.8v2.4h2.4" />
          </svg>
        </button>
      </span>
    </li>
  );
}

/** "Press keys…": captures one chord, then waits SEQUENCE_MS for a second; a conflict is
 *  shown and refused (the recorder stays open for another try). */
function Recorder({
  action,
  replacing,
  onDone,
  onCancel,
}: {
  action: Action;
  /** The binding this one replaces: the same key again is fine, not a conflict. */
  replacing?: string;
  onDone: (binding: string | null) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [first, setFirst] = useState<Chord | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [soft, setSoft] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    ref.current?.focus();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const tryCommit = (seq: Chord[]) => {
    const binding = bindingString(seq);
    const c = binding === replacing ? null : conflictFor(action.id, binding);
    // The same key already on this action (another chip): nothing to do.
    const dup = binding !== replacing && activeKeys(action.id).includes(binding);
    if (c) {
      setConflict(c);
      setFirst(null);
      return;
    }
    if (dup) {
      onCancel();
      return;
    }
    onDone(binding);
  };

  const onKey = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const native = e.nativeEvent;
    if (native.key === "Escape" && !first) {
      onCancel();
      return;
    }
    if ((native.key === "Backspace" || native.key === "Delete") && !first && !native.metaKey && !native.ctrlKey) {
      onDone(null);
      return;
    }
    if (native.key === "Tab" && !first && !native.ctrlKey) return; // Tab leaves the recorder
    const chord = chordOf(native);
    if (!chord) return;
    setConflict(null);
    setSoft(browserTakes(bindingString([chord])) === "soft");
    if (first) {
      if (timer.current) clearTimeout(timer.current);
      tryCommit([first, chord]);
      return;
    }
    // A chord with a modifier is a whole binding by itself; a bare key may start a sequence.
    if (chord.mod || chord.ctrl || chord.alt || chord.meta || chord.key.length > 1) {
      tryCommit([chord]);
      return;
    }
    setFirst(chord);
    timer.current = setTimeout(() => tryCommit([chord]), SEQUENCE_MS);
  };

  return (
    <span className="sc-recorder" data-recording>
      {conflict && (
        <span className="sc-conflict" id="sc-conflict" role="alert">
          {conflictWords(conflict)} · try another
        </span>
      )}
      {!conflict && soft && <span className="sc-soft">The browser may take this key first</span>}
      {/* biome-ignore lint/a11y/useSemanticElements: a key-capturing field has no native element */}
      <span
        ref={ref}
        className="sc-rec-field"
        role="textbox"
        aria-label={`New key for ${action.label}: press it now`}
        aria-describedby={conflict ? "sc-conflict" : undefined}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={(e) => {
          // Focus left without a key: cancel, unless it moved into the recorder's own parts.
          if (!ref.current?.parentElement?.contains(e.relatedTarget as Node)) onCancel();
        }}
      >
        {first ? (
          <>
            <Keys binding={bindingString([first])} /> <span className="sc-rec-then">then…</span>
          </>
        ) : (
          "Press keys…"
        )}
      </span>
    </span>
  );
}
