// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The sessions this one asked (sessionpipe ask, a handoff) or launched, on
// its page under the bar: one ruled panel, "Asked sessions", a row each (lib/delegated.ts
// askedSessions: those that need you first, then the newest), five and "Show all n". A
// row is the child's state (the board's glyph and word), its agent, its title, the
// computer it runs on (always named, cut in its middle) and how long ago it last moved;
// the whole row opens its page, and over its end, on hover, Open beside and Message (the Handoff sheet aimed at
// it, the answer brought back). A phone stacks the row in two lines and keeps the actions
// in its long-press menu. One level: a child's own asked sessions are on its page. What a
// child says is never drawn here: only its title, as the board draws it.
import type { SessionSummary } from "@shared/api";
import { type RefObject, useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "../data/hooks";
import { askedComputer, askedSessions, askedShown } from "../lib/delegated";
import { wideLayout } from "../lib/device";
import { harnessMark, STATE_LABEL, sessionTitle } from "../lib/format";
import { canMessage, messageItem, openMessage } from "../lib/menus";
import { Link, navigate, sessionPath } from "../lib/router";
import { openSplit } from "../lib/split";
import { HarnessGlyph, MidCut, Since, StateDot } from "./bits";
import { tidy, useContextMenu } from "./ContextMenu";
import { BesideButton } from "./SessionCard";

/** The sessions `parent` asked, kept as one array until a row would draw differently. */
function useAsked(parent: SessionSummary): SessionSummary[] {
  const store = useStore();
  const last = useRef<{ sig: string; list: SessionSummary[] }>({ sig: "", list: [] });
  const read = useCallback(() => {
    const list = askedSessions(parent, store.get().sessions.values());
    const sig = list
      .map((s) => [s.key, sessionTitle(s), s.state, s.lastAt, s.machine ?? "", s.harness].join("\u0000"))
      .join("\u0001");
    if (sig !== last.current.sig) last.current = { sig, list };
    return last.current.list;
  }, [store, parent]);
  return useSyncExternalStore(store.subscribe, read, read);
}

export function AskedSessions({ s }: { s: SessionSummary }) {
  const list = useAsked(s);
  const [all, setAll] = useState(false);
  const head = useId();
  if (list.length === 0) return null;
  const { shown } = askedShown(list, all);
  return (
    <section className="kids" aria-labelledby={head}>
      <h2 className="kids-head" id={head}>
        Asked sessions <span className="kids-count num">{list.length}</span>
      </h2>
      <ul className="kids-list">
        {shown.map((c) => (
          <AskedRow key={c.key} parent={s} c={c} />
        ))}
        {askedShown(list, false).more > 0 && (
          <li className="kids-more">
            <button type="button" className="kids-more-btn" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${list.length}`}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

function AskedRow({ parent, c }: { parent: SessionSummary; c: SessionSummary }) {
  const store = useStore();
  const path = sessionPath(c.harness, c.id);
  const title = sessionTitle(c);
  const agent = harnessMark(c.harness).label;
  const computer = askedComputer(c);
  const read = useCallback(() => canMessage(parent, c, store), [parent, c, store]);
  const message = useSyncExternalStore(store.subscribe, read, read);
  const menu = useContextMenu(
    () =>
      tidy([
        { label: "Open", run: () => navigate(path) },
        // A phone opens it as the preview, as its other rows' menus say.
        { label: wideLayout() ? "Open beside" : "Preview", run: () => openSplit(c.key) },
        messageItem(parent, c, store),
      ]),
    { title: () => title, subtitle: () => `${agent} · ${computer}` },
  );
  const titleRef = useRef<HTMLSpanElement>(null);
  const fitted = useWordFit(titleRef, title);
  return (
    <li className="kids-row" data-kid={c.key} data-state={c.state} {...menu}>
      <Link
        to={path}
        className="kids-link"
        title={title}
        modClick={(o) => openSplit(c.key, { background: o.background })}
      >
        <span className="kids-dot">
          <StateDot state={c.state} decorative />
        </span>
        <span className="kids-title" ref={titleRef}>
          {fitted}
        </span>
        <span className="kids-meta">
          <span className="kids-word">{STATE_LABEL[c.state]}</span>
          <span className="kids-agent">
            <HarnessGlyph name={c.harness} size="sm" />
            <span className="kids-agent-name">{agent}</span>
          </span>
          <span className="kids-where">
            <MidCut text={computer} />
          </span>
          <span className="kids-age">
            <Since iso={c.lastAt} />
          </span>
        </span>
      </Link>
      <span className="kids-acts">
        <BesideButton className="kids-act" onClick={() => openSplit(c.key)} />
        {message && (
          <button
            type="button"
            className="icon-btn kids-act"
            aria-label={`Message ${agent}`}
            title="Message"
            tabIndex={-1}
            onClick={(e) => {
              e.preventDefault();
              openMessage(parent, c, store);
            }}
          >
            <svg
              viewBox="0 0 20 20"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
            </svg>
          </button>
        )}
      </span>
    </li>
  );
}

/** The title in at most its two lines (the element's own max-height), cut after the last
 *  whole word that fits, with "…": never mid-word. Measured again when its width changes. */
function useWordFit(ref: RefObject<HTMLElement | null>, text: string): string {
  const [fit, setFit] = useState(text);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    const node = el?.firstChild;
    if (!el || !node || node.nodeType !== Node.TEXT_NODE || width === 0) {
      setFit(text);
      return;
    }
    const fits = () => el.scrollHeight <= el.clientHeight + 1;
    node.nodeValue = text;
    if (fits()) {
      setFit(text);
      return;
    }
    const words = text.split(/\s+/);
    let lo = 1;
    let hi = words.length - 1;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      node.nodeValue = `${words.slice(0, mid).join(" ")}…`;
      if (fits()) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const out = `${words
      .slice(0, best)
      .join(" ")
      .replace(/[\s,.;:–—-]+$/, "")}…`;
    node.nodeValue = out;
    setFit(out);
  }, [ref, text, width]);
  return fit;
}
