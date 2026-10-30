// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The session page's control: the strip wired to a signed send
// (a message, Allow / Deny on an open permission, Stop), with the one reason under its
// field (control/ControlStrip.tsx picks it from the facts this hands it), and under it
// what became of an answer or a stop. A message sent from here and its reply are drawn
// in the timeline, where its turn is (SessionView), not here. The signing and the answer
// bookkeeping live in useSend.ts, shared with the inbox; the first send of the day asks
// for the passkey once (the day grant), and "Unlock now" takes it ahead. "Ask another
// agent…" under the field opens the Handoff sheet (orchestrate/handoff), hosted here so
// it opens over whichever surface holds this session.
import type { Attention, ControlActivity, MachineControl, SessionSummary } from "@shared/api";
import { useState } from "react";
import { ControlStrip } from "../components/ControlStrip";
import { useAppState, useStore } from "../data/hooks";
import { HandoffHost } from "../orchestrate/handoff/HandoffHost";
import { canAskFrom } from "../orchestrate/handoff/handoff";
import { openHandoff } from "../orchestrate/handoff/handoffState";
import { ActivityList, forkOf } from "./Activity";
import {
  deviceWords,
  machineTakes,
  signerKind,
  signerLabel,
  signHint,
  unlock as takeGrant,
  updateWords,
  useOwnKeys,
} from "./signer";
import { useSessionSend } from "./useSend";
import { isFinal, sendErrorWords } from "./words";
import "./control.css";
import "../orchestrate/handoff/handoff.css";

/** What stays under the composer: an answer or a Stop on its way, or one that didn't
 *  make it; and a message that went to a copy of this session (CONTROL.md §6), whose turn
 *  is the copy's and never shows here: its row says so and links there. A message's own
 *  progress is its turn's, in the timeline. */
const underStrip = (a: ControlActivity) =>
  ((a.kind === "permission.answer" || a.kind === "cancel") && (!isFinal(a) || a.outcome !== "delivered")) ||
  !!forkOf(a);

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
  const {
    rp,
    secure: canSignHere,
    grant,
    tap,
    error,
    answers,
    activity,
    onSend,
  } = useSessionSend(session, control, attentions);
  const device = signerKind() === "device";
  // The app signs only for a machine whose daemon takes device keys (CONTROL.md §2).
  const old = device && control && !machineTakes(control) ? updateWords(session.machine) : null;
  const secure = canSignHere && !old;
  const own = useOwnKeys(rp);
  const { connection, suggestions: all, sessions } = useAppState();
  const store = useStore();
  // "Unlock now": take the day grant ahead of the first send (one passkey tap).
  const [unlock, setUnlock] = useState<string | null>(null);
  const unlockNow = async () => {
    if (!rp) return;
    setUnlock(`Confirm with ${signerLabel()}…`);
    try {
      await takeGrant(rp);
      grant.refresh();
      setUnlock(null);
    } catch (e) {
      setUnlock(sendErrorWords(e));
    }
  };
  // A plugin's advice on an open permission (a reply from Telegram, say); Confirm signs as usual.
  const suggestions = all.length ? all.filter((s) => s.session === session.key) : all;

  const working = session.state === "working" || session.state === "stale" || !!session.currentTurn;
  // A secure page whose browser holds no passkey the machine trusts (a phone that can open
  // the https origin but never paired): a send would be refused untrusted_key, so point
  // at /add-device, where a trusted device vouches for this one (CONTROL.md §2).
  const untrustedHere = secure && !!rp && !!control && !control.keys.some((k) => own.some((s) => s.id === k.id));
  // The line's one live fact: a refusal, the passkey prompt, or the unlock under way.
  const note = error
    ? error.replace(/^not sent · /, "Not sent: ")
    : tap
      ? device
        ? `Confirm with ${deviceWords().auth}: it vouches for ${deviceWords().this} for a day, so later sends need no prompt.`
        : "Confirm with your passkey: it vouches for this browser for a day, so later sends need no tap."
      : (unlock ?? undefined);
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
        blocked={secure ? undefined : (old ?? signHint(rp))}
        note={note}
        noteKind={error ? "err" : "info"}
        answers={answers}
        suggestions={suggestions}
        chat={chat}
        untrusted={untrustedHere}
        stream={down ? { state: down, retry: () => store.reconnect() } : undefined}
        unlock={control && secure && grant.exp === null ? () => void unlockNow() : undefined}
        ask={askable ? () => openHandoff({ session: session.key }) : undefined}
      />
      <ActivityList items={activity.filter(underStrip)} machine={session.machine} online={control?.online} limit={2} />
      <HandoffHost session={session.key} />
    </>
  );
}
