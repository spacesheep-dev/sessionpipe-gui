// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The one signed send path for a session, shared by the session
// page's strip (SessionControl) and the inbox's Allow / Deny: builds the command for a
// strip action, signs it with the day grant (one passkey tap a day), and remembers which
// attentions have an answer out or were closed by the machine, so no second answer goes.
import type { Attention, ControlActivity, MachineControl, SessionSummary } from "@shared/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ControlAction, preHello } from "../components/ControlStrip";
import { ControlError, UNHEARD_CODE } from "./api";
import { type CommandFields, HeldForConfirm, heldWhy, sendCommand, UnheardSend } from "./command";
import { type Held, useHeld } from "./HeldNotice";
import type { HeldMeta } from "./held";
import { HELD_WORDS } from "./heldWords";
import { useControlActivity, useGrant, useRpId } from "./hooks";
import { remoteHostFor } from "./remoteRp";
import { canSign, machineTakes, signerLabel, signHint, updateWords } from "./signer";
import { sendErrorWords, unheardWords } from "./words";

export type AnswerStatus = "sent" | "closed";

/** Whether Allow / Deny can go for one prompt right now, and if not (or while an answer
 *  is out) why, in words: the machine is not paired, this page cannot use passkeys, the
 *  prompt predates the pairing, or an answer is already out. Shared by the inbox rows
 *  and the toasts. `tag` is the short state for a data attribute. */
export function answerState(
  s: SessionSummary,
  a: Attention,
  control: MachineControl | undefined,
  send: Pick<SessionSend, "rp" | "secure" | "tap" | "answers">,
): { reason: string | null; off: boolean; status: AnswerStatus | undefined; tag: string } {
  const status = send.answers[a.attentionId];
  const early = preHello(a, control);
  const old = control && !machineTakes(control) ? updateWords(s.machine ?? undefined).replace(/\.$/, "") : null;
  const reason = !control
    ? `pair ${s.machine ?? "this machine"} to send messages`
    : !send.secure
      ? signHint(send.rp)
      : old
        ? old
        : early
          ? "raised before this machine was paired; answer it in its terminal"
          : status === "closed"
            ? "answered in the terminal, or expired"
            : status === "sent"
              ? `answer sent · waiting for ${s.machine ?? "the machine"}`
              : send.tap
                ? `confirm with ${signerLabel()}`
                : null;
  const off = !control || !send.secure || !send.rp || !!old || early || !!status;
  const tag = !control ? "unpaired" : !send.secure || old ? "blocked" : (status ?? (early ? "pre-hello" : "open"));
  return { reason, off, status, tag };
}

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
  /** The last send's refusal, in words; null once a send is retried. */
  error: string | null;
  /** Per attention id: "sent" while an answer is out, "closed" once the machine said the
   *  prompt is no longer open (answered in its terminal, or expired). */
  answers: Readonly<Record<string, AnswerStatus>>;
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
  const key = session.key;
  const mine = useCallback((a: { session?: string }) => a.session === key, [key]);
  const activity = useControlActivity(mine);

  const [answers, setAnswers] = useState<Record<string, AnswerStatus>>({});
  /** Message id → the attention its answer named. */
  const sent = useRef(new Map<string, string>());
  /** An answer that went is "sent" until the machine says what became of it. */
  const went = useCallback((fields: CommandFields, carried: ControlActivity) => {
    if (fields.kind !== "permission.answer") return;
    sent.current.set(carried.id, fields.for);
    setAnswers((prev) => ({ ...prev, [fields.for]: "sent" }));
  }, []);
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
    (e) => setError(sendErrorWords(e)),
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
      if (a.unheard?.state === "unsent" && a.code === "confirm_required" && notice && was.fields && rp && machineId) {
        const fields = was.fields;
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
        setError(caught === "changed" ? HELD_WORDS.changed : caught ? null : unheardWords(a));
        continue;
      }
      // Not sent, or nobody can say: the row's words, as a send's own answer would read.
      if (a.unheard) {
        setError(unheardWords(a));
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
  useEffect(() => {
    const closed: string[] = [];
    for (const a of activity) {
      const att = sent.current.get(a.id);
      if (!att) continue;
      if ((a.outcome === "refused" && (a.code === "no_attention" || a.code === "expired")) || a.outcome === "expired")
        closed.push(att);
    }
    if (closed.length)
      setAnswers((prev) => {
        const next = { ...prev };
        for (const att of closed) next[att] = "closed";
        return next;
      });
  }, [activity]);
  // An attention the stream cleared needs no memory any more.
  useEffect(() => {
    const open = new Set(attentions.map((a) => a.attentionId));
    setAnswers((prev) => {
      const keep = Object.entries(prev).filter(([id]) => open.has(id));
      return keep.length === Object.keys(prev).length ? prev : Object.fromEntries(keep);
    });
  }, [attentions]);

  const onSend = useCallback(
    async (action: ControlAction) => {
      if (!control || !rp) return;
      // A held send's confirm is on its way: nothing else goes until it has answered.
      if (confirmingHeld()) return;
      setError(null);
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
        setError(sendErrorWords(e));
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
          setAnswers((prev) => ({ ...prev, [att]: "closed" }));
        // Held for a confirm: the notice says so where it is shown, the refusal elsewhere.
        const attached = action.kind === "prompt" ? action.attached : undefined;
        const caught = notice
          ? catchHeld(e, { draft: keyAtSend, ...(attached ? { attached } : {}) }, keyAtSend)
          : false;
        if (caught === "changed") setError(HELD_WORDS.changed);
        else if (!caught) setError(sendErrorWords(e));
        throw e;
      } finally {
        pressed.current = {};
        setTap(false);
        grant.refresh();
      }
    },
    [control, rp, key, grant.refresh, answers, notice, catchHeld, dropHeld, confirmingHeld, went, asking],
  );

  // A row still being asked for says so whenever the page is opened, not only after the send.
  const line = error ?? (asking[0] ? unheardWords(asking[0]) : null);
  return { rp, secure, grant, tap, error: line, answers, activity, onSend, held };
}
