// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The one signed send path for a session, shared by the session
// page's strip (SessionControl) and the inbox's Allow / Deny: builds the command for a
// strip action, signs it with the day grant (one passkey tap a day), and knows which
// prompts have an answer out or were closed by the machine (answers.ts, over the page's
// activity, with this surface's own press on top), so no second answer goes from anywhere.
import type { Attention, ControlActivity, MachineControl, SessionSummary } from "@shared/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePhone } from "../account/device";
import { type Approval, approvalOf, type SendState, useSendStates } from "../account/sendable";
import type { ControlAction } from "../components/ControlStrip";
import { answerLate } from "../lib/answerWindow";
import { isPlanReview } from "../lib/format";
import { clock, NEW_WORDS, SEND, ThisPhone, thisPhone } from "../native/accountWords";
import { type AnswerOut, type AnswerStatus, answerEnded } from "./answers";
import { ControlError, UNHEARD_CODE } from "./api";
import { type CommandFields, HeldForConfirm, heldWhy, sendCommand, UnheardSend } from "./command";
import { type Held, useHeld } from "./HeldNotice";
import type { HeldMeta } from "./held";
import { HELD_WORDS } from "./heldWords";
import { useAnswersOut, useControlActivity, useGrant, useRpId } from "./hooks";
import { remoteHostFor } from "./remoteRp";
import { canSign, isCancel, machineTakes, ownKeyKnown, signerKind, signerLabel, signHint, updateWords } from "./signer";
import { answerEndWords, notSentLine, notSentWords, receiptWords, unheardWords } from "./words";

export type { AnswerOut, AnswerStatus };

/** Whether Allow / Deny can go for one prompt right now, and if not (or while an answer
 *  is out) why, in words: the machine is not paired, this page cannot use passkeys, this
 *  device is not approved or the computer has not added its key yet (`approval`), the
 *  prompt's hook stopped waiting as of `now` (`late`: lib/answerWindow.ts), or an answer
 *  is already out (the receipt: which answer, and what it waits for). Shared by the inbox
 *  rows, the toasts and a row's menu. `tag` is the short state for a data attribute;
 *  "unapproved" offers no answer at all, only the way to approve this device. */
export function answerState(
  s: SessionSummary,
  a: Attention,
  control: MachineControl | undefined,
  send: Pick<SessionSend, "rp" | "secure" | "tap" | "answers"> & {
    cooling?: string | null;
    approval?: Approval;
  },
  now: number,
): {
  reason: string | null;
  off: boolean;
  status: AnswerStatus | undefined;
  tag: string;
  /** While an answer is out: the receipt, `what` went first (receiptWords). */
  receipt?: { what: string; text: string };
} {
  const out = send.answers[a.attentionId];
  const status = out?.status;
  const late = answerLate(a, control, s.harness, now);
  const receipt =
    status === "sent"
      ? receiptWords({
          decision: out?.decision,
          plan: isPlanReview(a),
          machine: s.machine,
          offline: control?.online === false,
        })
      : undefined;
  const old = control && !machineTakes(control) ? updateWords(s.machine ?? undefined).replace(/\.$/, "") : null;
  const approval = send.approval ?? "ok";
  const reason = !control
    ? `pair ${s.machine ?? "this machine"} to send messages`
    : !send.secure
      ? signHint(send.rp)
      : old
        ? old
        : send.cooling
          ? // Inside the hour a newly approved phone waits, an answer would be refused like
            // any send: the same line the composer has, and no button that will be refused.
            send.cooling
          : approval === "unapproved"
            ? NEW_WORDS.answerNotYet(ThisPhone())
            : approval === "catching-up"
              ? SEND.long.notHere(s.machine ?? "its computer", thisPhone()).replace(/\.$/, "")
              : late
                ? NEW_WORDS.answerLate(s.machine ?? undefined)
                : status === "closed"
                  ? NEW_WORDS.answerClosed
                  : receipt
                    ? receipt.text
                    : send.tap
                      ? `confirm with ${signerLabel()}`
                      : null;
  const off = !control || !send.secure || !send.rp || !!old || !!send.cooling || approval !== "ok" || late || !!status;
  const tag = !control
    ? "unpaired"
    : !send.secure || old || send.cooling || approval === "catching-up"
      ? "blocked"
      : approval === "unapproved"
        ? "unapproved"
        : late
          ? "late"
          : (status ?? "open");
  return { reason, off, status, tag, ...(receipt && reason === receipt.text ? { receipt } : {}) };
}

