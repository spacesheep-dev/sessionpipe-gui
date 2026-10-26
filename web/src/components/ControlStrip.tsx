// SPDX-License-Identifier: Apache-2.0
// The control affordance on a session, docked at the bottom of the view: an open
// permission as one action bar (the question, Deny and Allow), then the composer, one
// field that grows to 40 % of the view with the images to send, attach, stop and send
// inside it, then at most one quiet line under it: the one reason sending is off or will
// ask for something, with its one action, and nothing at all when all is well. Every
// press shows at once: Allow, Deny, Stop and Send take their pending face until the
// receiver has the signed command, and what the machine did next is said by the
// machine's own acks, never here.
// The draft is kept per session. Disabled with its reason until the machine paired and
// `onSend` is wired (web/src/control/SessionControl.tsx signs and sends). Keep this
// component self-contained: everything it needs comes through props.
import type { Attention, MachineControl, SessionSummary, Suggestion } from "@shared/api";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AttachButton, AttachmentTray, useAttachments } from "../control/Attachments";
import { httpsHere, wrongOriginHere, wrongOriginHref } from "../control/api";
import { SETUP_LABEL, signerKind } from "../control/signer";
import { attentionMessage, toolLabel } from "../lib/format";
import { Link } from "../lib/router";
import { hintFor } from "../lib/shortcuts";
import { ActionButton, Spinner, StateDot } from "./bits";
import "../control/control.css";

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
  /** The line under the field while it says something now: the last send's refusal, or a
   *  passkey prompt being up. It wins over every other reason. */
  note?: string;
  noteKind?: "info" | "err";
  /** This browser holds no passkey the machine trusts (in the app: the machine doesn't
   *  trust this Mac's device key): a send would be refused. */
  untrusted?: boolean;
  /** The app's stream to the receiver is down ("reconnecting" or "offline"): the strip
   *  waits for it, with Retry now. */
  stream?: { state: "reconnecting" | "offline"; retry: () => void };
  /** The next send asks for the passkey (no day grant yet): the line offers Unlock now. */
  unlock?: () => void;
  /** Per attention id: "sent" while an answer is out (no second one goes), "closed" once
   *  the machine said the prompt is no longer open (answered in its terminal, or expired). */
  answers?: Readonly<Record<string, "sent" | "closed">>;
  /** Plugins' suggested answers for this session's attentions (shared/plugin-api.ts).
   *  Advice only: Confirm sends the ordinary signed answer through `onSend`. */
  suggestions?: readonly Suggestion[];
  /** The textarea's placeholder; one voice in both modes. */
  placeholder?: string;
  /** Simple mode's composer (its class only: the words are the same). */
  chat?: boolean;
  /** Unused: the line under the field is the strip's own one reason now. */
  foot?: ReactNode;
}

/** The one line under the field: which reason, its words and its one action. */
interface Reason {
  kind: string;
  text: ReactNode;
  action?: ReactNode;
  tone?: "err";
}

/** A session's unsent draft, kept per device while it is typed (300 ms after the last
 *  key), so a reload or a trip to another page keeps it. */
const DRAFT_KEY = (key: string) => `sessionpipe-gui.draft:${key}`;
function readDraft(key: string): string {
  try {
    return localStorage.getItem(DRAFT_KEY(key)) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_KEY(key), text);
    else localStorage.removeItem(DRAFT_KEY(key));
  } catch {
    // this page only
  }
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

/** Stop as a media control reads: a square in a ring, at the send arrow's size. */
function StopIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="10" cy="10" r="7.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7.25" y="7.25" width="5.5" height="5.5" rx="1" fill="currentColor" />
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
        Allow <span className="ctl-tool">{toolLabel(a.tool)}</span> to run <code className="ctl-cmd">{msg}</code>?
      </>
    );
  return (
    <>
      Allow <span className="ctl-tool">{toolLabel(a.tool)}</span>?
      {msg ? <span className="ctl-answer-msg"> {msg}</span> : null}
    </>
  );
}

