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
import type { ControlActivity, MachineControl, SessionKey, SessionSummary, StoredEvent } from "@shared/api";
import { splitKey } from "@shared/api";
import { type MutableRefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { answerState, useSessionSend } from "../control/useSend";
import { type OpenAttention, openAttentions, useAppState, useStore } from "../data/hooks";
import { ATTENTION_LABEL, attentionMessage, oneLine, sessionTitle } from "../lib/format";
import { copyItem } from "../lib/menus";
import { reducedMotion, tokenMs } from "../lib/motion";
import { SPLIT_ACTIVE_PARAM, SPLIT_PARAM, sessionPath, usePath } from "../lib/router";
import { useShortcut } from "../lib/shortcuts";
import { installSoundUnlock, type SoundKind, useSounds } from "../lib/sounds";
import { openSplit, parseSplit } from "../lib/split";
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
import { Redacted } from "./bits";
import { type MenuList, useContextMenu } from "./ContextMenu";
import { LabelDot } from "./LabelDot";
import { answerItems } from "./SessionCard";

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
    tool: a.tool,
    body: a.message
      ? oneLine(attentionMessage(a) ?? a.message, 160)
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
  return {
    id: `ctl|${a.id}`,
    kind: "delivered",
    sticky: false,
    session: s?.key ?? a.session,
    title: s ? sessionTitle(s) : "a message",
    machine: s?.machine,
    verb: a.kind === "start" ? "Started" : a.reply ? "Replied" : "Delivered",
    label: "delivered",
    body: a.reply ? oneLine(a.reply, 160) : `Your ${a.kind} reached ${s?.machine ?? "the machine"}`,
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
        if (onScreen(r.session.key)) continue;
        // An older server may pass on a harness's notification about a prompt already
        // open as an answerable one (readings.ts folds these): one card, not two.
        const twin =
          !r.answerable &&
          r.attention.kind === "permission" &&
          rows.some((x) => x.session.key === r.session.key && x.answerable);
        if (!twin) pushToast(attentionToast(r));
      }
      pruneAttentionToasts(ids);
      for (const a of st.control) {
        const before = outcomes.get(a.id);
        const seen = outcomes.has(a.id);
        if (a.outcome === "delivered" && seen && before !== "delivered" && !isOwnSend(a.id) && !onScreen(a.session))
          pushToast(deliveredToast(a, st.sessions));
      }
      outcomes = next;
    };
    check();
    const offState = store.subscribe(check);
    const offEvents = store.onEvent((e, s) => {
      if (known === null || s.parentId) return;
      if (e.type === "turn.ended" && e.data.reason === "error" && !onScreen(s.key)) pushToast(errorToast(e, s));
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

export function Toasts() {
  useToastEffects();
  useEffect(() => installSoundUnlock(), []);
  const list = useToasts();
  const { sessions, machines } = useAppState();
  const sounds = useSounds();
  // A session opened by any path takes its banner away.
  const path = usePath();
  useEffect(() => {
    void path;
    for (const t of list) if (t.session && onScreen(t.session) && t.kind !== "undo") dismissForSession(t.session);
  }, [path, list]);
  // ⌘Z: the newest undo on screen (a text field keeps its own).
  useShortcut("undo", () => (undoLatest() ? undefined : false));
  const shown = useLeaving(list);
  if (shown.length === 0) return null;
  return (
    <section className="toasts" aria-label="Notifications">
      {shown.map(({ toast: t, closing }) => (
        <div key={t.id} className="toast-slot" data-closing={closing ? "" : undefined}>
          {t.kind === "undo" ? (
            <UndoCard toast={t} />
          ) : (
            <ToastCard
              toast={t}
              session={t.session ? sessions.get(t.session) : undefined}
              control={(k) => machines.get(k)?.control}
            />
          )}
        </div>
      ))}
      {sounds.on && sounds.wanted && !sounds.unlocked && (
        <p className="toast-unlock">click anywhere once to enable sound</p>
      )}
    </section>
  );
}

/** A shell tool asks to run a command; any other asks to use its input. */
const SHELL = /^(bash|shell|sh|zsh|exec|exec_command|run_terminal_cmd|run_shell_command|terminal)$/i;

function ToastCard({
  toast: t,
  session,
  control,
}: {
  toast: Toast;
  session?: SessionSummary;
  control: (machine: string) => MachineControl | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const open = () => {
    if (!t.session) return;
    openSplit(t.session, { from: ref.current?.getBoundingClientRect() });
    dismissToast(t.id);
  };
  const attention = t.attentionId ? session?.openAttentions.find((a) => a.attentionId === t.attentionId) : undefined;
  const answerMenu = useRef<MenuList>([]);
  const menu = useContextMenu(
    () => [
      t.session && { label: "Open beside", run: open },
      ...answerMenu.current,
      { sep: true },
      { label: "Copy", items: [copyItem("Title", t.title), copyItem("Message", t.body)] },
      { sep: true },
      { label: "Dismiss", run: () => dismissToast(t.id) },
    ],
    { title: () => t.title, subtitle: () => t.machine ?? "" },
  );
  const verb = t.tool ? (SHELL.test(t.tool) ? " wants to run " : " wants to use ") : "";
  const marked = t.kind === "needs-you" || t.kind === "error";
  return (
    <div
      ref={ref}
      className={`toast toast--${t.kind}${marked ? " toast--marked" : ""}`}
      data-toast={t.kind}
      data-session={t.session}
      data-attention={t.attentionId}
      data-sticky={t.sticky ? "true" : undefined}
      role="status"
      {...menu}
    >
      {marked && (
        <span className={`toast-mark toast-mark--${t.kind}`} aria-hidden="true">
          {t.kind === "needs-you" && <span className="toast-dot" />}
        </span>
      )}
      <button
        type="button"
        className="toast-main"
        onClick={open}
        disabled={!t.session}
        title={t.session ? "Open the session beside this page" : undefined}
      >
        <span className="toast-head">
          {t.verb ?? t.label}
          {t.machine && (
            <>
              {" "}
              {t.kind === "delivered" && t.verb === "Delivered" ? "to" : "on"}{" "}
              <span className="toast-machine">{t.machine}</span>
            </>
          )}
        </span>
        <span className="toast-top">
          {t.session && <LabelDot session={t.session} />}
          <span className="toast-title">{t.title}</span>
        </span>
        <span className="toast-body">
          <span className="toast-label sr-only">{t.label}</span>
          {t.tool && <code className="toast-tool">{t.tool}</code>}
          {verb && <span className="toast-verb">{verb}</span>}
          {t.body && (
            <span className={`toast-msg ${t.tool ? "mono" : ""}`}>
              <Redacted text={t.body} />
            </span>
          )}
        </span>
      </button>
      <button type="button" className="icon-btn toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {t.answerable && session && attention && (
        <ToastAnswer
          toast={t}
          session={session}
          attention={attention}
          control={session.machine ? control(session.machine) : undefined}
          into={answerMenu}
        />
      )}
    </div>
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

/** Allow / Deny on the banner, through the same signed send as the session page and the
 *  inbox; the banner leaves once an answer is out. Its menu gets the same two. */
function ToastAnswer({
  toast,
  session: s,
  attention: a,
  control,
  into,
}: {
  toast: Toast;
  session: SessionSummary;
  attention: NonNullable<SessionSummary["openAttentions"]>[number];
  control?: MachineControl;
  into: MutableRefObject<MenuList>;
}) {
  const send = useSessionSend(s, control, s.openAttentions);
  const st = answerState(s, a, control, send);
  const { reason, off, status, tag } = st;
  const answer = (allow: boolean) =>
    void send
      .onSend({ kind: "permission.answer", attentionId: a.attentionId, allow })
      .then(() => dismissToast(toast.id))
      .catch(() => {});
  useLayoutEffect(() => {
    into.current = status === "closed" ? [] : answerItems(a.tool, st, answer);
  });
  useEffect(
    () => () => {
      into.current = [];
    },
    [into],
  );
  return (
    <span className="toast-actions" data-answer={tag}>
      {status !== "closed" && (
        <>
          <button type="button" className="btn btn--sm btn--deny" disabled={off} onClick={() => answer(false)}>
            Deny
          </button>
          <button type="button" className="btn btn--sm btn--allow" disabled={off} onClick={() => answer(true)}>
            Allow
          </button>
        </>
      )}
      {send.error ? (
        <span className="toast-note toast-note--err">{send.error}</span>
      ) : reason ? (
        <span className="toast-note">{reason}</span>
      ) : null}
    </span>
  );
}
