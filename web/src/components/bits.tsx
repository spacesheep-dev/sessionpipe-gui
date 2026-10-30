// SPDX-License-Identifier: Apache-2.0
// Small shared pieces: the status glyph, harness monograms, chips, ticking times,
// spinner, copy buttons (text and icon), redaction highlighting, the toolbar search,
// segmented control, the toolbar pop-up (chip select), slider, switch; and the round-4
// pieces every surface shares: the action button with its pending state, key caps, the
// one-line command well, the listening row, the inline notice and the empty state. The
// select itself lives in Select.tsx; motion hooks in lib/motion.ts.
import type { SessionState, Tier } from "@shared/api";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { copyText } from "../lib/clipboard";
import { harnessMark, STATE_HINT, STATE_LABEL } from "../lib/format";
import { HARNESS_ICONS } from "../lib/harnessIcons";
import { ago, durCoarse, ms, since, tickFor, useNow } from "../lib/time";
import { Select } from "./Select";

/** The status glyph (styles/shared.css `.dot`): the one signal a row shows for its state.
 *  `decorative` when the state's word is already said beside it (visibly or sr-only). */
export function StateDot({
  state,
  size = 10,
  decorative = false,
  unread = false,
}: {
  state: SessionState;
  size?: number;
  decorative?: boolean;
  /** News since the person looked (lib/marks.ts): an idle or done glyph drawn filled in. */
  unread?: boolean;
}) {
  // A change of state while on screen is drawn once (shared.css `.dot--arrive`): the new
  // glyph settles in, and a session that finishes in front of you draws its check. A
  // glyph that mounts in a state just shows it.
  const prev = useRef(state);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (prev.current === state) return;
    prev.current = state;
    setChanges((n) => n + 1);
  }, [state]);
  const style = { width: size, height: size };
  const filled = unread && (state === "idle" || state === "done");
  const cls = `dot dot--${state}${filled ? " dot--unread" : ""}${changes ? " dot--arrive" : ""}`;
  if (decorative) return <span key={changes} className={cls} style={style} aria-hidden="true" />;
  return (
    <span
      key={changes}
      className={cls}
      style={style}
      role="img"
      aria-label={STATE_LABEL[state]}
      title={STATE_HINT[state]}
    />
  );
}

/** "● working · 12 s": the state as text, no box. */
export function StateBadge({ state, since: sinceIso }: { state: SessionState; since?: string }) {
  const now = useNow(sinceIso ? tickFor(Date.now() - ms(sinceIso), 60_000) : "off");
  return (
    <span className={`badge badge--${state}`} title={STATE_HINT[state]}>
      <StateDot state={state} decorative />
      {STATE_LABEL[state]}
      {sinceIso && <span className="badge-since num">{since(sinceIso, now)}</span>}
    </span>
  );
}

/** The harness as a small monochrome mark (lib/harnessIcons.ts): 14 px beside text
 *  (`sm`), 16 px in a header (`md`). A harness without a mark keeps its two-letter
 *  monogram, "Cl", "Cx". */
export function HarnessGlyph({
  name,
  size = "md",
  withLabel = false,
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  withLabel?: boolean;
}) {
  const m = harnessMark(name);
  const icon = HARNESS_ICONS[name];
  const px = size === "sm" ? 14 : size === "md" ? 16 : 18;
  return (
    <span className={`glyph-wrap ${withLabel ? "glyph-wrap--label" : ""}`} title={m.label}>
      {icon ? (
        <svg
          className={`glyph glyph--${size} glyph--icon`}
          width={px}
          height={px}
          viewBox={icon.viewBox}
          role="img"
          aria-label={m.label}
        >
          <path fill="currentColor" d={icon.path} />
        </svg>
      ) : (
        <span className={`glyph glyph--${size}`} aria-hidden="true">
          {m.glyph}
        </span>
      )}
      {withLabel ? (
        <span className="glyph-label">{m.label}</span>
      ) : icon ? null : (
        <span className="sr-only">{m.label}</span>
      )}
    </span>
  );
}

export function Chip({
  children,
  kind,
  title,
}: {
  children: ReactNode;
  kind?: "machine" | "repo" | "model" | "tier" | "plain";
  title?: string;
}) {
  return (
    <span className={`chip chip--${kind ?? "plain"}`} title={title}>
      {children}
    </span>
  );
}

