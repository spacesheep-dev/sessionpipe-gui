// SPDX-License-Identifier: Apache-2.0
// One session's body, used by the Session page and by the side panel: on the page its
// title bar (PageBar: back, the title, a quiet status and the facts, Follow, Forget, the
// "⋯" menu), in the panel one meta line under the panel's own head; then the timeline
// grouped by turn (newest page first, older pages on demand, the stream appending) and
// the docked control bar. The page scrolls the window; the panel scrolls its own element
// (`scrollRef`). In Simple mode (lib/settings.ts) the same view is a chat: the person's
// prompts as bubbles on the right, the assistant's replies as plain prose under its
// name, the tools of a turn folded into one line. Replies render as markdown in both
// modes. Every row of the timeline has its own right-click menu (long-press on touch);
// the empty space around it has the view's options.
import type { ControlActivity, SessionState, SessionSummary, StoredEvent, Tier } from "@shared/api";
import { sessionKey, splitKey } from "@shared/api";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { forkOf } from "../control/Activity";
import { PromptBody, promptParts } from "../control/Attachments";
import { useControlActivity } from "../control/hooks";
import { SessionControl } from "../control/SessionControl";
import { useMachinesMap, useSession, useStore } from "../data/hooks";
import { useFocusTrap } from "../lib/focus";
import {
  ATTENTION_LABEL,
  attentionMessage,
  basename,
  eventSummary,
  harnessMark,
  modelShort,
  repoBranch,
  repoShort,
  sessionTitle,
} from "../lib/format";
import { absoluteUrl, copyItem, sessionItems } from "../lib/menus";
import { back, Link, navigate, sessionPath } from "../lib/router";
import { setTierLens, useAppSettings, useLens } from "../lib/settings";
import { useShortcut } from "../lib/shortcuts";
import { openSplit } from "../lib/split";
import { atTier, TIER_HINT, TIER_LABEL } from "../lib/tier";
import { clock, dur, ms, useNow } from "../lib/time";
import { type EventItem, groupTurns, sentTurns, type ToolItem, type Turn, unframe } from "../lib/turns";
import { HarnessGlyph, Redacted, Segmented, Spinner, StateDot } from "./bits";
import { confirmAction, type MenuItem, type MenuList, MoreButton, useContextMenu } from "./ContextMenu";
import { CodeFrame, Markdown } from "./Markdown";
import { BackButton, PageBar } from "./PageBar";

/** The newest page a session opens on, and the size of each older page. Both slim: the
 *  full event is fetched only when a row is expanded (`fill`). */
const TAIL = 100;
const OLDER = 200;
/** While following a live session, rows past this many are let go from the top (they
 *  are one "Older turns" click away), so a tab left open for hours stays small. */
const LIVE_CAP = TAIL + 2 * OLDER;
/** Characters of each tool input/output or transcript kept in a list page. */
const LIST_PREVIEW = 400;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The state in a word, for the bar and the panel head; the colour is the glyph's alone. */
export const STATUS_WORD: Record<SessionState, string> = {
  needs_you: "Needs you",
  working: "Working",
  stale: "Stale",
  idle: "Idle",
  done: "Done",
};

/** `#seq-N` on the URL: the row a search hit asks to open on (pages/Review.tsx), read once. */
const hashSeq = (): number | null => {
  const m = /^#seq-(\d+)$/.exec(location.hash);
  return m ? Number(m[1]) : null;
};

/** Allow / Deny for an open permission as menu items that press the strip's own buttons,
 *  so a menu answers through the one signed send (and its one-answer memory) the strip
 *  uses; disabled with the strip's reason when it cannot. `root` is the view (or the
 *  panel's active body); the first open prompt unless `attentionId` names one. */
export function answerItems(root: HTMLElement | null, s: SessionSummary, attentionId?: string): MenuList {
  const rows = [...(root?.querySelectorAll<HTMLElement>(".ctl-answer[data-attention]") ?? [])];
  const row = attentionId ? rows.find((r) => r.dataset.attention === attentionId) : rows[0];
  const allow = row?.querySelector<HTMLButtonElement>(".btn--allow");
  const deny = row?.querySelector<HTMLButtonElement>(".btn--deny");
  if (!row || !allow || !deny) return [];
  const tool = s.openAttentions.find((a) => a.attentionId === row.dataset.attention)?.tool;
  const why = allow.disabled
    ? row.querySelector(".ctl-answer-note")?.textContent?.trim() || "This prompt cannot be answered from here"
    : undefined;
  return [
    { label: tool ? `Allow ${tool}` : "Allow", action: "session.allow", disabled: why, run: () => allow.click() },
    { label: tool ? `Deny ${tool}` : "Deny", action: "session.deny", disabled: why, run: () => deny.click() },
  ];
}

