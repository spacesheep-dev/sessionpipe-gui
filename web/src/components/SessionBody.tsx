// SPDX-License-Identifier: Apache-2.0
// One session's body, used by the Session page and by the side panel through
// components/SessionView.tsx (this module is its own chunk, fetched once the app is idle
// or the first session opens): on the page its title bar (PageBar: back, the state glyph
// and the title, then where it runs, the "⋯" menu), in the panel nothing above the
// timeline but the panel's own head; then the
// timeline grouped by turn (newest page first, older pages on demand, the stream
// appending) and the docked composer. The page scrolls the window; the panel scrolls its
// own element (`scrollRef`). The view sticks to the bottom while the person is within
// 48 px of it; scrolled up, nothing moves and an "n new" pill offers the way back. A
// session with several answers since the person last looked opens on a New line above
// the first of them instead (lib/newLine.ts). In
// Simple mode (lib/settings.ts) the same view is a chat: the person's prompts as bubbles
// on the right, the assistant's replies as plain prose under its name, the tools of a
// turn folded into one line. A message sent from here is drawn where its turn is or will
// be: a session this device started is its layout from the first frame (its first
// message as the title and the first bubble, one status row following the machine's
// acks), and the first hook event fills it in place (control/Starting.tsx). Every row of
// the timeline has its own right-click menu (long-press on touch); the empty space around
// it has the view's options.
import type {
  AgentRun,
  ControlActivity,
  Delegation,
  MachineControl,
  SessionKey,
  SessionState,
  SessionSummary,
  StoredEvent,
  Tier,
} from "@shared/api";
import { sessionKey, splitKey } from "@shared/api";
import {
  createContext,
  Fragment,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { forkOf } from "../control/Activity";
import { PromptBody, promptParts } from "../control/Attachments";
import { machineHome, tildify } from "../control/folders";
import { useControlActivity } from "../control/hooks";
import { SessionControl } from "../control/SessionControl";
import {
  appliedFact,
  editAgain,
  optionsIgnored,
  SentFailure,
  SentFiles,
  StatusRow,
  sentRow,
  startTitle,
  useStartOf,
} from "../control/Starting";
import { signHint } from "../control/signer";
import { useSessionSend } from "../control/useSend";
import { harnessCommand, isFinal, REFUSAL_WORDS, refusalWords, sentLine } from "../control/words";
import { useLaunched, useLimits, useMachines, useMachinesMap, useSession, useStore } from "../data/hooks";
import { LIST_PREVIEW, TAIL, takeWarm } from "../data/prefetch";
import { agentLabel, agentsFact, agentType, openAgent, taskNotification } from "../lib/agents";
import "../lib/acp";
import {
  ATTENTION_LABEL,
  attentionMessage,
  basename,
  harnessMark,
  modelShort,
  repoBranch,
  repoShort,
  STATE_LABEL,
  sessionTitle,
  toolLabel,
} from "../lib/format";
import { useKeyboardInset } from "../lib/keyboardInset";
import { labelMenu } from "../lib/labels";
import { absoluteUrl, agentItems, askItem, copyItem, sessionItems } from "../lib/menus";
import { reducedMotion, useFlip } from "../lib/motion";
import { leftOff, type NewLineAt, newLinePlace } from "../lib/newLine";
import { clockTime, eventWindows, leftBecause, sentenceName, servedBy, swaps, swapWords } from "../lib/pool";
import { AGENT_PARAM, back, hrefFor, Link, navigate, sessionPath, useSearchParam } from "../lib/router";
import { backgroundFact, submittedLabel } from "../lib/runs";
import { setTierLens, useAppSettings, useLens } from "../lib/settings";
import { useShortcut } from "../lib/shortcuts";
import { openSplit } from "../lib/split";
import { atTier, TIER_HINT, TIER_LABEL } from "../lib/tier";
import { ago, clock, dur, ms, useNow } from "../lib/time";
import {
  type AgentItem,
  type DelegationItem,
  type EventItem,
  eventWords,
  groupTurns,
  handoffAnswer,
  sentTurns,
  type ToolItem,
  type Turn,
  unframe,
} from "../lib/turns";
import { HistoryOrMissing } from "../search/HistoryEntry";
import { AgentGlyph, AgentNow, AgentText } from "./AgentRow";
import { CopyIconButton, HarnessGlyph, Redacted, Segmented, Since, Spinner, StateDot } from "./bits";
import { confirmAction, type MenuItem, type MenuList, MoreButton, openMenu, tidy, useContextMenu } from "./ContextMenu";
import { LabelDot, useLabelKeys } from "./LabelDot";
import { CodeFrame, Markdown } from "./Markdown";
import { BackButton, PageBar } from "./PageBar";
import { askingFact } from "./SessionCard";
import { answerItems, SessionLoading, type SessionViewProps } from "./SessionView";
import { openUsage } from "./UsageGlance";
import "../styles/lineage.css";

/** The size of each older page; the newest page (TAIL) is data/prefetch's, which warms
 *  it on hover. Both slim: the full event is fetched only when a row is expanded. */
const OLDER = 200;
/** While following a live session, rows past this many are let go from the top (they
 *  are one "Older turns" click away), so a tab left open for hours stays small. */
const LIVE_CAP = TAIL + 2 * OLDER;
/** The view sticks to the bottom only while the person is this close to it. */
const PIN_PX = 48;
/** Arrivals the "new below" pill doesn't count: a reply growing, a heartbeat, a status
 *  line's usage report (none is a row of its own). */
const QUIET_TYPES = new Set(["turn.progress", "session.heartbeat", "limits.observed"]);
/** A delivered message with no turn of its own yet keeps its row this long. */
const DELIVERED_HOLD_MS = 120_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `#seq-N` on the URL: the row a search hit asks to open on (pages/Review.tsx), read once. */
const hashSeq = (): number | null => {
  const m = /^#seq-(\d+)$/.exec(location.hash);
  return m ? Number(m[1]) : null;
};

type Leaf = Extract<MenuItem, { run: unknown }>;

/** "Send a message…" and "Stop the running turn…", read off the strip when the menu
 *  opens: what a surface puts beside the session's own items. */
function controlItems(root: HTMLElement | null): { send: Leaf | null; cancel: Leaf | null } {
  const ta = root?.querySelector<HTMLTextAreaElement>(".ctl textarea");
  const cancel = root?.querySelector<HTMLButtonElement>(".ctl-cancel");
  const hint = root?.querySelector(".ctl-hint")?.textContent?.trim();
  return {
    send: ta
      ? {
          label: "Send a message…",
          action: "session.prompt",
          disabled: ta.disabled ? hint || true : undefined,
          run: () => focusPrompt(ta),
        }
      : null,
    cancel: cancel
      ? {
          label: "Stop the running turn…",
          action: "session.cancel",
          disabled: cancel.disabled || undefined,
          run: () => void askCancel(cancel),
        }
      : null,
  };
}

const focusPrompt = (ta: HTMLTextAreaElement) => {
  ta.focus();
  ta.scrollIntoView({ block: "nearest" });
};
const askCancel = async (btn: HTMLButtonElement) => {
  const ok = await confirmAction({
    title: "Stop the running turn?",
    body: "The agent stops what it is doing; the session stays open for the next message.",
    action: "Stop the turn",
  });
  if (ok && btn.isConnected && !btn.disabled) btn.click();
};

/** The tier lens as a radio submenu (Advanced). */
const lensMenu = (lens: Tier): MenuItem => ({
  label: "Tier lens",
  items: ([0, 1, 2, 3] as Tier[]).map((t) => ({
    label: `${t} · ${cap(TIER_LABEL[t])}`,
    radio: true,
    checked: lens === t,
    run: () => setTierLens(t),
  })),
});

/** What the timeline's rows share: where links point, which prompts are open, the menus
 *  that reach the strip, the machine a sent message went to, and the one anchor an
 *  expanding row keeps. */
interface Timeline {
  path: string;
  open: ReadonlySet<string>;
  working: boolean;
  root: RefObject<HTMLDivElement>;
  session: () => SessionSummary | undefined;
  /** The session's subagents (its summary's). */
  agents: readonly AgentRun[];
  /** The agent the view was opened on (`?agent=`, an agent tab): its block opens. */
  focus: string | null;
  /** Scroll to an agent's block and open it (a "Subagent finished" row). */
  showAgent: (id: string) => void;
  mode: "page" | "panel";
  /** The session's machine, as a sent message's row names it. */
  machine: string;
  online: boolean;
  control?: MachineControl;
  /** Puts a message's words back in the composer ("Edit and send again"). */
  compose: (text: string) => void;
  /** A row about to open or close in place: keep it where it is on screen, and stop
   *  following the bottom (the person is reading). */
  anchorOn: (el: HTMLElement) => void;
}
const TimelineCtx = createContext<Timeline | null>(null);
const useTimeline = () => useContext(TimelineCtx)!;

/** The link to a row of this session (the view jumps to it on open). */
const seqLink = (path: string, seq: number | undefined) =>
  seq === undefined ? null : `${absoluteUrl(path)}#seq-${seq}`;

/** Whether a message sent from here, with no turn of its own in the view, still gets its
 *  row at the end of the timeline: while it is on its way; once it failed or was just
 *  delivered, only when nothing began after it. A start without its session yet always. */
function stillPending(a: ControlActivity, lastStart: number, hasTurns: boolean, now: number): boolean {
  if (a.kind === "start") return !hasTurns;
  if (!isFinal(a)) return true;
  const at = Date.parse(a.at);
  if (Number.isFinite(lastStart) && at < lastStart) return false;
  if (a.outcome !== "delivered") return true;
  return now - Date.parse(a.ackedAt ?? a.at) < DELIVERED_HOLD_MS;
}

/** A prompt whose text its machine keeps (a privacy tier below 2): said as the feature it
 *  is, with a small lock, never as a gap ("A prompt of 110 characters"). */
const PROMPT_KEPT = "Its machine sends at a tier that keeps prompt text on the machine; only the length arrives.";
function PromptKept({ chars }: { chars: number | undefined }) {
  return (
    <>
      <svg className="prompt-lock" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
        <rect x="2.5" y="5.25" width="7" height="5" rx="1.25" fill="currentColor" />
        <path d="M4 5.25V4a2 2 0 0 1 4 0v1.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
      </svg>
      {chars !== undefined ? (
        <>
          Prompt not shared · <span className="num">{chars}</span> characters
        </>
      ) : (
        "Prompt not shared"
      )}
    </>
  );
}

export function SessionBody({ harness, id, mode, scrollRef, onSession, onForgotten, agent }: SessionViewProps) {
  const pageAgent = useSearchParam(AGENT_PARAM);
  const focusAgent = (mode === "page" ? pageAgent : agent) ?? null;
  const store = useStore();
  const key = sessionKey(harness, id);
  const live = useSession(key);
  // A start this device signed names the key before any event does (STEER-SPEC B.5).
  const started = useStartOf(key);
  const machines = useMachinesMap();
  const machineList = useMachines();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [summary, setSummary] = useState<SessionSummary | undefined>();
  const [children, setChildren] = useState<SessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  // The tier lens is the app's (Settings › Tier lens, the chip, `l`); this control reads
  // and writes it. "all" is tier 3 here. Simple mode: the chat, everything shown.
  const lensSetting = useLens();
  const lens: Tier = lensSetting ?? 3;
  const { mode: uiMode } = useAppSettings();
  const chat = uiMode === "simple";
  const [follow, setFollow] = useState(true);
  const followRef = useRef(follow);
  followRef.current = follow;
  /** Within PIN_PX of the bottom (read on every scroll; a ref, so growth can read it). */
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  /** Events that arrived while the person was scrolled up (the "n new" pill). */
  const [unseen, setUnseen] = useState(0);
  /** The row a disclosure click asked to keep in place (Timeline.anchorOn). */
  const held = useRef<{ el: HTMLElement; top: number } | null>(null);
  const lastSeq = useRef(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const [hasOlder, setHasOlder] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const firstSeq = useRef<number | undefined>(undefined);
  /** Taken just before older events are prepended, to keep the viewport still: the first row
   *  on screen (by seq) and where it was, plus the page height as a fallback. */
  const anchor = useRef<{ seq: number | null; top: number; height: number; y: number } | null>(null);
  const firstPaint = useRef(true);

  // The scroller: the panel's element, or the window.
  const sc = useCallback(() => scrollRef?.current ?? null, [scrollRef]);
  const scrollHeight = useCallback(() => sc()?.scrollHeight ?? document.documentElement.scrollHeight, [sc]);
  const scrollY = useCallback(() => sc()?.scrollTop ?? window.scrollY, [sc]);
  const viewHeight = useCallback(() => sc()?.clientHeight ?? window.innerHeight, [sc]);
  const scrollTo = useCallback(
    (y: number, smooth = false) => {
      const el = sc();
      const behavior: ScrollBehavior = smooth && !reducedMotion() ? "smooth" : "auto";
      if (el) el.scrollTo({ top: y, behavior });
      else window.scrollTo({ top: y, behavior });
    },
    [sc],
  );
  const scrollBy = useCallback(
    (d: number) => {
      const el = sc();
      if (el) el.scrollTop += d;
      else window.scrollBy(0, d);
    },
    [sc],
  );
  /** To the very end, and stay there. */
  const toBottom = useCallback(
    (smooth = false) => {
      pinned.current = true;
      scrollTo(scrollHeight(), smooth);
    },
    [scrollTo, scrollHeight],
  );
  const setFollowing = useCallback(
    (on: boolean) => {
      followRef.current = on;
      setFollow(on);
      if (on) {
        setUnseen(0);
        toBottom(true);
      }
    },
    [toBottom],
  );

  // The newest page in one round trip, then let the stream append. Older pages load on demand.
  useEffect(() => {
    let cancelled = false;
    lastSeq.current = -1;
    firstSeq.current = undefined;
    firstPaint.current = true;
    setEvents([]);
    setLoading(true);
    setError(null);
    setHasOlder(false);
    const ahead = reload === 0 ? takeWarm(key) : undefined;
    const buffered: StoredEvent[] = ahead ? [...ahead.since] : [];
    const unsub = store.onEvent((e) => {
      if (`${e.harness.name}:${e.session.id}` === key) buffered.push(e);
    });
    (async () => {
      try {
        const d = await (ahead?.answer ??
          store.transport.session(harness, id, {
            tail: true,
            limit: TAIL,
            slim: true,
            preview: LIST_PREVIEW,
          }));
        if (cancelled) return;
        const acc = d.events.slice();
        const seen = new Set(acc.map((e) => e.session.seq));
        for (const e of buffered) if (!seen.has(e.session.seq)) acc.push(e);
        acc.sort((a, b) => a.session.seq - b.session.seq);
        lastSeq.current = acc[acc.length - 1]?.session.seq ?? -1;
        firstSeq.current = d.firstSeq ?? acc[0]?.session.seq;
        setSummary(d.session);
        setChildren(d.children);
        setTotal(d.total);
        setHasOlder(!!d.hasOlder);
        setEvents(acc);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        unsub();
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      unsub();
    };
  }, [store, harness, id, key, reload]);

  // A session started from here was not on the receiver when the page opened (404); once
  // its first event lands, read it again, once.
  const retried = useRef(false);
  const appeared = !!live;
  useEffect(() => {
    if (!error || !appeared || retried.current) return;
    retried.current = true;
    setReload((n) => n + 1);
  }, [error, appeared]);

  /** The previous page of older events, prepended; the viewport stays where it was. */
  const loadOlder = useCallback(async () => {
    const before = firstSeq.current;
    if (olderBusy || before === undefined) return;
    setOlderBusy(true);
    try {
      const d = await store.transport.session(harness, id, { before, limit: OLDER, slim: true, preview: LIST_PREVIEW });
      anchor.current = { ...firstVisibleRow(rootRef.current, sc()), height: scrollHeight(), y: scrollY() };
      if (d.firstSeq !== undefined) firstSeq.current = d.firstSeq;
      setHasOlder(!!d.hasOlder);
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.session.seq));
        return [...d.events.filter((e) => !seen.has(e.session.seq)), ...prev];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOlderBusy(false);
    }
  }, [store, harness, id, olderBusy, scrollHeight, scrollY, sc]);

  /** Scroll to the row of a seq when it is loaded (centred, marked for a moment) and drop
   *  the hash either way; true when the row was there. */
  const jumpTo = useCallback((seq: number | null): boolean => {
    if (seq === null) return false;
    history.replaceState(null, "", location.pathname + location.search);
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!row) return false;
    followRef.current = false;
    pinned.current = false;
    setFollow(false);
    row.scrollIntoView({ block: "center" });
    row.classList.add("is-target");
    setTimeout(() => row.classList.remove("is-target"), 1600);
    return true;
  }, []);
  /** Scroll to an agent's block (it opens itself: it is the focus, or was just asked). */
  const [shownAgent, setShownAgent] = useState<string | null>(null);
  const jumpToAgent = useCallback((agentId: string | null): boolean => {
    if (!agentId) return false;
    const block = rootRef.current?.querySelector<HTMLElement>(`[data-agent="${CSS.escape(agentId)}"]`);
    if (!block) return false;
    // Off at once, not at the next render: the view's growth would otherwise pin it
    // straight back to the bottom.
    followRef.current = false;
    pinned.current = false;
    setFollow(false);
    block.scrollIntoView({ block: "start" });
    return true;
  }, []);
  const showAgent = useCallback(
    (agentId: string) => {
      setShownAgent(agentId);
      requestAnimationFrame(() => jumpToAgent(agentId));
    },
    [jumpToAgent],
  );
  useEffect(() => {
    const onHash = () => jumpTo(hashSeq());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [jumpTo]);

  /** Open on the New line when what came since it is taller than two thirds of the view:
   *  the line a third of the way down, so the first new answer reads from its start. */
  const toNewLine = useCallback((): boolean => {
    const line = rootRef.current?.querySelector<HTMLElement>(".new-line");
    if (!line) return false;
    const top = line.getBoundingClientRect().top - (sc()?.getBoundingClientRect().top ?? 0) + scrollY();
    if (scrollHeight() - top <= (viewHeight() * 2) / 3) return false;
    followRef.current = false;
    pinned.current = false;
    setFollow(false);
    scrollTo(top - viewHeight() / 3);
    return true;
  }, [sc, scrollY, scrollHeight, viewHeight, scrollTo]);

  // Bottom-anchored first paint (the newest turn is what a session opens on, unless the
  // URL names a row or there is a New line to open on), before the browser paints, and a
  // still viewport when older events land above it, whether or not the browser's own
  // scroll anchoring already moved it.
  useLayoutEffect(() => {
    if (events.length === 0) return;
    if (firstPaint.current) {
      firstPaint.current = false;
      if (!jumpTo(hashSeq()) && !jumpToAgent(focusAgent) && !toNewLine()) toBottom();
      return;
    }
    const a = anchor.current;
    if (a) {
      anchor.current = null;
      const row = a.seq === null ? null : rootRef.current?.querySelector(`[data-seq="${a.seq}"]`);
      if (row) {
        const d = row.getBoundingClientRect().top - a.top;
        if (Math.abs(d) > 1) scrollBy(d);
      } else {
        const want = a.y + (scrollHeight() - a.height);
        if (Math.abs(scrollY() - want) > 1) scrollTo(want);
      }
    }
  }, [events, scrollTo, scrollBy, scrollHeight, scrollY, jumpTo, jumpToAgent, focusAgent, toNewLine, toBottom]);
  // Asked for another agent while open (a second "Open beside" on the same tab, the URL).
  const lastFocus = useRef(focusAgent);
  useEffect(() => {
    if (focusAgent === lastFocus.current) return;
    lastFocus.current = focusAgent;
    if (focusAgent) requestAnimationFrame(() => jumpToAgent(focusAgent));
  }, [focusAgent, jumpToAgent]);

  useEffect(() => {
    if (loading) return;
    return store.onEvent((e, s) => {
      if (s.key !== key) return;
      setEvents((prev) => {
        if (prev.some((p) => p.session.seq === e.session.seq)) return prev;
        let next = [...prev, e];
        if (e.session.seq < lastSeq.current) next.sort((a, b) => a.session.seq - b.session.seq);
        lastSeq.current = Math.max(lastSeq.current, e.session.seq);
        if (followRef.current && next.length > LIVE_CAP) {
          next = next.slice(next.length - LIVE_CAP);
          firstSeq.current = next[0]!.session.seq;
          setHasOlder(true);
        }
        return next;
      });
      setTotal((t) => t + 1);
      // The pill counts what landed below the fold; a growing reply is one thing, not many.
      if (!pinned.current && !QUIET_TYPES.has(e.type)) setUnseen((n) => n + 1);
    });
  }, [store, key, loading]);

  // Sticking to the bottom (Slack's, iMessage's): whatever grows the view (a new row, a
  // reply streaming, the composer's own lines, a font arriving) keeps the end in sight,
  // but only while following and within PIN_PX of it; scrolled up, nothing moves. Runs
  // before paint (a ResizeObserver callback), so a cold open never shows a re-anchor.
  // A disclosure that opened or closed keeps its own row where it was instead.
  const shape = !live && !summary && !started ? (loading ? "loading" : "missing") : "view";
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver !== "function") return;
    let last = root.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = root.offsetHeight;
      if (h === last) return;
      last = h;
      const a = held.current;
      if (a) {
        held.current = null;
        if (a.el.isConnected) {
          const d = a.el.getBoundingClientRect().top - a.top;
          if (Math.abs(d) > 1) scrollBy(d);
        }
        return;
      }
      if (followRef.current && pinned.current) scrollTo(scrollHeight());
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, [shape, scrollTo, scrollBy, scrollHeight]);
  // Where the person is: following resumes when they come back down to the end, and
  // stops the moment they scroll up away from it.
  useEffect(() => {
    const target: EventTarget = sc() ?? window;
    let lastY = scrollY();
    const onScroll = () => {
      const y = scrollY();
      const near = scrollHeight() - (y + viewHeight()) <= PIN_PX;
      pinned.current = near;
      setAway(!near);
      if (near) {
        setUnseen(0);
        if (!followRef.current && y > lastY) {
          followRef.current = true;
          setFollow(true);
        }
      } else if (y < lastY - 2 && followRef.current) {
        followRef.current = false;
        setFollow(false);
      }
      lastY = y;
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [sc, scrollY, viewHeight, scrollHeight]);
  const anchorOn = useCallback((el: HTMLElement) => {
    followRef.current = false;
    pinned.current = false;
    setFollow(false);
    held.current = { el, top: el.getBoundingClientRect().top };
  }, []);
  // Every disclosure in the timeline (a tool's details, "Ran 4 tools", a subagent's
  // block) keeps the row that was clicked where it is: caught on the way down, before the
  // row opens, in one listener for the view.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const row = (e.target as Element | null)?.closest?.(".timeline summary, .timeline .agent-toggle");
      if (row instanceof HTMLElement && root.contains(row)) anchorOn(row);
    };
    root.addEventListener("click", onClick, true);
    return () => root.removeEventListener("click", onClick, true);
  }, [anchorOn, shape]);

  /** Stream and feed events are slim (data cut to a preview); the detail route has the
   *  whole event. Swap one in by its seq. */
  const fillEv = useCallback(
    async (e: StoredEvent) => {
      const d = await store.transport.session(harness, id, { after: e.session.seq - 1, limit: 1 });
      const full = d.events.find((x) => x.session.seq === e.session.seq);
      if (full) setEvents((prev) => prev.map((p) => (p.session.seq === full.session.seq ? full : p)));
    },
    [store, harness, id],
  );

  // A copy of another session (a message sent there went to a fork, CONTROL.md §6): the
  // original, named in the bar, linked.
  const isCopy = useCallback((a: ControlActivity) => forkOf(a) === key, [key]);
  const original = useControlActivity(isCopy)[0]?.session ?? "";
  const originalSummary = useSession(original);
  // The agents this page asked (the handoff sheet's `from`): their rows at the end of the
  // view until the events say what became of them (AskRows).
  const isFromHere = useCallback(
    (a: ControlActivity) => a.from === key && a.session !== key && (a.kind === "prompt" || a.kind === "start"),
    [key],
  );
  const askedFromHere = useControlActivity(isFromHere);

  const s = live ?? summary;
  // The launcher and the runs it launched are subscriptions: a launcher's open page shows a
  // run that starts later, and a run's page finds a launcher that reports later.
  const launcherKey = s?.launchedBy && s.launchedBy !== key ? s.launchedBy : "";
  const launcherSummary = useSession(launcherKey);
  const launchedRuns = useLaunched(key);
  const sRef = useRef(s);
  sRef.current = s;
  useEffect(() => {
    if (s) onSession?.(s);
  }, [s, onSession]);

  // The phone's keyboard: the docked composer rides on it (lib/keyboardInset.ts sets --kb
  // from visualViewport; styles/session.css reads it), so the field and Send are never
  // under the keys.
  useKeyboardInset(mode === "page");

  // The docked bar's height, so a row scrolled into view (a jump, the focused prompt) is
  // never left under it (styles/session.css: scroll-padding-bottom).
  useEffect(() => {
    if (mode !== "page") return;
    const bar = rootRef.current?.querySelector<HTMLElement>(".sess-ctl");
    if (!bar || typeof ResizeObserver !== "function") return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty("--sess-ctl-h", `${Math.round(bar.offsetHeight)}px`));
    ro.observe(bar);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--sess-ctl-h");
    };
  }, [mode, s?.key]);

  const visible = useMemo(
    () => events.map((e) => atTier(e, lens)).filter((e): e is StoredEvent => e !== null),
    [events, lens],
  );
  const agentRuns = s?.agents;
  const turns = useMemo(() => groupTurns(visible, agentRuns), [visible, agentRuns]);
  const hidden = events.length - visible.length;
  // Every loaded event's turns, whatever the lens leaves out: what a sent message joins.
  const allTurns = useMemo(() => (lens >= 3 ? turns : groupTurns(events, agentRuns)), [lens, turns, events, agentRuns]);

  // The New line (lib/newLine.ts). Where the person left off is read as the session first
  // shows, before useSeen marks it read, and only when it was unread then; the line is
  // placed once this session's first page is in and stays put while the page is open.
  // A cold open can have its page before the marks (the stream's snapshot): it waits for
  // them, re-rendered once when they land (useSeen can't move them before either).
  const marksIn = useSyncExternalStore(store.subscribe, () => !!store.get().marks.since);
  const opened = useRef<{ key: string; mark?: string; line?: NewLineAt | null; late?: boolean } | null>(null);
  if (marksIn && s?.key === key && opened.current?.key !== key) {
    const mark = leftOff(s, store.get().marks);
    if (mark !== null) opened.current = { key, mark };
  }
  const first = events[0];
  const pageIn = !loading && !!first && sessionKey(first.harness.name, first.session.id) === key;
  if (pageIn && opened.current?.key === key && opened.current.line === undefined) {
    opened.current.line = newLinePlace(allTurns, opened.current.mark, { attended: s?.attended });
    opened.current.late = !firstPaint.current;
  }
  const newLineSeq = opened.current?.key === key ? opened.current.line?.seq : undefined;
  // Placed after the first paint (the marks came after the page): open on it then, the
  // same way, unless the person has already scrolled away from the bottom.
  useLayoutEffect(() => {
    const o = opened.current;
    if (newLineSeq === undefined || !o?.late) return;
    o.late = false;
    if (followRef.current && pinned.current) toNewLine();
  }, [newLineSeq, toNewLine]);

  // The messages sent from here to this session (its start among them), and the turn each
  // became: the turn shows the words as they were signed (tier 2 sends only a length),
  // the files and, until the turn has a reply of its own, the reply the machine streamed
  // back. One still on its way has its row at the end, where its turn will be.
  const isMine = useCallback(
    (a: ControlActivity) => a.session === key && (a.kind === "prompt" || a.kind === "start") && !forkOf(a),
    [key],
  );
  const sentAll = useControlActivity(isMine);
  const joined = useMemo(
    () =>
      sentTurns(
        sentAll.map((a) => ({
          id: a.id,
          at: a.at,
          takenAt: a.takenAt,
          text: promptParts(a.text ?? "").body,
          start: a.kind === "start",
        })),
        allTurns,
        (t) => promptParts(t).body,
        { fromStart: !hasOlder },
      ),
    [sentAll, allTurns, hasOlder],
  );
  const sentByTurn = useMemo(() => {
    const m = new Map<number, ControlActivity>();
    for (const a of sentAll) {
      const n = joined.get(a.id);
      if (n !== undefined) m.set(n, a);
    }
    return m;
  }, [sentAll, joined]);
  // A just-delivered message keeps its row a while; only then does the view need a clock.
  const holding = sentAll.some((a) => a.outcome === "delivered" && !joined.has(a.id));
  const clockNow = useNow(holding ? "coarse" : "off");
  const pending = useMemo(() => {
    const begun = allTurns.filter((t) => t.start);
    const lastStart = ms(begun[begun.length - 1]?.start?.time);
    return sentAll.filter((a) => !joined.has(a.id) && stillPending(a, lastStart, begun.length > 0, clockNow)).reverse();
  }, [sentAll, joined, allTurns, clockNow]);
  // A pending turn takes the number (and so the key) its real turn will have: the first
  // hook event fills the same block in place.
  const lastN = Math.max(0, ...turns.map((t) => t.n), ...allTurns.map((t) => t.n));
  /** The loaded window ends at the latest turn, so its last turn is turn `counts.turns`. */
  const loadedTurns = turns.filter((t) => t.start).length;
  const turnOffset = Math.max(0, (s?.counts.turns ?? loadedTurns) - loadedTurns);

  const isLive = !!s && (s.state === "working" || s.state === "needs_you");
  // A session this device started: its first turns slide into place as they arrive.
  const fresh = !!started && turns.filter((t) => t.start).length <= 2;
  useFlip(listRef, 12);

  // The machine the session (or the start) runs on.
  const startMachine = started ? machineList.find((m) => m.control?.machineId === started.machineId) : undefined;
  const machineName = s?.machine ?? startMachine?.name ?? "the machine";
  const control = s?.machine ? machines.get(s.machine)?.control : startMachine?.control;

  // The pool at work on this session (UX-SPEC §7.1, §7.2): the account serving it when it
  // is not its own, and each moment it switched, from its own limits.observed events. An
  // account is named as the machine's pool names it, else by its login's email.
  const limits = useLimits();
  const poolAccounts = control?.pool?.accounts;
  const logins = control?.accounts;
  const nameFor = useCallback(
    (id: string | undefined): string | undefined => {
      if (!id) return undefined;
      const pooled = poolAccounts?.find((a) => a.id === id);
      if (pooled) return sentenceName(pooled, poolAccounts);
      const login = logins?.find((a) => a.id === id);
      return login?.email ? sentenceName({ id, email: login.email }) : login?.name;
    },
    [poolAccounts, logins],
  );
  const served = s ? (s.servedBy ?? servedBy(events, s)) : null;
  const swapRows = useMemo(() => {
    if (!s) return [];
    const reports = events.filter((e) => e.type === "limits.observed");
    return swaps(events, s).map((sw) => {
      // Why it left: the last report of the account it left, read at that report's time;
      // failing that, what the hello says of that account now.
      const prior = reports
        .filter((e) => e.session.seq < sw.seq && (e.data?.account_id ?? s.accountId) === sw.from)
        .at(-1);
      const acct = poolAccounts?.find((a) => a.id === sw.from);
      const because =
        (prior ? leftBecause({ entry: { windows: eventWindows(prior) } }, Date.parse(prior.time)) : null) ??
        (acct
          ? leftBecause(
              { status: acct.status, limitedBy: acct.limitedBy, entry: limits.find((e) => e.accountId === sw.from) },
              Date.now(),
            )
          : null);
      return { seq: sw.seq, text: swapWords(nameFor(sw.to) ?? "another account", nameFor(sw.from), because) };
    });
  }, [events, s, poolAccounts, limits, nameFor]);
  // Each switch goes to the turn it fell in: the last turn whose start precedes it.
  const swapNotes = useMemo(() => {
    const by = new Map<number, string[]>();
    for (const sw of swapRows) {
      let home: number | undefined;
      for (const t of turns) if ((t.start?.session.seq ?? -1) <= sw.seq) home = t.n;
      if (home !== undefined) by.set(home, [...(by.get(home) ?? []), sw.text]);
    }
    return by;
  }, [swapRows, turns]);
  const compose = useCallback(
    (text: string) => window.dispatchEvent(new CustomEvent("sp:compose", { detail: { key, text } })),
    [key],
  );

  // The session keys (lib/shortcuts.ts). A view in the panel answers only while it is the
  // active tab; the page's view wins over the panel's unless focus is inside the panel.
  const inert = () => !rootRef.current || !!rootRef.current.closest(".panel-body--off") || !s;
  const click = (sel: string) => {
    if (inert()) return false;
    const el = rootRef.current?.querySelector<HTMLButtonElement>(sel);
    if (!el || el.disabled) return false;
    el.click();
    return true;
  };
  const keyOpts = { within: rootRef, priority: mode === "page" ? 1 : 0 };
  useShortcut("session.allow", () => click(".ctl .btn--allow:not(:disabled)"), keyOpts);
  useShortcut("session.deny", () => click(".ctl .btn--deny:not(:disabled)"), keyOpts);
  useShortcut(
    "session.cancel",
    () => {
      if (inert()) return false;
      const el = rootRef.current?.querySelector<HTMLButtonElement>(".ctl-cancel:not(:disabled)");
      if (!el) return false;
      void askCancel(el);
    },
    keyOpts,
  );
  useShortcut(
    "session.prompt",
    () => {
      if (inert()) return false;
      const ta = rootRef.current?.querySelector<HTMLTextAreaElement>(".ctl textarea:not(:disabled)");
      if (!ta) return false;
      focusPrompt(ta);
    },
    keyOpts,
  );
  useShortcut("session.follow", () => (inert() || !isLive ? false : setFollowing(!followRef.current)), keyOpts);
  useShortcut(
    "session.openPage",
    () => (inert() || mode === "page" ? false : navigate(sessionPath(harness, id))),
    keyOpts,
  );
  useShortcut("session.older", () => (inert() || !hasOlder || olderBusy ? false : void loadOlder()), keyOpts);
  // The "n new" pill's way back, from the keyboard.
  useShortcut("session.latest", () => (inert() ? false : setFollowing(true)), keyOpts);
  // ⇧A: the strip's "Ask another agent…" (the Handoff sheet), where the strip offers it.
  useShortcut("session.ask", () => click("[data-ctl-ask]:not(:disabled)"), keyOpts);
  // ⌥⌘1 … ⌥⌘7 label this session, ⌥⌘0 clears it.
  useLabelKeys(() => (inert() ? [] : [key]), keyOpts);

  const path = sessionPath(harness, id);
  const followItem = (): MenuItem | null =>
    isLive
      ? {
          label: "Follow the live turn",
          action: "session.follow",
          checked: follow,
          run: () => setFollowing(!followRef.current),
        }
      : null;
  // The empty space of the view: how it shows, not what it shows.
  const bgMenu = useContextMenu(
    () => [
      followItem(),
      hasOlder && {
        label: "Older turns",
        action: "session.older",
        disabled: olderBusy || undefined,
        run: () => void loadOlder(),
      },
      { sep: true },
      !chat && lensMenu(lens),
      { sep: true },
      ((send) => send && { ...send, label: "Focus the prompt" })(controlItems(rootRef.current).send),
      mode === "panel" && { label: "Open as page", action: "session.openPage", run: () => navigate(path) },
    ],
    { title: () => (sRef.current ? sessionTitle(sRef.current) : "Session") },
  );
  // The docked bar: the answers and the strip's own actions, never the view's options.
  const ctlMenu = useContextMenu(() => {
    const cur = sRef.current;
    if (!cur) return null;
    const { send, cancel } = controlItems(rootRef.current);
    return [...answerItems(rootRef.current, cur), { sep: true }, send, cancel];
  });

  const timeline = useMemo<Timeline>(
    () => ({
      path,
      open: new Set((s?.openAttentions ?? []).map((a) => a.attentionId)),
      working: s?.state === "working",
      root: rootRef,
      session: () => sRef.current,
      agents: agentRuns ?? [],
      focus: shownAgent ?? focusAgent,
      showAgent,
      mode,
      machine: machineName,
      online: control?.online ?? false,
      control,
      compose,
      anchorOn,
    }),
    [
      path,
      s?.openAttentions,
      s?.state,
      agentRuns,
      shownAgent,
      focusAgent,
      showAgent,
      mode,
      machineName,
      control,
      compose,
      anchorOn,
    ],
  );

  // The composer arrives once the session does: it slides in under a page that was
  // starting, and is simply there on an ordinary open.
  const wasStarting = useRef(!s && !!started);
  if (!s && started) wasStarting.current = true;

  if (shape === "loading") return <SessionLoading mode={mode} rootRef={rootRef} />;
  if (shape === "missing") {
    // The receiver's "not_found" is the ordinary missing session, said in words; any other
    // failure is named as it came.
    const failed = error && !/^(not_found|404\b)/.test(error) ? error : null;
    const none = (
      <div className={`page session ${mode === "panel" ? "session--panel" : ""}`} ref={rootRef}>
        {mode === "page" && <PageBar title="Session" back={<BackButton onClick={() => back("/")} />} large={false} />}
        <div className="state state--center">
          <h2 className="state-title">{failed ? "This session didn't load" : "No such session here"}</h2>
          <p className="state-text">
            {failed ?? "This receiver holds nothing for it: it was forgotten, or never arrived."}
          </p>
          <div className="state-actions">
            <Link to="/" className="btn">
              Back to the board
            </Link>
          </div>
        </div>
      </div>
    );
    // Not on the receiver: this machine's own agent history may hold it (search/History.tsx).
    return failed ? none : <HistoryOrMissing harness={harness} id={id} mode={mode} rootRef={rootRef} fallback={none} />;
  }

  const kids = s ? (children.length ? children : childrenFromStore(store, key)) : [];
  // The session's own title once it has one; until then a start's first message, never
  // the folder's name.
  const title = s?.title?.trim() ? sessionTitle(s) : (startTitle(started) ?? (s ? sessionTitle(s) : "New session"));
  const startState: SessionState = !started?.outcome ? "idle" : isFinal(started) ? "idle" : "working";
  const copyOf = original
    ? {
        path: sessionPath(splitKey(original).harness, splitKey(original).id),
        title: originalSummary ? sessionTitle(originalSummary) : "another session",
      }
    : undefined;
  // A launcher this receiver never saw is named by its key, so it can be looked up elsewhere.
  const launcher = launcherKey
    ? launcherSummary
      ? { path: sessionPath(launcherSummary.harness, launcherSummary.id), title: sessionTitle(launcherSummary) }
      : { path: null, title: launcherKey }
    : undefined;
  const launched = launchedRuns.map((l) => ({
    path: sessionPath(l.harness, l.id),
    title: sessionTitle(l),
    at: l.startedAt,
  }));

  // The session's "⋯", in three sections at most: what it can be asked now (Allow, Deny,
  // a message, Stop), how the view shows and what it is (Follow, the lens, its own
  // items), then Forget, last on its own.
  const pageMenu = (): MenuList => {
    if (!s)
      return started ? [{ label: "Edit and start again", run: () => editAgain(started, startMachine?.name) }] : [];
    const { send, cancel } = controlItems(rootRef.current);
    const own = sessionItems(s, { store, surface: mode, children: kids, onForgotten }).filter((i) => !("sep" in i));
    return tidy([
      ...answerItems(rootRef.current, s),
      send,
      cancel,
      { sep: true },
      followItem(),
      !chat && lensMenu(lens),
      ...own,
    ]);
  };

  const flags = !chat && s?.flags?.length ? s.flags : null;
  const applied = appliedFact(started);
  const waiting = s ? backgroundFact(s) : null;
  const folder = started?.cwd ? tildify(started.cwd, machineHome(control)) : undefined;
  // The timeline's rows: the loaded turns, each with the message sent from here that
  // became it, then the messages still on their way.
  // A "Session" group that only says the session started tells nothing the title band
  // does not (its time is in the meta's tooltip), and arriving a beat after the first
  // turn it pushed that turn down: the started moment held still but for it.
  const onlyStarted = (t: Turn) =>
    t.n === 0 &&
    !hasOlder &&
    t.items.length > 0 &&
    t.items.every(
      (i) =>
        i.kind === "event" &&
        i.e.type === "session.started" &&
        ["", "startup", undefined].includes(i.e.data?.source as string | undefined),
    );
  const rows = [
    ...turns.filter((t) => !onlyStarted(t)).map((t) => ({ t, sent: sentByTurn.get(t.n), pending: false })),
    ...pending.map((a, i) => ({
      t: { n: lastN + 1 + i, items: [] } as Turn,
      sent: a as ControlActivity | undefined,
      pending: true,
    })),
  ];

  return (
    <TimelineCtx.Provider value={timeline}>
      <CodeFrame.Provider value={CodeWell}>
        <div
          className={`page session ${mode === "panel" ? "session--panel" : ""} ${chat ? "session--chat" : ""} ${s ? "" : "starting"}`}
          ref={rootRef}
          data-ui={chat ? "simple" : "advanced"}
          data-starting={
            !s && started
              ? started.outcome === "taken" && started.reply !== undefined
                ? "progress"
                : (started.outcome ?? "queued")
              : undefined
          }
          {...bgMenu}
        >
          {mode === "page" && (
            <PageBar
              back={<BackButton onClick={() => back("/")} />}
              title={
                <>
                  <StateDot state={s?.state ?? startState} />
                  {s && <BarLabel s={s} />}
                  <span className="sess-title-text">{title}</span>
                </>
              }
              titleClassName="sess-title"
              large={false}
              className="sess-bar"
              meta={
                s ? (
                  <>
                    <SessionMeta
                      s={s}
                      total={total}
                      copyOf={copyOf}
                      launcher={launcher}
                      launched={launched}
                      chat={chat}
                    />
                    {applied && <span className="sess-applied">{applied}</span>}
                  </>
                ) : (
                  <>
                    <span className="sess-where">
                      {[machineName, harnessMark(harness).label, folder].filter(Boolean).join(" · ")}
                    </span>
                    {applied && <span className="sess-applied">{applied}</span>}
                  </>
                )
              }
              actions={<MoreButton build={pageMenu} title={() => title} />}
            />
          )}

          {!chat && s && lens < 3 && <LensTools lens={lens} hidden={hidden} maxTier={s.maxTier} />}
          {flags && (
            <p className="page-note sess-flags">
              {flags.map((f) => (
                <span key={f.kind} className={f.kind === "error_streak" ? "is-err" : undefined}>
                  {f.detail}
                </span>
              ))}
            </p>
          )}
          {served && s && (
            <p className="page-note sess-served" data-served>
              <span>
                Served by{" "}
                <a
                  href={`${hrefFor("/usage")}#${encodeURIComponent(`pool:${machineName}`)}`}
                  onClick={(ev) => {
                    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
                    ev.preventDefault();
                    openUsage(`pool:${machineName}`);
                  }}
                >
                  {nameFor(served.accountId) ?? "another account"}
                </a>{" "}
                since{" "}
                <time
                  className="num"
                  dateTime={served.since}
                  title={new Date(served.since).toLocaleString([], { hourCycle: "h23" })}
                >
                  {clockTime(served.since)}
                </time>
              </span>
            </p>
          )}
          {error && s && events.length > 0 && <p className="page-note is-err">{error}</p>}
          {waiting && (
            <p className="page-note sess-waiting">
              {waiting.replace(/^w/, "W")}; each one wakes the session when it finishes.
            </p>
          )}
          {optionsIgnored(started) && (
            <p className="page-note">
              {machineName} ran this at its own mode; its sessionpipe ignores per-session options.
            </p>
          )}

          <ol className={`timeline ${chat ? "timeline--chat" : ""}`} ref={listRef}>
            {hasOlder && (
              <li className="older">
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => void loadOlder()}
                  disabled={olderBusy}
                >
                  {olderBusy ? "Loading…" : `Older turns · ${Math.max(0, total - events.length)} earlier events`}
                </button>
              </li>
            )}
            {rows.map(({ t, sent, pending: p }) => (
              <TurnBlock
                key={t.n}
                turn={t}
                newLine={
                  newLineSeq !== undefined && t.items.some((i) => i.kind === "event" && i.e.session.seq === newLineSeq)
                }
                sent={sent}
                pending={p}
                flip={fresh}
                swaps={swapNotes.get(t.n)}
                label={
                  t.n === 0
                    ? hasOlder
                      ? turnOffset > 0
                        ? `Turn ${turnOffset}, continued`
                        : "Earlier"
                      : "Session"
                    : `Turn ${t.n + turnOffset}`
                }
                lens={lens}
                liveTurn={!p && !!s?.currentTurn && t === turns[turns.length - 1]}
                fill={fillEv}
                chat={chat}
                harness={s?.harness ?? harness}
              />
            ))}
            {s && <AskRows sent={askedFromHere} delegations={s.delegations ?? []} chat={chat} />}
            {!loading && s && visible.length === 0 && rows.length === 0 && (
              <li className="page-note">No events at this tier.</li>
            )}
            {/* A chat with nothing said yet (only the session's start): say so where the
                first message will land, rather than leave the column blank. */}
            {chat &&
              !loading &&
              s &&
              !hasOlder &&
              visible.length > 0 &&
              pending.length === 0 &&
              turns.every((t) => t.n === 0) && (
                <li className="state">
                  <h2 className="state-title">No messages yet</h2>
                  <p className="state-text">What you and the agent say shows here as it happens.</p>
                </li>
              )}
          </ol>

          {s && (
            <div
              className={`sess-ctl ${chat ? "sess-ctl--chat" : ""} ${wasStarting.current ? "sess-ctl--arrive" : ""}`}
              {...ctlMenu}
            >
              {unseen > 0 && away && (
                <button type="button" className="sess-new" onClick={() => setFollowing(true)}>
                  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                    <path
                      d="M6 2.5v7M3 6.5l3 3 3-3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="num">{unseen > 99 ? "99+" : unseen}</span> new
                </button>
              )}
              <SessionControl session={s} control={control} attentions={s.openAttentions} chat={chat} />
            </div>
          )}
        </div>
      </CodeFrame.Provider>
    </TimelineCtx.Provider>
  );
}