export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <Chip kind="tier" title="The highest tier any event of this session arrived at">
      tier {tier}
    </Chip>
  );
}

/** "12 s ago", ticking. */
export function Ago({ iso, prefix }: { iso: string | undefined; prefix?: string }) {
  // `ago` shows seconds only for the first minute.
  const now = useNow(iso ? tickFor(Date.now() - ms(iso), 60_000) : "off");
  if (!iso) return null;
  return (
    <time dateTime={iso} className="num" title={new Date(iso).toLocaleString()}>
      {prefix}
      {ago(iso, now)}
    </time>
  );
}

/** Elapsed since an instant, ticking, in the one grammar: "12 s", "4 m", "1 h 05 m".
 *  `coarse` is kept for its callers; every duration is coarse now (lib/time.ts). */
export function Since({ iso }: { iso: string | undefined; coarse?: boolean }) {
  // Every second in the first minute; after that the text changes once a minute, and a
  // ten-second tick is plenty.
  const now = useNow(iso ? tickFor(Date.now() - ms(iso), 60_000) : "off");
  if (!iso) return null;
  return (
    <time dateTime={iso} className="num" title={new Date(iso).toLocaleString()}>
      {durCoarse(now - ms(iso))}
    </time>
  );
}

export function Spinner({ label = "running" }: { label?: string }) {
  return <span className="spinner" role="img" aria-label={label} />;
}

export function CopyButton({ text, label = "Copy", small = false }: { text: string; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      setDone(true);
    }
  };
  return (
    <button
      type="button"
      className={`btn ${small ? "btn--sm" : ""} ${done ? "btn--done" : ""}`}
      onClick={copy}
      aria-live="polite"
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** Copy as a 28 px icon button (in a row, beside a well): the glyph turns into a check
 *  for a moment and a live region says "Copied". */
export function CopyIconButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={`icon-btn ${done ? "icon-btn--done" : ""}`}
      aria-label={label}
      title={label}
      onClick={() => void copyText(text).then(() => setDone(true))}
    >
      <svg
        viewBox="0 0 16 16"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        {done ? (
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
            <path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
          </>
        )}
      </svg>
      <span className="sr-only" aria-live="polite">
        {done ? "Copied" : ""}
      </span>
    </button>
  );
}

const REDACTED = /(\[redacted\])/gi;

