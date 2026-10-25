// SPDX-License-Identifier: Apache-2.0
// The side panel: sessions open beside the current page, as tabs (`?s=<key>,…&t=<i>`).
// 44 % of the width by default, resizable at its left edge, remembered per device; a
// page sheet on phones. One bar, as tall as the page bar so their hairlines make one
// rule (the state glyph, the title, "⋯", Open as page, Close; where it runs is the
// title's tooltip); with two tabs or more, window tabs under it sharing the width; then
// the bodies, the timeline and the composer: every tab keeps its own scroller mounted up
// to MOUNTED_MAX, so its scroll position and loaded pages survive a switch. Tabs and the
// head have their own menus. A dragged tab rides under the pointer while its neighbours
// slide out of its way; a reordered tab slides to its place and a new one fades in; an
// overflowing strip fades at the edge that has more. Opening from a rectangle morphs a
// ghost of it into the panel. Pages that list no sessions (Setup, Connect, /phone,
// Settings) don't show it.
import type { AgentRun, SessionKey, SessionSummary } from "@shared/api";
import { splitKey } from "@shared/api";
import {
  createRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStartTitles } from "../control/Starting";
import { useAppState, useStore } from "../data/hooks";
import { agentLabel, parseTab } from "../lib/agents";
import { focusTab, tablistKey } from "../lib/focus";
import { repoShort, sessionTitle } from "../lib/format";
import { historyTitle, useHistoryTitles } from "../lib/historyTitle";
import { agentItems, sessionItems, sessionMenuSubtitle } from "../lib/menus";
import { agentPath, Link, navigate, sessionPath } from "../lib/router";
import { setTierLens, useAppSettings, useLens } from "../lib/settings";
import { hintFor, useShortcut } from "../lib/shortcuts";
import {
  activateTab,
  closeOthers,
  closeSplit,
  closeTab,
  cycleTab,
  MOUNTED_MAX,
  moveTab,
  openSplit,
  PAGE_MIN,
  type Rect,
  SPLIT_MIN,
  setSplitWidth,
  takeFrom,
  usePanelHere,
  useSplit,
  useSplitWidth,
} from "../lib/split";
import { TIER_LABEL } from "../lib/tier";
import { AgentGlyph } from "./AgentRow";
import { StateDot } from "./bits";
import { type MenuList, MoreButton, useContextMenu } from "./ContextMenu";
import { LabelDot } from "./LabelDot";
import { answerItems, SessionView } from "./SessionView";

const MOTION_MS = 240;
/** The slide out is quicker than the slide in (every exit is 140 ms). */
const EXIT_MS = 140;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** The strip's tabs move instead of jumping: a tab whose place changed (a reorder, a
 *  neighbour closed) slides there from where it was drawn; a new one fades in. The tab
 *  under the pointer in a drag is the pointer's, not this. Transform and opacity only. */
function useTabFlip(strip: RefObject<HTMLDivElement>, keys: readonly SessionKey[], skip: SessionKey | null): void {
  const prev = useRef<Map<string, number> | null>(null);
  const sig = keys.join(",");
  useLayoutEffect(() => {
    const box = strip.current;
    if (!box) return;
    const els = [...box.querySelectorAll<HTMLElement>("[data-tab-key]")];
    const now = new Map(els.map((el) => [el.dataset.tabKey!, el.offsetLeft]));
    const before = prev.current;
    prev.current = now;
    // Nothing to move from on the first frame, while the strip folds into the head, or
    // when the person asked for less motion.
    if (!before || before.size === 0 || els.length < 2 || reduced() || typeof Element.prototype.animate !== "function")
      return;
    for (const el of els) {
      const k = el.dataset.tabKey!;
      if (k === skip) continue;
      const was = before.get(k);
      if (was === undefined) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: EASE });
        continue;
      }
      const dx = was - now.get(k)!;
      if (Math.abs(dx) < 1) continue;
      el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 200, easing: EASE });
    }
  }, [sig]);
}

