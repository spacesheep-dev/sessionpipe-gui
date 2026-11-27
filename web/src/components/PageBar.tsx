// SPDX-License-Identifier: Apache-2.0
// The page's title band, the first child of every `.page`: the page's one h1, a short
// live fact beside it, the page's tools (search, filters) and actions (icon buttons, the
// "⋯" menu) at the right. Sticky and opaque, --bar tall, its hairline in line with the
// sidebar's and the panel's (styles/shell.css). On a phone it is a 44 px navigation bar
// over an iOS large title: the bar's own title fades in once the large one scrolls under
// it, and the tools sit below the large title, scrolling with the page. The line under
// the large title is the bar's subtitle slot: the page's meta, or, while the stream is
// down, its state with Retry, where iOS keeps "Connecting…". A desktop's bar says a
// dropped stream in the same way, in the meta's place beside the title: the one place a
// window says it, with the sidebar shown or hidden.
import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useBehind } from "../account/current";
import { useStore } from "../data/hooks";
import { usePhoneLayout } from "../lib/device";
import { SearchInput } from "./bits";
import { BackIcon } from "./Icons";
import { listBehind, useConnection } from "./Shell";

/** The phone's subtitle line under a large title: the meta, or while the stream is down
 *  its state and Retry (ConnStatus below, in the phone's look). Its own component, so the
 *  bar itself does not follow the stream's state. */
function PhoneSub({ meta, connSaid }: { meta?: ReactNode; connSaid?: boolean }) {
  const said = useConnSaid();
  if (said && !connSaid) return <ConnStatus phone />;
  return meta ? <div className="bar-sub">{meta}</div> : null;
}

/** A desktop bar's meta slot, beside the title: the page's meta, or while the stream is
 *  down its state and Retry. The down state takes the slot on every page ("Catching up…",
 *  a session's machine and repo come back with the stream). */
function BarMeta({ meta, connSaid }: { meta?: ReactNode; connSaid?: boolean }) {
  const said = useConnSaid();
  if (said && !connSaid) return <ConnStatus />;
  return meta ? <span className="bar-meta">{meta}</span> : null;
}

/** How long a first connect goes unsaid: one that answers at once never shows. */
const FIRST_CONNECT_QUIET_MS = 1000;

/** Whether the bar says where the stream stands: while it is down, and before the first
 *  snapshot while a connect takes longer than a moment ("Connecting…", nothing to press;
 *  not while an account catches up, which its page says). */
function useConnSaid(): boolean {
  const { as, down, first } = useConnection();
  const behind = useBehind();
  const waiting = first && as === "connecting" && !behind;
  const [long, setLong] = useState(false);
  useEffect(() => {
    setLong(false);
    if (!waiting) return;
    const t = window.setTimeout(() => setLong(true), FIRST_CONNECT_QUIET_MS);
    return () => window.clearTimeout(t);
  }, [waiting]);
  return down || (waiting && long);
}

/** A dropped stream, said once: its dot (a ring while reconnecting, red when offline),
 *  "Reconnecting…" or "Offline", and the one Retry (the same reconnect as the pull down a
 *  phone's page). Before the first snapshot: "Can't reach studio-mac" with Retry, and a
 *  long connect's "Connecting…" alone. One component for a desktop's bar and, as
 *  `phone`, the phone's subtitle line: the same words, each in its own look. Not a live region: what is spoken is the
 *  shell's (Shell.tsx ConnAnnouncer), once per change. When the stream comes back while
 *  Retry holds the focus, the focus goes to the page rather than to nowhere. */