type Leaf = Extract<MenuItem, { run: unknown }>;

/** "Send a message…" and "Cancel the running turn…", read off the strip when the menu
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
          label: "Cancel the running turn…",
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
    title: "Cancel the running turn?",
    body: "The agent stops what it is doing; the session stays open for the next prompt.",
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
 *  that reach the strip. */
interface Timeline {
  path: string;
  open: ReadonlySet<string>;
  working: boolean;
  root: RefObject<HTMLDivElement>;
  session: () => SessionSummary | undefined;
}
const TimelineCtx = createContext<Timeline | null>(null);
const useTimeline = () => useContext(TimelineCtx)!;

/** The link to a row of this session (the view jumps to it on open). */
const seqLink = (path: string, seq: number | undefined) =>
  seq === undefined ? null : `${absoluteUrl(path)}#seq-${seq}`;

export interface SessionViewProps {
  harness: string;
  id: string;
  /** "page": the window scrolls and the title bar is part of the view.
   *  "panel": the panel scrolls (`scrollRef`) and carries the title itself. */
  mode: "page" | "panel";
  scrollRef?: RefObject<HTMLElement | null>;
  /** The summary as soon as it is known (the panel header shows it). */
  onSession?: (s: SessionSummary) => void;
  /** After Forget succeeded; the page goes to the board by default. */
  onForgotten?: () => void;
}