/** A ghost rectangle animated from one viewport rect to another: transform and opacity only. */
function morph(from: Rect, to: Rect, opts: { fadeIn?: boolean; ms?: number } = {}): void {
  if (reduced() || from.width <= 0 || from.height <= 0) return;
  const el = document.createElement("div");
  el.className = "split-ghost";
  el.style.cssText = `left:${from.x}px;top:${from.y}px;width:${from.width}px;height:${from.height}px`;
  document.body.appendChild(el);
  const end = `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${to.width / from.width}, ${to.height / from.height})`;
  const anim = el.animate(
    [
      { transform: "none", opacity: opts.fadeIn ? 0.4 : 0.9 },
      { transform: end, opacity: opts.fadeIn ? 0.9 : 0 },
    ],
    { duration: opts.ms ?? MOTION_MS, easing: EASE, fill: "forwards" },
  );
  anim.finished.then(() => el.remove()).catch(() => el.remove());
}

/** The agent an agent tab holds, from its session's summary. */
const agentOf = (s: SessionSummary | undefined, tab: SessionKey): AgentRun | undefined => {
  const id = parseTab(tab).agent;
  return id ? s?.agents?.find((a) => a.id === id) : undefined;
};

/** Tab labels: the session title ("Explore · description" for an agent tab; a session
 *  started here and not titled yet, its first message), plus " · machine" only where two
 *  tabs share a title. */
function tabLabels(
  tabs: SessionKey[],
  summary: (k: SessionKey) => SessionSummary | undefined,
  started: ReadonlyMap<SessionKey, string>,
): string[] {
  const titles = tabs.map((k) => {
    const s = summary(k);
    if (parseTab(k).agent) {
      const a = agentOf(s, k);
      return a ? agentLabel(a) : "Subagent";
    }
    const begun = started.get(parseTab(k).session);
    if (begun && !s?.title?.trim()) return begun;
    return s ? sessionTitle(s) : (historyTitle(parseTab(k).session) ?? splitKey(k).id.slice(0, 8));
  });
  return titles.map((t, i) => {
    const dup = titles.some((o, j) => j !== i && o === t);
    const m = summary(tabs[i]!)?.machine;
    return dup && m ? `${t} · ${m}` : t;
  });
}

