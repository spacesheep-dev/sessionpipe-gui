// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A session that was just started from here and has sent nothing
// yet (STEER-SPEC B.5). The store holds no summary for its key, but the `start` this
// device signed names it, so the page draws the session's own layout instead of "No such
// session": the message as the first bubble, then one neutral status row that follows the
// machine's acks (queued, sent, starting, the reply growing). The first hook event for the
// key turns the page into the ordinary live session (SessionView). A start the machine
// refused or that failed says why in place, with one action: Edit and start again.
import { type ControlActivity, splitKey } from "@shared/api";
import { useCallback, useEffect } from "react";
import { HarnessGlyph, Spinner } from "../components/bits";
import { Markdown } from "../components/Markdown";
import { BackButton, PageBar } from "../components/PageBar";
import { useMachines } from "../data/hooks";
import { bytes, harnessMark } from "../lib/format";
import { back, navigate, sessionPath } from "../lib/router";
import { tildify } from "./folders";
import { useControlActivity } from "./hooks";
import "./newSession.css";
import { openNewSession } from "./newSessionState";
import { isFinal, PERMISSION_LABEL, shownState, startFailureWords } from "./words";

/** The start this device (or another) sent that names `key`, newest first. */
export function useStartOf(key: string): ControlActivity | undefined {
  const mine = useCallback((a: ControlActivity) => a.kind === "start" && a.session === key, [key]);
  return useControlActivity(mine)[0];
}

/** "Accept edits · sonnet": what the machine ran a start with, from its ack. */
export function appliedFact(a: ControlActivity | undefined): string | null {
  if (!a?.applied) return null;
  return (
    [a.applied.permission && PERMISSION_LABEL[a.applied.permission], a.applied.model].filter(Boolean).join(" · ") ||
    null
  );
}

/** A start that asked for options and was delivered without `applied` reached a machine
 *  that ignored them (a daemon before 0.10); the sender rule makes this rare. */
export const optionsIgnored = (a: ControlActivity | undefined): boolean =>
  !!a && a.outcome === "delivered" && !!(a.permission || a.model) && !a.applied;

/** Reopens the sheet with what the start carried, so it can be fixed and sent again. */
export function editAgain(a: ControlActivity, machine: string | undefined): void {
  openNewSession({
    ...(machine ? { machine } : {}),
    ...(a.session ? { harness: splitKey(a.session).harness } : {}),
    ...(a.cwd ? { cwd: a.cwd } : {}),
    text: a.text ?? "",
    ...(a.permission ? { permission: a.permission } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.files ? { files: a.files } : {}),
  });
}

export function StartingSession({ a, mode }: { a: ControlActivity; mode: "page" | "panel" }) {
  const machines = useMachines();
  const m = machines.find((x) => x.control?.machineId === a.machineId);
  const name = m?.name ?? "the machine";
  const harness = a.session ? splitKey(a.session).harness : "";
  const agent = harnessMark(harness).label;
  const online = m?.control?.online ?? false;
  const first = (a.text ?? "").split("\n")[0]!.trim();
  const title = first.length > 80 ? `${first.slice(0, 79)}…` : first || "New session";
  const folder = a.cwd ? tildify(a.cwd, m?.control?.home) : undefined;
  const state = shownState(a);
  const failure = isFinal(a) && a.outcome !== "delivered" ? startFailureWords(a, name, agent) : null;
  const applied = appliedFact(a);

  // The machine started it under another id (the final ack names it): go there instead.
  useEffect(() => {
    if (!a.ackSession || a.ackSession === a.session || mode !== "page") return;
    const k = splitKey(a.ackSession);
    navigate(sessionPath(k.harness, k.id), { replace: true });
  }, [a.ackSession, a.session, mode]);

  const line =
    state === "queued"
      ? online
        ? `Sent to ${name}`
        : `Waiting for ${name}. It starts when the machine is back.`
      : state === "taken"
        ? `Starting on ${name}`
        : state === "progress"
          ? "Working…"
          : state === "delivered"
            ? `Started on ${name}; the session's first events are on their way`
            : null;

  return (
    <div
      className={`page session session--chat starting ${mode === "panel" ? "session--panel" : ""}`}
      data-starting={state}
    >
      {mode === "page" ? (
        <PageBar
          back={<BackButton onClick={() => back("/")} />}
          title={title}
          titleClassName="sess-title"
          large={false}
          className="sess-bar"
          meta={
            <span className="sess-counts">
              <span>{name}</span>
              <span>{agent}</span>
              {folder && <span className="sess-repo">{folder}</span>}
              {applied && <span className="sess-applied">{applied}</span>}
            </span>
          }
        />
      ) : (
        <p className="sess-sub">{[name, agent, folder, applied].filter(Boolean).join(" · ")}</p>
      )}
      <ol className="timeline timeline--chat">
        <li className="turn turn--chat">
          <div className="chat-you">
            <time className="chat-time num" dateTime={a.at}>
              {new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </time>
            <p className="chat-bubble">{a.text}</p>
            {a.files && a.files.length > 0 && (
              <ul className="starting-files" aria-label="Files">
                {a.files.map((f) => (
                  <li key={f.sha256} className="starting-file">
                    <span className="ellipsis">{f.name}</span>
                    <span className="num">{bytes(f.size)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="chat-ai">
            <span className="chat-meta">
              <HarnessGlyph name={harness} size="sm" />
              {agent}
            </span>
            {a.reply && <Markdown text={a.reply} />}
            {failure ? (
              <div className="starting-failed" role="alert">
                <p className="chat-err">
                  <InlineCode text={failure} />
                </p>
                <button type="button" className="btn btn--sm" onClick={() => editAgain(a, m?.name)} data-edit-again>
                  Edit and start again
                </button>
              </div>
            ) : (
              line && (
                <p className="chat-working starting-state" aria-live="polite">
                  {!isFinal(a) && <Spinner label={state} />}
                  {line}
                </p>
              )
            )}
            {optionsIgnored(a) && (
              <p className="chat-note">{name} ran this at its own mode; its sessionpipe ignores per-session options.</p>
            )}
          </div>
        </li>
      </ol>
    </div>
  );
}

/** A machine's words with its `backticked` commands set as code, not shown as backticks. */
function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`]+`)/)
        .map((part, i) =>
          part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
            <code key={i}>{part.slice(1, -1)}</code>
          ) : (
            part
          ),
        )}
    </>
  );
}
