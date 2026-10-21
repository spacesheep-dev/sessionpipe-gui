// SPDX-License-Identifier: Apache-2.0
// The control affordance on a session: Ask / Allow / Deny / Cancel. Disabled with a hint
// until the machine paired and `onSend` is wired (web/src/control/SessionControl.tsx
// signs and sends). Keep this component self-contained: everything it needs comes
// through props.
import type { Attention, MachineControl, SessionSummary, Suggestion } from "@shared/api";
import { type KeyboardEvent, useState } from "react";
import { AttachButton, AttachmentTray, useAttachments } from "../control/Attachments";
import { httpsHere, wrongOriginHere, wrongOriginHref } from "../control/api";

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
  /** Simple mode's composer: rounded, a send glyph, the hint folded (SessionControl writes it above). */
  chat?: boolean;
}

function SendIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M2.5 3.2 18 10 2.5 16.8l1.9-5.6L12 10l-7.6-1.2z" />
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
}: ControlStripProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
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
          ? `${session.machine} is listening · Enter sends, Shift+Enter for a new line`
          : `${session.machine} is offline; the message waits`;
  const permissions = (attentions ?? (attention ? [attention] : [])).filter((a) => a.kind === "permission");
  // The answerable prompt(s) only; a notification twin adds nothing. With no answerable one,
  // the notification is shown as what it is: a prompt waiting in the terminal.
  const open = permissions.some(answerable) ? permissions.filter(answerable) : permissions;

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
        return (
          <div
            className="ctl-answer"
            key={a.attentionId}
            data-attention={a.attentionId}
            data-answer={terminal ? "terminal" : (status ?? (early ? "pre-hello" : "open"))}
          >
            <span className="ctl-q">
              Allow {a.tool ? <code>{a.tool}</code> : "this"}?
              {a.message ? (
                <span className="ctl-answer-msg"> {a.message}</span>
              ) : a.tool ? null : (
                <span className="ctl-answer-msg"> a permission request</span>
              )}
            </span>
            {terminal ? (
              <span className="ctl-answer-note">waiting in the terminal</span>
            ) : status === "closed" ? (
              <span className="ctl-answer-note">answered in the terminal, or expired</span>
            ) : (
              <>
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
                {early ? (
                  <span className="ctl-answer-note">
                    raised before this machine was paired; answer it in its terminal
                  </span>
                ) : status === "sent" ? (
                  <span className="ctl-answer-note">answer sent · waiting for {session.machine ?? "the machine"}</span>
                ) : suggested ? (
                  <span
                    className="ctl-suggestion"
                    data-suggestion={suggested.decision}
                    title={`Suggested by the ${suggested.plugin} plugin${suggested.note ? ` · ${suggested.note}` : ""}. Nothing is sent until you confirm with your passkey.`}
                  >
                    <span className="ctl-suggestion-text">
                      {suggested.decision === "allow" ? "Allow" : "Deny"} suggested by {suggested.by}
                    </span>
                    <span aria-hidden="true"> · </span>
                    <button
                      type="button"
                      className="btn btn--sm ctl-suggestion-confirm"
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
              </>
            )}
          </div>
        );
      })}
      <AttachmentTray att={att} />
      <div className="ctl-ask">
        <AttachButton att={att} disabled={!enabled || !!busy} />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          disabled={!enabled}
          aria-label="Message for the next turn"
          rows={1}
          enterKeyHint="send"
        />
        <button
          type="submit"
          className={`btn ${enabled ? "btn--primary" : "btn--ghost"}`}
          disabled={!enabled || !!busy || att.uploading || (!text.trim() && att.items.length === 0)}
        >
          {busy === "prompt" ? "Sending…" : chat ? <SendIcon /> : "Send"}
          {chat && busy !== "prompt" && <span className="sr-only">Send</span>}
        </button>
        {working && (
          <button
            type="button"
            className="btn btn--ghost ctl-cancel"
            disabled={!enabled || !!busy}
            onClick={() => run("cancel", { kind: "cancel" })}
            title="Stop the running turn"
          >
            {busy === "cancel" ? "Sending…" : "Cancel"}
          </button>
        )}
      </div>
      <p className="ctl-hint" data-wrong-origin={wrong ? "" : undefined}>
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
            Open on {new URL(httpsHref).host} →
          </a>
        ) : null}
      </p>
      {note && <p className={`ctl-note ctl-note--${noteKind}`}>{note}</p>}
    </form>
  );
}
