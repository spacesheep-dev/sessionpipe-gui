// SPDX-License-Identifier: Apache-2.0
// The toast stack, as the OS's notification banners: top-right on a desktop (left of an
// open panel), prompts nearest the corner, newest first, and passing cards (an error,
// Delivered, "Hidden · Undo") under them; a compact banner under the status bar on a
// phone. On a desktop the stack holds still while it is in use (lib/toasts.ts
// holdToasts): the pointer over it, keyboard focus in it, the window hidden. Nothing
// leaves by itself then, a new card waits, and a card that goes keeps its room until the
// hold ends, so no Allow moves under the hand. Focus that was on a card that goes moves to
// the card now in its place, else back where ⌘⇧T took it from. One banner per moment
// the stream brings after the first snapshot, about a session that is not already on
// screen: an attention opened (Allow / Deny right on it when a control answer can reach
// it, through control/useSend.ts), a turn that ended with an error, a control reply that
// came back delivered from another device; and "Hidden · Undo" after an action that went
// through at once. It leads with what happened ("Needs you on build-box", "Failed on
// studio-mac"), then the session, then the detail; a click opens the session beside the
// page, a right-click has the rest. Opening the session by any path takes its banner
// away. A banner leaves the way it came, then the stack closes over it. The list and its
// rules live in lib/toasts.ts. Allow and Deny are signed and final: never an undo.
// On a phone it is iOS's banner (Banner.tsx), one at a time, the Inbox holding the
// answers; "Hidden · Undo" sits at the bottom, by the thumb that just swiped. A session
// set to Never (its own "Notify me", or a parent's) raises no banner, so no sound either;
// it still waits in Needs you and the Inbox. In the Mac app a prompt whose notification
// macOS sounds for is a silent banner here (lib/systemSound.ts).
import type { ControlActivity, SessionKey, SessionSummary, StoredEvent } from "@shared/api";
import { splitKey } from "@shared/api";
import {
  type FocusEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type OpenAttention, openAttentions, useAppState, useStore } from "../data/hooks";
import { phoneLayout, usePhoneLayout } from "../lib/device";
import { ATTENTION_LABEL, attentionMessage, isQuestion, oneLine, sessionTitle, toolLabel } from "../lib/format";
import { lazyModule, whenIdle } from "../lib/lazy";
import { toastAllowed } from "../lib/marks";
import { reducedMotion, tokenMs } from "../lib/motion";
import { SPLIT_ACTIVE_PARAM, SPLIT_PARAM, sessionPath, usePath } from "../lib/router";
import { hintFor, useShortcut } from "../lib/shortcuts";
import { installSoundUnlock, type SoundKind, useSounds } from "../lib/sounds";
import { parseSplit } from "../lib/split";
import { followSystemSound, systemSound } from "../lib/systemSound";
import {
  dismissForSession,
  dismissToast,
  holdToasts,
  isOwnSend,
  pruneAttentionToasts,
  pushToast,
  returnFromToasts,
  runUndo,
  type Toast,
  undoLatest,
  useToasts,
  useToastsHeld,
} from "../lib/toasts";
import { answerable } from "./ControlStrip";
import type { ToastCard as ToastCardType } from "./ToastCard";

const attKey = (r: OpenAttention): string => `${r.session.key}|${r.attention.attentionId}`;

/** The session a person is looking at right now: its page, or the panel's active tab. A
 *  banner about it would say what is already in front of them. */
function onScreen(key: SessionKey | undefined): boolean {
  if (!key || typeof document === "undefined" || document.visibilityState === "hidden") return false;
  const { harness, id } = splitKey(key);
  if (location.pathname === sessionPath(harness, id)) return true;
  const q = new URLSearchParams(location.search);
  const split = parseSplit(q.get(SPLIT_PARAM), q.get(SPLIT_ACTIVE_PARAM));
  return split.tabs[split.active] === key;
}

/** What happened, as the banner's first words. */
const ATTENTION_VERB: Record<string, string> = {
  permission: "Needs you",
  question: "Asks you",
  error: "Hit an error",
  idle: "Waiting for you",
};

const soundFor = (kind: string): SoundKind =>
  kind === "permission" ? "needsYou" : kind === "error" ? "error" : "question";

