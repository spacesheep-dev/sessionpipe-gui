// SPDX-License-Identifier: Apache-2.0
// The toast stack, as the OS's notification banners: top-right on a desktop (left of an
// open panel), a compact banner under the status bar on a phone. One banner per moment
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
// it still waits in Needs you and the Inbox.
import type { ControlActivity, SessionKey, SessionSummary, StoredEvent } from "@shared/api";
import { splitKey } from "@shared/api";
import { useEffect, useRef, useState } from "react";
import { type OpenAttention, openAttentions, useAppState, useStore } from "../data/hooks";
import { ATTENTION_LABEL, attentionMessage, oneLine, sessionTitle, toolLabel } from "../lib/format";
import { lazyModule, whenIdle } from "../lib/lazy";
import { toastAllowed } from "../lib/marks";
import { reducedMotion, tokenMs } from "../lib/motion";
import { SPLIT_ACTIVE_PARAM, SPLIT_PARAM, sessionPath, usePath } from "../lib/router";
import { useShortcut } from "../lib/shortcuts";
import { installSoundUnlock, type SoundKind, useSounds } from "../lib/sounds";
import { parseSplit } from "../lib/split";
import {
  dismissForSession,
  dismissToast,
  isOwnSend,
  pruneAttentionToasts,
  pushToast,
  runUndo,
  type Toast,
  undoLatest,
  useToasts,
} from "../lib/toasts";
import { PHONE_QUERY, useMedia } from "./Shell";
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

const soundFor = (r: OpenAttention): SoundKind =>
  r.attention.kind === "permission" ? "needsYou" : r.attention.kind === "error" ? "error" : "question";

function attentionToast(r: OpenAttention): Toast {
  const { session: s, attention: a } = r;
  const msg = attentionMessage(a);
  return {
    id: `att|${attKey(r)}`,
    kind: "needs-you",
    sticky: true,
    session: s.key,
    attentionId: a.attentionId,
    answerable: r.answerable,
    title: sessionTitle(s),
    machine: s.machine,
    verb: ATTENTION_VERB[a.kind] ?? "Needs you",
    label: ATTENTION_LABEL[a.kind] ?? a.kind,
    tool: a.tool ? toolLabel(a.tool) : undefined,
    body: msg
      ? oneLine(msg, 160)
      : a.tool
        ? undefined
        : r.answerable
          ? "A permission request"
          : "Waiting in the terminal",
    sound: soundFor(r),
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
        // open as an answerable one (readings.ts folds these): one card, not two.
        const twin =
          !r.answerable &&
          r.attention.kind === "permission" &&
          rows.some((x) => x.session.key === r.session.key && x.answerable);
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
 *  each plays its exit (pop-out, then the stack closes over its height) where it stood. */
function useLeaving(list: readonly Toast[]): { toast: Toast; closing: boolean }[] {
  const shown = useRef<{ toast: Toast; closing: boolean; at: number }[]>([]);
  const [, bump] = useState(0);
  const ids = new Set(list.map((t) => t.id));
  const byId = new Map(list.map((t) => [t.id, t]));
  const now = Date.now();
  const next = shown.current
    .map((e) =>
      ids.has(e.toast.id)
        ? { toast: byId.get(e.toast.id)!, closing: false, at: 0 }
        : e.closing
          ? e
          : { ...e, closing: true, at: now },
    )
    .filter((e) => !e.closing || (!reducedMotion() && now - e.at < LEAVE_MS));
  const had = new Set(next.map((e) => e.toast.id));
  for (const t of list) if (!had.has(t.id)) next.push({ toast: t, closing: false, at: 0 });
  shown.current = next;
  const closing = next.some((e) => e.closing);
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => bump((n) => n + 1), LEAVE_MS);
    return () => window.clearTimeout(t);
  });
  return next;
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
if (typeof window !== "undefined")
  whenIdle(() => void (window.matchMedia?.(PHONE_QUERY).matches ? banner : card).preload().catch(() => {}));

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
  const list = useToasts();
  const { sessions, machines } = useAppState();
  const sounds = useSounds();
  const phone = useMedia(PHONE_QUERY);
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
  const leaving = useLeaving(visible);
  // The phone's undo sits at the bottom, after the banner.
  const shown = phone
    ? [...leaving.filter((e) => e.toast.kind !== "undo"), ...leaving.filter((e) => e.toast.kind === "undo")]
    : leaving;
  if (shown.length === 0) return null;
  return (
    <section className={`toasts${phone ? " toasts--phone" : ""}`} aria-label="Notifications">
      {shown.map(({ toast: t, closing }) => (
        <div
          key={t.id}
          className={`toast-slot${t.kind === "undo" ? " toast-slot--undo" : ""}`}
          data-closing={closing ? "" : undefined}
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
      {sounds.on && sounds.wanted && !sounds.unlocked && (
        <p className="toast-unlock">
          {phone ? "Tap anywhere once to turn sound on" : "click anywhere once to enable sound"}
        </p>
      )}
    </section>
  );
}

/** "Hidden · Undo": one line, what happened and to what, and the way back. */
function UndoCard({ toast: t }: { toast: Toast }) {
  return (
    <div className="toast toast--undo" data-toast="undo" role="status">
      <span className="toast-undo-text">
        <span className="toast-head">{t.title}</span>
        {t.body && <span className="toast-undo-what"> · {t.body}</span>}
      </span>
      <button type="button" className="btn btn--sm btn--ghost toast-undo" onClick={() => runUndo(t.id)}>
        Undo
      </button>
    </div>
  );
}
