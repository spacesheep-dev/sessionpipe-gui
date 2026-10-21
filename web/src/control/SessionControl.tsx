// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The session page's control: the strip wired to a signed send
// (a prompt, Allow / Deny on an open permission, cancel) and, under it, what became of
// each message. The signing and the answer bookkeeping live in useSend.ts, shared with
// the inbox; the first send of the day asks for the passkey once (the day grant).
import type { Attention, MachineControl, SessionSummary } from "@shared/api";
import { useState } from "react";
import { ControlStrip } from "../components/ControlStrip";
import { useAppState } from "../data/hooks";
import { Link } from "../lib/router";
import { ActivityList } from "./Activity";
import { obtainGrant } from "./daykey";
import { useSessionSend } from "./useSend";
import { insecureHint, storedPasskeys } from "./webauthn";
import { sendErrorWords } from "./words";
import "./control.css";

export function SessionControl({
  session,
  control,
  attentions,
  chat = false,
}: {
  session: SessionSummary;
  control?: MachineControl;
  attentions: Attention[];
  /** Simple mode's composer: one line of context above a rounded "Message this session…". */
  chat?: boolean;
}) {
  const { rp, secure, grant, tap, error, answers, activity, onSend } = useSessionSend(session, control, attentions);
  // "Unlock now": take the day grant ahead of the first send (one passkey tap).
  const [unlock, setUnlock] = useState<string | null>(null);
  const unlockNow = async () => {
    if (!rp) return;
    setUnlock("Confirm with your passkey…");
    try {
      await obtainGrant(rp);
      grant.refresh();
      setUnlock(null);
    } catch (e) {
      setUnlock(sendErrorWords(e));
    }
  };
  // A plugin's advice on an open permission (a reply from Telegram, say); Confirm signs as usual.
  const all = useAppState().suggestions;
  const suggestions = all.length ? all.filter((s) => s.session === session.key) : all;

  const working = session.state === "working" || session.state === "stale" || !!session.currentTurn;
  const tapHint = tap
    ? "Confirm with your passkey: it vouches for this browser for a day, so later sends need no tap."
    : control && secure && grant.exp === null
      ? "The first send of the day asks for your passkey once; this browser then signs by itself until tomorrow."
      : undefined;

  // A secure page whose browser holds no passkey the machine trusts (a phone that can open
  // the https origin but never paired): a send would be refused untrusted_key, so point
  // at /add-device, where a trusted device vouches for this one (CONTROL.md §2).
  const untrustedHere =
    secure && !!rp && !!control && !control.keys.some((k) => storedPasskeys(rp).some((s) => s.id === k.id));

  const machine = session.machine ?? "the machine";
  // With the keyboard up on a phone the explanation hides and the links stay (app.css, html[data-composing]).
  return (
    <>
      {chat && (
        <p className="ctl-context">
          <span className="ctl-context-why">
            {control ? (
              <>
                Messages go to <strong>{machine}</strong>, which picks this session up there. Sending asks for your
                passkey once a day.
              </>
            ) : (
              <>
                Pair <strong>{machine}</strong> to message this session from here.
              </>
            )}{" "}
          </span>
          {control && secure && grant.exp === null && (
            <>
              <button type="button" className="ctl-link" onClick={() => void unlockNow()}>
                Unlock now
              </button>
              {" · "}
            </>
          )}
          <Link to="/add-device">New phone or laptop? Add it</Link>
          {unlock && <span className="ctl-context-note"> · {unlock}</span>}
        </p>
      )}
      <ControlStrip
        session={session}
        control={control}
        attentions={attentions}
        onSend={secure && rp ? onSend : undefined}
        working={working}
        blocked={secure ? undefined : insecureHint()}
        note={error ?? (chat ? undefined : tapHint)}
        noteKind={error ? "err" : "info"}
        answers={answers}
        suggestions={suggestions}
        placeholder={chat ? "Message this session…" : undefined}
        chat={chat}
      />
      {untrustedHere && (
        <p className="ctl-untrusted">
          {session.machine ?? "the machine"} trusts no passkey from this browser, so it would refuse a send from here.{" "}
          <Link to="/add-device">Add this device →</Link>
        </p>
      )}
      <ActivityList items={activity} machine={session.machine} online={control?.online} />
    </>
  );
}
