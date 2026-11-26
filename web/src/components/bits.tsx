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
import { createPortal } from "react-dom";
import { copyText } from "../lib/clipboard";
import { endCuts, harnessMark, leadMidCut, STATE_HINT, STATE_LABEL } from "../lib/format";
import { MEASURE_EVENT } from "../lib/giveWay";
import { HARNESS_ICONS } from "../lib/harnessIcons";
import { syncSpins } from "../lib/spin";
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
  // A ring that starts turns on the one clock every other ring keeps (lib/motion.ts).
  useLayoutEffect(() => {
    if (state === "working") syncSpins();
  }, [state, changes]);
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
  decorative = false,
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  withLabel?: boolean;
  decorative?: boolean;
}) {
  const m = harnessMark(name);
  const icon = HARNESS_ICONS[name];
  const px = size === "sm" ? 14 : size === "md" ? 16 : 18;
  return (
    <span
      className={`glyph-wrap ${withLabel ? "glyph-wrap--label" : ""}`}
      title={decorative ? undefined : m.label}
      aria-hidden={decorative || undefined}
    >
      {icon ? (
        <svg
          className={`glyph glyph--${size} glyph--icon`}
          width={px}
          height={px}
          viewBox={icon.viewBox}
          role={decorative ? undefined : "img"}
          aria-label={decorative ? undefined : m.label}
          aria-hidden={decorative || undefined}
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
      ) : icon || decorative ? null : (
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

/** One line of quiet text (a chip) that, where its box is too narrow, is cut in its middle
 *  (lib/format.ts midCut) rather than at its end: a computer's name keeps the start and the
 *  end that tell two apart. Its box is the stylesheet's (a max-width, a flex share, a grid
 *  track) and is always laid out from the whole text (styles/shared.css `.midcut::before`),
 *  so what is cut never changes the room it is cut to. The line drawn over it is measured
 *  in fractional pixels, again when the box changes width and once the fonts are in. The
 *  whole text is its tooltip and what a screen reader reads. `lead` ("trigger ") is always
 *  drawn whole, and only the text after it is cut (lib/format.ts leadMidCut). `sep` ("· ")
 *  is drawn before the lead, whole, and is no part of the tooltip or of what is read: a
 *  row's dot before it, kept beside the words when a cut leaves room in the box. With `tip`
 *  the chip is a stop of its own for the keyboard, and the app's tooltip (Tip.tsx, at once
 *  on keyboard focus) says `tip` in place of the browser's; a screen reader hears it as the
 *  chip's description: never inside a link or a row that is one tab stop. */
export function MidCut({
  sep = "",
  lead = "",
  text,
  className,
  tip,
}: {
  sep?: string;
  lead?: string;
  text: string;
  className?: string;
  tip?: string;
}) {
  return (
    <CutChip
      text={sep + lead + text}
      label={lead + text}
      sep={sep}
      className={className}
      count={[...text].length - 1}
      at={(n) => sep + leadMidCut(lead, text, n)}
      tip={tip}
    />
  );
}

/** The same chip cut at its end, after the last whole word that fits (or, for a text of
 *  one word, its last character: lib/format.ts endCuts), with "…": a title reads as the
 *  start of a sentence, not two fragments. `lead` ("for ") is always drawn whole. */
export function EndCut({ lead = "", text, className }: { lead?: string; text: string; className?: string }) {
  const cuts = endCuts(text);
  return <CutChip text={lead + text} className={className} count={cuts.length} at={(n) => lead + cuts[n - 1]} />;
}

/** A chip drawn whole where it fits, else as the longest of `at(1)`…`at(count)` (each
 *  longer than the one before) that does, else as `at(1)`, which then ends in the
 *  stylesheet's "…" (`data-over`) rather than mid-letter. */
function CutChip({
  text,
  label = text,
  sep = "",
  className,
  count,
  at,
  tip,
}: {
  text: string;
  /** What it says, for the tooltip and a screen reader: the text without `sep`. */
  label?: string;
  sep?: string;
  className?: string;
  count: number;
  at: (n: number) => string;
  tip?: string;
}) {
  const cutAt = useRef(at);
  cutAt.current = at;
  const box = useRef<HTMLSpanElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  const [fit, setFit] = useState({ text, shown: text, over: false });
  const [measure, setMeasure] = useState(0);
  /** Measure the box and write the longest cut that fits into the line in place: what is
   *  drawn is right as soon as this returns, and React is told after. */
  const measureNow = useRef(() => {});
  measureNow.current = () => {
    const el = box.current;
    const lineEl = line.current;
    // React's own text node, written in place while measuring and set back to what React
    // renders next: it must stay the line's only child.
    const node = lineEl?.firstChild;
    if (!el || !lineEl || !node || node.nodeType !== Node.TEXT_NODE) return;
    // Both read as drawn (a row's slide moves them alike); a chip has no padding.
    const room = el.getBoundingClientRect().width;
    if (!(room > 0)) return;
    const range = document.createRange();
    const fits = (s: string) => {
      node.nodeValue = s;
      range.selectNodeContents(node);
      return range.getBoundingClientRect().width <= room + 0.5;
    };
    let shown = text;
    let over = false;
    if (count > 0 && !fits(text)) {
      // The longest cut that fits.
      let lo = 1;
      let hi = count;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(cutAt.current(mid))) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      // Not even the shortest: it is drawn all the same, and ends in "…" where it is cut off.
      over = best === 0;
      shown = cutAt.current(Math.max(best, 1));
    }
    node.nodeValue = shown;
    lineEl.toggleAttribute("data-over", over);
    setFit((f) => (f.text === text && f.shown === shown && f.over === over ? f : { text, shown, over }));
  };
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const again = () => measureNow.current();
    el.addEventListener(MEASURE_EVENT, again);
    if (typeof ResizeObserver !== "function") return () => el.removeEventListener(MEASURE_EVENT, again);
    let width = -1;
    const ro = new ResizeObserver(([e]) => {
      const w = e?.contentRect.width ?? 0;
      if (w !== width) {
        width = w;
        setMeasure((n) => n + 1);
      }
    });
    ro.observe(el);
    let live = true;
    document.fonts?.ready.then(() => live && setMeasure((n) => n + 1));
    return () => {
      live = false;
      ro.disconnect();
      el.removeEventListener(MEASURE_EVENT, again);
    };
  }, []);
  // `measure` changes with the box's width and the fonts.
  useLayoutEffect(() => measureNow.current(), [text, count, measure]);
  const now = fit.text === text ? fit : { shown: text, over: false };
  const cut = now.shown !== text;
  // A separator is never read: with one, the words are always the screen reader's own copy.
  const quiet = cut || !!sep;
  const body = (
    <>
      <span className="midcut-text" ref={line} aria-hidden={quiet || undefined} data-over={now.over ? "" : undefined}>
        {now.shown}
      </span>
      {quiet && <span className="sr-only">{label}</span>}
    </>
  );
  const cls = `chip midcut ${className ?? ""}`;
  if (tip)
    return (
      // An empty title: no line's own tooltip shows through from around it (Tip.tsx keeps
      // an empty one in place while its own is up).
      <span
        ref={box}
        className={cls}
        title=""
        data-text={text}
        data-sep={sep || undefined}
        data-tip={tip}
        data-tip-wrap=""
        // biome-ignore lint/a11y/noNoninteractiveTabindex: its tooltip says what its words do not (where the rule lives, how to see it), so a keyboard must reach it; a screen reader hears it as the description
        tabIndex={0}
        aria-describedby={tipId}
      >
        {body}
        <span id={tipId} hidden>
          {tip}
        </span>
      </span>
    );
  return (
    <span ref={box} className={cls} title={label} data-text={text} data-sep={sep || undefined}>
      {body}
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
 *  `coarse` is kept for its callers; every duration is coarse now (lib/time.ts). `title`:
 *  its tooltip, the instant by default; `false` where the cell around it has its own. */
export function Since({ iso, title }: { iso: string | undefined; coarse?: boolean; title?: string | false }) {
  // Every second in the first minute; after that the text changes once a minute, and a
  // ten-second tick is plenty.
  const now = useNow(iso ? tickFor(Date.now() - ms(iso), 60_000) : "off");
  if (!iso) return null;
  return (
    <time
      dateTime={iso}
      className="num"
      title={title === false ? undefined : (title ?? new Date(iso).toLocaleString())}
    >
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
      <kbd title="Press / to find">/</kbd>
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

/** `text` with the machine's `name` in it kept whole on a line (base.css `.whole-name`): a
 *  name such as "Misha-Petrov-laptop" breaks at no hyphen where it fits a line. The text as
 *  it is where the name is not in it. */
export function WithName({ text, name }: { text: string; name?: string | null }) {
  const i = name ? text.indexOf(name) : -1;
  if (!name || i < 0) return <>{text}</>;
  // A line may break on either side of the span, so it takes what touches the name up to a
  // space: a full stop after it, or a wide card's "·", never starts a line of its own.
  const from = i - (text.slice(0, i).match(/[^ \n]*$/)?.[0].length ?? 0);
  const to = i + name.length + (text.slice(i + name.length).match(/^[^ \n]*/)?.[0].length ?? 0);
  return (
    <>
      {text.slice(0, from)}
      <span className="whole-name">{text.slice(from, to)}</span>
      {text.slice(to)}
    </>
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
  role,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  center?: boolean;
  glyph?: ReactNode;
  className?: string;
  /** "status" for a state that changes in place and is read out as it does. */
  role?: "status";
}) {
  return (
    <div className={`state ${center ? "state--center" : ""} ${className}`} role={role}>
      {glyph ? <div className="state-glyph">{glyph}</div> : null}
      <h2 className="state-title">{title}</h2>
      {children ? <div className="state-text">{children}</div> : null}
      {actions ? <div className="state-actions">{actions}</div> : null}
    </div>
  );
}

/** A phone's full-window sheet (New session, Ask another agent, the pool's), and before it
 *  the dim it stands on where the window has room and it is a form sheet
 *  (styles/regular.css); compact, the dim is not shown. A tap on the dim puts it away.
 *  `into`: both in a portal there. */
export function withFormScrim(close: () => void, closing: boolean, sheet: ReactNode, into?: Element) {
  const both = (
    <>
      <button
        type="button"
        className="menu-scrim menu-scrim--dialog ns-scrim ns-scrim--form"
        aria-label="Close"
        onClick={close}
        data-closing={closing ? "" : undefined}
        data-dismiss
      />
      {sheet}
    </>
  );
  return into ? createPortal(both, into) : both;
}
