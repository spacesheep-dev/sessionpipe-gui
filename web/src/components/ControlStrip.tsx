// SPDX-License-Identifier: Apache-2.0
// The control affordance on a session, docked at the bottom of the view: an open
// permission as one action bar (the question, Deny and Allow), then the composer, one
// field that grows to 40 % of the view with the images to send, attach, stop and send
// inside it, then at most one quiet line under it: the one reason sending is off or will
// ask for something, with its one action, and nothing at all when all is well. Every
// press shows at once: Allow, Deny, Stop and Send take their pending face until the
// receiver has the signed command, and what the machine did next is said by the
// machine's own acks, never here. On the phone, unpaired with a prompt to answer, the
// bar is the card alone: one sentence says how to pair (for answering and messaging
// both), and the composer, which could do nothing, takes no room.
// Allow and Deny are hidden where only something done elsewhere brings them back (this
// device is not approved, or its request waits): the card says so and offers the way to
// approve it in their place, and on the phone it stands alone, as unpaired. They are
// disabled where they come back by themselves (the hour a new device waits, reconnecting, a
// send under way), and where this device is approved and the computer has not added its key
// (the card says so, with Approve this iPhone). Each of those is said once: on the card,
// with its way on, while it has a prompt to answer (in the hour, on the phone, the card then
// stands alone too), else under the field. A question from the agent has no
// pair at all: its card is the question and its options to read, and where to answer it.
// The draft is kept per session. Disabled with its reason until the machine paired and
// `onSend` is wired (web/src/control/SessionControl.tsx signs and sends). Keep this
// component self-contained: everything it needs comes through props.
import type { Attention, MachineControl, SessionSummary, StartFile, Suggestion } from "@shared/api";
import {
  type KeyboardEvent,
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type Approval, type SendState, sendWords } from "../account/sendable";
import {
  AttachButton,
  AttachmentTray,
  pictureMode,
  picturesOffWords,
  useAttachments,
  useThisMachine,
} from "../control/Attachments";
import type { AnswerOut } from "../control/answers";
import { httpsHere, wrongOriginHere, wrongOriginHref } from "../control/api";

import { deviceWords, setupLabel, signerKind, signerLabel } from "../control/signer";
import { receiptWords } from "../control/words";
import { answerLate, useAnswerClock } from "../lib/answerWindow";
import { useAskedInput } from "../lib/askedInput";
import { usePhoneLayout, useTouchKeys } from "../lib/device";
import {
  askCut,
  askedQuestion,
  attentionMessage,
  CC_COMMAND_MAX,
  isPlanReview,
  isQuestion,
  isShellTool,
  saidCommand,
  toolLabel,
} from "../lib/format";

import { Link } from "../lib/router";
import { askedCommand, shellLines } from "../lib/shellCommand";
import { hintFor } from "../lib/shortcuts";
import { NEW_WORDS, ThisPhone } from "../native/accountWords";
import { ActionButton, Spinner, StateDot, WithName } from "./bits";
import "../control/control.css";

// The plan reads as Markdown, whose renderer stays out of the first paint (PlanText.tsx).
const PlanText = lazy(() => import("./PlanText").then((m) => ({ default: m.PlanText })));

/** `composer`: what it signs was typed in the composer (a message, Keep planning's note),
 *  so a hold of it depends on the composer and goes when the composer changes. */
export type ControlAction =
  /** `files`: the pictures sent beside the message, as the command's signed `files`
   *  (CONTROL.md §3.1); nothing of them is in `text`. `attached`: the attachment lines this
   *  page wrote into `text` instead, for a machine that takes no files on a prompt
   *  (Attachments compose). */
  | { kind: "prompt"; text: string; composer?: boolean; files?: StartFile[]; attached?: string[] }
  | { kind: "permission.answer"; attentionId: string; allow: boolean; note?: string; composer?: boolean }
  | { kind: "cancel"; note?: string };

/** The event that clears a session's composer once a message it held went another way. */
export const COMPOSER_SENT = "sp:composer-sent";

/** Why Allow / Deny are off where the page cannot send: at the wrong address, where it
 *  can; where the block has a sentence of its own that is as true of an answer as of a
 *  message (the hour a newly approved phone waits), that sentence; else that the page
 *  cannot sign one. */