/** A reply's fenced block, with its own menu. */
function CodeWell({ text, children }: { text: string; children: ReactNode }) {
  const menu = useContextMenu(() => [copyItem("Copy code", text)]);
  return (
    <div className="md-pre" {...menu}>
      {children}
    </div>
  );
}

/** The bar's meta, two facts in one muted tier: where it runs (machine · repo). The state
 *  is the glyph before the title; the model, the age, the counts and the tier are the
 *  meta's tooltip. A copy of another session names its original instead of the repo. */
function SessionMeta({
  s,
  total,
  copyOf,
  launcher,
  launched,
  chat,
}: {
  s: SessionSummary;
  total: number;
  /** This session is a copy (a fork) of that one. */
  copyOf?: { path: string; title: string };
  /** The session that launched this one (`session.launched_by`); no path when this receiver never saw it. */
  launcher?: { path: string | null; title: string };
  /** Sessions this one launched. */
  launched?: { path: string; title: string; at: string }[];
  chat: boolean;
}) {
  const repo = chat ? repoShort(s.repo) : repoBranch(s);
  const place = repo || (s.cwd ? basename(s.cwd) : "");
  const fact = agentsFact(s);
  // Asked by another session (sessionpipe ask, a handoff): that session, named and linked,
  // first; a `delegatedBy` session is not a subagent, so "for" never meets "parent".
  const parent = useSession(s.delegatedBy ?? "");
  const askedBy = s.delegatedBy ? splitKey(s.delegatedBy) : null;
  const more = [
    STATE_LABEL[s.state],
    fact,
    askingFact(s),
    s.attended === false && "unattended",
    s.model && modelShort(s.model),
    `started ${new Date(s.startedAt).toLocaleString([], { hourCycle: "h23" })}`,
    plural(s.counts.turns, "turn"),
    plural(s.counts.tools, "tool"),
    s.counts.toolErrors > 0 && plural(s.counts.toolErrors, "error"),
    s.counts.filesChanged > 0 && plural(s.counts.filesChanged, "file"),
    s.counts.subagents > 0 && plural(s.counts.subagents, "subagent"),
    s.counts.compactions > 0 && plural(s.counts.compactions, "compaction"),
    plural(total, "event"),
    `arrived at tier ${s.maxTier}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const first = launched?.[0];
  return (
    <span className="sess-where" title={more} data-events={total}>
      {askedBy && (
        <span className="sess-for">
          for{" "}
          <Link to={sessionPath(askedBy.harness, askedBy.id)} title={parent ? sessionTitle(parent) : s.delegatedBy}>
            {parent ? sessionTitle(parent) : `a ${harnessMark(askedBy.harness).label} session`}
          </Link>
        </span>
      )}
      {s.machine && <span className="sess-machine">{s.machine}</span>}
      {copyOf ? (
        <span className="sess-copy">
          Copy of <Link to={copyOf.path}>{copyOf.title}</Link>
        </span>
      ) : (
        place && <span className="sess-repo">{place}</span>
      )}
      {launcher && (
        <span className="sess-copy sess-launch">
          Launched by{" "}
          {launcher.path ? (
            <Link to={launcher.path} title={launcher.title}>
              {launcher.title}
            </Link>
          ) : (
            <span title={launcher.title}>{launcher.title}</span>
          )}
        </span>
      )}
      {launched && first && (
        <span className="sess-copy sess-launch">
          Launched{" "}
          {launched.length === 1 ? (
            <Link to={first.path} title={first.title}>
              {first.title}
            </Link>
          ) : (
            <MoreButton
              className="sess-launched"
              label={`${launched.length} launched sessions`}
              title={() => `Launched ${launched.length} sessions`}
              build={() => {
                // Newest first, each with when it started (a script's runs share a title); the
                // twelve newest, then a line for the rest.
                const now = Date.now();
                const shown = launched.slice(0, 12);
                return [
                  ...shown.map((l) => ({ label: `${l.title} · ${ago(l.at, now)}`, run: () => navigate(l.path) })),
                  launched.length > shown.length && {
                    label: `${launched.length - shown.length} more, older`,
                    run: () => {},
                    disabled: "The newest twelve are listed",
                  },
                ];
              }}
            >
              {launched.length} sessions
            </MoreButton>
          )}
        </span>
      )}
    </span>
  );
}

/** The tier lens while it hides something (Advanced): one quiet line over the timeline
 *  with the segmented control Settings has, what it takes away, and Show all. At
 *  "everything" it is gone; the lens is then in "⋯" and on `l`. */
function LensTools({ lens, hidden, maxTier }: { lens: Tier; hidden: number; maxTier: Tier }) {
  return (
    <div
      className="lens sess-lens"
      title={`${TIER_HINT[lens]}${lens > maxTier ? ` · arrived at tier ${maxTier}` : ""}`}
    >
      <span className="lens-label sr-only">Tier lens</span>
      <Segmented<Tier>
        value={lens}
        onChange={(t) => setTierLens(t)}
        label="Tier lens"
        options={([0, 1, 2, 3] as Tier[]).map((t) => ({
          value: t,
          label: String(t),
          title: `${TIER_LABEL[t]}: ${TIER_HINT[t]}`,
        }))}
      />
      <span className="lens-hint">
        {cap(TIER_LABEL[lens])}
        {hidden > 0 ? <span className="num"> · {hidden} hidden</span> : null}
      </span>
      <button type="button" className="btn btn--sm btn--ghost lens-all" onClick={() => setTierLens(null)}>
        Show all
      </button>
    </div>
  );
}

/** Children straight from the live store, for when the detail call has not answered yet. */
function childrenFromStore(store: ReturnType<typeof useStore>, key: string): SessionSummary[] {
  const out: SessionSummary[] = [];
  const { harness, id } = { harness: key.slice(0, key.indexOf(":")), id: key.slice(key.indexOf(":") + 1) };
  for (const s of store.get().sessions.values()) if (s.harness === harness && s.parentId === id) out.push(s);
  return out;
}

type Fill = (e: StoredEvent) => Promise<void>;

/** The first timeline row of this view whose top edge is on screen (below the bar and a
 *  stuck turn head), by seq. Turn heads are sticky, so they never anchor. */
function firstVisibleRow(root: HTMLElement | null, scroller: HTMLElement | null): { seq: number | null; top: number } {
  if (!root) return { seq: null, top: 0 };
  const bar = root.querySelector(".bar")?.getBoundingClientRect().bottom ?? scroller?.getBoundingClientRect().top ?? 0;
  const headerBottom = bar + 28;
  for (const el of root.querySelectorAll<HTMLElement>("[data-seq]:not(.turn-head)")) {
    const top = el.getBoundingClientRect().top;
    if (top >= headerBottom) return { seq: Number(el.dataset.seq), top };
  }
  return { seq: null, top: 0 };
}

function TurnBlock({
  turn,
  lens,
  liveTurn,
  fill,
  label,
  chat = false,
  harness = "",
  sent,
  pending = false,
  flip = false,
  newLine = false,
  swaps,
}: {
  turn: Turn;
  lens: Tier;
  liveTurn: boolean;
  fill: Fill;
  label: string;
  /** Simple mode: the turn as a chat exchange (see ChatTurn). */
  chat?: boolean;
  harness?: string;
  /** The message sent from here that this turn is (or will be). */
  sent?: ControlActivity;
  /** No event of this turn has arrived yet: the message is on its way. */
  pending?: boolean;
  /** Slide into place as the turns around it arrive (a session started here). */
  flip?: boolean;
  /** The first answer since the person last looked: the New line sits above it. */
  newLine?: boolean;
  /** The pool switched accounts during this turn: one quiet row each (UX-SPEC §7.2). */
  swaps?: string[];
}) {
  // Only a running turn or a running tool shows a moving duration; the other blocks
  // (most of the page) have nothing to redraw each second.
  const hasRunningTool = turn.items.some(
    (i) => (i.kind === "tool" && !i.ended) || (i.kind === "agent" && i.tools.some((t) => !t.ended)),
  );
  const now = useNow(liveTurn || hasRunningTool ? "fine" : "off");
  const { machine, online, control, compose, session } = useTimeline();
  const transcript = [...turn.items].reverse().find((i) => i.kind === "event" && i.e.type === "turn.transcript") as
    | EventItem
    | undefined;
  const progress = transcript
    ? undefined
    : ([...turn.items].reverse().find((i) => i.kind === "event" && i.e.type === "turn.progress") as
        | EventItem
        | undefined);
  const ended = turn.items.find((i) => i.kind === "event" && i.e.type === "turn.ended") as EventItem | undefined;
  const prompt = (transcript?.e.data.user as string | undefined) ?? (progress?.e.data.user as string | undefined);
  const promptChars = turn.start?.data.prompt_chars as number | undefined;
  const startMs = ms(turn.start?.time);
  const endMs = ms(ended?.e.time);
  const elapsed = ended
    ? ((ended.e.data.ms as number | undefined) ?? endMs - startMs)
    : liveTurn
      ? now - startMs
      : undefined;
  const startSeq = turn.start?.session.seq;
  // Claude Code's own follow-up when a background agent stops: not a person's prompt.
  const notice = taskNotification(prompt);
  // An answer a handoff brought back (CONTROL.md §6): the asked agent's words, not the
  // person's, but only once the events say a handoff was relayed here (a prompt anyone
  // writes can wear the frame; without the delegation it shows as the message it is).
  const framed = prompt ? handoffAnswer(prompt) : undefined;
  const answer =
    framed && relayedFrom(session()?.delegations, framed.harness, turn.start?.time ?? sent?.at) ? framed : undefined;
  // What the machine said of the message sent from here: its failure, in place; while
  // it is on its way (or the agent is at it with nothing to show yet) the one status row.
  const failed = !!sent && isFinal(sent) && sent.outcome !== "delivered";
  const ownReply = String((transcript ?? progress)?.e.data.assistant ?? "").trim();
  const ackReply = sent?.reply?.trim() && !ownReply ? sent.reply : undefined;
  const status = (() => {
    if (!sent || failed) return null;
    if (pending) return sentRow(sent, { machine, online });
    if (liveTurn && !ended)
      return {
        text: "Running",
        since: sent.takenAt ?? turn.start?.time,
        spinning: true,
        tip: undefined,
        state: "running",
      };
    return null;
  })();
  const failure = failed && sent ? <SentFailure a={sent} machine={machine} control={control} onEdit={compose} /> : null;

  if (chat)
    return (
      <ChatTurn
        turn={turn}
        lens={lens}
        liveTurn={liveTurn}
        fill={fill}
        now={now}
        harness={harness}
        prompt={prompt}
        notice={notice?.agentId}
        answer={answer}
        promptChars={promptChars}
        transcript={transcript}
        progress={progress}
        ended={ended}
        sent={sent}
        pending={pending}
        ackReply={ackReply}
        status={status}
        failure={failure}
        flip={flip}
        newLine={newLine}
        swaps={swaps}
      />
    );

  const endReason = ended ? String(ended.e.data.reason ?? "stop") : undefined;
  const endErr = endReason === "error";
  const items = turn.items.filter(
    (it) => !(it.kind === "event" && (it.e.type === "turn.progress" || it.e.type === "turn.ended")),
  );
  return (
    <li
      className={`turn ${liveTurn || (pending && !failed) ? "turn--live" : ""} ${turn.n === 0 ? "turn--pre" : ""}`}
      data-flip={flip ? String(turn.n) : undefined}
    >
      <TurnHead
        label={label}
        start={turn.start}
        at={turn.start?.time ?? sent?.at}
        elapsed={elapsed}
        running={(liveTurn && !ended) || (pending && !!sent && !isFinal(sent))}
        reason={endReason && endReason !== "stop" && !endErr ? endReason : undefined}
        error={endErr ? String(ended?.e.data.error ?? "the turn ended with an error") : undefined}
      />
      {turn.start ? (
        notice ? (
          <AgentNotice agentId={notice.agentId} seq={startSeq} />
        ) : prompt ? (
          <Prompt text={prompt} seq={startSeq} by={submittedLabel(turn.start.data.submitted_by)} />
        ) : sent?.text ? (
          <Prompt text={sent.text} seq={startSeq} sent={sent} />
        ) : (
          <p className="prompt prompt--hidden" title={PROMPT_KEPT}>
            <PromptKept chars={promptChars} />
          </p>
        )
      ) : pending && sent?.text ? (
        <Prompt text={sent.text} sent={sent} />
      ) : null}
      <ol className="turn-items">
        {items.length === 0 && status && <StatusRow {...status} chat={false} />}
        {items.map((it) => {
          if (it.kind === "tool") return <ToolRow key={it.key} item={it} lens={lens} now={now} fill={fill} />;
          if (it.kind === "agent") return <AgentBlock key={it.key} item={it} lens={lens} now={now} fill={fill} />;
          if (it.kind === "delegation") return <AskRow key={it.key} item={it} as="li" />;
          const e = it.e;
          if (e.type === "turn.transcript") {
            if (it !== transcript) return null;
            const reply = <Reply key={it.key} e={e} turnSeq={startSeq} fill={fill} />;
            return newLine ? (
              <Fragment key={it.key}>
                <NewLine />
                {reply}
              </Fragment>
            ) : (
              reply
            );
          }
          if (e.type === "attention.needed") return <AttentionMarker key={it.key} e={e} />;
          if (e.type === "subagent.started" || e.type === "subagent.ended") return <AgentMarker key={it.key} e={e} />;
          return <EventMarker key={it.key} e={e} />;
        })}
        {newLine && !transcript && <NewLine />}
        {progress && String(progress.e.data.assistant ?? "").trim() && (
          <Reply e={progress.e} turnSeq={startSeq} fill={fill} live />
        )}
        {ackReply && <AckReply text={ackReply} live={!!sent && !isFinal(sent)} />}
        {swaps?.map((text) => (
          <li key={text} className="marker marker--swap" data-swap>
            <Lead />
            <span className="marker-body">
              <span>{text}</span>
            </span>
          </li>
        ))}
        {endErr && ended && <EndMarker e={ended.e} />}
        {failure && <li className="turn-failed">{failure}</li>}
      </ol>
    </li>
  );
}

/** A turn's section head: its number, then trailing how long it ran (and why it stopped,
 *  when that was not the usual end); when it started shows on hover. Sticky under the
 *  bar, so the turn a row belongs to is always in sight. The "Turn ended" row it used to
 *  be followed by is this head's duration now. */
function TurnHead({
  label,
  start,
  at,
  elapsed,
  running,
  reason,
  error,
}: {
  label: string;
  start?: StoredEvent;
  /** When it began: its first event, or when the message was sent. */
  at?: string;
  elapsed?: number;
  running: boolean;
  /** How it stopped, when not the usual way ("interrupted"). */
  reason?: string;
  /** It ended with an error: the ✕ beside the duration, the words in its row below. */
  error?: string;
}) {
  const { path } = useTimeline();
  const seq = start?.session.seq;
  const menu = useContextMenu(() => [
    copyItem("Copy link to this turn", seqLink(path, seq)),
    at && copyItem("Copy time", at),
  ]);
  return (
    <header className="turn-head" data-seq={seq} {...menu}>
      <span className="turn-n">{label}</span>
      {running && <Spinner label="turn running" />}
      <span className="turn-facts num">
        {at && (
          <time className="turn-time" dateTime={at} title={new Date(at).toLocaleString([], { hourCycle: "h23" })}>
            {clock(at).slice(0, 5)}
          </time>
        )}
        {reason && <span className="turn-reason">{reason.replace(/_/g, " ")}</span>}
        {error && (
          <span className="turn-err" role="img" aria-label="ended with an error" title={error}>
            <ErrGlyph />
          </span>
        )}
        {elapsed !== undefined && <span className="turn-dur meta-col">{dur(elapsed)}</span>}
      </span>
    </header>
  );
}

/** The small ✕ that is an error's one signal in a row: red, 10 px, in the glyph column. */
function ErrGlyph() {
  return (
    <svg className="err-glyph" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** The person's prompt: a well in the timeline, a bubble in the chat. A message sent from
 *  here keeps the files it carried as chips under it. A start's first message is the
 *  session's first bubble in both modes (the started moment is one surface). */
function Prompt({
  text,
  seq,
  bubble = false,
  sent,
  by,
}: {
  text: string;
  seq?: number;
  bubble?: boolean;
  sent?: ControlActivity;
  /** Who submitted the turn, when the harness said it was not the person ("Scheduled"). */
  by?: string;
}) {
  const { path, root, machine } = useTimeline();
  // A message sent through sessionpipe arrives framed ("Message via … (sessionpipe
  // control, …):"); the words show as written, and where they came from as a quiet line.
  // A question another session asked (sessionpipe ask) says who asked under it; an answer
  // a handoff brought back shows raw here (the chat draws it as the agent's turn).
  const { text: words, via, askedBy } = unframe(text);
  const answer = bubble ? undefined : handoffAnswer(text);
  const menu = useContextMenu(() => [
    copyItem("Copy message", words),
    copyItem("Copy link to this turn", seqLink(path, seq)),
    { sep: true },
    controlItems(root.current).send,
  ]);
  const cls = bubble ? "chat-bubble" : sent?.kind === "start" ? "prompt chat-bubble" : "prompt";
  return (
    <>
      <blockquote className={cls} data-start-message={sent?.kind === "start" ? "" : undefined} {...menu}>
        <PromptBody text={words} />
        {via && <span className="prompt-via">Sent from {via}</span>}
        {askedBy && (
          <span className="prompt-via">
            Asked by {harnessMark(splitKey(askedBy).harness).label} with sessionpipe ask
          </span>
        )}
        {answer && (
          <span className="prompt-via">
            answer from {harnessMark(answer.harness).label}, brought back by {machine}
          </span>
        )}
        {by && <span className="prompt-via">{by}</span>}
      </blockquote>
      <SentFiles files={sent?.files} />
    </>
  );
}

/** The reply the machine streamed back with its acks, for a turn that has no reply event
 *  of its own yet: rendered as the reply will be, in the same place. */
function AckReply({ text, live, chat = false }: { text: string; live: boolean; chat?: boolean }) {
  const { session } = useTimeline();
  const store = useStore();
  const menu = useContextMenu(() => {
    const s = session();
    return [
      copyItem("Copy reply", text),
      s && askItem(s, store, { label: "Ask another agent about this…", reply: text }),
    ];
  });
  if (chat)
    return (
      <div className="chat-card" {...menu}>
        <Markdown text={text} />
      </div>
    );
  return (
    <li className={`reply ${live ? "reply--live" : ""}`} {...menu}>
      <Markdown text={text} />
    </li>
  );
}

/** The assistant's text as markdown: plain prose, no box. `live` while it is still arriving. */
function Reply({
  e,
  turnSeq,
  fill,
  live = false,
  chat = false,
}: {
  e: StoredEvent;
  turnSeq?: number;
  fill: Fill;
  live?: boolean;
  chat?: boolean;
}) {
  const { path, session } = useTimeline();
  const store = useStore();
  const text = String(e.data.assistant ?? "");
  const cut = e.preview?.assistant !== undefined;
  const menu = useContextMenu(() => {
    const s = session();
    return [
      copyItem(cut ? "Copy reply (preview)" : "Copy reply", text),
      copyItem("Copy link to this turn", seqLink(path, turnSeq ?? e.session.seq)),
      // The Handoff sheet prefilled with this reply, not the last one.
      s &&
        askItem(s, store, { label: "Ask another agent about this…", reply: text, turnSeq: turnSeq ?? e.session.seq }),
      cut && { sep: true },
      cut && { label: "Load full text", run: () => fill(e) },
    ];
  });
  if (chat)
    return (
      <div className="chat-card" data-seq={e.session.seq} {...menu}>
        <Markdown text={text} />
        <Cut e={e} field="assistant" fill={fill} />
      </div>
    );
  return (
    <li className={`reply ${live ? "reply--live" : ""}`} data-seq={e.session.seq} {...menu}>
      <Markdown text={text} />
      <Cut e={e} field="assistant" fill={fill} />
    </li>
  );
}

/** The 16 px glyph column every timeline row starts with. When a row happened is its
 *  turn head's (on hover) and its menu's "Copy time", not a column on every row. */
function Lead({ children }: { children?: ReactNode }) {
  return <span className="marker-glyph">{children}</span>;
}

/** The raw event, for the menus: "Copy event" and "Copy time". */
const eventCopy = (e: StoredEvent): MenuList => [
  copyItem("Copy event", JSON.stringify(e, null, 2)),
  copyItem("Copy time", e.time),
];

/** A prompt the agent raised: the orange glyph in the gutter (no stripe), the kind and the
 *  message. While it is the open one, its menu answers it. */
function AttentionMarker({ e }: { e: StoredEvent }) {
  const { open, root, session } = useTimeline();
  const kind = String(e.data.kind);
  const id = typeof e.data.attention_id === "string" ? e.data.attention_id : undefined;
  const isOpen = !!id && open.has(id);
  const message = typeof e.data.message === "string" ? e.data.message : undefined;
  const tool = typeof e.data.tool === "string" ? e.data.tool : undefined;
  // The tool is named beside the message, so a message that starts with it drops it.
  const shown = attentionMessage({ message, tool });
  const menu = useContextMenu(() => {
    const s = session();
    return [
      ...(isOpen && s ? answerItems(root.current, s, id) : []),
      { sep: true },
      copyItem("Copy message", message),
      ...eventCopy(e),
    ];
  });
  return (
    <li className={`marker marker--attn ${isOpen ? "is-open" : ""}`} data-seq={e.session.seq} title={e.type} {...menu}>
      <Lead>
        <StateDot state={isOpen ? "needs_you" : "idle"} size={10} decorative />
      </Lead>
      <span className="marker-body">
        <span className="marker-kind">{cap(ATTENTION_LABEL[kind] ?? kind)}</span>
        {tool && <span className="marker-tool">{toolLabel(tool)}</span>}
        {shown && (
          <span className="marker-msg">
            <Redacted text={shown} />
          </span>
        )}
      </span>
    </li>
  );
}

/** A subagent.started / .ended the timeline could not put in an agent's block (it named
 *  no agent): a quiet marker, as it came. */
function AgentMarker({ e }: { e: StoredEvent }) {
  const menu = useContextMenu(() => eventCopy(e));
  return (
    <li className="marker marker--agent" data-seq={e.session.seq} title={e.type} {...menu}>
      <Lead>
        <span className="marker-tree" aria-hidden="true">
          ↳
        </span>
      </Lead>
      <span className="marker-body">
        <span>
          {cap(String(e.data.agent_type ?? "subagent"))} {e.type === "subagent.started" ? "started" : "ended"}
        </span>
      </span>
    </li>
  );
}

/** A turn that ended with an error: the one end worth its own row (the head carries the
 *  duration of every other end), its words after the red ✕. */
function EndMarker({ e }: { e: StoredEvent }) {
  const err = e.data.error as string | undefined;
  const menu = useContextMenu(() => eventCopy(e));
  return (
    <li className="marker marker--end is-err" data-seq={e.session.seq} title={e.type} {...menu}>
      <Lead>
        <ErrGlyph />
      </Lead>
      <span className="marker-body">
        <span className="marker-msg">
          {err ? `The turn ended with an error: ${err}` : "The turn ended with an error"}
        </span>
      </span>
    </li>
  );
}

/** Any other event, in words ("Session started", "Changed handler.ts"); the raw type is
 *  the row's tooltip, the event itself in "Copy event". */
function EventMarker({ e }: { e: StoredEvent }) {
  const menu = useContextMenu(() => eventCopy(e));
  const w = eventWords(e);
  return (
    <li className={`marker marker--${e.type.split(".")[0]}`} data-seq={e.session.seq} title={e.type} {...menu}>
      <Lead />
      <span className="marker-body">
        <span className="marker-text">{w.text}</span>
        {w.detail && (
          <span className="marker-msg">
            <Redacted text={w.detail} />
          </span>
        )}
      </span>
    </li>
  );
}

type Status = ReturnType<typeof sentRow>;

/** One turn as a chat exchange (Simple mode): the person's prompt as a bubble on the
 *  right (when it was sent shows on hover), then under the harness's mark and name the
 *  turn's tools folded into one quiet line ("Ran 4 tools"), and the reply as plain
 *  prose. The open permission is the docked bar's, so it is not repeated here; an
 *  answered one is a quiet note. While the agent works, one "Running · 12 s" row; a
 *  message on its way, its status row in the same place. */
function ChatTurn({
  turn,
  lens,
  liveTurn,
  fill,
  now,
  harness,
  prompt,
  notice,
  answer,
  promptChars,
  transcript,
  progress,
  ended,
  sent,
  pending,
  ackReply,
  status,
  failure,
  flip,
  newLine = false,
  swaps,
}: {
  turn: Turn;
  lens: Tier;
  liveTurn: boolean;
  fill: Fill;
  now: number;
  harness: string;
  prompt: string | undefined;
  /** The agent a `<task-notification>` prompt reports on: a quiet line, not a bubble. */
  notice?: string;
  /** The prompt is an answer a handoff brought back: the asked agent's turn, not a bubble. */
  answer?: HandoffAnswer;
  promptChars: number | undefined;
  transcript: EventItem | undefined;
  progress: EventItem | undefined;
  ended: EventItem | undefined;
  sent?: ControlActivity;
  pending: boolean;
  ackReply?: string;
  status: Status;
  failure: ReactNode;
  flip: boolean;
  newLine?: boolean;
  swaps?: string[];
}) {
  const { open, working } = useTimeline();
  const tools = turn.items.filter((i): i is ToolItem => i.kind === "tool");
  const agentItems = turn.items.filter((i): i is AgentItem => i.kind === "agent");
  const asks = turn.items.filter((i): i is DelegationItem => i.kind === "delegation");
  // An ask the agent made while it worked sits with its tools; one made after the turn
  // ended (a handoff from here, once the reply was in) sits after the reply.
  const endedMs = ended ? ms(ended.e.time) : Number.NaN;
  const after = (it: DelegationItem) => Number.isFinite(endedMs) && ms((it.started ?? it.ended)?.time) > endedMs;
  const asksDuring = asks.filter((it) => !after(it));
  const asksAfter = asks.filter(after);
  // The harness's idle notice ("waiting for your input") asked for nothing: no note.
  const notes = turn.items.filter(
    (i): i is EventItem =>
      i.kind === "event" &&
      i.e.type === "attention.needed" &&
      i.e.data.kind !== "idle" &&
      !open.has(String(i.e.data.attention_id ?? "")),
  );
  const endErr = ended && String(ended.e.data.reason) === "error" ? ((ended.e.data.error as string) ?? "error") : null;
  const replyItem = transcript ?? progress;
  const replyText = replyItem ? String(replyItem.e.data.assistant ?? "").trim() : "";
  const busy = liveTurn && !ended && working;
  const startSeq = turn.start?.session.seq;
  // A running turn's one row: the sent message's status, else Running with its timer.
  const row: Status =
    status ?? (busy ? { text: "Running", since: turn.start?.time, spinning: true, state: "running" } : null);
  const agent =
    tools.length > 0 ||
    agentItems.length > 0 ||
    asks.length > 0 ||
    !!replyText ||
    !!ackReply ||
    !!row ||
    !!failure ||
    notes.length > 0 ||
    !!swaps?.length ||
    !!endErr;
  // Before the first turn there is nothing a chat shows (session markers stay out of it).
  if (!turn.start && !agent && !pending) return null;
  const at = turn.start?.time ?? sent?.at;
  return (
    <li
      className={`turn turn--chat ${liveTurn || (pending && !failure) ? "turn--live" : ""}`}
      data-seq={startSeq}
      data-flip={flip ? String(turn.n) : undefined}
    >
      {turn.start && notice ? (
        <AgentNotice agentId={notice} seq={startSeq} />
      ) : turn.start && answer ? (
        <AnswerTurn answer={answer} at={at} seq={startSeq} e={(transcript ?? progress)?.e} fill={fill} />
      ) : turn.start || (pending && sent) ? (
        <div className="chat-you">
          {at && (
            <time className="chat-time num" dateTime={at} title={new Date(at).toLocaleString([], { hourCycle: "h23" })}>
              {clock(at).slice(0, 5)}
            </time>
          )}
          {prompt ? (
            <Prompt text={prompt} seq={startSeq} bubble by={submittedLabel(turn.start?.data.submitted_by)} />
          ) : sent?.text ? (
            <Prompt text={sent.text} seq={startSeq} bubble sent={sent} />
          ) : (
            <p className="chat-bubble chat-bubble--hidden" title={PROMPT_KEPT}>
              <PromptKept chars={promptChars} />
            </p>
          )}
        </div>
      ) : null}
      {agent && (
        <div className="chat-ai">
          <span className="chat-meta">
            <HarnessGlyph name={harness} size="sm" />
            {harnessMark(harness).label}
          </span>
          {tools.length > 0 && <ChatTools tools={tools} lens={lens} now={now} fill={fill} />}
          {agentItems.length > 0 && (
            <ol className="turn-items chat-agents">
              {agentItems.map((it) => (
                <AgentBlock key={it.key} item={it} lens={lens} now={now} fill={fill} />
              ))}
            </ol>
          )}
          {asksDuring.map((it) => (
            <AskRow key={it.key} item={it} as="div" />
          ))}
          {notes.map((it) => (
            <p key={it.key} className="chat-note" data-seq={it.e.session.seq}>
              {cap(ATTENTION_LABEL[String(it.e.data.kind)] ?? String(it.e.data.kind))}
              {typeof it.e.data.tool === "string" ? ` · ${toolLabel(it.e.data.tool)}` : ""}
            </p>
          ))}
          {newLine && <NewLine chat />}
          {endErr && (
            <p className="chat-err">
              <ErrGlyph />
              The turn ended with an error: {endErr}
            </p>
          )}
          {replyItem && replyText && <Reply e={replyItem.e} turnSeq={startSeq} fill={fill} live={!transcript} chat />}
          {ackReply && <AckReply text={ackReply} live={!!sent && !isFinal(sent)} chat />}
          {swaps?.map((text) => (
            <p key={text} className="chat-note" data-swap>
              {text}
            </p>
          ))}
          {asksAfter.map((it) => (
            <AskRow key={it.key} item={it} as="div" />
          ))}
          {failure}
          {row && <StatusRow {...row} chat />}
        </div>
      )}
    </li>
  );
}

/** Where the person left off: "New" and a hairline across the column, above the first
 *  answer since they last looked (lib/newLine.ts). In the meta tier: it says where, and
 *  asks nothing. */
function NewLine({ chat = false }: { chat?: boolean }) {
  const line = (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't hold the word "New"
    <div className="new-line" role="separator" aria-label="New since you looked">
      New
    </div>
  );
  // Among a turn's rows it is an item that holds the separator: a list's own children
  // can't be separators (axe's "list").
  return chat ? line : <li>{line}</li>;
}

/** The tools of a turn as one quiet disclosure line, the usual rows when opened. */
function ChatTools({ tools, lens, now, fill }: { tools: ToolItem[]; lens: Tier; now: number; fill: Fill }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const errors = tools.filter((t) => t.ended && t.ended.data.ok === false).length;
  const running = tools.find((t) => !t.ended);
  const menu = useContextMenu(() => {
    const d = ref.current;
    if (!d) return null;
    return [
      {
        label: d.open ? "Hide tools" : `Show ${plural(tools.length, "tool")}`,
        run: () => {
          d.open = !d.open;
        },
      },
    ];
  });
  const name = running ? toolLabel(String((running.started ?? running.ended)?.data.tool ?? "a tool")) : "";
  return (
    <details className="chat-tools" ref={ref}>
      <summary className="chat-tools-sum" {...menu}>
        <Chevron />
        {running ? (
          <>
            <span className="spinner spinner--sm" aria-hidden="true" />
            <span>
              Running {name}
              {tools.length > 1 ? ` · ${plural(tools.length - 1, "more tool")}` : ""}
            </span>
          </>
        ) : (
          <span>Ran {plural(tools.length, "tool")}</span>
        )}
        {errors > 0 && (
          <span className="chat-tools-err">
            <ErrGlyph />
            {errors} failed
          </span>
        )}
      </summary>
      <ol className="turn-items">
        {tools.map((it) => (
          <ToolRow key={it.key} item={it} lens={lens} now={now} fill={fill} />
        ))}
      </ol>
    </details>
  );
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg
      className={className ? `chev ${className}` : "chev"}
      viewBox="0 0 12 12"
      width="10"
      height="10"
      aria-hidden="true"
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "Showing a preview · Load full text" after a slim field. */
function Cut({ e, field, fill }: { e: StoredEvent; field: string; fill: Fill }) {
  const [busy, setBusy] = useState(false);
  const full = e.preview?.[field];
  if (full === undefined) return null;
  return (
    <span className="cut">
      A preview of {full.toLocaleString()} characters ·{" "}
      <button
        type="button"
        className="cut-btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void fill(e).finally(() => setBusy(false));
        }}
      >
        {busy ? "Loading…" : "Load full text"}
      </button>
    </span>
  );
}

/** The one line a tool's input reads as: its command, path, pattern or address. An input
 *  that arrived as a JSON string (some harnesses send it so) is read as the object. */
function toolSubject(input: unknown): string {
  if (typeof input === "string") {
    const t = input.trim();
    if (!t.startsWith("{")) return input;
    try {
      return toolSubject(JSON.parse(t)) || "";
    } catch {
      // Cut to a preview, it no longer parses: its first known field still reads.
      const m = /"(command|file_path|path|pattern|url|query|description)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t);
      return m ? m[2]!.replace(/\\n.*$/s, "").replace(/\\(.)/g, "$1") : input;
    }
  }
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url", "query", "q", "description", "prompt"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.split("\n")[0]!;
  }
  return "";
}

function ToolRow({ item, lens, now, fill }: { item: ToolItem; lens: Tier; now: number; fill: Fill }) {
  const e = item.ended ?? item.started!;
  const tool = String(e.data.tool);
  const label = toolLabel(tool);
  const running = !item.ended;
  const ok = item.ended ? item.ended.data.ok !== false : undefined;
  const msv = item.ended ? (item.ended.data.ms as number | undefined) : now - ms(item.started?.time);
  const input = lens >= 3 ? (item.ended?.data.input ?? item.started?.data.input) : undefined;
  const output = lens >= 3 ? item.ended?.data.output : undefined;
  const error = item.ended?.data.error as string | undefined;
  const expandable = input !== undefined || output !== undefined || !!error;
  const subject = toolSubject(input);
  const details = useRef<HTMLDetailsElement>(null);
  const inputEvent = item.ended?.data.input !== undefined ? item.ended : item.started;
  const cutIn = inputEvent?.preview?.input !== undefined;
  const cutOut = item.ended?.preview?.output !== undefined;
  const menu = useContextMenu(() => {
    const d = details.current;
    return [
      copyItem("Copy tool name", tool),
      { sep: true },
      input !== undefined && copyItem("Copy input", pretty(input)),
      output !== undefined && copyItem("Copy output", pretty(output)),
      error && copyItem("Copy error", error),
      { sep: true },
      d && {
        label: d.open ? "Hide details" : "Show details",
        run: () => {
          d.open = !d.open;
        },
      },
      cutIn && inputEvent && { label: "Load full input", run: () => fill(inputEvent) },
      cutOut && item.ended && { label: "Load full output", run: () => fill(item.ended!) },
    ];
  });
  // One 10 px glyph in the 16 px column, the same box as a subagent's: the spinner, the
  // drawn check, or the red ✕.
  const head = (
    <>
      <span
        className={`tool-status ${running ? "is-run" : ok ? "is-ok" : "is-err"}`}
        role="img"
        aria-label={running ? "running" : ok ? "ok" : "error"}
      >
        {running ? (
          <span className="spinner spinner--sm" aria-hidden="true" />
        ) : ok ? (
          <StateDot state="done" size={10} decorative />
        ) : (
          <ErrGlyph />
        )}
      </span>
      <span className="tool-main">
        <span className="tool-name" title={tool === label ? undefined : tool}>
          {label}
        </span>
        {error ? (
          <span className="tool-err ellipsis">{error}</span>
        ) : subject ? (
          <span className="tool-subject mono ellipsis">{subject}</span>
        ) : null}
      </span>
      <span className="tool-dur num">{dur(msv)}</span>
      {expandable && <Chevron />}
    </>
  );
  if (!expandable)
    return (
      <li className="tool" data-seq={e.session.seq} {...menu}>
        {head}
      </li>
    );
  return (
    <li className="tool tool--x" data-seq={e.session.seq} {...menu}>
      <details ref={details}>
        <summary>{head}</summary>
        <div className="tool-io">
          {input !== undefined && (
            <div>
              <IoHead label="Input" text={pretty(input)} />
              <pre>
                <Redacted text={pretty(input)} />
              </pre>
              <Cut e={inputEvent!} field="input" fill={fill} />
            </div>
          )}
          {output !== undefined && (
            <div>
              <IoHead label="Output" text={pretty(output)} />
              <pre>
                <Redacted text={pretty(output)} />
              </pre>
              <Cut e={item.ended!} field="output" fill={fill} />
            </div>
          )}
          {error && (
            <div>
              <IoHead label="Error" text={error} />
              <pre className="is-err">
                <Redacted text={error} />
              </pre>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

/** The head of a tool's input, output or error: its name, and Copy at the well's edge. */
function IoHead({ label, text }: { label: string; text: string }) {
  return (
    <span className="tool-io-head">
      <span className="tool-io-label">{label}</span>
      <CopyIconButton text={text} label={`Copy ${label.toLowerCase()}`} />
    </span>
  );
}

const pretty = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "preview" in (v as object)) return String((v as { preview: unknown }).preview);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/** The session's label beside the bar's title: its dot, which opens the Label menu at the
 *  dot. Nothing when it has none (the "⋯" menu sets one). */
function BarLabel({ s }: { s: SessionSummary }) {
  const store = useStore();
  return (
    <span className="bar-label">
      <button
        type="button"
        className="bar-label-btn"
        aria-label="Label"
        onClick={(e) => {
          const items = labelMenu(store, [s.key]);
          if ("items" in items) openMenu(tidyMenu(items.items), e.currentTarget.getBoundingClientRect());
        }}
      >
        <LabelDot session={s.key} />
      </button>
    </span>
  );
}

const tidyMenu = (list: MenuList): MenuItem[] => list.filter((i): i is MenuItem => !!i);

/** An agent the timeline has no reading for (past the summary's AGENTS_MAX, or before it
 *  arrived): what its own events say. */
function runOf(item: AgentItem, agents: readonly AgentRun[]): AgentRun {
  const known = agents.find((a) => a.id === item.id);
  if (known) return known;
  const first = item.started ?? item.launch?.started ?? item.tools[0]?.started ?? item.tools[0]?.ended;
  const ended = item.tools.filter((t) => t.ended);
  return {
    id: item.id,
    type: typeof item.started?.data.agent_type === "string" ? item.started.data.agent_type : undefined,
    state: item.ended ? "done" : "running",
    startedAt: first?.time ?? new Date().toISOString(),
    endedAt: item.ended?.time,
    lastAt: item.ended?.time ?? ended[ended.length - 1]?.ended?.time ?? first?.time ?? new Date().toISOString(),
    tools: ended.length,
    toolErrors: ended.filter((t) => t.ended!.data.ok === false).length,
    attributed: item.tools.length > 0,
    recentTools: [],
  };
}

/** A page of an agent's tools that came before the loaded ones. */
const AGENT_PAGE = 50;

/** One subagent under the turn that spawned it: a disclosure group in the timeline, not a
 *  box. Its head is the launching call's row in a tool row's columns (the agent glyph,
 *  "Type · description", what it does now or how long it ran, the chevron), so its time
 *  lines up with theirs; Open beside lies over the chevron and takes its place on hover.
 *  Open, its own tool rows on the tree guide, earlier ones a page at a time, then its
 *  result when the harness sent one. Open while it runs, folded once done, unless the
 *  person or the URL opened it. */
function AgentBlock({ item, lens, now, fill }: { item: AgentItem; lens: Tier; now: number; fill: Fill }) {
  const store = useStore();
  const { agents, focus, session, mode } = useTimeline();
  const run = runOf(item, agents);
  const focused = focus === item.id;
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (focused || run.state !== "done");
  const [older, setOlder] = useState<ToolItem[]>([]);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderDone, setOlderDone] = useState(false);
  const tools = [...older, ...item.tools];
  const missing = run.attributed && !run.session && !olderDone ? run.tools - tools.filter((t) => t.ended).length : 0;
  // A focus that arrives later (another agent tab on the same view) opens it again.
  useEffect(() => {
    if (focused) setChosen(null);
  }, [focused]);
  const s = session();
  const menu = useContextMenu(
    () => {
      const cur = session();
      return cur
        ? agentItems(cur, run, { extra: [{ label: open ? "Hide tools" : "Show tools", run: () => setChosen(!open) }] })
        : null;
    },
    { title: () => agentLabel(run) },
  );
  const loadOlder = async () => {
    const cur = session();
    const first = tools.map((t) => (t.started ?? t.ended)!.session.seq).sort((a, b) => a - b)[0];
    if (!cur || olderBusy) return;
    setOlderBusy(true);
    try {
      const d = await store.transport.session(cur.harness, cur.id, {
        agent: run.id,
        ...(first !== undefined ? { before: first } : { tail: true }),
        limit: AGENT_PAGE,
        slim: true,
        preview: LIST_PREVIEW,
      });
      // The page also carries the call that launched it: that is the block's head, not a row.
      const page = groupTurns(d.events)
        .flatMap((t) => t.items.flatMap((i) => (i.kind === "agent" ? i.tools : i.kind === "tool" ? [i] : [])))
        .filter((t) => !run.callId || (t.started ?? t.ended)?.data.call_id !== run.callId);
      const have = new Set(tools.map((t) => t.key));
      setOlder((prev) => [...page.filter((t) => !have.has(t.key)), ...prev]);
      if (!d.hasOlder || page.length === 0) setOlderDone(true);
    } catch {
      setOlderDone(true);
    } finally {
      setOlderBusy(false);
    }
  };
  const startSeq = (item.launch?.started ?? item.launch?.ended ?? item.started)?.session.seq;
  return (
    <li className={`agent-block ${open ? "is-open" : ""}`} data-agent={item.id} data-seq={startSeq}>
      <div className="agent-head" data-open={focused ? "" : undefined} {...menu}>
        <button
          type="button"
          className="agent-toggle"
          aria-expanded={open}
          onClick={() => setChosen(!open)}
          title={run.attributed || run.session ? undefined : "Codex doesn't report a subagent's tools separately"}
        >
          <span className="marker-glyph">
            <AgentGlyph a={run} size={10} />
          </span>
          <AgentText a={run} />
          <AgentNow a={run} />
          <Chevron className="agent-chev" />
        </button>
        {s && !(mode === "panel" && focused) && (
          <button
            type="button"
            className="icon-btn agent-beside"
            aria-label={`Open ${agentLabel(run)} beside`}
            data-tip="Open beside"
            onClick={() => openAgent(s, run, "beside")}
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
              <rect x="2.5" y="4" width="15" height="12" rx="1.5" />
              <path d="M11 4v12" />
            </svg>
          </button>
        )}
      </div>
      {open && (tools.length > 0 || missing > 0) && (
        <ol className="agent-items" aria-label={`${agentType(run)} tools`}>
          {missing > 0 && (
            <li className="agent-older">
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => void loadOlder()}
                disabled={olderBusy}
              >
                {olderBusy ? "Loading…" : `Earlier tools · ${missing}`}
              </button>
            </li>
          )}
          {tools.map((t) => (
            <ToolRow key={t.key} item={t} lens={lens} now={now} fill={fill} />
          ))}
        </ol>
      )}
      {open && run.result && <AgentResult text={run.result} />}
    </li>
  );
}

/** The agent's last word, when the harness sent it: prose, six lines until asked for all. */
function AgentResult({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !all) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, all]);
  const menu = useContextMenu(() => [copyItem("Copy result", text)]);
  return (
    <div className="agent-result" {...menu}>
      <span className="agent-result-label">Result</span>
      <div className={`agent-result-text ${all ? "" : "is-clamped"}`} ref={ref}>
        <Markdown text={text} />
      </div>
      {(long || all) && (
        <button type="button" className="cut-btn agent-result-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/** Claude Code's `<task-notification>` turn: "Subagent finished: Explore · …" with the
 *  agent glyph; a click goes to the agent's block. */
function AgentNotice({ agentId, seq }: { agentId: string; seq?: number }) {
  const { agents, showAgent } = useTimeline();
  const run = agents.find((a) => a.id === agentId);
  const menu = useContextMenu(() => [{ label: "Show the subagent", run: () => showAgent(agentId) }]);
  return (
    <div className="agent-notice" data-seq={seq} {...menu}>
      <button type="button" className="agent-notice-btn" onClick={() => showAgent(agentId)}>
        <span className="marker-glyph">
          <AgentGlyph a={run ?? { state: "done" }} size={10} />
        </span>
        <span className="agent-notice-text ellipsis">
          Subagent finished: {run ? agentLabel(run) : "a background agent"}
        </span>
      </button>
    </div>
  );
}

// ----- the agents this session asked (sessionpipe ask, a handoff): the lineage rows -----

type HandoffAnswer = NonNullable<ReturnType<typeof handoffAnswer>>;

/** One ask as its row reads it: from the summary's `Delegation` (the store's reading),
 *  from the turn's own events when the summary has none for it (past DELEGATIONS_MAX, or
 *  a reading still on its way), or from the activity of a message this page sent to
 *  another agent (`from`) before any event said what became of it. */
interface Ask {
  askId?: string;
  /** "You asked …": a handoff, or a message sent from here; else the agent asked on its own. */
  you: boolean;
  harness: string;
  to?: SessionKey;
  startedAt: string;
  endedAt?: string;
  ok?: boolean;
  ms?: number;
  reply?: string;
  error?: string;
  relayed?: Delegation["relayed"];
  /** The message, while the row is the activity's alone. */
  activity?: ControlActivity;
}

const askOf = (d: Delegation): Ask => ({
  askId: d.askId,
  you: d.via === "handoff",
  harness: d.harness,
  to: d.to,
  startedAt: d.startedAt,
  endedAt: d.endedAt,
  ok: d.ok,
  reply: d.reply,
  error: d.error,
  relayed: d.relayed,
  ...(d.ms !== undefined ? { ms: d.ms } : {}),
});

const strOf = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The events' own reading of an ask the summary has no Delegation for. */
function askFromItem(item: DelegationItem): Ask {
  const sd = item.started?.data ?? {};
  const ed = item.ended?.data ?? {};
  const to = strOf(ed.to) ?? strOf(sd.to);
  const relayed = ed.relayed;
  return {
    askId: item.askId,
    you: sd.via === "handoff" || relayed !== undefined,
    harness: strOf(sd.harness) ?? (to ? splitKey(to).harness : ""),
    to,
    startedAt: item.started?.time ?? item.ended?.time ?? new Date().toISOString(),
    endedAt: item.ended?.time,
    ok: typeof ed.ok === "boolean" ? ed.ok : undefined,
    ...(typeof ed.ms === "number" ? { ms: ed.ms } : {}),
    reply: strOf(ed.reply),
    error: strOf(ed.error),
    relayed: relayed === "delivered" || relayed === "unsupported" || relayed === "failed" ? relayed : undefined,
  };
}

/** A message this page sent to another agent, before the events: the session it named
 *  (a start's new one, or the one the ack said it went to). */
function askFromActivity(a: ControlActivity): Ask {
  const to = a.ackSession ?? a.session;
  return { you: true, harness: to ? splitKey(to).harness : "", to, startedAt: a.at, activity: a };
}

/** A daemon's refusal of an ask (CONTROL.md §13 codes), when the error starts with its
 *  code ("harness: gemini-cli is not installed here"); the control codes keep their words. */
const ASK_REFUSALS: Record<string, (machine: string) => string> = {
  ask_off: (m) => `asking between agents is off on ${m} (sessionpipe ask on)`,
  harness: (m) => `${m} can't run that agent`,
  depth: () => "an asked agent can't ask a third one",
  loop: () => "it would be asking itself",
};
function askRefusal(error: string, machine: string): string | null {
  const m = /^([a-z_]+)(?::\s|$)/.exec(error);
  if (!m) return null;
  const code = m[1]!;
  const own = ASK_REFUSALS[code];
  if (own) return own(machine);
  return REFUSAL_WORDS[code] ? refusalWords(code) : null;
}

/** A machine's detail ends the sentence it is quoted in; most arrive without a full stop. */
const stopped = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);
const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** The row's state (UX-SPEC §3.1): one phrase in the meta tier, a live timer while it
 *  runs, red only when it went wrong. `child` is the asked session when the store has it. */