function ConnStatus({ phone = false }: { phone?: boolean }) {
  const { as, label, down } = useConnection();
  const store = useStore();
  const retry = useRef<HTMLButtonElement>(null);
  // A layout effect: its cleanup runs while the button is still in the document. Again
  // when Retry comes and goes (a first connect's "Connecting…" has none).
  useLayoutEffect(() => {
    const button = down ? retry.current : null;
    return () => {
      if (button && document.activeElement === button) document.getElementById("main")?.focus({ preventScroll: true });
    };
  }, [down]);
  return (
    <div className={phone ? `bar-sub phone-conn-sub phone-conn-sub--${as}` : `bar-conn bar-conn--${as}`}>
      <span className="conn-dot" aria-hidden="true" />
      <span className={phone ? "phone-conn-label" : "bar-conn-label"}>{label}</span>
      {down ? (
        <button
          ref={retry}
          type="button"
          className={phone ? "phone-conn-act" : "btn btn--ghost btn--sm"}
          onClick={() => store.reconnect()}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** A state of the page's in the meta's place, with nothing to do about it ("Catching up…"):
 *  the subtitle's quiet dot and its words, said once as it comes. */
export function BarStatus({ children }: { children: string }) {
  return (
    <span className="bar-status" role="status" aria-live="polite">
      <span className="conn-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/** The tools as a flat list (fragments opened), so the phone can lift the search out. */
function flat(node: ReactNode): ReactNode[] {
  return Children.toArray(node).flatMap((c) =>
    isValidElement<{ children?: ReactNode }>(c) && c.type === Fragment ? flat(c.props.children) : [c],
  );
}

/** On a phone the search is a full-width field of its own, and the pop-ups after it are
 *  one row that never wraps: it scrolls sideways inside itself, as iOS filter rows do. */
function PhoneTools({ tools }: { tools: ReactNode }) {
  const all = flat(tools);
  const search = all.filter((c) => isValidElement(c) && c.type === SearchInput);
  const rest = all.filter((c) => !search.includes(c));
  return (
    <div className="bar-tools">
      {search}
      {rest.length ? <div className="bar-filters">{rest}</div> : null}
    </div>
  );
}

export function PageBar({
  title,
  meta,
  back,
  tools,
  actions,
  large = true,
  connSaid = false,
  titleClassName = "",
  className = "",
}: {
  title: ReactNode;
  /** One short live fact in the meta tier ("1 needs an answer", "3 of 5 done"). */
  meta?: ReactNode;
  /** A BackButton, on a detail page. */
  back?: ReactNode;
  /** Search and pop-ups: in the bar on a desktop, under the large title on a phone. */
  tools?: ReactNode;
  /** Icon buttons; the "⋯" More actions button last. */
  actions?: ReactNode;
  /** The phone's large title; false on a detail page, whose title sits in the bar. */
  large?: boolean;
  /** The page itself says where the stream stands (the Board and the Inbox before their
   *  first snapshot: their loading rows, "Can't reach studio-mac" with Retry): the bar
   *  does not say it a second time. */
  connSaid?: boolean;
  /** Extra classes on the h1 (the session page's `sess-title`). */
  titleClassName?: string;
  className?: string;
}) {
  const phone = usePhoneLayout();
  const bigTitle = phone && large;
  const big = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(!bigTitle);
  useEffect(() => {
    if (!bigTitle) {
      setCollapsed(true);
      return;
    }
    const el = big.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const barH = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar")) || 44;
    const io = new IntersectionObserver(
      ([e]) => setCollapsed(!!e && !e.isIntersecting && e.boundingClientRect.top < barH),
      {
        rootMargin: `-${barH}px 0px 0px 0px`,
        threshold: 0,
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [bigTitle]);
  return (
    <>
      <header
        className={`bar ${bigTitle ? "bar--large" : "bar--inline"} ${className}`}
        data-collapsed={collapsed && phone ? "" : undefined}
      >
        <div className="bar-lead">
          {back}
          <h1 className={`bar-title ${titleClassName}`}>{title}</h1>
          {phone ? null : <BarMeta meta={meta} connSaid={connSaid} />}
        </div>
        {tools && !phone ? <div className="bar-tools">{tools}</div> : null}
        {actions ? <div className="bar-actions">{actions}</div> : null}
      </header>
      {phone && (bigTitle || meta || tools) ? (
        <div className="bar-below">
          {bigTitle ? (
            <div className="bar-large" ref={big} aria-hidden="true">
              {title}
            </div>
          ) : null}
          {bigTitle ? (
            <PhoneSub meta={meta} connSaid={connSaid} />
          ) : meta ? (
            <div className="bar-sub">{meta}</div>
          ) : null}
          {tools ? <PhoneTools tools={tools} /> : null}
        </div>
      ) : null}
    </>
  );
}

/** The list pages by route name, as the back button says them. */
const LIST_TITLE: Record<string, string> = {
  board: "Board",
  inbox: "Inbox",
  search: "Search",
  feed: "Feed",
  review: "Review",
};

/** The chevron back to where the page was opened from. `label` names that page; a session
 *  page leaves it out and gets the list it was opened from (Shell.tsx). On a desktop the
 *  label is the tooltip; on a phone it stands beside the chevron in the tint, as iOS's
 *  back button does, cut with an ellipsis before it reaches the title. */
export function BackButton({ onClick, label }: { onClick: () => void; label?: string }) {
  const phone = usePhoneLayout();
  const text = label ?? LIST_TITLE[listBehind()] ?? "Board";
  return (
    <button
      type="button"
      className={`icon-btn bar-back${phone ? " bar-back--labelled" : ""}`}
      onClick={onClick}
      aria-label="Back"
      title={`Back to ${text}`}
    >
      <BackIcon size={18} />
      {phone ? (
        <span className="bar-back-label" aria-hidden="true">
          {text}
        </span>
      ) : null}
    </button>
  );
}