function attentionToast(r: OpenAttention): Toast {
  const { session: s, attention: a } = r;
  const msg = attentionMessage(a);
  // Claude Code asks its questions as permissions: a question's banner and sound.
  const kind = isQuestion(a) ? "question" : a.kind;
  return {
    id: `att|${attKey(r)}`,
    kind: "needs-you",
    sticky: true,
    session: s.key,
    attentionId: a.attentionId,
    answerable: r.answerable,
    title: sessionTitle(s),
    machine: s.machine,
    verb: ATTENTION_VERB[kind] ?? "Needs you",
    label: ATTENTION_LABEL[kind] ?? kind,
    tool: a.tool ? toolLabel(a.tool) : undefined,
    body: msg
      ? oneLine(msg, 160)
      : a.tool
        ? undefined
        : r.answerable
          ? "A permission request"
          : "Waiting in the terminal",
    // In the Mac app the system's banner for this prompt plays the sound: once is enough.
    sound: systemSound(a.kind) ? undefined : soundFor(kind),
    at: Date.now(),
  };
}

function errorToast(e: StoredEvent, s: SessionSummary): Toast {
  const err = typeof e.data.error === "string" ? e.data.error : undefined;
  return {
    id: `err|${s.key}|${e.id}`,
    kind: "error",
    sticky: false,
    session: s.key,
    title: sessionTitle(s),
    machine: s.machine,
    verb: "Failed",
    label: "error",
    body: err ? `The turn ended with an error: ${err}` : "The turn ended with an error",
    sound: "error",
    at: Date.now(),
  };
}

function deliveredToast(a: ControlActivity, sessions: ReadonlyMap<SessionKey, SessionSummary>): Toast {
  const s = a.session ? sessions.get(a.session) : undefined;
  const key = a.kind === "key.add";
  return {
    id: `ctl|${a.id}`,
    kind: "delivered",
    sticky: false,
    session: s?.key ?? a.session,
    title: s ? sessionTitle(s) : key ? "A new device" : "A message",
    machine: s?.machine,
    verb: a.kind === "start" ? "Started" : a.reply ? "Replied" : key ? "Trusted" : "Delivered",
    label: "delivered",
    body: a.reply
      ? oneLine(a.reply, 160)
      : key
        ? "The machine takes its commands from now on"
        : `It reached ${s?.machine ?? "the machine"}`,
    sound: "done",
    at: Date.now(),
  };
}

/** Watches the store for the moments that toast. The first snapshot only seeds what is
 *  known; from then on every attention the stream opens, every error turn and every
 *  reply delivered to a message another device sent becomes a card. */
function useToastEffects(): void {
  const store = useStore();
  useEffect(() => {
    /** Open attention keys; null until the first snapshot seeds it. */
    let known: Set<string> | null = null;
    /** Control message id → the outcome last seen. */
    let outcomes = new Map<string, string | undefined>();
    /** A banner, unless its session is set to Never. */
    const push = (t: Toast) => {
      const st = store.get();
      if (toastAllowed(t, st.marks, st.sessions)) pushToast(t);
    };
    const check = () => {
      const st = store.get();
      if (!st.snapshotAt) return;
      const rows = openAttentions(st.sessions);
      const ids = new Set(rows.map(attKey));
      const next = new Map(st.control.map((a) => [a.id, a.outcome]));
      if (known === null) {
        known = ids;
        outcomes = next;
        return;
      }
      const fresh = rows.filter((r) => !known?.has(attKey(r)));
      known = ids;
      // Oldest first, so the newest ends up nearest the corner. Nothing for a session the
      // person is already looking at.
      for (const r of fresh.reverse()) {
        // Nobody attends an unattended run (`attended: false`): the Inbox has it, no banner.
        if (onScreen(r.session.key) || r.session.attended === false) continue;
        // An older server may pass on a harness's notification about a prompt already
        // open as an answerable one (readings.ts folds these): one card, not two. By the
        // protocol's word, so a question, answered on its computer, folds its twin too.
        const hook = (x: OpenAttention) => x.attention.kind === "permission" && answerable(x.attention);
        const twin =
          r.attention.kind === "permission" && !hook(r) && rows.some((x) => x.session.key === r.session.key && hook(x));
        if (!twin) push(attentionToast(r));
      }
      pruneAttentionToasts(ids);
      for (const a of st.control) {
        const before = outcomes.get(a.id);
        const seen = outcomes.has(a.id);
        // A pool command's delivery is the section's to show (the hello redraws it): no toast.
        if (
          a.outcome === "delivered" &&
          a.kind !== "pool" &&
          seen &&
          before !== "delivered" &&
          !isOwnSend(a.id) &&
          !onScreen(a.session)
        )
          push(deliveredToast(a, st.sessions));
      }
      outcomes = next;
    };
    check();
    const offState = store.subscribe(check);
    const offEvents = store.onEvent((e, s) => {
      if (known === null || s.parentId || s.attended === false) return;
      if (e.type === "turn.ended" && e.data.reason === "error" && !onScreen(s.key)) push(errorToast(e, s));
    });
    return () => {
      offState();
      offEvents();
    };
  }, [store]);
}

