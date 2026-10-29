// SPDX-License-Identifier: Apache-2.0
// The one custom select (house rule: no native <select> anywhere in the GUI). A
// pop-up button (the toolbar's control height) and a listbox in a portal under document.body,
// anchored below the trigger and flipped above when the room runs out; on a phone the
// same list is a bottom sheet. The APG select-only combobox pattern: focus stays on the
// trigger (role combobox), the list is role listbox, the row under the cursor is named by
// aria-activedescendant. Space / Enter / arrows open; arrows, Home, End and typing move;
// Enter picks; Esc closes and gives focus back; Tab closes. `MultiSelect` is the same
// with checkmarks and a summary ("3 selected"). `searchable` adds a filter input to the
// list (on by default past eight options); `custom` turns what is typed there into one
// more row ("Use ~/acme/web/app"), for a field that takes a value the list does not hold.
// An option with `divider` has a hairline above it: sections without headings.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import "../styles/select.css";

export interface SelectOption<T> {
  value: T;
  label: string;
  /** A second word in muted text at the row's right, "default", "ding.wav". */
  hint?: string;
  /** The hint in the attention colour, for the one state it carries ("None left"). */
  hintTone?: "attention";
  /** A mark in the column before the label (a harness glyph). */
  icon?: ReactNode;
  disabled?: boolean;
  /** A hairline above this row: the start of a section with no heading. */
  divider?: boolean;
  /** One muted line under the label, in the list only (a permission level's meaning). */
  detail?: string;
}

interface CommonProps<T> {
  options: SelectOption<T>[];
  /** Shown in the trigger when nothing is chosen. */
  placeholder?: string;
  size?: "sm" | "md";
  /** Which edge of the trigger the list lines up with when it is wider. */
  align?: "start" | "end";
  /** A filter input at the top of the list; on by itself past eight options. */
  searchable?: boolean;
  /** The filter's placeholder ("Filter"). */
  filterPlaceholder?: string;
  /** What the filter's text means when no row is it: one more row at the end (a path, a
   *  model id), or null. Implies `searchable`. */
  custom?: (text: string) => SelectOption<T> | null;
  /** One muted line under the list ("studio-mac is in safe mode. …"). */
  footer?: ReactNode;
  /** The trigger's text, given the chosen option(s). */
  renderValue?: (chosen: SelectOption<T>[]) => ReactNode;
  "aria-label"?: string;
  labelledBy?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  /** Where the id of a value comes from when values are not strings. */
  keyOf?: (v: T) => string;
}

export interface SelectProps<T> extends CommonProps<T> {
  value: T | null | undefined;
  onChange: (v: T) => void;
}

export interface MultiSelectProps<T> extends CommonProps<T> {
  value: T[];
  onChange: (v: T[]) => void;
}