/** Text with every `[redacted]` placeholder highlighted. */
export function Redacted({ text }: { text: string }) {
  if (!REDACTED.test(text)) return <>{text}</>;
  REDACTED.lastIndex = 0;
  const parts = text.split(REDACTED);
  return (
    <>
      {parts.map((p, i) =>
        REDACTED.test(p) ? (
          <mark key={i} title="Removed on the sending machine by the secrets ruleset">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** The toolbar search field. The placeholder stays short ("Search"); `label` is the
 *  accessible name when it should say more ("Search events"). */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <label className="search">
      <svg className="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        data-search
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        autoComplete="off"
        enterKeyHint="search"
      />
      <kbd title="Press / to search">/</kbd>
    </label>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="seg" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <label key={String(o.value)} className={`seg-opt ${o.value === value ? "seg-on" : ""}`} title={o.title}>
          <input
            type="radio"
            name={name}
            value={String(o.value)}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

/** A filter as quiet text with a caret: the custom Select (components/Select.tsx) without
 *  its border, "" standing for `all`. */
export function ChipSelect({
  value,
  options,
  onChange,
  all,
  label,
  optionLabel = (o) => o,
  icon,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  all: string;
  label: string;
  /** What an option is called; the value stays the raw id. */
  optionLabel?: (o: string) => string;
  /** Drawn before an option's name, in the chip and in the list. */
  icon?: (o: string) => ReactNode;
}) {
  if (options.length === 0) return null;
  return (
    <Select<string>
      value={value}
      onChange={onChange}
      aria-label={label}
      className={`chipsel ${value ? "chipsel-on" : ""}`}
      options={[
        { value: "", label: all },
        ...options.map((o) => ({ value: o, label: optionLabel(o), icon: icon?.(o) })),
      ]}
    />
  );
}

/** A 2 px hairline track with a 14 px knob; an `<input type=range>` underneath, so it is
 *  a slider to assistive tech and to Playwright's `fill`. */
export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
  label,
  id,
  disabled,
  className = "",
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      id={id}
      className={`slider ${className}`}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ "--slider-pct": `${pct}%` } as CSSProperties}
    />
  );
}

export function Toggle({
  on,
  onChange,
  label,
  disabled,
  describedBy,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  /** The id of the hint under its row, read after the label. */
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-describedby={describedBy}
      className={`toggle ${on ? "toggle-on" : ""}`}
      onClick={() => onChange(!on)}
      disabled={disabled}
    >
      <span className="toggle-knob" />
    </button>
  );
}

/** The same 36×20 switch under the name the design notes use. */
export const Switch = Toggle;

// ----- round 4: shared pieces -----

/** A key cap: one key ("⌘", "K", "Esc") on a quiet raised face. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** A button whose press shows at once and whose work shows as a pending verb: on
 *  pointer-down it takes its pressed face; while `onClick`'s promise runs (or `pending`
 *  is set) it reads `pendingLabel` ("Stopping…"), is inert and `aria-busy`, and holds the
 *  width it had, so nothing beside it moves. It never shows success by itself: what
 *  happened next is the caller's to say, from the daemon's real answer. */
export function ActionButton({
  children,
  pendingLabel,
  pending: pendingProp,
  onClick,
  className = "btn",
  disabled,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  pendingLabel?: ReactNode;
  pending?: boolean;
  onClick?: () => unknown;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [running, setRunning] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const pending = pendingProp ?? running;
  useLayoutEffect(() => {
    if (pending && ref.current) setWidth(ref.current.offsetWidth);
    if (!pending) setWidth(null);
  }, [pending]);
  return (
    <button
      type="button"
      {...rest}
      ref={ref}
      className={className}
      disabled={disabled}
      aria-busy={pending || undefined}
      data-pending={pending ? "" : undefined}
      style={width ? { ...rest.style, minWidth: width } : rest.style}
      onClick={() => {
        if (pending || !onClick) return;
        const r = onClick();
        if (r && typeof (r as Promise<unknown>).then === "function") {
          setRunning(true);
          void (r as Promise<unknown>).finally(() => setRunning(false));
        }
      }}
    >
      {pending ? (
        <>
          <span className="spinner spinner--sm" aria-hidden="true" />
          {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** A literal command on one line: mono, a quiet well, never wrapped (it scrolls sideways
 *  inside itself), with Copy at its end. `prompt` draws a muted "$" first. */
export function CommandWell({
  command,
  prompt = true,
  label = "Copy command",
}: {
  command: string;
  prompt?: boolean;
  label?: string;
}) {
  return (
    <div className="cmdwell">
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls sideways, so a keyboard must reach it (axe scrollable-region-focusable) */}
      <code className="cmdwell-text" tabIndex={0}>
        {prompt ? (
          <span className="cmdwell-prompt" aria-hidden="true">
            ${" "}
          </span>
        ) : null}
        {command}
      </code>
      <CopyIconButton text={command} label={label} />
    </div>
  );
}

/** "Listening · Claude Code, Codex": a live wait drawn as the working ring and one muted
 *  line, never a progress bar. */
export function Listening({ children, label = "Listening" }: { children?: ReactNode; label?: string }) {
  return (
    <p className="listening" role="status">
      <span className="dot dot--working" style={{ width: 10, height: 10 }} aria-hidden="true" />
      <span className="listening-text">
        {label}
        {children ? <span className="listening-detail"> · {children}</span> : null}
      </span>
    </p>
  );
}

/** A condition of the system ("Notifications are off for this site"), as one quiet row
 *  with its one way out at the right. Not a banner slab: the well tier, no icon colour. */
export function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="notice" role="note">
      <span className="notice-text">{children}</span>
      {action ? <span className="notice-action">{action}</span> : null}
    </div>
  );
}

/** The empty view (POLISH-PLAN.md §3): what fills this view in one sentence, and the one
 *  thing to do. `center` sits it at the content's optical centre, 40 % down; without it
 *  it stands where the first row would be (inside a panel, under a filter). */
export function EmptyState({
  title,
  children,
  actions,
  center = false,
  glyph,
  className = "",
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  center?: boolean;
  glyph?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`state ${center ? "state--center" : ""} ${className}`}>
      {glyph ? <div className="state-glyph">{glyph}</div> : null}
      <h2 className="state-title">{title}</h2>
      {children ? <div className="state-text">{children}</div> : null}
      {actions ? <div className="state-actions">{actions}</div> : null}
    </div>
  );
}