/** The textarea grows with its text up to 40 % of the view, then scrolls (CSS caps it). */
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
  placeholder = "Message this session…",
  chat = false,
  untrusted = false,
  stream,
  unlock,
}: ControlStripProps) {
  const [text, setText] = useState(() => readDraft(session.key));
  // The same strip shown for another session takes that session's own draft.
  const [draftOf, setDraftOf] = useState(session.key);
  if (draftOf !== session.key) {
    setDraftOf(session.key);
    setText(readDraft(session.key));
  }
  const [busy, setBusy] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useGrow(field, text);
  useEffect(() => {
    const t = window.setTimeout(() => writeDraft(session.key, text), 300);
    return () => window.clearTimeout(t);
  }, [session.key, text]);
  // "Edit and send again" on a message that didn't make it: its words come back here.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; text: string }>).detail;
      if (d?.key !== session.key) return;
      setText(d.text);
      requestAnimationFrame(() => field.current?.focus());
    };
    window.addEventListener("sp:compose", on);
    return () => window.removeEventListener("sp:compose", on);
  }, [session.key]);
  const paired = !!control;
  // The wrong address (control/origin.ts): the hint is the one line naming where sending
  // works, as a link to this very page there; never an offer to add a device.
  const wrong = blocked ? wrongOriginHere() : null;
  const httpsHref = blocked ? (wrong ? wrongOriginHref() : httpsHere()) : null;
  const enabled = paired && !!onSend && !blocked && !stream;
  // Images beside the message (control/Attachments.tsx): paperclip, paste, drop, the phone's picker.
  const att = useAttachments({ machine: session.machine, enabled });
  const name = session.machine ?? "the machine";
  // One reason at a time, most fundamental first (the wrong address or an insecure page
  // come before pairing, which needs the right address too), each with its one way out; none when
  // sending simply works (the composer then carries no caption at all).
  const reason = ((): Reason | null => {
    if (note)
      return { kind: noteKind === "err" ? "error" : "note", text: note, tone: noteKind === "err" ? "err" : undefined };
    if (wrong)
      return {
        kind: "wrong-origin",
        text: (
          <>
            Sending works from{" "}
            <a className="ctl-origin-link" href={httpsHref ?? wrong}>
              {wrong}
            </a>
            ; open it there.
          </>
        ),
      };
    if (blocked)
      return {
        kind: "blocked",
        text: blocked,
        action: httpsHref ? (
          <a className="ctl-open-https" href={httpsHref}>
            Open on {new URL(httpsHref).host}
          </a>
        ) : undefined,
      };
    if (!paired)
      return {
        kind: "unpaired",
        text: (
          <>
            Pair <strong>{name}</strong> to message this session from here.
          </>
        ),
        action: (
          <Link to="/connect" className="ctl-link">
            How to pair
          </Link>
        ),
      };
    if (untrusted)
      return signerKind() === "device"
        ? {
            kind: "untrusted",
            text: (
              <>
                <strong>{name}</strong> doesn't trust this Mac yet.
              </>
            ),
            action: (
              <Link to="/add-device" className="ctl-link">
                {SETUP_LABEL}
              </Link>
            ),
          }
        : {
            kind: "untrusted",
            text: (
              <>
                <strong>{name}</strong> trusts no passkey from this browser.
              </>
            ),
            action: (
              <Link to="/add-device" className="ctl-link">
                Add this device
              </Link>
            ),
          };
    if (!onSend) return null;
    if (stream)
      return {
        kind: "stream",
        text:
          stream.state === "offline"
            ? "Offline. Sending waits for the connection."
            : "Reconnecting. Sending waits for the connection.",
        action: (
          <button type="button" className="ctl-link" onClick={stream.retry}>
            Retry now
          </button>
        ),
      };
    if (control && !control.online)
      return {
        kind: "offline",
        text: (
          <>
            <strong>{name}</strong> is offline. A message waits until it's back.
          </>
        ),
      };
    if (unlock)
      return {
        kind: "passkey",
        text: "The first send today asks for your passkey.",
        action: (
          <button type="button" className="ctl-link" onClick={unlock}>
            Unlock now
          </button>
        ),
      };
    return null;
  })();
  // Why Allow / Deny are off, said on their own bar (the line under the field says the rest).
  const offWhy = enabled
    ? null
    : !paired
      ? `pair ${name} to answer here`
      : blocked
        ? wrong
          ? "answer it where sending works"
          : "this page cannot sign an answer"
        : stream
          ? "waiting for the connection"
          : null;
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
      writeDraft(session.key, "");
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
                <ActionButton
                  className="btn btn--deny"
                  disabled={off && busy !== `deny:${a.attentionId}`}
                  pending={busy === `deny:${a.attentionId}`}
                  pendingLabel="Denying…"
                  data-tip-keys={hintFor("session.deny") || undefined}
                  onClick={() =>
                    run(`deny:${a.attentionId}`, {
                      kind: "permission.answer",
                      attentionId: a.attentionId,
                      allow: false,
                    })
                  }
                >
                  Deny
                </ActionButton>
                <ActionButton
                  className="btn btn--allow"
                  disabled={off && busy !== `allow:${a.attentionId}`}
                  pending={busy === `allow:${a.attentionId}`}
                  pendingLabel="Allowing…"
                  data-tip-keys={hintFor("session.allow") || undefined}
                  onClick={() =>
                    run(`allow:${a.attentionId}`, {
                      kind: "permission.answer",
                      attentionId: a.attentionId,
                      allow: true,
                    })
                  }
                >
                  Allow
                </ActionButton>
              </span>
            )}
          </div>
        );
      })}
      <div className="ctl-field">
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
              disabled={!enabled || (!!busy && busy !== "cancel")}
              onClick={() => run("cancel", { kind: "cancel" })}
              aria-label="Stop the turn"
              aria-busy={busy === "cancel" || undefined}
              data-tip-keys={hintFor("session.cancel") || undefined}
            >
              {busy === "cancel" ? <Spinner label="Stopping" /> : <StopIcon />}
            </button>
          )}
          <button
            type="submit"
            className={`icon-btn ctl-send ${canSend || busy === "prompt" ? "is-ready" : ""}`}
            disabled={!canSend}
            aria-label="Send"
            aria-busy={busy === "prompt" || undefined}
            data-tip-keys="↩"
          >
            {busy === "prompt" ? <Spinner label="Sending" /> : <SendIcon />}
          </button>
        </div>
      </div>
      {reason && (
        <p className="ctl-foot" data-reason={reason.kind}>
          <span
            className={`ctl-hint ctl-context ${reason.tone === "err" ? "ctl-note--err" : ""}`}
            data-wrong-origin={reason.kind === "wrong-origin" ? "" : undefined}
          >
            {reason.text}
          </span>
          {reason.action}
        </p>
      )}
    </form>
  );
}
