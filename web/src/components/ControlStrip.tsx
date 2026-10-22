// SPDX-License-Identifier: Apache-2.0
// The control affordance on a session, docked at the bottom of the view: an open
// permission as one action bar (the question, Deny and Allow), then the composer, one
// field that grows to six lines with attach, stop and send inside it, then one quiet
// line of context under it. Disabled with its reason until the machine paired and
// `onSend` is wired (web/src/control/SessionControl.tsx signs and sends). Keep this
// component self-contained: everything it needs comes through props.
import type { Attention, MachineControl, SessionSummary, Suggestion } from "@shared/api";
import { type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { AttachButton, AttachmentTray, useAttachments } from "../control/Attachments";
import { httpsHere, wrongOriginHere, wrongOriginHref } from "../control/api";
import { attentionMessage } from "../lib/format";
import { Spinner, StateDot } from "./bits";

export type ControlAction =
  | { kind: "prompt"; text: string }
  | { kind: "permission.answer"; attentionId: string; allow: boolean; note?: string }
  | { kind: "cancel"; note?: string };

export interface ControlStripProps {
  session: SessionSummary;
  /** The session machine's control status, when it paired. */
  control?: MachineControl;
  /** One open attention (kept for callers that pass just the first). */
  attention?: Attention;
  /** Every open attention; the permission ones get an Allow / Deny pair each (CONTROL.md §7). */
  attentions?: Attention[];
  /** Set by the control engineer; while absent the strip is disabled. */
  onSend?: (action: ControlAction) => Promise<void>;
  /** A turn is running: offer Cancel. */
  working?: boolean;
  /** Why nothing here can work (no secure context): replaces the hint and disables the strip. */
  blocked?: string;
  /** One extra line under the hint: an error, or why a passkey prompt is about to appear. */
  note?: string;
  noteKind?: "info" | "err";
  /** Per attention id: "sent" while an answer is out (no second one goes), "closed" once
   *  the machine said the prompt is no longer open (answered in its terminal, or expired). */
  answers?: Readonly<Record<string, "sent" | "closed">>;
  /** Plugins' suggested answers for this session's attentions (shared/plugin-api.ts).
   *  Advice only: Confirm sends the ordinary signed answer through `onSend`. */
  suggestions?: readonly Suggestion[];
  /** The textarea's placeholder; "Ask for the next turn…" by default. */
  placeholder?: string;
  /** Simple mode's composer: the hint folded unless something is wrong. */
  chat?: boolean;
  /** More of the context line under the field (SessionControl's routing and passkey words). */
  foot?: ReactNode;
}

function SendIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="M10 16V4.5M5 9.5l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** An attention raised before the daemon said hello cannot be answered from here: the hook
 *  only waits on the daemon when it was already running. A minute of slack covers the two
 *  clocks (the sender stamps `at`, the receiver stamps the hello). */
export const preHello = (a: Attention, control: MachineControl | undefined): boolean =>
  !!control && (!control.lastHelloAt || Date.parse(a.at) < Date.parse(control.lastHelloAt) - 60_000);

/** Whether a control answer can reach this prompt (shared/api.ts `answerable`). Claude Code
 *  raises two attentions per permission: the hook's (answerable) and a notification about
 *  it (`notif-…`, nobody can answer). An older server leaves the field unset. */
export const answerable = (a: Attention): boolean => a.answerable ?? !a.attentionId.startsWith("notif-");

/** A shell tool, whose message is the command it wants to run. */
const SHELL = /^(bash|shell|sh|zsh|powershell|run_shell_command|exec|terminal)$/i;

/** "Allow Bash to run `npm run deploy`?", or "Allow Write?" with its message after it. */
function Question({ a }: { a: Attention }) {
  if (!a.tool)
    return (
      <>
        Allow this?<span className="ctl-answer-msg"> {a.message ?? "a permission request"}</span>
      </>
    );
  const msg = attentionMessage(a);
  if (msg && SHELL.test(a.tool) && !/\b(permission|wants|needs)\b/i.test(msg))
    return (
      <>
        Allow <span className="ctl-tool">{a.tool}</span> to run <code className="ctl-cmd">{msg}</code>?
      </>
    );
  return (
    <>
      Allow <span className="ctl-tool">{a.tool}</span>?{msg ? <span className="ctl-answer-msg"> {msg}</span> : null}
    </>
  );
}

/** The textarea grows with its text up to six lines, then scrolls (CSS caps it). */
function useGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

export function ControlStrip({
  session,
  control,
  attention,
  attentions,
  onSend,
  working,
  blocked,
  note,
  noteKind = "info",
  answers,
  suggestions,
  placeholder = "Ask for the next turn…",
  chat = false,
  foot,
}: ControlStripProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useGrow(field, text);
  const paired = !!control;
  // The wrong address (control/origin.ts): the hint is the one line naming where sending
  // works, as a link to this very page there; never an offer to add a device.
  const wrong = blocked ? wrongOriginHere() : null;
  const httpsHref = blocked ? (wrong ? wrongOriginHref() : httpsHere()) : null;
  const enabled = paired && !!onSend && !blocked;
  // Images beside the message (control/Attachments.tsx): paperclip, paste, drop, the phone's picker.
  const att = useAttachments({ machine: session.machine, enabled });
  const hint = blocked
    ? blocked
    : !paired
      ? `pair ${session.machine ?? "this machine"} to send messages`
      : !onSend
        ? "sending arrives in the next release"
        : control?.online
          ? `${session.machine} is listening`
          : `${session.machine} is offline; the message waits`;
  // Why Allow / Deny are off, said on their own bar (the line under the field says the rest).
  const offWhy = enabled
    ? null
    : !paired
      ? `pair ${session.machine ?? "this machine"} to answer here`
      : blocked
        ? wrong
          ? "answer it where sending works"
          : "this page cannot sign an answer"
        : "sending arrives in the next release";
  const permissions = (attentions ?? (attention ? [attention] : [])).filter((a) => a.kind === "permission");
  // The answerable prompt(s) only; a notification twin adds nothing. With no answerable one,
  // the notification is shown as what it is: a prompt waiting in the terminal.
  const open = permissions.some(answerable) ? permissions.filter(answerable) : permissions;
  const canSend = enabled && !busy && !att.uploading && (!!text.trim() || att.items.length > 0);

  const run = (id: string, action: ControlAction, after?: () => void) => {
    if (!enabled || busy) return;
    if (action.kind === "permission.answer" && answers?.[action.attentionId]) return;
    setBusy(id);
    void onSend?.(action)
      .then(after)
      .catch(() => {})
      .finally(() => setBusy(null));
  };
  const sendText = () => {
    const t = text.trim();
    if (!t && att.items.length === 0) return;
    // The signed text: the message, then the attachments block (or null while an upload runs).
    const composed = att.compose(t);
    if (!composed) return;
    run("prompt", { kind: "prompt", text: composed.text }, () => {
      setText("");
      att.clear();
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendText();
    }
  };

  return (
    <form
      className={`ctl ${enabled ? "" : "ctl--off"} ${blocked ? "ctl--blocked" : ""} ${chat ? "ctl--chat" : ""} ${att.dragging ? "ctl--drop" : ""}`}
      aria-label="Control"
      {...att.handlers}
      onSubmit={(e) => {
        e.preventDefault();
        sendText();
      }}
    >
      {open.map((a) => {
        const status = answers?.[a.attentionId];
        const terminal = !answerable(a);
        const early = !terminal && preHello(a, control);
        const off = !enabled || !!busy || status === "sent" || early;
        const suggested = suggestions?.find((s) => s.attentionId === a.attentionId);
        const shut = terminal || status === "closed";
        const why = terminal
          ? "waiting in the terminal"
          : status === "closed"
            ? "answered in the terminal, or expired"
            : early
              ? "raised before this machine was paired; answer it in its terminal"
              : status === "sent"
                ? `answer sent · waiting for ${session.machine ?? "the machine"}`
                : offWhy;
        return (
          <div
            className="ctl-answer"
            key={a.attentionId}
            data-attention={a.attentionId}
            data-answer={terminal ? "terminal" : (status ?? (early ? "pre-hello" : "open"))}
          >
            <p className="ctl-q">
              <StateDot state="needs_you" size={8} decorative />
              <span className="ctl-q-text">
                <Question a={a} />
              </span>
            </p>
            {why ? (
              <span className="ctl-answer-note">{why}</span>
            ) : suggested && !shut ? (
              <span
                className="ctl-suggestion"
                data-suggestion={suggested.decision}
                title={`Suggested by the ${suggested.plugin} plugin${suggested.note ? ` · ${suggested.note}` : ""}. Nothing is sent until you confirm with your passkey.`}
              >
                <span className="ctl-suggestion-text">
                  {suggested.decision === "allow" ? "Allow" : "Deny"} suggested by {suggested.by}
                </span>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost ctl-suggestion-confirm"
                  disabled={off}
                  onClick={() =>
                    run(`${suggested.decision}:${a.attentionId}`, {
                      kind: "permission.answer",
                      attentionId: a.attentionId,
                      allow: suggested.decision === "allow",
                      ...(suggested.note ? { note: suggested.note } : {}),
                    })
                  }
                >
                  Confirm
                </button>
              </span>
            ) : null}
            {!shut && (
              <span className="ctl-answer-btns">
                <button
                  type="button"
                  className="btn btn--deny"
                  disabled={off}
                  onClick={() =>
                    run(`deny:${a.attentionId}`, {
                      kind: "permission.answer",
                      attentionId: a.attentionId,
                      allow: false,
                    })
                  }
                >
                  {busy === `deny:${a.attentionId}` ? "Sending…" : "Deny"}
                </button>
                <button
                  type="button"
                  className="btn btn--allow"
                  disabled={off}
                  onClick={() =>
                    run(`allow:${a.attentionId}`, {
                      kind: "permission.answer",
                      attentionId: a.attentionId,
                      allow: true,
                    })
                  }
                >
                  {busy === `allow:${a.attentionId}` ? "Sending…" : "Allow"}
                </button>
              </span>
            )}
          </div>
        );
      })}
      <AttachmentTray att={att} />
      <div className="ctl-ask">
        <AttachButton att={att} disabled={!enabled || !!busy} />
        <textarea
          ref={field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          disabled={!enabled}
          aria-label="Message for the next turn"
          rows={1}
          enterKeyHint="send"
        />
        {working && (
          <button
            type="button"
            className="icon-btn ctl-cancel"
            disabled={!enabled || !!busy}
            onClick={() => run("cancel", { kind: "cancel" })}
            aria-label="Cancel"
            title="Stop the running turn"
          >
            {busy === "cancel" ? <Spinner label="Sending" /> : <StopIcon />}
          </button>
        )}
        <button
          type="submit"
          className={`icon-btn ctl-send ${canSend ? "is-ready" : ""}`}
          disabled={!canSend}
          aria-label="Send"
        >
          {busy === "prompt" ? <Spinner label="Sending" /> : <SendIcon />}
        </button>
      </div>
      <p className="ctl-foot">
        <span
          className={`ctl-hint ${chat && !blocked ? "ctl-hint--quiet" : ""}`}
          data-wrong-origin={wrong ? "" : undefined}
        >
          {wrong ? (
            <>
              Sending works from{" "}
              <a className="ctl-origin-link" href={httpsHref ?? wrong}>
                {wrong}
              </a>
              ; open it there.
            </>
          ) : (
            hint
          )}
          {blocked && !wrong && httpsHref ? (
            <a className="ctl-open-https" href={httpsHref}>
              Open on {new URL(httpsHref).host}
            </a>
          ) : null}
        </span>
        {foot}
        {note && <span className={`ctl-note ctl-note--${noteKind}`}>{note}</span>}
      </p>
    </form>
  );
}