/** The banners on screen: the live ones, and for a moment the ones that just left, so
 *  each plays its exit (pop-out, then the stack closes over its height) where it stood.
 *  While `held` one that left keeps its room (its slot `data-held`) and closes over it
 *  once the hold ends. */
function useLeaving(list: readonly Toast[], held = false): { toast: Toast; closing: boolean }[] {
  const shown = useRef<{ toast: Toast; closing: boolean; at: number }[]>([]);
  const wasHeld = useRef(held);
  const [, bump] = useState(0);
  const ids = new Set(list.map((t) => t.id));
  const byId = new Map(list.map((t) => [t.id, t]));
  const now = Date.now();
  // Let go: the rooms kept start closing now.
  const released = wasHeld.current && !held;
  wasHeld.current = held;
  const next = shown.current
    .map((e) =>
      ids.has(e.toast.id)
        ? { toast: byId.get(e.toast.id)!, closing: false, at: 0 }
        : e.closing
          ? released
            ? { ...e, at: now }
            : e
          : { ...e, closing: true, at: now },
    )
    .filter((e) => !e.closing || held || (!reducedMotion() && now - e.at < LEAVE_MS));
  const had = new Set(next.map((e) => e.toast.id));
  for (const t of list) if (!had.has(t.id)) next.push({ toast: t, closing: false, at: 0 });
  shown.current = next;
  const closing = !held && next.some((e) => e.closing);
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => bump((n) => n + 1), LEAVE_MS);
    return () => window.clearTimeout(t);
  });
  return next;
}

/** How long after the pointer leaves the stack it lets go: the gap between two cards is
 *  not a leaving. */
const POINTER_RELEASE_MS = 300;

/** The desktop stack's hold (lib/toasts.ts holdToasts) and its focus: held while a mouse
 *  is over it, keyboard focus is in it, or the window is hidden. Focus on a card that goes
 *  moves to the card now in its place, else back where it came from (returnFromToasts).
 *  Only while focus is still the stack's or nobody's: what took it (Open beside) keeps it. */
