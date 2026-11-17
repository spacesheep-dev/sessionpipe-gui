// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The session page's control: the strip wired to a signed send
// (a message, Allow / Deny on an open permission, Stop), with the one reason under its
// field (control/ControlStrip.tsx picks it from the facts this hands it), and under it
// what became of an answer or a stop. A message sent from here and its reply are drawn
// in the timeline, where its turn is (SessionView), not here. The signing and the answer
// bookkeeping live in useSend.ts, shared with the inbox; the first send of the day asks
// for the passkey once (the day grant), and in a browser "Unlock now" takes it ahead. The
// app says nothing ahead: its first send's own prompt (Face ID, Touch ID) says what it is.
// "Ask another agent…" under the field opens the Handoff sheet (orchestrate/handoff),
// hosted here so it opens over whichever surface holds this session.
import type { Attention, ControlActivity, MachineControl, SessionSummary } from "@shared/api";
import { useEffect, useState } from "react";
import { COMPOSER_SENT, ControlStrip } from "../components/ControlStrip";
import { useAppState, useListedSessions, useStore } from "../data/hooks";
import { accountMode, accountSessionUrl, receiverOrigin } from "../lib/net";
import { HandoffHost } from "../orchestrate/handoff/HandoffHost";
import { canAskFrom } from "../orchestrate/handoff/handoff";
import { openHandoff } from "../orchestrate/handoff/handoffState";
import { ActivityList, forkOf } from "./Activity";
import { HeldNotice } from "./HeldNotice";
import { isCancel, machineTakes, signerKind, signHint, unlock as takeGrant, tapWords, updateWords } from "./signer";
import { useSessionSend } from "./useSend";
import { isFinal, notSentWords } from "./words";
import "./control.css";
import "../orchestrate/handoff/handoff.css";

/** What stays under the composer: an answer or a Stop on its way, or one that didn't
 *  make it; and a message that went to a copy of this session (CONTROL.md §6), whose turn
 *  is the copy's and never shows here: its row says so and links there. A message's own
 *  progress is its turn's, in the timeline. */
const underStrip = (a: ControlActivity) =>
  ((a.kind === "permission.answer" || a.kind === "cancel") && (!isFinal(a) || a.outcome !== "delivered")) ||
  !!forkOf(a);

/** Where the focus goes when the notice under the composer goes: the composer, the form
 *  just before it. */
const composerBefore = (live: HTMLElement) => live.previousElementSibling?.querySelector<HTMLElement>("textarea");

export function SessionControl({
  session,
  control,
  attentions,
  chat = false,
}: {
  session: SessionSummary;
  control?: MachineControl;
  attentions: Attention[];
  /** Simple mode's composer (its class; the words are one voice in both modes). */
  chat?: boolean;
  /** Unused: messages are joined to their turns in the timeline now. */
  inChat?: (messages: readonly ControlActivity[]) => ReadonlySet<string>;
}) {
  // The composer's words and attachments as they are now (ControlStrip onDraft).
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const {
    rp,
    secure: canSignHere,
    grant,
    tap,
    error,
    answers,
    activity,
    onSend,
    held,
    // On a spacesheep account a phone approved less than an hour ago cannot send yet: said
    // here with the time, before a send or an answer is refused for it.
    cooling,
    // Whether this device can send to the session's machine (on an account the device door's
    // word, else the machine's key list: account/sendable.ts), and what of it turns the strip off.
    sendable: send,
    approval,
  } = useSessionSend(session, control, attentions, {
    draft,
    // A message the receiver held is confirmed from the notice under the composer; once
    // it went, the composer that still held its words is cleared.
    notice: true,
    confirmed: (_fields, typed) => {
      if (typed !== undefined)
        window.dispatchEvent(new CustomEvent(COMPOSER_SENT, { detail: { key: session.key, draft: typed } }));
    },
  });
  const device = signerKind() === "device";
  // The app signs only for a machine whose daemon takes device keys (CONTROL.md §2).
  const old = device && control && !machineTakes(control) ? updateWords(session.machine) : null;
  const secure = canSignHere && !old;
  const { connection, suggestions: all } = useAppState();
  const sessions = useListedSessions();
  const store = useStore();
  // "Unlock now": take the day grant ahead of the first send (one passkey tap). A prompt
  // the person closes leaves the line as it was, with Unlock now; a refusal is said until a
  // grant is held, so a send that takes one ends it too.
  const [unlock, setUnlock] = useState<string | null>(null);
  const unlockNow = async () => {
    if (!rp) return;
    setUnlock(tapWords());
    try {
      await takeGrant(rp);
      grant.refresh();
      setUnlock(null);
    } catch (e) {
      setUnlock(isCancel(e) ? null : notSentWords(e));
    }
  };
  // Once a grant is held what Unlock now said is over, also when that grant goes later.
  useEffect(() => {
    if (grant.exp) setUnlock(null);
  }, [grant.exp]);
  // A plugin's advice on an open permission (a reply from Telegram, say); Confirm signs as usual.
  const suggestions = all.length ? all.filter((s) => s.session === session.key) : all;

  const working = session.state === "working" || session.state === "stale" || !!session.currentTurn;
  // The line's one live fact: a refusal, the prompt being up, or the unlock under way (or
  // why it failed, while no grant is held). All but the prompt's own line are refusals.
  const note = error ?? (tap ? tapWords() : grant.exp === null && unlock ? unlock : undefined);
  const down = connection === "reconnecting" || connection === "offline" ? connection : null;
  // Someone to ask on its machine: another session there, or a harness its hello lists.
  const askable = canAskFrom(session, control, sessions.values(), Date.now());
  return (
    <>
      <ControlStrip
        session={session}
        control={control}
        attentions={attentions}
        onSend={secure && rp ? onSend : undefined}
        working={working}
        blocked={secure ? (cooling ?? undefined) : (old ?? signHint(rp))}
        blockedSays={secure ? (cooling ?? undefined) : undefined}
        elsewhere={
          // On a spacesheep account a session this phone cannot send to (no signer yet on
          // Android, a computer not paired for it) can still be answered on spacesheep itself.
          accountMode() ? { href: accountSessionUrl(session.id), host: new URL(receiverOrigin()).host } : undefined
        }
        note={note}
        noteKind={note && note !== tapWords() ? "err" : "info"}
        answers={answers}
        suggestions={suggestions}
        chat={chat}
        send={secure && rp ? send : undefined}
        approval={secure && rp ? approval : undefined}
        stream={down ? { state: down, retry: () => store.reconnect() } : undefined}
        unlock={!device && control && secure && grant.exp === null ? () => void unlockNow() : undefined}
        ask={askable ? () => openHandoff({ session: session.key }) : undefined}
        onDraft={setDraft}
      />
      <HeldNotice h={held} focusBack={composerBefore} />
      <ActivityList items={activity.filter(underStrip)} machine={session.machine} online={control?.online} limit={2} />
      <HandoffHost session={session.key} />
    </>
  );
}