/** A send nobody heard the answer to, as the line under the field says it. */
const unheardLine = (a: ControlActivity): string | null => {
  const words = unheardWords(a);
  return words && notSentLine(words);
};

/** What a strip send kept beside a hold: the composer as it was when it was pressed, when
 *  what it signs was typed there. */
export interface StripSent extends HeldMeta {
  draft?: string;
}

export interface SessionSend {
  /** The receiver's rp id; null until known. */
  rp: string | null;
  /** Passkeys can work on this page (secure context under the rp id). */
  secure: boolean;
  grant: ReturnType<typeof useGrant>;
  /** A passkey prompt is up right now. */
  tap: boolean;
  /** The last send's refusal, as a line of its own ("Not sent: …"); null once a send is
   *  retried, or when the person closed the prompt (nothing was signed, nothing is wrong). */
  error: string | null;
  /** Per open attention id: "sent" while an answer is out, with the answer, "closed" once
   *  the machine said the prompt is no longer open (already answered, or timed out). The
   *  same for every surface (answers.ts); this one's own press shows before its row does. */
  answers: Readonly<Record<string, AnswerOut>>;
  /** On a spacesheep account, a phone approved less than an hour ago cannot send yet: the
   *  line that says from when (when the time is known exactly), or the refusal of a send
   *  for that hour in its place; null everywhere else. */
  cooling: string | null;
  /** Whether this device can send to the session's machine (account/sendable.ts). */
  sendable: SendState;
  /** What of it turns Allow, Deny and the composer off here (sendable.ts approvalOf): the
   *  app's own key, not approved for that machine or not added there yet. */
  approval: Approval;
  /** This session's control activity, newest first. */
  activity: ReturnType<typeof useControlActivity>;
  /** Signs and sends one strip action; throws the refusal after recording it in `error`. */
  onSend: (action: ControlAction) => Promise<void>;
  /** A send the receiver held for a confirm, for a surface that shows its notice
   *  (`notice`); elsewhere a hold is a refusal in `error` that says where to confirm it. */
  held: Held<ControlActivity, StripSent>;
}

/** What was pressed for a send: the composer as it was (when it was typed there), the
 *  fields that were signed, and the attachment lines the page wrote into the message. */
interface Pressed {
  typed?: string;
  fields?: CommandFields;
  attached?: readonly string[];
}