function askState(
  a: Ask,
  o: { machine: string; online: boolean; child?: SessionSummary },
): { text: string; since?: string; err?: boolean; glyph: "run" | "ok" | "err" | "none" } {
  const act = a.activity;
  if (act) {
    const harness = a.to ? splitKey(a.to).harness : "";
    if (isFinal(act) && act.outcome !== "delivered")
      return {
        text: `not sent · ${act.outcome === "refused" ? refusalWords(act.code) : (act.detail ?? act.outcome)}`,
        err: true,
        glyph: "err",
      };
    if (act.outcome === "delivered" && o.child)
      return o.child.state === "working" || o.child.state === "needs_you"
        ? { text: "running", since: o.child.stateSince, glyph: "run" }
        : { text: STATE_LABEL[o.child.state], glyph: o.child.state === "done" ? "ok" : "none" };
    if (!act.outcome && !o.online)
      return { text: `waiting for ${o.machine}. It asks when the machine is back.`, glyph: "run" };
    const line = sentLine(act, {
      machine: o.machine,
      online: o.online,
      command: harnessCommand(harness, harnessMark(harness).label),
    });
    return { text: line ? lower(line.text).replace(/[.…]?$/, "…") : "sent…", glyph: "run" };
  }
  if (!a.endedAt) return { text: "running", since: a.startedAt, glyph: "run" };
  const took = a.ms !== undefined ? dur(a.ms) : dur(ms(a.endedAt) - ms(a.startedAt));
  if (a.ok === false) {
    const refusal = a.error ? askRefusal(a.error, o.machine) : null;
    if (refusal) return { text: `refused · ${refusal}`, err: true, glyph: "err" };
    return { text: `failed after ${took}${a.error ? ` · ${a.error}` : ""}`, err: true, glyph: "err" };
  }
  if (a.ok === undefined) return { text: "no answer", glyph: "none" };
  const relay =
    a.relayed === "delivered"
      ? " · answer below"
      : a.relayed === "unsupported"
        ? ` · couldn't bring it back: ${o.machine} can't message this session`
        : a.relayed === "failed"
          ? ` · couldn't bring it back: ${stopped(a.error ?? "it didn't arrive")}`
          : "";
  return { text: `answered in ${took}${relay}`, glyph: "ok" };
}