function useStackHold(stack: RefObject<HTMLElement | null>, on: boolean, shown: { toast: Toast; closing: boolean }[]) {
  const release = useRef<number | undefined>(undefined);
  /** The card keyboard focus is on. */
  const focused = useRef<string | null>(null);
  /** The last input was a key, not a pointer: the focus it moves is the keyboard's. Kept
   *  here rather than read from `:focus-visible`, whose match after a script's focus (⌘⇧T)
   *  differs from engine to engine. */
  const viaKeys = useRef(false);
  useEffect(() => {
    if (!on) return;
    const vis = () => holdToasts("hidden", document.visibilityState === "hidden");
    const key = () => {
      viaKeys.current = true;
    };
    const point = () => {
      viaKeys.current = false;
    };
    vis();
    document.addEventListener("visibilitychange", vis);
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", point, true);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", point, true);
      window.clearTimeout(release.current);
      holdToasts("hidden", false);
      holdToasts("pointer", false);
      holdToasts("focus", false);
    };
  }, [on]);
  const live = shown.length > 0;
  useEffect(() => {
    if (!live) return;
    // A stack taken away under the pointer or focus fires no leave: it lets go here.
    return () => {
      window.clearTimeout(release.current);
      holdToasts("pointer", false);
      holdToasts("focus", false);
    };
  }, [live]);
  useLayoutEffect(() => {
    // Read before a card goes inert: that can blur its button at once.
    const id = focused.current;
    const el = stack.current;
    // A card on its way out can neither keep focus nor take it. The card, not its slot: a
    // held slot still holds the pointer (an inert one is not under it).
    if (el)
      for (const slot of el.querySelectorAll<HTMLElement>(".toast-slot")) {
        const card = slot.firstElementChild;
        if (card instanceof HTMLElement) card.inert = slot.hasAttribute("data-closing");
      }
    if (!id) {
      // Nothing is the keyboard's: the focus hold ends once focus is no longer in the stack
      // (a card that left with it took its blur along).
      if (!el?.contains(document.activeElement)) holdToasts("focus", false);
      return;
    }
    if (shown.some((e) => e.toast.id === id && !e.closing)) return;
    focused.current = null;
    const a = document.activeElement;
    if (a && a !== document.body && !el?.contains(a)) {
      holdToasts("focus", false);
      return;
    }
    // The card now in its place: the next one down (the list is in the order drawn), which
    // moves up into the room once the hold ends; else the one above it.
    const slots = el ? [...el.querySelectorAll<HTMLElement>(".toast-slot")] : [];
    const at = slots.findIndex((s) => s.dataset.toastId === id);
    const alive = (s: HTMLElement) => !s.hasAttribute("data-closing");
    const after = at < 0 ? slots.filter(alive) : slots.slice(at + 1).filter(alive);
    const before = at < 0 ? [] : slots.slice(0, at).filter(alive).reverse();
    const to = [...after, ...before]
      .map((s) => s.querySelector<HTMLElement>("button:not([disabled])"))
      .find((b): b is HTMLElement => !!b);
    if (to) to.focus({ preventScroll: true });
    else returnFromToasts();
  });
  if (!on) return {};
  return {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      window.clearTimeout(release.current);
      holdToasts("pointer", true);
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      window.clearTimeout(release.current);
      release.current = window.setTimeout(() => holdToasts("pointer", false), POINTER_RELEASE_MS);
    },
    onFocus: (e: FocusEvent) => {
      // The keyboard's focus only: a click that focuses a button (Chromium) is the pointer's,
      // and the pointer's own hold covers it, so the keyboard's lets go.
      const keys = viaKeys.current;
      focused.current = keys
        ? ((e.target as HTMLElement).closest<HTMLElement>("[data-toast-id]")?.dataset.toastId ?? null)
        : null;
      holdToasts("focus", keys);
    },
    onBlur: (e: FocusEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      // A card going takes its focus with it: the layout effect above says where it goes.
      if (!e.relatedTarget && (e.target as HTMLElement).closest("[data-closing]")) return;
      focused.current = null;
      holdToasts("focus", false);
    },
  };
}
/** The exit (--dur-exit) and the collapse after it. */
const LEAVE_MS = tokenMs("--dur-exit", 140) + 140;

/** The Inbox lists every prompt: a banner about one would repeat the page. */
const onInbox = (path: string): boolean => path.split("?")[0] === "/inbox";

/** What a phone shows of the list: the newest banner (one at a time, as iOS does) and the
 *  newest undo; on the Inbox no prompt banner at all. */
function phoneList(list: readonly Toast[], path: string): Toast[] {
  const banner = [...list].reverse().find((t) => t.kind !== "undo" && !(t.attentionId && onInbox(path)));
  const undo = [...list].reverse().find((t) => t.kind === "undo");
  return list.filter((t) => t === banner || t === undo);
}

/** A banner's code is the screen's own: the phone's (Banner.tsx) or the desktop's
 *  (ToastCard.tsx), fetched when the page is idle after load. A banner only ever follows
 *  the first snapshot, so it is in long before the first one is drawn. */
const banner = lazyModule(() => import("./Banner"));
const card = lazyModule(() => import("./ToastCard"));
if (typeof window !== "undefined") whenIdle(() => void (phoneLayout() ? banner : card).preload().catch(() => {}));