export const blockedAnswer = (wrong: string | null | undefined, says?: string): string =>
  wrong ? "answer it where sending works" : (says ?? "this page cannot sign an answer");

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
  /** Where this session can be answered when this page cannot sign: its page on the
   *  spacesheep account the window shows. */
  elsewhere?: { href: string; host: string };
  /** The line under the field while it says something now: the last send's refusal, or a
   *  passkey prompt being up. It wins over every other reason. */
  note?: string;
  noteKind?: "info" | "err";
  /** The composer's words and attachments, as one string, each time they change: a held
   *  message (control/HeldNotice.tsx) depends on them. */
  /** The block in a sentence that holds for an answer too (blockedAnswer). */
  blockedSays?: string;
  onDraft?: (draft: string) => void;
  /** Whether this device can send to the machine (account/sendable.ts): where it is not
   *  approved, waits for approval, or the machine does not trust its key yet, the line
   *  says so, with the way on where there is one. Absent where the page cannot sign. */
  send?: SendState;
  /** What of `send` turns the strip off (sendable.ts approvalOf): "unapproved" puts the way
   *  to approve this device in place of Allow and Deny, "catching-up" disables them. */
  approval?: Approval;
  /** On an account, history is still being read: with no `control`, the machine is not known
   *  yet, not unpaired, and nothing says to pair it (the page bar says "Catching up…"). */
  catching?: boolean;
  /** The app's stream to the receiver is down (after the grace: data/hooks.ts
   *  useStreamDown): nothing can be sent or answered until it is back. The page bar says
   *  which state it is and holds Retry; the strip says only what follows from it here,
   *  once: on an open prompt's card, else under the field. */
  stream?: boolean;
  /** The next send asks for the passkey (no day grant yet): the line offers Unlock now. A
   *  browser's only: the app's first send brings up its own prompt, which says what it is. */
  unlock?: () => void;
  /** Opens the Ask another agent sheet (orchestrate/handoff), at the right end of the line
   *  under the field; absent, no button (hidden, never disabled: the line's own reason
   *  already says why sending is off). Not offered while `stream`: it would only be
   *  refused. In a mouse window the line then keeps the button's height, so the field
   *  holds still across the drop. */
  ask?: () => void;
  /** Per attention id: "sent" while an answer is out (no second one goes; the card says
   *  which, in place of the pair), "closed" once the machine said the prompt is no longer
   *  open (already answered, or timed out). */
  answers?: Readonly<Record<string, AnswerOut>>;
  /** Plugins' suggested answers for this session's attentions (shared/plugin-api.ts).
   *  Advice only: Confirm sends the ordinary signed answer through `onSend`. */
  suggestions?: readonly Suggestion[];
  /** The textarea's placeholder, and its name; one voice in both modes. */
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

/** Whether a control answer can reach this prompt (shared/api.ts `answerable`). Claude Code
 *  raises two attentions per permission: the hook's (answerable) and a notification about
 *  it (`notif-…`, nobody can answer). An older server leaves the field unset. */
export const answerable = (a: Attention): boolean => a.answerable ?? !a.attentionId.startsWith("notif-");

/** What the machine says of a command it cut: a message is its first 200 characters. */
const CUT = "The machine sends the first 200 characters";

/** A shell prompt's command as its card shows it: the whole command from the call's own
 *  input where the session sent it (lib/askedInput.ts) and it is the one the message names,
 *  else the message's, ending in "…" where the machine cut it (lib/format.ts askCut), with
 *  `cut` saying how much it keeps (Claude Code's 120 characters, or the server's 200).
 *  Undefined where the message is no command. */
export function shownCommand(
  a: Pick<Attention, "tool" | "message">,
  harness: string | undefined,
  input: Record<string, unknown> | undefined,
): { cmd: string; cut: string | null } | undefined {
  const said = saidCommand(attentionMessage(a));
  // Cut is read off the message as sent: neither the server nor Claude Code marks it.
  const cutMsg = askCut(a, harness);
  const whole = askedCommand(input, said, cutMsg);
  if (whole) return { cmd: whole, cut: null };
  if (!said) return undefined;
  if (!cutMsg) return { cmd: said, cut: null };
  const short = (a.message?.length ?? 0) < 200 && said.length >= CC_COMMAND_MAX && harness === "claude-code";
  return { cmd: said.endsWith("…") ? said : `${said}…`, cut: short ? NEW_WORDS.commandCut : CUT };
}
/** A command block shows this many steps until "Show more". */
const CMD_LINES = 4;