const isWide = () => typeof matchMedia === "function" && matchMedia("(min-width: 840px)").matches;

/** One agent this session asked, where the ask happened (UX-SPEC §3.1): one line in the
 *  agent's column, a glyph, "Asked Codex · <its title> · <state>", the whole row a link to
 *  the asked session; the answer folded under it only when it was not relayed here. */
function AskRow({ item, ask: given, as }: { item?: DelegationItem; ask?: Ask; as: "li" | "div" }) {
  const { session, machine, online, control } = useTimeline();
  const s = session();
  const d = item ? s?.delegations?.find((x) => x.askId === item.askId) : undefined;
  const a = given ?? (d ? askOf(d) : askFromItem(item!));
  const child = useSession(a.to ?? "");
  const st = askState(a, { machine, online, child });
  const label = harnessMark(a.harness).label;
  const verb = `${a.you ? "You asked" : "Asked"} ${label}`;
  const title = child ? sessionTitle(child) : "new session";
  const target = a.to ? splitKey(a.to) : null;
  const path = target ? sessionPath(target.harness, target.id) : null;
  const running = st.glyph === "run" && !a.activity;
  const stop = useRef<MenuList>([]);
  const menu = useContextMenu(
    () => [
      path && { label: "Open the asked session", run: () => navigate(path) },
      path && isWide() && { label: "Open beside", run: () => openSplit(a.to!) },
      copyItem("Copy the answer", a.reply ?? null),
      target && copyItem("Copy session ID", target.id),
      { sep: true },
      ...stop.current,
    ],
    { title: () => verb, subtitle: () => st.text },
  );
  const glyph =
    st.glyph === "run" ? (
      <span className="spinner spinner--sm" aria-hidden="true" />
    ) : st.glyph === "ok" ? (
      <StateDot state="done" size={10} decorative />
    ) : st.glyph === "err" ? (
      <ErrGlyph />
    ) : null;
  const body = (
    <>
      <span className="marker-glyph">{glyph}</span>
      <span className="ask-text">
        <span className="ask-verb">{verb}</span>
        <span className="ask-title" title={title}>
          {title}
        </span>
        <span className={`ask-state ${st.err ? "is-err" : ""}`}>
          {st.text}
          {st.since && (
            <>
              {" "}
              <Since iso={st.since} />
            </>
          )}
        </span>
      </span>
      <span className="ask-chev" aria-hidden="true">
        ›
      </span>
    </>
  );
  const Tag = as;
  return (
    <Tag
      className="ask"
      data-ask={a.askId ?? a.activity?.id}
      data-seq={item?.started?.session.seq ?? item?.ended?.session.seq}
      {...menu}
    >
      {path ? (
        <Link to={path} className="ask-link" modClick={(o) => openSplit(a.to!, { background: o.background })}>
          {body}
        </Link>
      ) : (
        <span className="ask-link ask-link--none">{body}</span>
      )}
      {a.reply && a.relayed !== "delivered" && <AskFold reply={a.reply} />}
      {running && child && control && <AskStop child={child} control={control} label={label} into={stop} />}
    </Tag>
  );
}