export function useSessionSend(
  session: SessionSummary,
  control: MachineControl | undefined,
  attentions: readonly Attention[],
  o: {
    /** This surface shows the held notice (the session page's strip). */
    notice?: boolean;
    /** After a held send was confirmed and went, with the fields it carried and, when it
     *  was typed in the composer, the composer as it was when it was pressed. */
    confirmed?: (fields: CommandFields, draft: string | undefined) => void;
    /** The composer as it is now (its words and attachments): a held message depends on
     *  it, and goes the moment it changes. */
    draft?: string;
  } = {},
): SessionSend {
  const rp = useRpId();
  const notice = !!o.notice;
  const secure = canSign(rp);
  const grant = useGrant(rp);
  const [tap, setTap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** spacesheep refused the last send for the hour a new device waits, and said until when. */
  const [refusedHour, setRefusedHour] = useState<{ words: string; until: number } | null>(null);
  const key = session.key;
  const machine = session.machine;
  const phoneKey = usePhone().view?.phase;
  // Inside that hour, where its end is known (approve.ts `exact`), nothing is offered: the
  // line says from when. A send refused for the hour says so in that line's place ("Not
  // sent. …"), never beside it.
  const hourRefusal = refusedHour && Date.now() < refusedHour.until ? refusedHour.words : null;
  const cooling =
    phoneKey?.kind === "cooling" && phoneKey.exact
      ? (hourRefusal ?? NEW_WORDS.composerCooling(ThisPhone(), clock(phoneKey.until)))
      : null;
  // Where a send would only be refused, nothing offers one: one fact for the strip, the
  // inbox, the toasts and a row's menu.
  const sendable = useSendStates(rp)(control);
  const approval = approvalOf(sendable, { device: signerKind() === "device", keyKnown: !!rp && ownKeyKnown(rp) });
  const mine = useCallback((a: { session?: string }) => a.session === key, [key]);
  const activity = useControlActivity(mine);

  // What every surface knows of the answers to these prompts, from the activity.
  const shared = useAnswersOut(attentions);
  /** This surface's own presses, per attention: what went and when (`row`: the row it made,
   *  whose word takes over once the activity has it), or that the machine refused it as no
   *  longer open before any row was made. */
  const [own, setOwn] = useState<Record<string, AnswerOut & { at: number; row?: string }>>({});
  /** An answer that went is "sent" from the moment it went. */
  const went = useCallback((fields: CommandFields, carried: ControlActivity) => {
    if (fields.kind !== "permission.answer") return;
    const at = Date.parse(carried.at);
    setOwn((prev) => ({
      ...prev,
      [fields.for]: {
        status: "sent",
        decision: fields.decision,
        at: Number.isNaN(at) ? Date.now() : at,
        row: carried.id,
      },
    }));
  }, []);
  const answers = useMemo(() => {
    let out: Record<string, AnswerOut> | null = null;
    for (const a of attentions) {
      const mine = own[a.attentionId];
      // A press for an earlier prompt under the same id, or one whose row the activity has.
      if (!mine || mine.at < Date.parse(a.at) || shared[a.attentionId]?.status === "sent") continue;
      if (mine.row && activity.some((r) => r.id === mine.row)) continue;
      out ??= { ...shared };
      out[a.attentionId] = { status: mine.status, ...(mine.decision ? { decision: mine.decision } : {}) };
    }
    return out ?? shared;
  }, [attentions, own, shared, activity]);
  const draftNow = useRef(o.draft);
  draftNow.current = o.draft;
  // A send of this session nobody heard the answer to (account/unheard.ts): its row says it
  // may have been sent while the app finds out, and holds the same kind of send meanwhile.
  const asking = useMemo(() => activity.filter((a) => a.unheard?.state === "asking"), [activity]);
  /** Row id → what was pressed: the composer as it was, and (where this page made the send)
   *  the fields it signed, which a hold's Confirm signs again. */
  const unheard = useRef(new Map<string, Pressed>());
  /** The send that is out now: the row of an unheard one takes it. */
  const pressed = useRef<Pressed>({});
  const confirmedNow = useRef(o.confirmed);
  confirmedNow.current = o.confirmed;
  const held = useHeld<ControlActivity, StripSent>(
    (carried, h, meta) => {
      went(h.fields, carried);
      o.confirmed?.(h.fields, meta.draft);
      grant.refresh();
    },
    (e) => setError(notSentWords(e)),
    o.draft,
  );
  const { catchHeld, drop: dropHeld, confirming: confirmingHeld } = held;
  const machineId = control?.machineId;
  useEffect(() => {
    for (const a of activity) {
      if (a.unheard?.state === "asking") {
        if (!unheard.current.has(a.id)) unheard.current.set(a.id, pressed.current);
        continue;
      }
      const was = unheard.current.get(a.id);
      if (!was) continue;
      unheard.current.delete(a.id);
      const typed = was.typed;
      // spacesheep holds it for a confirm, and it is known that no job was made: the hold's
      // own notice, with its Confirm, as if the send's answer had been heard. One press.
      // (After a reload the page no longer has what was pressed; a message's fields are its
      // row's own, so its notice comes all the same. An answer's are not, and it reads as
      // the refusal.)
      const again: CommandFields | undefined =
        was.fields ?? (a.kind === "prompt" && a.text ? { kind: "prompt", session: key, text: a.text } : undefined);
      if (a.unheard?.state === "unsent" && a.code === "confirm_required" && notice && again && rp && machineId) {
        const fields = again;
        const refusal = new ControlError(a.unheard.status ?? 422, a.unheard.reason ?? "", a.code, a.detail);
        const h = new HeldForConfirm<ControlActivity>(
          refusal,
          heldWhy(refusal),
          fields,
          machineId,
          remoteHostFor(machineId) ?? null,
          (c = {}) => sendCommand(rp, machineId, fields, { onTap: c.onTap, confirm: true }),
        );
        const caught = catchHeld(h, { draft: typed, ...(was.attached ? { attached: was.attached } : {}) }, typed);
        setError(caught === "changed" ? HELD_WORDS.changed : caught ? null : unheardLine(a));
        continue;
      }
      // Not sent, or nobody can say: the row's words, as a send's own answer would read.
      if (a.unheard) {
        setError(unheardLine(a));
        continue;
      }
      // spacesheep holds it: a send like any other. The composer that still holds its words is cleared.
      setError(null);
      if (a.kind === "prompt")
        confirmedNow.current?.(
          { kind: "prompt", session: key, text: a.text ?? "" },
          typed ?? JSON.stringify([a.text ?? "", []]),
        );
    }
  }, [activity, key, notice, rp, machineId, catchHeld]);

  const onSend = useCallback(
    async (action: ControlAction) => {
      if (!control || !rp) return;
      // A held send's confirm is on its way: nothing else goes until it has answered.
      if (confirmingHeld()) return;
      setError(null);
      setRefusedHour(null);
      let fields: CommandFields;
      switch (action.kind) {
        case "prompt":
          fields = { kind: "prompt", session: key, text: action.text };
          break;
        case "permission.answer":
          fields = {
            kind: "permission.answer",
            session: key,
            for: action.attentionId,
            decision: action.allow ? "allow" : "deny",
            ...(action.note ? { note: action.note } : {}),
          };
          break;
        case "cancel":
          fields = { kind: "cancel", session: key, ...(action.note ? { note: action.note } : {}) };
          break;
      }
      const att = action.kind === "permission.answer" ? action.attentionId : null;
      if (att && answers[att]) return;
      // The same kind of send is out and nobody knows what became of it: held, in its words.
      const out = asking.find((a) => a.kind === fields.kind);
      if (out) {
        const e = new ControlError(504, out.detail ?? "", UNHEARD_CODE, out.detail);
        setError(notSentWords(e));
        throw e;
      }
      // A message depends on the composer it was typed in; an answer or a Stop on nothing.
      const keyAtSend = action.kind !== "cancel" && action.composer ? draftNow.current : undefined;
      const attachedNow = action.kind === "prompt" ? action.attached : undefined;
      pressed.current = { typed: keyAtSend, fields, ...(attachedNow ? { attached: attachedNow } : {}) };
      try {
        const carried = await sendCommand(rp, control.machineId, fields, { onTap: () => setTap(true) });
        went(fields, carried);
        dropHeld();
      } catch (e) {
        // Nobody heard its answer: what was pressed is kept under its row's id.
        if (e instanceof UnheardSend) unheard.current.set(e.id, pressed.current);
        if (att && e instanceof ControlError && e.code === "no_attention")
          setOwn((prev) => ({ ...prev, [att]: { status: "closed", at: Date.now() } }));
        // Held for a confirm: the notice says so where it is shown, the refusal elsewhere.
        const attached = action.kind === "prompt" ? action.attached : undefined;
        const caught = notice
          ? catchHeld(e, { draft: keyAtSend, ...(attached ? { attached } : {}) }, keyAtSend)
          : false;
        if (caught === "changed") setError(HELD_WORDS.changed);
        // Refused for the hour, whose end the phone holds from here on (doors.ts onCooling):
        // said where the hour is said (`cooling`).
        else if (!caught && e instanceof ControlError && e.code === "cooling" && e.until !== undefined)
          setRefusedHour({ words: notSentWords(e, machine), until: e.until });
        // A prompt the person closed is no refusal: the field and the answer stay as they were.
        else if (!caught) setError(isCancel(e) ? null : notSentWords(e, machine));
        throw e;
      } finally {
        pressed.current = {};
        setTap(false);
        grant.refresh();
      }
    },
    [control, rp, key, machine, grant.refresh, answers, notice, catchHeld, dropHeld, confirmingHeld, went, asking],
  );

  // An answer that did not reach its prompt, which takes one again: why, on every surface.
  const ended = answerEnded(activity, attentions, answers);
  // A row still being asked for says so whenever the page is opened, not only after the send.
  // A refusal for the hour where the phone does not hold the hour's end is the send's own.
  const line =
    error ??
    (ended ? answerEndWords(ended, machine ?? "the computer") : null) ??
    (asking[0] ? unheardWords(asking[0]) : null) ??
    (cooling ? null : hourRefusal);
  return { rp, secure, grant, tap, error: line, answers, cooling, sendable, approval, activity, onSend, held };
}