export function SessionPanel({ phone }: { phone: boolean }) {
  const { tabs, active } = useSplit();
  useHistoryTitles();
  const activeKey = tabs[active] ?? null;
  const width = useSplitWidth();
  const sessions = useAppState().sessions;
  /** Summaries the views learned, for tabs whose session is not in the snapshot. */
  const [known, setKnown] = useState<ReadonlyMap<SessionKey, SessionSummary>>(new Map());
  // An agent tab reads its session's summary.
  const summary = useCallback(
    (k: SessionKey) => {
      const key = parseTab(k).session;
      return sessions.get(key) ?? known.get(key);
    },
    [sessions, known],
  );
  const onSession = useCallback(
    (s: SessionSummary) => setKnown((m) => (m.get(s.key) === s ? m : new Map(m).set(s.key, s))),
    [],
  );

  /** Tabs whose SessionView is mounted, least recently used first. */
  const [mounted, setMounted] = useState<SessionKey[]>(activeKey ? [activeKey] : []);
  /** What the panel shows while it slides out: the tabs lag the URL by one animation. */
  const [shownTabs, setShownTabs] = useState<SessionKey[]>(tabs);
  const bodyRefs = useRef(new Map<SessionKey, RefObject<HTMLDivElement>>());
  const bodyRef = (k: SessionKey) => {
    let r = bodyRefs.current.get(k);
    if (!r) {
      r = createRef<HTMLDivElement>();
      bodyRefs.current.set(k, r);
    }
    return r;
  };
  const panelRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const lastFrom = useRef<Rect | null>(null);
  const here = usePanelHere();
  const wasOpen = useRef(tabs.length > 0 && here);
  const open = tabs.length > 0 && here;
  const started = useStartTitles();

  const panelRect = useCallback(
    (): Rect =>
      phone
        ? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
        : { x: window.innerWidth - width, y: 0, width, height: window.innerHeight },
    [phone, width],
  );

  // Open and close: the morph in and out, and the body kept until the slide-out ends.
  useEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = open;
    if (open) {
      setShownTabs(tabs);
      if (!was) {
        const from = takeFrom();
        lastFrom.current = from;
        if (from) morph(from, panelRect());
      } else takeFrom();
      return;
    }
    if (was) {
      const from = lastFrom.current;
      lastFrom.current = null;
      if (from) morph(panelRect(), from, { ms: EXIT_MS });
      const t = setTimeout(
        () => {
          setShownTabs([]);
          setMounted([]);
          bodyRefs.current.clear();
        },
        reduced() ? 0 : EXIT_MS,
      );
      return () => clearTimeout(t);
    }
  }, [open, tabs, panelRect]);

  // Which views stay mounted: the active one joins (most recent last); closed tabs leave;
  // past MOUNTED_MAX the least recently used goes.
  useEffect(() => {
    if (!activeKey) return;
    setMounted((prev) => {
      const next = prev.filter((k) => k !== activeKey && tabs.includes(k));
      next.push(activeKey);
      while (next.length > MOUNTED_MAX) {
        const drop = next.shift()!;
        bodyRefs.current.delete(drop);
      }
      return next;
    });
  }, [activeKey, tabs]);

  // The active tab scrolls into view in the strip.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeKey) return;
    const el = strip.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(activeKey)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced() ? "auto" : "smooth" });
    edges(strip);
  }, [activeKey, tabs, width]);
  // An overflowing strip fades out at each edge that has tabs past it, kept up to date as
  // it scrolls (a class flip per frame at most, no React render).
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    let raf = 0;
    const on = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          edges(strip);
        });
    };
    strip.addEventListener("scroll", on, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      strip.removeEventListener("scroll", on);
    };
  }, []);

  // Keyboard, through the keymap (lib/shortcuts.ts): [ / ] (and ctrl+tab) cycle, mod+1…9
  // jump, mod+w closes the active tab while the panel has focus (the browser keeps it
  // otherwise), x closes the panel.
  useShortcut("panel.prev", () => (tabs.length > 1 ? cycleTab(-1) : false), { enabled: open });
  useShortcut("panel.next", () => (tabs.length > 1 ? cycleTab(1) : false), { enabled: open });
  useShortcut("panel.close", () => closeSplit(), { enabled: open });
  useShortcut("panel.closeTab", () => (panelRef.current?.contains(document.activeElement) ? closeTab(active) : false), {
    enabled: open,
  });
  for (let i = 1; i <= 9; i++) {
    useShortcut(`panel.tab${i}`, () => (i <= tabs.length ? activateTab(i - 1) : false), { enabled: open });
  }

  // The divider by keyboard: the arrows move it 24 px, shift 96 px.
  const onGripKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 96 : 24;
    let w = width;
    if (e.key === "ArrowLeft") w += step;
    else if (e.key === "ArrowRight") w -= step;
    else if (e.key === "Home") w = window.innerWidth - PAGE_MIN;
    else if (e.key === "End") w = SPLIT_MIN;
    else return;
    e.preventDefault();
    setSplitWidth(Math.max(SPLIT_MIN, Math.min(w, window.innerWidth - PAGE_MIN)));
  };

  // The divider: drag to resize; the page keeps PAGE_MIN, the panel keeps SPLIT_MIN.
  const onGrip = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    document.documentElement.classList.add("split-dragging");
    const move = (ev: PointerEvent) => {
      const w = Math.max(SPLIT_MIN, Math.min(window.innerWidth - ev.clientX, window.innerWidth - PAGE_MIN));
      setSplitWidth(w);
    };
    const up = () => {
      document.documentElement.classList.remove("split-dragging");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };

  // Tabs reorder by drag: past 6 px the tab lifts and rides under the pointer (a
  // transform, written straight to the element); once its middle crosses a neighbour's,
  // the order changes and that neighbour slides out of its way (useTabFlip). Let go, it
  // settles into its slot. A click that never moved activates.
  const [dragging, setDragging] = useState<SessionKey | null>(null);
  /** While a tab is dragged: puts it back under the pointer after the strip re-renders in
   *  its new order, before that frame paints. */
  const dragFix = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    dragFix.current?.();
  });
  const onTabDown = (e: ReactPointerEvent<HTMLDivElement>, index: number) => {
    if (e.button !== 0) return;
    const tab = e.currentTarget;
    const strip = stripRef.current;
    if (!strip) return;
    const key = tabs[index]!;
    const startX = e.clientX;
    const grab = e.clientX - tab.getBoundingClientRect().left;
    let from = index;
    let moved = false;
    const pid = e.pointerId;
    const place = (clientX: number) => {
      // Where the pointer wants the tab, in the strip's own coordinates, kept inside it.
      const box = strip.getBoundingClientRect();
      const want = Math.max(
        0,
        Math.min(clientX - grab - box.left + strip.scrollLeft, strip.scrollWidth - tab.offsetWidth),
      );
      tab.style.transform = `translateX(${want - tab.offsetLeft}px)`;
      return want + tab.offsetWidth / 2;
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      if (!moved && Math.abs(ev.clientX - startX) < 6) return;
      if (!moved) {
        moved = true;
        setDragging(key);
      }
      const x = ev.clientX;
      dragFix.current = () => place(x);
      const mid = place(x);
      const others = [...strip.querySelectorAll<HTMLElement>("[data-tab-key]")].filter((el) => el !== tab);
      const to = others.filter((el) => el.offsetLeft + el.offsetWidth / 2 < mid).length;
      if (to !== from) {
        moveTab(from, to);
        from = to;
      }
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      dragFix.current = null;
      if (!moved) {
        activateTab(index);
        return;
      }
      // Settle: from under the pointer into its slot.
      const left = tab.style.transform;
      tab.style.transform = "";
      setDragging(null);
      if (left && !reduced() && typeof tab.animate === "function")
        tab.animate([{ transform: left }, { transform: "none" }], { duration: 160, easing: EASE });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  useTabFlip(stripRef, open ? tabs : shownTabs, dragging);
  const onTabAux = (e: ReactMouseEvent<HTMLDivElement>, index: number) => {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(index);
    }
  };

  const shown = open ? tabs : shownTabs;
  const s = activeKey ? summary(activeKey) : undefined;
  const activeAgentId = activeKey ? parseTab(activeKey).agent : undefined;
  const activeAgent = activeKey ? agentOf(s, activeKey) : undefined;
  const labels = tabLabels(shown, summary, started);
  const activeIndex = activeKey ? shown.indexOf(activeKey) : -1;
  const title = activeAgentId
    ? activeAgent
      ? agentLabel(activeAgent)
      : "Subagent"
    : activeIndex >= 0
      ? (labels[activeIndex] ?? "Session")
      : "Session";
  // Where it runs, as the title's tooltip: the panel keeps one bar.
  const where = s ? [s.machine, repoShort(s.repo) || undefined].filter(Boolean).join(" · ") : "";
  const bodies = open ? mounted : [];
  const store = useStore();
  const { mode } = useAppSettings();
  const lens = useLens() ?? 3;
  /** The active tab's view, for the items that reach its strip (Allow, Deny). */
  const activeBody = () => panelRef.current?.querySelector<HTMLElement>(".panel-body:not(.panel-body--off)") ?? null;
  const pagePath = (k: SessionKey) => {
    const { session, agent } = parseTab(k);
    const { harness, id } = splitKey(session);
    return agent ? agentPath(harness, id, agent) : sessionPath(harness, id);
  };
  const lensItems: MenuList =
    mode === "simple"
      ? []
      : [
          {
            label: "Tier lens",
            items: ([0, 1, 2, 3] as const).map((t) => ({
              label: `${t} · ${TIER_LABEL[t].charAt(0).toUpperCase()}${TIER_LABEL[t].slice(1)}`,
              radio: true,
              checked: lens === t,
              run: () => setTierLens(t),
            })),
          },
        ];
  // The head's "⋯": the panel's own actions first, then the session's menu.
  const headMenu = (): MenuList => {
    if (!activeKey) return [];
    const cur = summary(activeKey);
    const run = agentOf(cur, activeKey);
    if (activeAgentId)
      return [
        { label: "Open as page", action: "session.openPage", run: () => navigate(pagePath(activeKey)) },
        { label: "Open parent beside", run: () => openSplit(parseTab(activeKey).session) },
        { label: "Close panel", action: "panel.close", run: closeSplit },
        ...(cur && run ? [{ sep: true } as const, ...agentItems(cur, run).slice(3)] : []),
      ];
    return [
      { label: "Open as page", action: "session.openPage", run: () => navigate(pagePath(activeKey)) },
      { label: "Close panel", action: "panel.close", run: closeSplit },
      { sep: true },
      ...lensItems,
      { sep: true },
      ...(cur ? sessionItems(cur, { store, surface: "panel", answer: answerItems(activeBody(), cur) }) : []),
    ];
  };
  const headProps = useContextMenu(headMenu, {
    title: () => title,
    subtitle: () => (s ? sessionMenuSubtitle(s) : ""),
  });

  return (
    <aside
      ref={panelRef}
      className={`panel ${open ? "panel--open" : ""} ${phone ? "panel--sheet" : ""}`}
      aria-label="Session panel"
      aria-hidden={!open}
      data-split={activeKey ?? undefined}
    >
      {!phone && (
        // biome-ignore lint/a11y/useSemanticElements: a separator with pointer handling has no native element
        <div
          className="panel-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          aria-valuenow={Math.round(width)}
          aria-valuemin={SPLIT_MIN}
          aria-valuemax={Math.max(SPLIT_MIN, window.innerWidth - PAGE_MIN)}
          aria-valuetext={`${Math.round(width)} px wide; arrows resize`}
          onPointerDown={onGrip}
          onKeyDown={onGripKey}
          tabIndex={0}
        />
      )}
      <div className="panel-bodies">
        {bodies.map((k) => {
          const tab = parseTab(k);
          const { harness, id } = splitKey(tab.session);
          const isActive = k === activeKey;
          return (
            <div
              key={k}
              className={`panel-body ${isActive ? "" : "panel-body--off"}`}
              ref={bodyRef(k)}
              aria-hidden={!isActive}
              data-body={k}
            >
              <SessionView
                harness={harness}
                id={id}
                mode="panel"
                scrollRef={bodyRef(k)}
                agent={tab.agent}
                onSession={onSession}
                onForgotten={() => closeTab(tabs.indexOf(k))}
              />
            </div>
          );
        })}
      </div>
      <header className="panel-head" {...headProps}>
        {activeAgentId ? (
          <AgentGlyph a={activeAgent ?? { state: "done" }} size={10} />
        ) : (
          s && (
            <>
              <StateDot state={s.state} />
              <LabelDot session={s.key} />
            </>
          )
        )}
        <h2
          className="panel-title ellipsis"
          title={where ? `${title} · ${where}` : title}
          data-tip={where ? `${title} · ${where}` : title}
          data-tip-side="bottom"
        >
          {title}
        </h2>
        {activeAgentId && s && <span className="panel-status panel-parent ellipsis">{sessionTitle(s)}</span>}
        <span className="panel-actions">
          <MoreButton build={headMenu} title={() => title} className="panel-btn" />
          {activeKey && (
            <Link
              to={pagePath(activeKey)}
              className="icon-btn panel-btn panel-open"
              aria-label="Open as page"
              data-tip="Open as page"
              data-tip-keys={hintFor("session.openPage") || undefined}
              data-tip-side="bottom"
            >
              <svg
                viewBox="0 0 20 20"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 4H4.5A1.5 1.5 0 0 0 3 5.5v10A1.5 1.5 0 0 0 4.5 17h10a1.5 1.5 0 0 0 1.5-1.5V12" />
                <path d="M11 3h6v6" />
                <path d="M17 3l-7.5 7.5" />
              </svg>
            </Link>
          )}
          <button
            type="button"
            className="icon-btn panel-btn panel-close"
            onClick={closeSplit}
            aria-label="Close panel"
            data-tip="Close panel"
            data-tip-keys={hintFor("panel.close") || undefined}
            data-tip-side="bottom"
            data-dismiss
          >
            <svg
              viewBox="0 0 20 20"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
            <span className="panel-done" aria-hidden="true">
              Done
            </span>
          </button>
        </span>
      </header>
      <div
        className={`tabs ${shown.length < 2 ? "tabs--single" : ""}`}
        role="tablist"
        aria-label="Open sessions"
        ref={stripRef}
      >
        {shown.map((k, i) => (
          <PanelTab
            key={k}
            k={k}
            index={i}
            count={shown.length}
            label={labels[i]!}
            session={summary(k)}
            agent={parseTab(k).agent ? (agentOf(summary(k), k) ?? null) : undefined}
            paired={!!parseTab(k).agent && i > 0 && parseTab(shown[i - 1]!).session === parseTab(k).session}
            active={k === activeKey}
            dragging={dragging === k}
            onPointerDown={(e) => onTabDown(e, i)}
            onAuxClick={(e) => onTabAux(e, i)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activateTab(i);
                return;
              }
              tablistKey(e, shown.length, i, {
                activate: (n) => {
                  activateTab(n);
                  focusTab(stripRef.current, n);
                },
                close: (n) => {
                  closeTab(n);
                  focusTab(stripRef.current, Math.min(n, shown.length - 2));
                },
              });
            }}
            menu={() => {
              const cur = summary(k);
              const isActive = k === activeKey;
              const tabAgent = parseTab(k).agent;
              return [
                { label: "Close tab", action: isActive ? "panel.closeTab" : undefined, run: () => closeTab(i) },
                shown.length > 1 && { label: "Close other tabs", run: () => closeOthers(i) },
                { label: "Close panel", action: "panel.close", run: closeSplit },
                { sep: true },
                !phone && { label: "Move tab left", disabled: i === 0 || undefined, run: () => moveTab(i, i - 1) },
                !phone && {
                  label: "Move tab right",
                  disabled: i === shown.length - 1 || undefined,
                  run: () => moveTab(i, i + 1),
                },
                { sep: true },
                {
                  label: "Open as page",
                  action: isActive ? "session.openPage" : undefined,
                  run: () => navigate(pagePath(k)),
                },
                tabAgent && { label: "Open parent beside", run: () => openSplit(parseTab(k).session) },
                { sep: true },
                ...(cur && !tabAgent
                  ? sessionItems(cur, {
                      store,
                      surface: "tab",
                      answer: isActive ? answerItems(activeBody(), cur) : undefined,
                    }).filter(
                      // The tab is already beside: its own "Open as page" leads.
                      (it) => !("label" in it && ["Open as page", "Open beside", "Preview"].includes(it.label)),
                    )
                  : []),
              ];
            }}
          />
        ))}
      </div>
    </aside>
  );
}