/** The answer, folded like a turn's tools: "Show the answer", the reply as prose. */
function AskFold({ reply }: { reply: string }) {
  const [open, setOpen] = useState(false);
  const menu = useContextMenu(() => [copyItem("Copy the answer", reply)]);
  return (
    <details
      className="chat-tools ask-fold"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="chat-tools-sum" {...menu}>
        <Chevron />
        <span>{open ? "Hide the answer" : "Show the answer"}</span>
      </summary>
      <div className="chat-card">
        <Markdown text={reply} />
      </div>
    </details>
  );
}

/** "Stop Codex…" for a running ask: a `cancel` on the asked session through the one
 *  signed send path, mounted only while the row can offer it. Writes the menu item into
 *  the row's ref, as the board's rows keep their Allow / Deny. */
function AskStop({
  child,
  control,
  label,
  into,
}: {
  child: SessionSummary;
  control: MachineControl;
  label: string;
  into: MutableRefObject<MenuList>;
}) {
  const send = useSessionSend(child, control, child.openAttentions);
  useLayoutEffect(() => {
    into.current = [
      {
        label: `Stop ${label}…`,
        disabled: send.secure ? undefined : signHint(send.rp),
        run: async () => {
          const ok = await confirmAction({
            title: `Stop ${label}?`,
            body: "Its session keeps what it did so far.",
            action: "Stop",
          });
          if (ok) await send.onSend({ kind: "cancel" }).catch(() => {});
        },
      },
    ];
  });
  useEffect(
    () => () => {
      into.current = [];
    },
    [into],
  );
  return null;
}