const PHONE = "(max-width: 599px)";
const MAX_LIST_WIDTH = 320;
const MAX_LIST_HEIGHT = 320;
const GAP = 6;
const EDGE = 8;

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => (typeof matchMedia === "function" ? matchMedia(PHONE).matches : false));
  useEffect(() => {
    const mq = matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

const defaultKey = (v: unknown) => String(v);

export function Select<T>(p: SelectProps<T>) {
  const { value, onChange, ...rest } = p;
  const chosen = useMemo(() => (value === null || value === undefined ? [] : [value]), [value]);
  return <Picker<T> {...rest} multiple={false} chosen={chosen} onPick={(v) => onChange(v)} />;
}

export function MultiSelect<T>(p: MultiSelectProps<T>) {
  const { value, onChange, keyOf = defaultKey, ...rest } = p;
  return (
    <Picker<T>
      {...rest}
      keyOf={keyOf}
      multiple
      chosen={value}
      onPick={(v) => {
        const k = keyOf(v);
        onChange(value.some((x) => keyOf(x) === k) ? value.filter((x) => keyOf(x) !== k) : [...value, v]);
      }}
    />
  );
}

interface Place {
  top?: number;
  bottom?: number;
  left: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
  above: boolean;
}

function Picker<T>({
  options,
  chosen,
  onPick,
  multiple,
  placeholder = "Choose…",
  size = "md",
  align = "start",
  searchable,
  filterPlaceholder = "Filter",
  custom,
  footer,
  renderValue,
  "aria-label": ariaLabel,
  labelledBy,
  id,
  disabled = false,
  className = "",
  keyOf = defaultKey,
}: CommonProps<T> & { chosen: T[]; onPick: (v: T) => void; multiple: boolean }) {
  const phone = usePhone();
  const canSearch = !!custom || (searchable ?? options.length > 8);
  const rawId = useId().replace(/:/g, "");
  const listId = `sel-${rawId}-list`;
  const optId = (i: number) => `sel-${rawId}-${i}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(-1);
  const [place, setPlace] = useState<Place | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const chosenKeys = useMemo(() => new Set(chosen.map(keyOf)), [chosen, keyOf]);
  const isChosen = (o: SelectOption<T>) => chosenKeys.has(keyOf(o.value));
  const chosenOptions = useMemo(() => {
    const found = options.filter((o) => chosenKeys.has(keyOf(o.value)));
    // A value the list does not hold (typed by hand through `custom`) still shows as itself.
    if (!multiple && !found.length && chosen.length && custom) {
      const c = custom(keyOf(chosen[0]!));
      if (c) return [c];
    }
    return found;
  }, [options, chosenKeys, keyOf, chosen, custom, multiple]);
  const hasIcons = options.some((o) => o.icon);

  const visible = (text: string) => withCustom(filterOptions(options, text), text, custom, keyOf);
  const shown = useMemo(() => withCustom(filterOptions(options, q), q, custom, keyOf), [options, q, custom, keyOf]);

  // ----- open / close -----

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setQ("");
    setPlace(null);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  }, []);

  const show = (at?: number) => {
    if (disabled || open) return;
    const first = options.findIndex((o) => isChosen(o));
    const start = at ?? (first >= 0 ? first : options.findIndex((o) => !o.disabled));
    setCursor(start);
    setOpen(true);
  };

  // Focus the filter on open; the trigger keeps focus otherwise. On a desktop the list is
  // hidden until it is placed, and a hidden field takes no focus: wait for the place.
  const placed = phone || place !== null;
  useEffect(() => {
    if (open && canSearch && placed) search.current?.focus({ preventScroll: true });
  }, [open, canSearch, placed]);

  // A new filter puts the cursor on the first row that can be picked. (Not an effect on
  // `shown`: callers hand in a fresh options array each render, and the board re-renders
  // every second.)
  const filter = (text: string) => {
    setQ(text);
    setCursor(visible(text).findIndex((o) => !o.disabled));
  };

  useLayoutEffect(() => {
    if (!open || cursor < 0) return;
    list.current?.querySelector<HTMLElement>(`#${optId(cursor)}`)?.scrollIntoView({ block: "nearest" });
  });

  // Click outside closes; so does a pick elsewhere by keyboard (focus leaving both parts).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (trigger.current?.contains(t) || pop.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, close]);

  // ----- placement (desktop): under the trigger, flipped above when there is no room -----

  const measure = useCallback(() => {
    const t = trigger.current;
    const el = pop.current;
    if (!t || !el) return;
    const r = t.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxWidth = Math.min(Math.max(MAX_LIST_WIDTH, r.width), vw - EDGE * 2);
    const below = vh - r.bottom - GAP - EDGE;
    const aboveRoom = r.top - GAP - EDGE;
    const need = Math.min(el.scrollHeight, MAX_LIST_HEIGHT);
    const above = below < need && aboveRoom > below;
    const maxHeight = Math.max(96, Math.min(MAX_LIST_HEIGHT, above ? aboveRoom : below));
    const w = Math.min(Math.max(el.offsetWidth, r.width), maxWidth);
    let left = align === "end" ? r.right - w : r.left;
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
    setPlace({
      left,
      minWidth: r.width,
      maxWidth,
      maxHeight,
      above,
      ...(above ? { bottom: vh - r.top + GAP } : { top: r.bottom + GAP }),
    });
  }, [align]);

  useLayoutEffect(() => {
    if (!open || phone) return;
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, phone, measure, shown.length]);

  // ----- keys -----

  const move = (from: number, step: 1 | -1) => {
    const n = shown.length;
    if (n === 0) return -1;
    let i = from;
    for (let k = 0; k < n; k++) {
      i = (i + step + n) % n;
      if (!shown[i]!.disabled) return i;
    }
    return from;
  };
  const edge = (end: boolean) => {
    const idx = end
      ? shown
          .map((o, i) => (o.disabled ? -1 : i))
          .filter((i) => i >= 0)
          .pop()
      : shown.findIndex((o) => !o.disabled);
    return idx === undefined ? -1 : idx;
  };

  /** Type-ahead over the labels: letters within a moment form a prefix; the same letter
   *  again walks the rows starting with it. */
  const typeAhead = (ch: string, from: number) => {
    const now = Date.now();
    const t = typed.current;
    const text = now - t.at < 600 ? t.text + ch : ch;
    typed.current = { text, at: now };
    const same = text.length > 1 && [...text].every((c) => c === text[0]);
    const prefix = (same ? text[0]! : text).toLowerCase();
    const n = shown.length;
    const start = same || text.length === 1 ? from + 1 : from;
    for (let k = 0; k < n; k++) {
      const i = (Math.max(start, 0) + k) % n;
      const o = shown[i]!;
      if (!o.disabled && o.label.toLowerCase().startsWith(prefix)) return i;
    }
    return -1;
  };

  const pick = (i: number) => {
    const o = shown[i];
    if (!o || o.disabled) return;
    onPick(o.value);
    if (!multiple) close();
  };

  const onKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    const inSearch = e.target === search.current;
    if (!open) {
      // A chord is the page's (⌘↩ starts the New session sheet), not the list's.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "Enter" ||
        e.key === " " ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        e.preventDefault();
        e.stopPropagation();
        show(e.key === "End" ? edge(true) : e.key === "Home" ? edge(false) : undefined);
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        const i = typeAhead(e.key, -1);
        show(i >= 0 ? i : undefined);
      }
      return;
    }
    // Open: nothing here reaches the page's keys (Esc, j/k, /).
    if (e.key === "Tab") {
      close(false);
      return;
    }
    e.stopPropagation();
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        return;
      case "ArrowDown":
        e.preventDefault();
        setCursor((c) => move(c, 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setCursor((c) => move(c, -1));
        return;
      case "Home":
        if (inSearch && q) return;
        e.preventDefault();
        setCursor(edge(false));
        return;
      case "End":
        if (inSearch && q) return;
        e.preventDefault();
        setCursor(edge(true));
        return;
      case "Enter":
        e.preventDefault();
        if (e.nativeEvent.isComposing) return;
        pick(cursor);
        return;
      case " ":
        if (inSearch) return;
        e.preventDefault();
        pick(cursor);
        return;
      default:
        if (!inSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          const i = typeAhead(e.key, cursor);
          if (i >= 0) setCursor(i);
        }
    }
  };

  // ----- render -----

  const summary = (): ReactNode => {
    if (renderValue) return renderValue(chosenOptions);
    if (chosenOptions.length === 0) return <span className="sel-placeholder">{placeholder}</span>;
    if (!multiple || chosenOptions.length <= 2) return chosenOptions.map((o) => o.label).join(", ");
    return `${chosenOptions.length} selected`;
  };
  const activeId = open && cursor >= 0 && shown[cursor] ? optId(cursor) : undefined;
  const dataValue = multiple ? chosen.map(keyOf).join(",") : chosen.length ? keyOf(chosen[0]!) : "";

  const rows = (
    <div
      className={`sel-list ${hasIcons ? "sel-list--icons" : ""}`}
      role="listbox"
      id={listId}
      ref={list}
      aria-multiselectable={multiple || undefined}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
    >
      {shown.length === 0 && <p className="sel-empty">Nothing matches.</p>}
      {shown.map((o, i) => {
        const on = isChosen(o);
        const row = (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the trigger (combobox pattern)
          <div
            key={keyOf(o.value)}
            id={optId(i)}
            role="option"
            tabIndex={-1}
            className={`sel-opt ${i === cursor ? "sel-opt--active" : ""}`}
            aria-selected={on}
            aria-disabled={o.disabled || undefined}
            data-value={keyOf(o.value)}
            onMouseMove={() => i !== cursor && !o.disabled && setCursor(i)}
            onClick={() => pick(i)}
          >
            <span className="sel-opt-check" aria-hidden="true">
              {on && <Check />}
            </span>
            {hasIcons && (
              <span className="sel-opt-icon" aria-hidden="true">
                {o.icon}
              </span>
            )}
            <span className="sel-opt-label ellipsis">{o.label}</span>
            {o.hint && <span className={`sel-opt-hint ${o.hintTone ? "sel-opt-hint--attention" : ""}`}>{o.hint}</span>}
            {o.detail && <span className="sel-opt-detail">{o.detail}</span>}
          </div>
        );
        return o.divider && i > 0
          ? [<div key={`sep-${keyOf(o.value)}`} className="sel-sep" aria-hidden="true" />, row]
          : row;
      })}
    </div>
  );

  const filterBox = canSearch && (
    <div className="sel-search">
      <input
        ref={search}
        value={q}
        onChange={(e) => filter(e.target.value)}
        onKeyDown={onKey}
        placeholder={filterPlaceholder}
        aria-label={filterPlaceholder === "Filter" ? "Filter options" : filterPlaceholder}
        aria-controls={listId}
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );

  // data-dismiss: a dialog's focus trap (lib/focus.ts) lets focus move into the filter.
  const popover = open
    ? createPortal(
        phone ? (
          <>
            <button type="button" className="sel-scrim" aria-label="Close" onClick={() => close()} />
            <div className="sel-sheet" ref={pop} data-dismiss>
              <span className="sel-grab" aria-hidden="true" />
              {filterBox}
              {rows}
              {footer && <p className="sel-foot">{footer}</p>}
            </div>
          </>
        ) : (
          <div
            className={`sel-pop ${place?.above ? "sel-pop--above" : ""}`}
            ref={pop}
            data-dismiss
            style={
              place
                ? {
                    top: place.top,
                    bottom: place.bottom,
                    left: place.left,
                    minWidth: place.minWidth,
                    maxWidth: place.maxWidth,
                    maxHeight: place.maxHeight,
                  }
                : { visibility: "hidden", top: 0, left: 0 }
            }
          >
            {filterBox}
            {rows}
            {footer && <p className="sel-foot">{footer}</p>}
          </div>
        ),
        document.body,
      )
    : null;

  return (
    <>
      <button
        type="button"
        ref={trigger}
        id={id}
        className={`sel sel--${size} ${open ? "sel--open" : ""} ${className}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={canSearch ? undefined : activeId}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        data-value={dataValue}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKey}
      >
        {!multiple && chosenOptions[0]?.icon ? (
          <span className="sel-icon" aria-hidden="true">
            {chosenOptions[0].icon}
          </span>
        ) : null}
        <span className="sel-text ellipsis">{summary()}</span>
        <svg className="sel-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path
            d="M3 4.5 6 7.5l3-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {popover}
    </>
  );
}

/** The filtered rows, and the `custom` row for the typed text when no row has its value. */
function withCustom<T>(
  shown: SelectOption<T>[],
  q: string,
  custom: ((text: string) => SelectOption<T> | null) | undefined,
  keyOf: (v: T) => string,
): SelectOption<T>[] {
  const t = q.trim();
  if (!custom || !t) return shown;
  const c = custom(t);
  if (!c || shown.some((o) => keyOf(o.value) === keyOf(c.value))) return shown;
  return [...shown, { ...c, divider: shown.length > 0 }];
}

function filterOptions<T>(options: SelectOption<T>[], q: string): SelectOption<T>[] {
  const t = q.trim().toLowerCase();
  if (!t) return options;
  return options.filter((o) => o.label.toLowerCase().includes(t) || o.hint?.toLowerCase().includes(t));
}

function Check() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path
        d="M2.5 6.5 5 9l4.5-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