/** "Allow Bash to run:" with the command on its own lines under it, or "Allow Write?" with
 *  its message after it. A long chained command reads one step per line, four steps until
 *  "Show more"; the whole command comes from the call's own input when the session sent it
 *  (lib/askedInput.ts), else from the message, cut at 200 characters. A plan review asks
 *  about the plan, from the same input, and shows it under the question. A question from
 *  the agent is its own words, with the labels of its options under it to read (they are
 *  answered on its computer), or one sentence where its input was not sent. Its glyph is
 *  the orange one while it asks; with an answer out, the working ring, or a still hollow
 *  one while the computer is offline (`out`). */
function Question({ a, session, out }: { a: Attention; session: SessionSummary; out?: "going" | "held" }) {
  const { input } = useAskedInput(session, a);
  // The prompt whose steps are all shown: another prompt starts folded.
  const [unfolded, setUnfolded] = useState<string | null>(null);
  const blockId = useId();
  const line = (words: ReactNode) => (
    <p className="ctl-q">
      {out === "held" ? (
        <span className="dot dot--held" style={{ width: 8, height: 8 }} aria-hidden="true" />
      ) : (
        <StateDot state={out === "going" ? "working" : "needs_you"} size={8} decorative />
      )}
      <span className="ctl-q-text">{words}</span>
    </p>
  );
  if (isPlanReview(a)) {
    // Below tier 3 there is no plan: the prompt's own message, when it says more than the
    // tool's name.
    const plan = typeof input?.plan === "string" && input.plan.trim() ? input.plan : null;
    const said = plan ? undefined : attentionMessage(a);
    return (
      <>
        {line(<>Ready to start on this plan?</>)}
        {plan ? (
          <Suspense fallback={null}>
            <PlanText text={plan} />
          </Suspense>
        ) : said ? (
          <p className="ctl-answer-msg ctl-plan-msg">{said}</p>
        ) : null}
      </>
    );
  }
  if (isQuestion(a)) {
    const q = askedQuestion(input);
    if (!q) return line(NEW_WORDS.questionAsked);
    return (
      <>
        {line(q.text)}
        {q.options.length > 0 && (
          <ul className="ctl-options" aria-label={NEW_WORDS.questionOptions}>
            {q.options.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        )}
        {q.more > 0 && <p className="ctl-questions-more">{NEW_WORDS.questionMore(q.more)}</p>}
      </>
    );
  }
  if (!a.tool)
    return line(
      <>
        Allow this?<span className="ctl-answer-msg"> {a.message ?? "a permission request"}</span>
      </>,
    );
  const tool = <span className="ctl-tool">{toolLabel(a.tool)}</span>;
  const msg = attentionMessage(a);
  const shown = isShellTool(a.tool) ? shownCommand(a, session.harness, input) : undefined;
  if (!shown)
    return line(
      <>
        Allow {tool}?{msg ? <span className="ctl-answer-msg"> {msg}</span> : null}
      </>,
    );
  // One shape for every command, at every size: the question, then the command under it.
  const steps = shellLines(shown.cmd) ?? [shown.cmd];
  const cut = shown.cut;
  const more = steps.length - CMD_LINES;
  const all = more <= 0 || unfolded === a.attentionId;
  // A command of one step on one line is shown whole, however it wraps: nothing caps it.
  const one = steps.length === 1 && !steps[0]!.includes("\n");
  return (
    <>
      {line(<>Allow {tool} to run:</>)}
      {/* biome-ignore lint/a11y/useSemanticElements: lines of text, not form controls a fieldset would hold */}
      <div
        id={blockId}
        className={one ? "ctl-cmd-block ctl-cmd-block--one" : "ctl-cmd-block"}
        role="group"
        aria-label="Command"
        title={cut ?? undefined}
      >
        {(all ? steps : steps.slice(0, CMD_LINES)).map((step, i) => (
          <div key={i}>{step}</div>
        ))}
        {cut && <span className="sr-only">{cut}</span>}
      </div>
      {more > 0 && (
        <button
          type="button"
          className="ctl-more"
          aria-expanded={all}
          aria-controls={blockId}
          onClick={() => setUnfolded(all ? null : a.attentionId)}
        >
          {all ? "Show less" : `Show ${more} more ${more === 1 ? "line" : "lines"}`}
        </button>
      )}
    </>
  );
}

/** A note travels with an answer up to this many characters (CONTROL.md §3, `note`). */
const NOTE_MAX = 2000;

/** Why Approve plan is off while the composer holds a note. */
const NOTED = "Send the note with Keep planning, or clear it";

/** Keep planning: a no to the plan, carrying what should change when the composer says
 *  it. The note reaches the model beside the decision, so the plan comes back revised. */
export function keepPlanning(attentionId: string, text: string): ControlAction {
  const note = text.trim();
  return { kind: "permission.answer", attentionId, allow: false, ...(note ? { note } : {}), composer: true };
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
  elsewhere,
  note,
  noteKind = "info",
  answers,
  suggestions,
  placeholder = "Message this session…",
  chat = false,
  send,
  approval = "ok",
  catching = false,
  stream,
  unlock,
  ask,
  blockedSays,
  onDraft,
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
  // The line under the field describes it: why it is off, or what a send will ask for.
  const reasonId = useId();
  // Each prompt's card line describes its Allow and Deny (`${cardId}-${attentionId}`).
  const cardId = useId();
  /** The prompt an answer was pressed for here: its receipt takes the focus the pressed
   *  button had, as it takes the button's place. */
  const refocus = useRef<string | null>(null);
  useGrow(field, text);
  useEffect(() => {
    const t = window.setTimeout(() => writeDraft(session.key, text), 300);
    return () => window.clearTimeout(t);
  }, [session.key, text]);
  // "Edit and send again" on a message that didn't make it: its words come back here;
  // the Files drawer's "Put in composer" adds its review under what is already typed.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; text: string; append?: boolean }>).detail;
      if (d?.key !== session.key) return;
      setText((cur) => (d.append && cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${d.text}` : d.text));
      requestAnimationFrame(() => field.current?.focus());
    };
    window.addEventListener("sp:compose", on);
    return () => window.removeEventListener("sp:compose", on);
  }, [session.key]);
  const paired = !!control;
  const phone = usePhoneLayout();
  const touch = useTouchKeys();
  // The wrong address (control/origin.ts): the hint is the one line naming where sending
  // works, as a link to this very page there; never an offer to add a device.
  const wrong = blocked ? wrongOriginHere() : null;
  const httpsHref = blocked ? (wrong ? wrongOriginHref() : httpsHere()) : null;
  const enabled = paired && !!onSend && !blocked && !stream && approval === "ok";
  // Not approved: the way to approve it stands where Allow and Deny would.
  const approve = paired && !blocked && approval === "unapproved";
  // Ask another agent… while the stream is down would only be refused: not offered.
  const offer = stream ? undefined : ask;
  // Images beside the message (control/Attachments.tsx): paperclip, paste, drop, the phone's
  // picker. How they go is the machine's: as the command's files where its sessionpipe takes
  // them, as paths for an older one on this machine, and not at all anywhere else. There a
  // picture pasted or dropped is answered by the line under the field, until the words change.
  const mode = pictureMode(control, useThisMachine(session.machine));
  const refusedKey = `${session.key}\n${text}`;
  const [refusedAt, setRefusedAt] = useState<string | null>(null);
  const picturesOff = mode === "off" && refusedAt === refusedKey;
  const att = useAttachments({
    machineId: control?.machineId,
    enabled,
    mode,
    onRefused: () => setRefusedAt(refusedKey),
  });
  // A held message confirmed from its notice (control/HeldNotice.tsx) went: the composer
  // is clear, as after Send. Until then its words stayed here.
  const clearAtt = att.clear;
  // Only while it still holds what was held: words typed while the confirm was going stay.
  const draft = JSON.stringify([text, att.items.map((i) => i.key)]);
  const draftNow = useRef(draft);
  draftNow.current = draft;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; draft: string }>).detail;
      if (d?.key !== session.key || d.draft !== draftNow.current) return;
      setText("");
      writeDraft(session.key, "");
      clearAtt();
    };
    window.addEventListener(COMPOSER_SENT, on);
    return () => window.removeEventListener(COMPOSER_SENT, on);
  }, [session.key, clearAtt]);
  const onDraftNow = useRef(onDraft);
  onDraftNow.current = onDraft;
  useEffect(() => onDraftNow.current?.(draft), [draft]);
  const name = session.machine ?? "the machine";
  const permissions = (attentions ?? (attention ? [attention] : [])).filter((a) => a.kind === "permission");
  // The answerable prompt(s) only; a notification twin adds nothing. With no answerable one,
  // the notification is shown as what it is: a prompt waiting in the terminal.
  const open = permissions.some(answerable) ? permissions.filter(answerable) : permissions;
  // Each prompt's hook waits a while for an answer (lib/answerWindow.ts); past it, the card
  // turns late on its own.
  const now = useAnswerClock(open);
  const late = (a: Attention) => answerable(a) && answerLate(a, control, session.harness, now);
  // A plan review this strip can answer: the composer then says what should change, and
  // sending it is Keep planning. A prompt could not reach the agent anyway, blocked on it.
  const review = open.find(
    (a) => isPlanReview(a) && answerable(a) && !late(a) && answers?.[a.attentionId]?.status !== "closed",
  );
  const tooLong = text.trim().length > NOTE_MAX;
  // Approve plan carries no note (an allow reaches Claude Code with none), so while the
  // composer holds one it waits: the words would otherwise stay behind as the next prompt.
  const noted = !!review && !!text.trim();
  // A prompt whose card says why it can't be answered from here (`offWhy`): one that is not
  // late, waiting in a terminal, a question, or answered already.
  const asks = open.some((a) => answerable(a) && !isQuestion(a) && !late(a) && !answers?.[a.attentionId]);
  // Inside the hour a new device waits, with such a prompt: the card says the hour, once,
  // with the way to answer it on spacesheep, and the line under the field does not.
  const hourOnCard = paired && !!blockedSays && !wrong && asks;
  // One reason at a time, most fundamental first (the wrong address or an insecure page
  // come before pairing, which needs the right address too), each with its one way out; none when
  // sending simply works (the composer then carries no caption at all).
  const reason = ((): Reason | null => {
    if (note)
      return { kind: noteKind === "err" ? "error" : "note", text: note, tone: noteKind === "err" ? "err" : undefined };
    if (picturesOff) {
      // The sentence, with the command it names set as one.
      const [words, command, rest] = picturesOffWords(name, !!control?.remote).split("`");
      return {
        kind: "pictures-off",
        text: (
          <>
            <WithName text={words ?? ""} name={session.machine} />
            {command && <code>{command}</code>}
            {rest}
          </>
        ),
      };
    }
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
    if (blocked && hourOnCard) return null;
    if (blocked)
      return {
        kind: "blocked",
        text: blocked,
        action: httpsHref ? (
          <a className="ctl-open-https" href={httpsHref}>
            Open on {new URL(httpsHref).host}
          </a>
        ) : elsewhere ? (
          <a className="ctl-open-https" href={elsewhere.href} target="_blank" rel="noreferrer noopener" data-elsewhere>
            Open on {elsewhere.host}
          </a>
        ) : undefined,
      };
    if (!paired && catching) return null;
    if (!paired)
      return {
        kind: "unpaired",
        text: (
          <>
            Pair <strong className="whole-name">{name}</strong> to message this session from here.
          </>
        ),
        // On a spacesheep account a computer is paired on spacesheep, not here: no page of
        // this app says how, and the session's own page there is the way on.
        action: elsewhere ? (
          <a className="ctl-open-https" href={elsewhere.href} target="_blank" rel="noreferrer noopener" data-elsewhere>
            Open on {elsewhere.host}
          </a>
        ) : (
          <Link to="/connect" className="ctl-link">
            How to pair
          </Link>
        ),
      };
    // Off an account: the machine's key list has no key of this device.
    if (send?.kind === "catching-up" && !send.account)
      return signerKind() === "device"
        ? {
            kind: "untrusted",
            text: (
              <>
                <strong className="whole-name">{name}</strong> doesn't trust {deviceWords().this} yet.
              </>
            ),
            action: (
              <Link to="/add-device" className="ctl-link">
                {setupLabel()}
              </Link>
            ),
          }
        : {
            kind: "untrusted",
            text: (
              <>
                <strong className="whole-name">{name}</strong> trusts no passkey from this browser.
              </>
            ),
            action: (
              <Link to="/add-device" className="ctl-link">
                Add this device
              </Link>
            ),
          };
    // Approved, and this machine has not added the key: beside a prompt to answer the card
    // says it, with the way on, and this line does not.
    if (approval === "catching-up" && asks) return null;
    // On an account: not approved, waiting for it, or approved and this machine has not
    // added the key yet. Nothing where it can send, or inside the hour (`blocked` says that).
    const trust = send?.kind === "unapproved" || send?.kind === "waiting" || send?.kind === "catching-up" ? send : null;
    const says = trust ? sendWords(trust, name) : null;
    if (trust && says?.long)
      return {
        kind: trust.kind,
        text: says.long,
        action: says.approve ? (
          <Link to="/add-device" className="ctl-link">
            {setupLabel()}
          </Link>
        ) : undefined,
      };
    if (!onSend) return null;
    if (review && tooLong) return { kind: "too-long", text: "Keep it under 2,000 characters", tone: "err" };
    if (noted) return { kind: "plan-note", text: NOTED };
    // The stream is down: beside a prompt to answer its card says so, and this line does not.
    if (stream) return asks ? null : { kind: "stream", text: NEW_WORDS.streamSend };
    if (control && !control.online)
      return {
        kind: "offline",
        text: (
          <>
            <strong className="whole-name">{name}</strong> is offline. A message waits until it's back.
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
  // The phone, unpaired, not approved or inside the hour, with a prompt to answer: one state,
  // one sentence (on the card), and no composer. A desktop keeps its field and the line under
  // it, and so does the phone where every prompt is late: that card says only that it is too late.
  const folded = phone && asks && ((((!paired && !catching) || approve) && !blocked) || hourOnCard);
  // A card note's sentence and its way on: on the phone the link takes a line of its own;
  // wider, it follows a "·" that never starts a line.
  const withWay = (sentence: string, way: ReactNode): ReactNode =>
    phone ? (
      <>
        <WithName text={sentence} name={session.machine} /> <br />
        {way}
      </>
    ) : (
      <>
        <WithName text={`${sentence.replace(/\.$/, "")}\u00a0·`} name={session.machine} /> {way}
      </>
    );
  const notAdded = approval === "catching-up" && send ? sendWords(send, name)?.long : null;
  // Why Allow / Deny are off, said on their own bar (the line under the field says the rest).
  const offWhy: ReactNode = enabled ? null : !paired ? (
    catching ? null : folded ? (
      <>
        Pair <strong className="whole-name">{name}</strong> to answer and message from here ·{"\u00a0"}
        {elsewhere ? (
          <a className="ctl-link" href={elsewhere.href} target="_blank" rel="noreferrer noopener" data-elsewhere>
            Open on {elsewhere.host}
          </a>
        ) : (
          <Link to="/connect" className="ctl-link">
            How to pair
          </Link>
        )}
      </>
    ) : (
      `pair ${name} to answer here`
    )
  ) : blocked ? (
    hourOnCard && elsewhere && blockedSays ? (
      withWay(
        blockedSays,
        <a className="ctl-link" href={elsewhere.href} target="_blank" rel="noreferrer noopener" data-elsewhere>
          Open on {elsewhere.host}
        </a>,
      )
    ) : (
      blockedAnswer(wrong, blockedSays)
    )
  ) : approve ? (
    `${NEW_WORDS.answerNotYet(ThisPhone())}.`
  ) : stream ? (
    NEW_WORDS.streamAnswer
  ) : notAdded ? (
    withWay(
      notAdded,
      <Link to="/add-device" className="ctl-link">
        {setupLabel()}
      </Link>,
    )
  ) : null;
  const canSend = review
    ? enabled && !busy && !!text.trim() && !tooLong && answers?.[review.attentionId]?.status !== "sent"
    : enabled && !busy && !att.uploading && (!!text.trim() || att.items.length > 0);

  const run = (id: string, action: ControlAction, after?: () => void) => {
    if (!enabled || busy) return;
    if (action.kind === "permission.answer" && answers?.[action.attentionId]) return;
    refocus.current = action.kind === "permission.answer" ? action.attentionId : null;
    setBusy(id);
    void onSend?.(action)
      .then(after)
      .catch(() => {
        // Not sent from here: no receipt is this press's to take the focus.
        refocus.current = null;
      })
      .finally(() => setBusy(null));
  };
  // Keep planning with what the composer says; once it went, the composer is clear again.
  const keep = (id: string, attentionId: string) =>
    run(id, keepPlanning(attentionId, text), () => {
      setText("");
      writeDraft(session.key, "");
    });
  const sendText = () => {
    // The press is Send's, so its own spinner says it, not Keep planning's.
    if (review) return canSend ? keep("prompt", review.attentionId) : undefined;
    const t = text.trim();
    if (!t && att.items.length === 0) return;
    // What is signed: the message and its pictures, as files or as the block of paths (null
    // while an upload runs or one failed).
    const composed = att.compose(t);
    if (!composed) return;
    const action: ControlAction = {
      kind: "prompt",
      text: composed.text,
      composer: true,
      ...(composed.files?.length ? { files: composed.files } : {}),
      attached: composed.lines,
    };
    run("prompt", action, () => {
      setText("");
      writeDraft(session.key, "");
      att.clear();
    });
  };
  // Return sends and Shift+Return is a new line; on a touch screen, whose keyboard has no
  // Shift+Return, Return is the new line (as in Messages) and ⌘/Ctrl+Return sends.
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const sends = touch ? e.metaKey || e.ctrlKey : !e.shiftKey;
    if (sends) {
      e.preventDefault();
      sendText();
    }
  };
  // The field's name is the words it shows, so saying them (Voice Control) finds it.
  const named = review ? "What should change?" : placeholder;

  return (
    <form
      className={`ctl ${enabled ? "" : "ctl--off"} ${blocked ? "ctl--blocked" : ""} ${folded ? "ctl--folded" : ""} ${chat ? "ctl--chat" : ""} ${att.dragging ? "ctl--drop" : ""}`}
      aria-label="Control"
      {...att.handlers}
      onSubmit={(e) => {
        e.preventDefault();
        sendText();
      }}
    >
      {open.map((a) => {
        const out = answers?.[a.attentionId];
        const status = out?.status;
        const plan = isPlanReview(a);
        // A question is read here and answered on its computer: Allow cannot carry the
        // option chosen. `answerable` stays the protocol's, for the twin above.
        const question = isQuestion(a);
        const terminal = !answerable(a) || question;
        // Its hook let go: an answer from here would only be refused, so none is offered.
        const gone = late(a);
        const off = !enabled || !!busy;
        const suggested = suggestions?.find((s) => s.attentionId === a.attentionId);
        // An answer is out: one line says which, and what it waits for, in the pair's place.
        const sent = !terminal && !gone && out?.status === "sent";
        const offline = control?.online === false;
        const receipt =
          sent && out?.status === "sent"
            ? receiptWords({ decision: out.decision, plan, machine: session.machine, offline })
            : null;
        const shut = terminal || gone || status === "closed" || sent;
        // On a line of its own: where it is answered, and that it is too late, as sentences.
        const said = question
          ? NEW_WORDS.questionWhereLine(session.machine ?? undefined)
          : terminal
            ? "waiting in the terminal"
            : gone
              ? NEW_WORDS.answerLateLine(session.machine ?? undefined)
              : status === "closed"
                ? NEW_WORDS.answerClosed
                : offWhy;
        const why: ReactNode = typeof said === "string" ? <WithName text={said} name={session.machine} /> : said;
        // The card's line describes both buttons; a button's own reason is its alone.
        const noteId = `${cardId}-${a.attentionId}`;
        const denyWhy = plan && tooLong ? "Keep it under 2,000 characters" : null;
        const allowWhy = plan && noted && !off ? NOTED : null;
        const describedBy = (own: string | null, side: string) =>
          [why ? noteId : null, own ? `${noteId}-${side}` : null].filter(Boolean).join(" ") || undefined;
        return (
          <div
            className={plan ? "ctl-answer ctl-answer--plan" : "ctl-answer"}
            key={a.attentionId}
            data-attention={a.attentionId}
            data-answer={
              question
                ? "question"
                : terminal
                  ? "terminal"
                  : gone
                    ? "late"
                    : (status ?? (approve ? "unapproved" : "open"))
            }
          >
            <Question a={a} session={session} out={sent ? (offline ? "held" : "going") : undefined} />
            {receipt ? (
              <p
                className="ctl-answer-receipt"
                role="status"
                aria-live="polite"
                tabIndex={-1}
                ref={(el) => {
                  // The pressed button went with the pair: its focus comes here.
                  if (!el || refocus.current !== a.attentionId) return;
                  refocus.current = null;
                  const at = document.activeElement;
                  if (!at || at === document.body) el.focus({ preventScroll: true });
                }}
              >
                <span className="ctl-answer-receipt-what">{receipt.what}</span>
                <WithName text={receipt.text.slice(receipt.what.length)} name={session.machine} />
              </p>
            ) : why ? (
              <span className="ctl-answer-note" id={noteId}>
                {why}
              </span>
            ) : suggested && !shut ? (
              <span
                className="ctl-suggestion"
                data-suggestion={suggested.decision}
                title={`Suggested by the ${suggested.plugin} plugin${suggested.note ? ` · ${suggested.note}` : ""}. Nothing is sent until you confirm with ${signerLabel()}.`}
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
            {!shut && approve ? (
              // Never just "Approve": beside a question, that word is the agent's action. A plain
              // `btn` (Deny's face), not `btn--deny`: Deny's key (d) and a menu's Deny look for that.
              <Link to="/add-device" className="btn ctl-approve">
                {setupLabel()}
              </Link>
            ) : !shut ? (
              <span className="ctl-answer-btns">
                <ActionButton
                  className="btn btn--deny"
                  disabled={(off || (plan && tooLong)) && busy !== `deny:${a.attentionId}`}
                  pending={busy === `deny:${a.attentionId}`}
                  pendingLabel={plan ? "Sending…" : "Denying…"}
                  data-tip-keys={hintFor("session.deny") || undefined}
                  aria-describedby={describedBy(denyWhy, "deny")}
                  onClick={() =>
                    plan
                      ? keep(`deny:${a.attentionId}`, a.attentionId)
                      : run(`deny:${a.attentionId}`, {
                          kind: "permission.answer",
                          attentionId: a.attentionId,
                          allow: false,
                        })
                  }
                >
                  {plan ? "Keep planning" : "Deny"}
                </ActionButton>
                <ActionButton
                  className="btn btn--allow"
                  disabled={(off || (plan && noted)) && busy !== `allow:${a.attentionId}`}
                  pending={busy === `allow:${a.attentionId}`}
                  pendingLabel={plan ? "Approving…" : "Allowing…"}
                  data-tip-keys={hintFor("session.allow") || undefined}
                  aria-describedby={describedBy(allowWhy, "allow")}
                  onClick={() =>
                    run(`allow:${a.attentionId}`, {
                      kind: "permission.answer",
                      attentionId: a.attentionId,
                      allow: true,
                    })
                  }
                >
                  {plan ? "Approve plan" : "Allow"}
                </ActionButton>
                {denyWhy && (
                  <span className="sr-only" id={`${noteId}-deny`}>
                    {denyWhy}
                  </span>
                )}
                {allowWhy && (
                  <span className="sr-only" id={`${noteId}-allow`}>
                    {allowWhy}
                  </span>
                )}
              </span>
            ) : null}
          </div>
        );
      })}
      {!folded && (
        <div className="ctl-field">
          <AttachmentTray att={att} />
          <div className="ctl-ask">
            {att.offered && <AttachButton att={att} disabled={!enabled || !!busy || !!review} />}
            <textarea
              ref={field}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder={named}
              disabled={!enabled}
              aria-label={named}
              aria-describedby={reason ? reasonId : undefined}
              rows={1}
              enterKeyHint={touch ? "enter" : "send"}
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
              aria-label={review ? "Keep planning" : "Send"}
              aria-busy={busy === "prompt" || undefined}
              data-tip-keys={touch ? "⌘↩" : "↩"}
            >
              {busy === "prompt" ? <Spinner label="Sending" /> : <SendIcon />}
            </button>
          </div>
        </div>
      )}
      {(reason || offer) && !folded && (
        <p className="ctl-foot" data-reason={reason?.kind} data-ask-held={ask && stream && !phone ? "" : undefined}>
          {reason && (
            <span
              id={reasonId}
              className={`ctl-hint ctl-context ${reason.tone === "err" ? "ctl-note--err" : ""}`}
              data-wrong-origin={reason.kind === "wrong-origin" ? "" : undefined}
              // It answers something just done (a picture pasted or dropped), so it is said.
              role={reason.kind === "pictures-off" ? "status" : undefined}
            >
              {reason.text}
            </span>
          )}
          {reason?.action}
          {offer && (
            <button type="button" className="btn btn--ghost btn--sm ctl-ask-agent" onClick={offer} data-ctl-ask>
              Ask another agent…
            </button>
          )}
        </p>
      )}
    </form>
  );
}