/** A message that did not go keeps its row this long before it folds to the activity. */
const ASK_FAILED_HOLD_MS = 60_000;

/** The messages this page sent to other agents that no event has caught up with yet (the
 *  handoff sheet's `from`): their rows at the end of the view, oldest first, each gone
 *  once a Delegation names the session it made, or a minute after one failed. */
function AskRows({
  sent,
  delegations,
  chat,
}: {
  sent: ControlActivity[];
  delegations: readonly Delegation[];
  chat: boolean;
}) {
  const failed = sent.some((a) => isFinal(a) && a.outcome !== "delivered");
  const now = useNow(failed ? "coarse" : "off");
  const rows = sent.filter((a) => {
    const to = a.ackSession ?? a.session;
    if (to && delegations.some((d) => d.to === to)) return false;
    if (isFinal(a) && a.outcome !== "delivered") return now - Date.parse(a.ackedAt ?? a.at) < ASK_FAILED_HOLD_MS;
    return true;
  });
  if (rows.length === 0) return null;
  const items = [...rows].reverse().map((a) => <AskRow key={a.id} ask={askFromActivity(a)} as={chat ? "div" : "li"} />);
  return chat ? (
    <li className="turn turn--chat">
      <div className="chat-ai">{items}</div>
    </li>
  ) : (
    <li className="turn">
      <ol className="turn-items">{items}</ol>
    </li>
  );
}

