// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. The search field, the page's hero: one filled field, no Search
// button, every keystroke a query. While the caret ends a token a small list completes it
// (keys with Tab; values with ↑↓ and Tab or ⏎). ↑↓ outside it walk the results, ⏎ / ⇧⏎ /
// ⌘⏎ open the one under the cursor, Esc closes the list, then clears, then leaves for
// the list.
import type { SearchFacets } from "@shared/api";
import { forwardRef, type KeyboardEvent, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { HarnessGlyph } from "../components/bits";
import { LabelSwatch } from "../components/LabelDot";
import { IS_MAC } from "../lib/shortcuts";
import { markTyped } from "./client";
import { applyCompletion, type Completion, completionAt } from "./complete";

export interface FieldKeys {
  move: (d: 1 | -1) => void;
  open: (mode: "page" | "beside" | "background") => void;
  /** Esc with nothing left to clear: focus goes to the list. */
  leave: () => void;
}

export interface FieldHandle {
  focus: (select?: boolean) => void;
  input: () => HTMLInputElement | null;
}

export const SearchField = forwardRef<
  FieldHandle,
  {
    value: string;
    onChange: (q: string) => void;
    facets: SearchFacets | null;
    keys: FieldKeys;
    phone: boolean;
    autoFocus: boolean;
  }
>(function SearchField({ value, onChange, facets, keys, phone, autoFocus }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [sel, setSel] = useState(-1);
  /** The token the person dismissed with Esc: its list stays shut until the token changes. */
  const [shut, setShut] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const pendingCaret = useRef<number | null>(null);
  useImperativeHandle(ref, () => ({
    focus: (select = false) => {
      input.current?.focus();
      if (select) input.current?.select();
    },
    input: () => input.current,
  }));
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !input.current) return;
    input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  });
  const comp: Completion | null = focused ? completionAt(value, caret, facets) : null;
  const tokenId = comp ? `${comp.start}:${value.slice(comp.start, comp.end)}` : null;
  const shown = comp && tokenId !== shut ? comp : null;
  const pick = (i: number) => {
    if (!shown) return;
    const opt = shown.options[i];
    if (!opt) return;
    const r = applyCompletion(value, shown, opt);
    pendingCaret.current = r.caret;
    setSel(-1);
    markTyped();
    onChange(r.q);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (shown && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      pick(sel >= 0 ? sel : 0);
      return;
    }
    if (shown?.kind === "value" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = shown.options.length;
      setSel((s) => (e.key === "ArrowDown" ? (s + 1) % n : s <= 0 ? n - 1 : s - 1));
      return;
    }
    if (shown?.kind === "value" && e.key === "Enter" && sel >= 0) {
      e.preventDefault();
      pick(sel);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      keys.move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      keys.open(mod ? "background" : e.shiftKey ? "beside" : "page");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (shown) {
        setShut(tokenId);
        setSel(-1);
      } else if (value) {
        markTyped();
        onChange("");
      } else keys.leave();
    }
  };
  const track = () => {
    const el = input.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };
  return (
    <div className={`sx-fieldwrap ${phone ? "sx-fieldwrap--phone" : ""}`}>
      <label className="search sx-search">
        <svg className="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={input}
          data-search
          type="search"
          value={value}
          // biome-ignore lint/a11y/noAutofocus: the search page's field is the page
          autoFocus={autoFocus}
          onChange={(e) => {
            markTyped();
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setSel(-1);
            onChange(e.target.value);
          }}
          onKeyDown={onKey}
          onKeyUp={track}
          onClick={track}
          onSelect={track}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setSel(-1);
          }}
          placeholder={phone ? "Search" : "Search all sessions"}
          aria-label="Search prompts, replies and tool calls in every session"
          role="combobox"
          aria-expanded={!!shown}
          aria-controls={shown ? "sx-complete" : undefined}
          aria-activedescendant={shown && sel >= 0 ? `sx-opt-${sel}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {value ? (
          <button
            type="button"
            className="sx-clear"
            aria-label="Clear the field"
            title="Clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              markTyped();
              onChange("");
              input.current?.focus();
            }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" fill="currentColor" />
              <path
                d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"
                stroke="var(--bg-2)"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : (
          <kbd title="Press / to search">/</kbd>
        )}
      </label>
      {shown && (
        <div
          className="sx-complete menu-surface"
          id="sx-complete"
          role="listbox"
          aria-label={shown.kind === "key" ? "Filters" : `Values for ${shown.key}`}
          onMouseDown={(e) => e.preventDefault()}
          style={{ ["--at" as string]: `${Math.min(shown.start, 60)}ch` }}
        >
          {shown.options.map((o, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the field handles the keys (combobox)
            <div
              key={o.insert}
              id={`sx-opt-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === sel}
              className="sx-opt"
              onMouseMove={() => i !== sel && setSel(i)}
              onClick={() => pick(i)}
            >
              {shown.key === "agent" && o.value ? (
                <HarnessGlyph name={o.value} size="sm" />
              ) : shown.key === "label" && o.value ? (
                <LabelSwatch color={o.value as never} />
              ) : null}
              <span className="sx-opt-label">{o.label}</span>
              {o.hint ? <span className="sx-opt-hint">{o.hint}</span> : null}
              {o.count !== undefined ? <span className="sx-opt-n num">{o.count.toLocaleString()}</span> : null}
            </div>
          ))}
          {shown.kind === "key" && <div className="sx-opt-foot">Tab to add</div>}
        </div>
      )}
    </div>
  );
});
