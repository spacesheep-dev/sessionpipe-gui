// SPDX-License-Identifier: Apache-2.0
// A desktop's notification banner (Toasts.tsx draws it with a pointer-sized screen only, so
// its code loads there alone, warmed at idle, long before a first banner can arrive): what
// happened and where, the session, the detail; Allow and Deny right on it when a control
// answer can reach it (control/useSend.ts). A click opens the session beside the page, a
// right-click has the rest.
import type { MachineControl, SessionSummary } from "@shared/api";
import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from "react";
import { answerState, useSessionSend } from "../control/useSend";
import { copyItem } from "../lib/menus";
import { openSplit } from "../lib/split";
import { dismissToast, type Toast } from "../lib/toasts";
import { Redacted } from "./bits";
import { type MenuList, useContextMenu } from "./ContextMenu";
import { LabelDot } from "./LabelDot";
import { answerItems } from "./SessionCard";

/** A shell tool asks to run a command; any other asks to use its input. */
const SHELL = /^(bash|shell|sh|zsh|exec|exec_command|run_terminal_cmd|run_shell_command|terminal)$/i;

export function ToastCard({
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
            <span className={`toast-msg ${t.tool && SHELL.test(t.tool) ? "mono" : ""}`}>
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