/** One window tab: the state glyph, the title, × on hover; its menu closes, moves and
 *  opens it, then the session's own items. */
function PanelTab({
  k,
  index,
  count,
  label,
  session,
  agent,
  paired,
  active,
  dragging,
  onPointerDown,
  onAuxClick,
  onKeyDown,
  menu,
}: {
  k: SessionKey;
  index: number;
  count: number;
  label: string;
  session: SessionSummary | undefined;
  /** An agent tab's agent (null while its summary does not know it yet). */
  agent?: AgentRun | null;
  /** An agent tab right after its session's tab: the two read as a pair. */
  paired?: boolean;
  active: boolean;
  dragging: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onAuxClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  menu: () => MenuList;
}) {
  const props = useContextMenu(menu, {
    title: () => label,
    subtitle: () => (session ? sessionMenuSubtitle(session) : ""),
  });
  return (
    <div
      className={`tab ${active ? "tab--active" : ""} ${dragging ? "tab--dragging" : ""} ${agent !== undefined ? "tab--agent" : ""} ${paired ? "tab--paired" : ""}`}
      role="tab"
      aria-selected={active}
      aria-setsize={count}
      aria-posinset={index + 1}
      tabIndex={active ? 0 : -1}
      data-tab-key={k}
      title={label}
      data-tip={label}
      data-tip-side="bottom"
      onPointerDown={onPointerDown}
      onAuxClick={onAuxClick}
      onKeyDown={onKeyDown}
      {...props}
    >
      {agent !== undefined ? (
        <>
          <svg className="tab-tree" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
            <path d="M1 0v4.5Q1 7 3.5 7H8" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
          <AgentGlyph a={agent ?? { state: "done" }} />
        </>
      ) : (
        <>
          <StateDot state={session?.state ?? "idle"} size={8} decorative />
          {session && <LabelDot session={session.key} />}
        </>
      )}
      <span className="tab-title">{label}</span>
      <button
        type="button"
        className="tab-close"
        aria-label={`Close ${label}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          closeTab(index);
        }}
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/** Which edges of the strip have tabs past them: each fades out where it does. */
function edges(strip: HTMLElement): void {
  const over = strip.scrollWidth > strip.clientWidth + 1;
  const start = over && strip.scrollLeft > 1;
  const end = over && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
  strip.toggleAttribute("data-fade-start", start);
  strip.toggleAttribute("data-fade-end", end);
}