/** The banner once its module is in (a few ms after the first ask, if not warmed yet). */
function PhoneBanner(p: { toast: Toast; closing: boolean }) {
  const m = banner.use();
  return m ? <m.Banner {...p} /> : null;
}
function DesktopCard(p: Parameters<typeof ToastCardType>[0]) {
  const m = card.use();
  return m ? <m.ToastCard {...p} /> : null;
}

export function Toasts() {
  useToastEffects();
  useEffect(() => installSoundUnlock(), []);
  useEffect(followSystemSound, []);
  const list = useToasts();
  const { sessions, machines } = useAppState();
  const sounds = useSounds();
  const phone = usePhoneLayout();
  // A session opened by any path takes its banner away.
  const path = usePath();
  useEffect(() => {
    void path;
    for (const t of list) if (t.session && onScreen(t.session) && t.kind !== "undo") dismissForSession(t.session);
  }, [path, list]);
  // A phone keeps one banner: a newer one replaces it (the older prompt is in the Inbox),
  // and on the Inbox the list says it already.
  const visible = phone ? phoneList(list, path) : list;
  useEffect(() => {
    if (!phone) return;
    for (const t of list) if (t.kind !== "undo" && !visible.includes(t)) dismissToast(t.id);
  });
  // ⌘Z: the newest undo on screen (a text field keeps its own).
  useShortcut("undo", () => (undoLatest() ? undefined : false));
  const held = useToastsHeld() && !phone;
  const leaving = useLeaving(visible, held);
  // The phone's undo sits at the bottom, after the banner. On a desktop the list is in the
  // order drawn, from the corner down (so Tab and ⌘⇧T meet the newest prompt first): the
  // prompts, newest first, then the passing cards under them, so a card that passes never
  // moves a prompt's Allow.
  const newest = [...leaving].reverse();
  const shown = phone
    ? [...leaving.filter((e) => e.toast.kind !== "undo"), ...leaving.filter((e) => e.toast.kind === "undo")]
    : [...newest.filter((e) => e.toast.sticky), ...newest.filter((e) => !e.toast.sticky)];
  const stackRef = useRef<HTMLElement>(null);
  const hold = useStackHold(stackRef, !phone, shown);
  if (shown.length === 0) return null;
  // Above the cards on a desktop; the phone's sits over the tab bar.
  const unlock = sounds.on && sounds.wanted && !sounds.unlocked && (
    <p className="toast-unlock">
      {phone ? "Tap anywhere once to turn sound on" : "click anywhere once to enable sound"}
    </p>
  );
  return (
    <section ref={stackRef} className={`toasts${phone ? " toasts--phone" : ""}`} aria-label="Notifications" {...hold}>
      {unlock}
      {shown.map(({ toast: t, closing }) => (
        <div
          key={t.id}
          className={`toast-slot${t.kind === "undo" ? " toast-slot--undo" : ""}`}
          data-toast-id={t.id}
          data-closing={closing ? "" : undefined}
          data-held={closing && held ? "" : undefined}
        >
          {t.kind === "undo" ? (
            <UndoCard toast={t} />
          ) : phone ? (
            <PhoneBanner toast={t} closing={closing} />
          ) : (
            <DesktopCard
              toast={t}
              session={t.session ? sessions.get(t.session) : undefined}
              control={(k) => machines.get(k)?.control}
            />
          )}
        </div>
      ))}
    </section>
  );
}

/** "Hidden · Undo": one line, what happened and to what, and the way back. */
function UndoCard({ toast: t }: { toast: Toast }) {
  return (
    <div className="toast toast--undo" data-toast="undo" role={t.quiet ? undefined : "status"}>
      <span className="toast-undo-text">
        <span className="toast-head">{t.title}</span>
        {t.body && <span className="toast-undo-what"> · {t.body}</span>}
      </span>
      <button
        type="button"
        className="btn btn--sm btn--ghost toast-undo"
        data-tip={t.quiet ? "Undo" : undefined}
        data-tip-keys={t.quiet ? hintFor("undo") || undefined : undefined}
        onClick={() => runUndo(t.id)}
      >
        Undo
      </button>
    </div>
  );
}