export function SessionView({ harness, id, mode, scrollRef, onSession, onForgotten }: SessionViewProps) {
  const store = useStore();
  const key = sessionKey(harness, id);
  const live = useSession(key);
  const machines = useMachinesMap();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [summary, setSummary] = useState<SessionSummary | undefined>();
  const [children, setChildren] = useState<SessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The tier lens is the app's (Settings › Tier lens, the chip, `l`); this control reads
  // and writes it. "all" is tier 3 here. Simple mode: the chat, everything shown.
  const lensSetting = useLens();
  const lens: Tier = lensSetting ?? 3;
  const { mode: uiMode, confirmForget } = useAppSettings();
  const chat = uiMode === "simple";
  const [follow, setFollow] = useState(true);
  const followRef = useRef(follow);
  followRef.current = follow;
  const [confirm, setConfirm] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const lastSeq = useRef(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(confirmRef, confirm, { onClose: () => setConfirm(false), initial: ".btn--danger" });

  const [hasOlder, setHasOlder] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [tailSeq, setTailSeq] = useState(-1);
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
    (y: number) => {
      const el = sc();
      if (el) el.scrollTop = y;
      else window.scrollTo(0, y);
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
    const buffered: StoredEvent[] = [];
    const unsub = store.onEvent((e) => {
      if (`${e.harness.name}:${e.session.id}` === key) buffered.push(e);
    });
    (async () => {
      try {
        const d = await store.transport.session(harness, id, {
          tail: true,
          limit: TAIL,
          slim: true,
          preview: LIST_PREVIEW,
        });
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
        setTailSeq(lastSeq.current);
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
  }, [store, harness, id, key]);

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
    setFollow(false);
    row.scrollIntoView({ block: "center" });
    row.classList.add("is-target");
    setTimeout(() => row.classList.remove("is-target"), 1600);
    return true;
  }, []);
  useEffect(() => {
    const onHash = () => jumpTo(hashSeq());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [jumpTo]);

  // Bottom-anchored first paint (the newest turn is what a session opens on, unless the
  // URL names a row), and a still viewport when older events land above it, whether or
  // not the browser's own scroll anchoring already moved it.
  useLayoutEffect(() => {
    if (events.length === 0) return;
    if (firstPaint.current) {
      firstPaint.current = false;
      if (!jumpTo(hashSeq())) scrollTo(scrollHeight());
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
  }, [events, scrollTo, scrollBy, scrollHeight, scrollY, jumpTo]);

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
      setTailSeq(e.session.seq);
      setTotal((t) => t + 1);
    });
  }, [store, key, loading]);

  const s = live ?? summary;
  const sRef = useRef(s);
  sRef.current = s;
  useEffect(() => {
    if (s) onSession?.(s);
  }, [s, onSession]);

  const visible = useMemo(
    () => events.map((e) => atTier(e, lens)).filter((e): e is StoredEvent => e !== null),
    [events, lens],
  );
  const turns = useMemo(() => groupTurns(visible), [visible]);
  const hidden = events.length - visible.length;
  // The delivered messages whose turn this view holds: their rows under the composer fold
  // to one line (control/Activity.tsx), the reply being right here. Matched on every
  // loaded event, whatever the lens leaves out; a copy's message is never here.
  const allTurns = useMemo(() => (lens >= 3 ? turns : groupTurns(events)), [lens, turns, events]);
  const inChat = useCallback(
    (messages: readonly ControlActivity[]) => {
      const sent = messages
        .filter((a) => (a.kind === "prompt" || a.kind === "start") && a.outcome === "delivered" && !forkOf(a))
        .map((a) => ({ id: a.id, at: a.at, text: promptParts(a.text ?? "").body }));
      return new Set(sentTurns(sent, allTurns, (t) => promptParts(t).body).keys());
    },
    [allTurns],
  );
  // A copy of another session (a message sent there went to a fork, CONTROL.md §6): the
  // original, named in the bar, linked; its row under the composer links back here.
  const isCopy = useCallback((a: ControlActivity) => forkOf(a) === key, [key]);
  const original = useControlActivity(isCopy)[0]?.session ?? "";
  const originalSummary = useSession(original);
  /** The loaded window ends at the latest turn, so its last turn is turn `counts.turns`. */
  const loadedTurns = turns.filter((t) => t.start).length;
  const turnOffset = Math.max(0, (s?.counts.turns ?? loadedTurns) - loadedTurns);

  // Auto-follow: stick to the bottom while live and the person has not scrolled up.
  const isLive = !!s && (s.state === "working" || s.state === "needs_you");
  // To the very end (not "the last row into view": the docked control bar and the tab
  // bar would cover the last rows), on every new event while following.
  useEffect(() => {
    if (!follow || !isLive) return;
    scrollTo(scrollHeight());
  }, [follow, isLive, tailSeq, scrollTo, scrollHeight]);
  useEffect(() => {
    if (!follow) return;
    const target: EventTarget = sc() ?? window;
    let lastY = scrollY();
    const onScroll = () => {
      const y = scrollY();
      const atBottom = viewHeight() + y >= scrollHeight() - 120;
      if (y < lastY - 24 && !atBottom) setFollow(false);
      lastY = y;
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [follow, sc, scrollY, viewHeight, scrollHeight]);

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

  /** Stream and feed events are slim (data cut to a preview); the detail route has the
   *  whole event. Swap one in by its seq. */
  const fill = useCallback(
    async (e: StoredEvent) => {
      const d = await store.transport.session(harness, id, { after: e.session.seq - 1, limit: 1 });
      const full = d.events.find((x) => x.session.seq === e.session.seq);
      if (full) setEvents((prev) => prev.map((p) => (p.session.seq === full.session.seq ? full : p)));
    },
    [store, harness, id],
  );

  const forget = useCallback(async () => {
    setForgetting(true);
    try {
      await store.transport.forget(harness, id);
      store.apply({ kind: "forgotten", key });
      if (onForgotten) onForgotten();
      else navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setForgetting(false);
      setConfirm(false);
    }
  }, [store, harness, id, key, onForgotten]);

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
  useShortcut("session.follow", () => (inert() || !isLive ? false : setFollow((f) => !f)), keyOpts);
  useShortcut(
    "session.openPage",
    () => (inert() || mode === "page" ? false : navigate(sessionPath(harness, id))),
    keyOpts,
  );
  useShortcut("session.older", () => (inert() || !hasOlder || olderBusy ? false : void loadOlder()), keyOpts);

  const path = sessionPath(harness, id);
  const followItem = (): MenuItem | null =>
    isLive
      ? { label: "Follow the live turn", action: "session.follow", checked: follow, run: () => setFollow((f) => !f) }
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
    }),
    [path, s?.openAttentions, s?.state],
  );

  if (!s && loading) {
    return (
      <div className={`page session ${mode === "panel" ? "session--panel" : ""}`}>
        {mode === "page" && <PageBar title="Loading…" back={<BackButton onClick={() => back("/")} />} large={false} />}
        <div className="skeleton sess-skel" aria-hidden="true">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
        <p className="sr-only">Loading session…</p>
      </div>
    );
  }
  if (!s) {
    return (
      <div className={`page session ${mode === "panel" ? "session--panel" : ""}`}>
        {mode === "page" && <PageBar title="Session" back={<BackButton onClick={() => back("/")} />} large={false} />}
        <div className="state">
          <p className="state-title">{error ? "This session did not load" : "No such session here"}</p>
          <p className="state-text">
            {error ?? "This receiver holds nothing for it: it was forgotten, or never arrived."}
          </p>
          <Link to="/" className="btn">
            Back to the board
          </Link>
        </div>
      </div>
    );
  }

  const control = s.machine ? machines.get(s.machine)?.control : undefined;
  const kids = children.length ? children : childrenFromStore(store, key);
  const title = sessionTitle(s);
  const copyOf = original
    ? {
        path: sessionPath(splitKey(original).harness, splitKey(original).id),
        title: originalSummary ? sessionTitle(originalSummary) : "another session",
      }
    : undefined;

  // The session's "⋯": Back, how the view follows, then the session's own menu with the
  // answers and the strip's actions in it.
  const pageMenu = (): MenuList => [
    mode === "page" && { label: "Back", action: "back", run: () => back("/") },
    { sep: true },
    followItem(),
    !chat && lensMenu(lens),
    { sep: true },
    ...sessionItems(s, {
      store,
      surface: mode,
      answer: answerItems(rootRef.current, s),
      extra: ((c) => [c.send, c.cancel])(controlItems(rootRef.current)),
      children: kids,
      onForgotten,
    }),
  ];

  const followBtn = isLive && (
    <button
      type="button"
      className="icon-btn sess-desk"
      aria-pressed={follow}
      onClick={() => setFollow((f) => !f)}
      data-tip="Follow the live turn · f"
      data-tip-side="bottom"
    >
      <svg
        viewBox="0 0 20 20"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M10 3.5v9M6 9l4 4 4-4M4.5 16.5h11" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="sr-only">{follow ? "Following" : "Follow"}</span>
    </button>
  );

  const forgetBtn = (
    <div className="sess-forget sess-desk">
      <button
        type="button"
        className="icon-btn"
        aria-label="Forget"
        aria-expanded={confirm}
        onClick={() => (confirmForget ? setConfirm((c) => !c) : void forget())}
        disabled={forgetting}
        data-tip="Forget this session"
        data-tip-side="bottom"
      >
        <svg
          viewBox="0 0 20 20"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path
            d="M4 5.5h12M8 5.5V4h4v1.5M5.5 5.5l.7 10a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-10M8.5 8.5v5M11.5 8.5v5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {confirm && (
        <div
          className="sess-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-label="Forget this session?"
          ref={confirmRef}
        >
          <p className="sess-confirm-title">Forget this session?</p>
          <p className="sess-confirm-text">Delete everything held for this session here?</p>
          <div className="sess-confirm-actions">
            <button type="button" className="btn btn--sm" onClick={() => setConfirm(false)} data-dismiss>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={() => void forget()}
              disabled={forgetting}
            >
              {forgetting ? "Forgetting…" : "Forget"}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const flags = !chat && s.flags?.length ? s.flags : null;

  return (
    <TimelineCtx.Provider value={timeline}>
      <CodeFrame.Provider value={CodeWell}>
        <div
          className={`page session ${mode === "panel" ? "session--panel" : ""} ${chat ? "session--chat" : ""}`}
          ref={rootRef}
          data-ui={chat ? "simple" : "advanced"}
          {...bgMenu}
        >
          {mode === "page" ? (
            <PageBar
              back={<BackButton onClick={() => back("/")} />}
              title={title}
              titleClassName="sess-title"
              large={false}
              className="sess-bar"
              meta={<SessionMeta s={s} chat={chat} total={total} copyOf={copyOf} />}
              tools={chat ? undefined : <LensTools lens={lens} hidden={hidden} maxTier={s.maxTier} />}
              actions={
                <>
                  {followBtn}
                  {forgetBtn}
                  <MoreButton build={pageMenu} title={() => title} />
                </>
              }
            />
          ) : (
            <p className="sess-sub">
              <SessionMeta s={s} chat={chat} total={total} withState={false} copyOf={copyOf} />
            </p>
          )}

          {flags && (
            <p className="page-note sess-flags">
              {flags.map((f) => (
                <span key={f.kind} className={f.kind === "error_streak" ? "is-err" : undefined}>
                  {f.detail}
                </span>
              ))}
            </p>
          )}
          {error && <p className="page-note is-err">{error}</p>}

          <ol className={`timeline ${chat ? "timeline--chat" : ""}`}>
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
            {turns.map((t) => (
              <TurnBlock
                key={t.n}
                turn={t}
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
                kids={kids}
                liveTurn={s.currentTurn ? t === turns[turns.length - 1] : false}
                fill={fill}
                chat={chat}
                harness={s.harness}
              />
            ))}
            {!loading && visible.length === 0 && <li className="page-note">No events at this tier.</li>}
            {/* A chat with nothing said yet (only the session's start): say so where the
                first message will land, rather than leave the column blank. */}
            {chat && !loading && !hasOlder && visible.length > 0 && turns.every((t) => t.n === 0) && (
              <li className="state">
                <p className="state-title">No messages yet</p>
                <p className="state-text">What you and the agent say shows here as it happens.</p>
              </li>
            )}
          </ol>

          <div className={`sess-ctl ${chat ? "sess-ctl--chat" : ""}`} {...ctlMenu}>
            <SessionControl session={s} control={control} attentions={s.openAttentions} chat={chat} inChat={inChat} />
          </div>
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

/** The bar's meta: the state as a quiet word beside its glyph, then where it runs; in
 *  Advanced the facts (machine · repo · model · age · events), the one chain allowed. */
function SessionMeta({
  s,
  chat,
  total,
  withState = true,
  copyOf,
}: {
  s: SessionSummary;
  chat: boolean;
  total: number;
  withState?: boolean;
  /** This session is a copy (a fork) of that one. */
  copyOf?: { path: string; title: string };
}) {
  const repo = chat ? repoShort(s.repo) : repoBranch(s);
  const place = repo || (s.cwd ? basename(s.cwd) : "");
  const state = withState && (
    <span className="sess-state">
      <StateDot state={s.state} decorative />
      {STATUS_WORD[s.state]}
    </span>
  );
  const copy = copyOf && (
    <span className="sess-copy">
      Copy of <Link to={copyOf.path}>{copyOf.title}</Link>
    </span>
  );
  if (chat)
    return (
      <>
        {state}
        {copy}
        <span className="sess-where">{[s.machine, place].filter(Boolean).join(" · ")}</span>
      </>
    );
  // The bar keeps where and how much; the model, the age and the counts are its tooltip.
  const more = [
    s.model && modelShort(s.model),
    `started ${new Date(s.startedAt).toLocaleString()}`,
    plural(s.counts.turns, "turn"),
    plural(s.counts.tools, "tool"),
    s.counts.filesChanged > 0 && plural(s.counts.filesChanged, "file"),
    s.counts.subagents > 0 && plural(s.counts.subagents, "subagent"),
    s.counts.compactions > 0 && plural(s.counts.compactions, "compaction"),
    `tier ${s.maxTier}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      {state}
      {copy}
      <span className="sess-counts num" title={more}>
        {s.machine && <span>{s.machine}</span>}
        {place && <span className="sess-repo">{place}</span>}
        <span className="sess-counts-ev">{total} events</span>
        {s.counts.toolErrors > 0 && <span className="is-err">{plural(s.counts.toolErrors, "error")}</span>}
      </span>
    </>
  );
}

/** The tier lens in the bar (Advanced): the segmented control Settings has, as a toolbar
 *  control, with what it takes away beside it. On a phone it lives in "⋯" instead. */
function LensTools({ lens, hidden, maxTier }: { lens: Tier; hidden: number; maxTier: Tier }) {
  return (
    <div className="lens" title={TIER_HINT[lens]}>
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
        {hidden > 0 ? ` · ${hidden} hidden` : ""}
        {lens > maxTier ? ` · arrived at tier ${maxTier}` : ""}
      </span>
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
  kids,
  liveTurn,
  fill,
  label,
  chat = false,
  harness = "",
}: {
  turn: Turn;
  lens: Tier;
  kids: SessionSummary[];
  liveTurn: boolean;
  fill: Fill;
  label: string;
  /** Simple mode: the turn as a chat exchange (see ChatTurn). */
  chat?: boolean;
  harness?: string;
}) {
  // Only a running turn or a running tool shows a moving duration; the other blocks
  // (most of the page) have nothing to redraw each second.
  const hasRunningTool = turn.items.some((i) => i.kind === "tool" && !i.ended);
  const now = useNow(liveTurn || hasRunningTool ? "fine" : "off");
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
        promptChars={promptChars}
        transcript={transcript}
        progress={progress}
        ended={ended}
      />
    );

  return (
    <li className={`turn ${liveTurn ? "turn--live" : ""} ${turn.n === 0 ? "turn--pre" : ""}`}>
      <TurnHead label={label} start={turn.start} elapsed={elapsed} running={liveTurn && !ended} />
      {turn.start &&
        (prompt ? (
          <Prompt text={prompt} seq={startSeq} />
        ) : (
          <p className="prompt prompt--hidden">
            {promptChars !== undefined ? `A prompt of ${promptChars} characters` : "A prompt"}
          </p>
        ))}
      <ol className="turn-items">
        {turn.items.map((it) => {
          if (it.kind === "tool") return <ToolRow key={it.key} item={it} lens={lens} now={now} fill={fill} />;
          const e = it.e;
          if (e.type === "turn.progress") return null;
          if (e.type === "turn.transcript") {
            if (it !== transcript) return null;
            return <Reply key={it.key} e={e} turnSeq={startSeq} fill={fill} />;
          }
          if (e.type === "turn.ended") return <EndMarker key={it.key} e={e} />;
          if (e.type === "attention.needed") return <AttentionMarker key={it.key} e={e} />;
          if (e.type === "subagent.started" || e.type === "subagent.ended")
            return <AgentMarker key={it.key} e={e} kids={kids} />;
          return <EventMarker key={it.key} e={e} />;
        })}
        {progress && String(progress.e.data.assistant ?? "").trim() && (
          <Reply e={progress.e} turnSeq={startSeq} fill={fill} live />
        )}
      </ol>
    </li>
  );
}

/** A turn's section head: its number, when it started and how long it ran. Sticky under
 *  the bar, so the turn a row belongs to is always in sight. */
function TurnHead({
  label,
  start,
  elapsed,
  running,
}: {
  label: string;
  start?: StoredEvent;
  elapsed?: number;
  running: boolean;
}) {
  const { path } = useTimeline();
  const seq = start?.session.seq;
  const menu = useContextMenu(() => [
    copyItem("Copy link to this turn", seqLink(path, seq)),
    start && copyItem("Copy time", start.time),
  ]);
  return (
    <header className="turn-head" data-seq={seq} {...menu}>
      <span className="turn-n">{label}</span>
      {running && <Spinner label="turn running" />}
      <span className="turn-facts num">
        {start && <span className="turn-time">{clock(start.time)}</span>}
        {elapsed !== undefined && <span className="turn-dur">{dur(elapsed)}</span>}
      </span>
    </header>
  );
}

/** The person's prompt: a well in the timeline, a bubble in the chat. */
function Prompt({ text, seq, bubble = false }: { text: string; seq?: number; bubble?: boolean }) {
  const { path, root } = useTimeline();
  // A message sent through sessionpipe arrives framed ("Message via … (sessionpipe
  // control, …):"); the words show as written, and where they came from as a quiet line.
  const { text: words, via } = unframe(text);
  const menu = useContextMenu(() => [
    copyItem("Copy message", words),
    copyItem("Copy link to this turn", seqLink(path, seq)),
    { sep: true },
    controlItems(root.current).send,
  ]);
  return (
    <blockquote className={bubble ? "chat-bubble" : "prompt"} {...menu}>
      <PromptBody text={words} />
      {via && <span className="prompt-via">Sent from {via}</span>}
    </blockquote>
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
  const { path } = useTimeline();
  const text = String(e.data.assistant ?? "");
  const cut = e.preview?.assistant !== undefined;
  const menu = useContextMenu(() => [
    copyItem(cut ? "Copy reply (preview)" : "Copy reply", text),
    copyItem("Copy link to this turn", seqLink(path, turnSeq ?? e.session.seq)),
    cut && { sep: true },
    cut && { label: "Load full text", run: () => fill(e) },
  ]);
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

/** The leading columns every timeline row shares: the time, then a 16 px glyph. */
function Lead({ time, children }: { time?: string; children?: ReactNode }) {
  return (
    <>
      <span className="marker-time num">{time ? clock(time) : ""}</span>
      <span className="marker-glyph">{children}</span>
    </>
  );
}

/** A prompt the agent raised: the amber glyph in the gutter (no stripe), the kind and the
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
    return [...(isOpen && s ? answerItems(root.current, s, id) : []), { sep: true }, copyItem("Copy message", message)];
  });
  return (
    <li className={`marker marker--attn ${isOpen ? "is-open" : ""}`} data-seq={e.session.seq} {...menu}>
      <Lead time={e.time}>
        <StateDot state={isOpen ? "needs_you" : "idle"} decorative />
      </Lead>
      <span className="marker-body">
        <span className="marker-kind">{cap(ATTENTION_LABEL[kind] ?? kind)}</span>
        {tool && <code>{tool}</code>}
        {shown && (
          <span className="marker-msg">
            <Redacted text={shown} />
          </span>
        )}
      </span>
    </li>
  );
}

function AgentMarker({ e, kids }: { e: StoredEvent; kids: SessionSummary[] }) {
  const agentId = String(e.data.agent_id ?? "");
  const kid = agentId ? kids.find((k) => k.id.includes(agentId)) : undefined;
  const menu = useContextMenu(() =>
    kid
      ? [
          { label: "Open subagent", run: () => navigate(sessionPath(kid.harness, kid.id)) },
          { label: "Open subagent beside", run: () => openSplit(kid.key) },
        ]
      : [copyItem("Copy event as JSON", JSON.stringify(e, null, 2)), copyItem("Copy time", e.time)],
  );
  return (
    <li className="marker marker--agent" data-seq={e.session.seq} {...menu}>
      <Lead time={e.time}>
        <span aria-hidden="true">↳</span>
      </Lead>
      <span className="marker-body">
        <span>
          {cap(String(e.data.agent_type ?? "subagent"))} {e.type === "subagent.started" ? "started" : "ended"}
        </span>
        {kid && (
          <Link to={sessionPath(kid.harness, kid.id)} className="marker-link">
            Open
          </Link>
        )}
      </span>
    </li>
  );
}

function EndMarker({ e }: { e: StoredEvent }) {
  const reason = String(e.data.reason ?? "stop");
  const err = e.data.error as string | undefined;
  const menu = useContextMenu(() => [
    copyItem("Copy event as JSON", JSON.stringify(e, null, 2)),
    copyItem("Copy time", e.time),
  ]);
  return (
    <li className={`marker marker--end ${reason === "error" ? "is-err" : ""}`} data-seq={e.session.seq} {...menu}>
      <Lead time={e.time} />
      <span className="marker-body">
        <span>
          {reason === "error" ? "Turn ended with an error" : "Turn ended"}
          {reason !== "error" && reason !== "stop" ? ` · ${reason}` : ""}
          {err ? ` · ${err}` : ""}
        </span>
      </span>
    </li>
  );
}

function EventMarker({ e }: { e: StoredEvent }) {
  const menu = useContextMenu(() => [
    copyItem("Copy event as JSON", JSON.stringify(e, null, 2)),
    copyItem("Copy time", e.time),
  ]);
  return (
    <li className={`marker marker--${e.type.split(".")[0]}`} data-seq={e.session.seq} {...menu}>
      <Lead time={e.time} />
      <span className="marker-body">
        <span className="marker-type mono">{e.type}</span>
        <span className="marker-msg">
          <Redacted text={eventSummary(e)} />
        </span>
      </span>
    </li>
  );
}

/** One turn as a chat exchange (Simple mode): the time centred over it (as Messages does),
 *  the prompt as a bubble on the right, then under the harness's mark and name the turn's
 *  tools folded into one quiet line ("Ran 4 tools"), and the reply as plain prose. The
 *  open permission is the docked bar's, so it is not repeated here; an answered one is a
 *  quiet note. While the agent works, one "Working…" line. */
function ChatTurn({
  turn,
  lens,
  liveTurn,
  fill,
  now,
  harness,
  prompt,
  promptChars,
  transcript,
  progress,
  ended,
}: {
  turn: Turn;
  lens: Tier;
  liveTurn: boolean;
  fill: Fill;
  now: number;
  harness: string;
  prompt: string | undefined;
  promptChars: number | undefined;
  transcript: EventItem | undefined;
  progress: EventItem | undefined;
  ended: EventItem | undefined;
}) {
  const { open, working } = useTimeline();
  const tools = turn.items.filter((i): i is ToolItem => i.kind === "tool");
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
  const agent = tools.length > 0 || !!replyText || busy || notes.length > 0 || !!endErr;
  // Before the first turn there is nothing a chat shows (session markers stay out of it).
  if (!turn.start && !agent) return null;
  return (
    <li className={`turn turn--chat ${liveTurn ? "turn--live" : ""}`} data-seq={startSeq}>
      {turn.start && (
        <div className="chat-you">
          <time className="chat-time num" dateTime={turn.start.time}>
            {clock(turn.start.time).slice(0, 5)}
          </time>
          {prompt ? (
            <Prompt text={prompt} seq={startSeq} bubble />
          ) : (
            <p className="chat-bubble chat-bubble--hidden">
              {promptChars !== undefined ? `A prompt of ${promptChars} characters` : "A prompt"}
            </p>
          )}
        </div>
      )}
      {agent && (
        <div className="chat-ai">
          <span className="chat-meta">
            <HarnessGlyph name={harness} size="sm" />
            {harnessMark(harness).label}
          </span>
          {tools.length > 0 && <ChatTools tools={tools} lens={lens} now={now} fill={fill} />}
          {notes.map((it) => (
            <p key={it.key} className="chat-note" data-seq={it.e.session.seq}>
              {cap(ATTENTION_LABEL[String(it.e.data.kind)] ?? String(it.e.data.kind))}
              {typeof it.e.data.tool === "string" ? ` · ${it.e.data.tool}` : ""}
            </p>
          ))}
          {endErr && <p className="chat-err">The turn ended with an error · {endErr}</p>}
          {replyItem && replyText && <Reply e={replyItem.e} turnSeq={startSeq} fill={fill} live={!transcript} chat />}
          {busy && (
            <p className="chat-working">
              <Spinner label="working" />
              Working…
            </p>
          )}
        </div>
      )}
    </li>
  );
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
  const name = running ? String((running.started ?? running.ended)?.data.tool ?? "a tool") : "";
  return (
    <details className="chat-tools" ref={ref}>
      <summary className="chat-tools-sum" {...menu}>
        <Chevron />
        {running ? (
          <>
            <Spinner />
            <span>
              Running {name}
              {tools.length > 1 ? ` · ${plural(tools.length - 1, "more tool")}` : ""}
            </span>
          </>
        ) : (
          <span>Ran {plural(tools.length, "tool")}</span>
        )}
        {errors > 0 && <span className="is-err">{errors} failed</span>}
      </summary>
      <ol className="turn-items">
        {tools.map((it) => (
          <ToolRow key={it.key} item={it} lens={lens} now={now} fill={fill} />
        ))}
      </ol>
    </details>
  );
}

function Chevron() {
  return (
    <svg className="chev" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
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

/** The one line a tool's input reads as: its command, path, pattern or address. */
function toolSubject(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.split("\n")[0]!;
  }
  return "";
}

function ToolRow({ item, lens, now, fill }: { item: ToolItem; lens: Tier; now: number; fill: Fill }) {
  const e = item.ended ?? item.started!;
  const tool = String(e.data.tool);
  const running = !item.ended;
  const ok = item.ended ? item.ended.data.ok !== false : undefined;
  const msv = item.ended ? (item.ended.data.ms as number | undefined) : now - ms(item.started?.time);
  const input = lens >= 3 ? (item.ended?.data.input ?? item.started?.data.input) : undefined;
  const output = lens >= 3 ? item.ended?.data.output : undefined;
  const error = item.ended?.data.error as string | undefined;
  const agent = typeof e.data.agent_id === "string";
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
  const head = (
    <>
      <span className="tool-time num">{clock((item.started ?? item.ended)!.time)}</span>
      <span
        className={`tool-status ${running ? "is-run" : ok ? "is-ok" : "is-err"}`}
        role="img"
        aria-label={running ? "running" : ok ? "ok" : "error"}
      >
        {running ? <Spinner /> : ok ? "✓" : "✕"}
      </span>
      <span className="tool-main">
        <code className="tool-name">{tool}</code>
        {agent && <span className="tool-agent">subagent</span>}
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
              <span className="tool-io-label">Input</span>
              <pre>
                <Redacted text={pretty(input)} />
              </pre>
              <Cut e={inputEvent!} field="input" fill={fill} />
            </div>
          )}
          {output !== undefined && (
            <div>
              <span className="tool-io-label">Output</span>
              <pre>
                <Redacted text={pretty(output)} />
              </pre>
              <Cut e={item.ended!} field="output" fill={fill} />
            </div>
          )}
          {error && (
            <div>
              <span className="tool-io-label">Error</span>
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

const pretty = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "preview" in (v as object)) return String((v as { preview: unknown }).preview);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};