/** The session whose answer a handoff relayed into this one just before `at`: the newest
 *  delegation of that harness that reads `relayed: "delivered"` and ended by then. */
function relayedFrom(ds: readonly Delegation[] | undefined, harness: string, at?: string): SessionKey | undefined {
  const t = ms(at);
  let best: Delegation | undefined;
  for (const d of ds ?? []) {
    if (d.relayed !== "delivered" || !d.to || d.harness !== harness) continue;
    const e = ms(d.endedAt);
    if (Number.isFinite(t) && Number.isFinite(e) && e > t + 60_000) continue;
    if (!best || ms(best.endedAt) < e) best = d;
  }
  return best?.to;
}

/** The answer a handoff brought back (UX-SPEC §3.2): the asked agent's glyph and name with
 *  "answer", the reply as prose, in the agent's column; linked to the asked session when
 *  the reading knows it. The session's own reply to it follows as usual. */
function AnswerTurn({
  answer,
  at,
  seq,
  e,
  fill,
}: {
  answer: HandoffAnswer;
  at?: string;
  seq?: number;
  /** The transcript (or progress) the answer was read from: slim, its `user` may be cut. */
  e?: StoredEvent;
  fill: Fill;
}) {
  const { session, path } = useTimeline();
  const from = relayedFrom(session()?.delegations, answer.harness, at);
  const target = from ? splitKey(from) : null;
  const label = harnessMark(answer.harness).label;
  const menu = useContextMenu(() => [
    copyItem("Copy the answer", answer.reply),
    copyItem("Copy link to this turn", seqLink(path, seq)),
    { sep: true },
    target && { label: "Open the asked session", run: () => navigate(sessionPath(target.harness, target.id)) },
  ]);
  const meta = (
    <>
      <HarnessGlyph name={answer.harness} size="sm" />
      {label}
      <span className="chat-meta-sub"> · answer</span>
    </>
  );
  return (
    <div className="chat-ai chat-answer" data-seq={seq} {...menu}>
      <span className="chat-meta">
        {target ? <Link to={sessionPath(target.harness, target.id)}>{meta}</Link> : meta}
        {at && (
          <time
            className="chat-answer-time num"
            dateTime={at}
            title={new Date(at).toLocaleString([], { hourCycle: "h23" })}
          >
            {clock(at).slice(0, 5)}
          </time>
        )}
      </span>
      <div className="chat-card">
        <Markdown text={answer.reply} />
        {e && <Cut e={e} field="user" fill={fill} />}
      </div>
    </div>
  );
}
