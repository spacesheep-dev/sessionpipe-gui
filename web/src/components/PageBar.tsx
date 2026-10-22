// SPDX-License-Identifier: Apache-2.0
// The page's title band, the first child of every `.page`: the page's one h1, a short
// live fact beside it, the page's tools (search, filters) and actions (icon buttons, the
// "⋯" menu) at the right. Sticky and opaque, --bar tall, its hairline in line with the
// sidebar's and the panel's (styles/shell.css). On a phone it is a 44 px navigation bar
// over an iOS large title: the bar's own title fades in once the large one scrolls under
// it, and the tools sit below the large title, scrolling with the page.
import { Children, Fragment, isValidElement, type ReactNode, useEffect, useRef, useState } from "react";
import { SearchInput } from "./bits";

const PHONE = "(max-width: 839px)";

function usePhone(): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = matchMedia(PHONE);
    const up = () => setOn(mq.matches);
    up();
    mq.addEventListener("change", up);
    return () => mq.removeEventListener("change", up);
  }, []);
  return on;
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
  /** Extra classes on the h1 (the session page's `sess-title`). */
  titleClassName?: string;
  className?: string;
}) {
  const phone = usePhone();
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
          {meta && !phone ? <span className="bar-meta">{meta}</span> : null}
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
          {meta ? <div className="bar-sub">{meta}</div> : null}
          {tools ? <PhoneTools tools={tools} /> : null}
        </div>
      ) : null}
    </>
  );
}

/** The chevron back to where the page was opened from (the label is its tooltip). */
export function BackButton({ onClick, label = "Board" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="icon-btn bar-back" onClick={onClick} aria-label="Back" title={`Back to ${label}`}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path
          d="M12.5 4.5 7 10l5.5 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
