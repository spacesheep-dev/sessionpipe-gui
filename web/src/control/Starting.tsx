// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A message this device sent, drawn where its turn is or will be
// (STEER-SPEC B.5): the session's own layout (SessionView) shows a `start` it signed
// before the receiver holds a single event of the session, then joins it to the turn it
// became, so the started moment is one surface. The pieces live here: the title a start
// gives its session, the files it carried as chips, the one status row that follows the
// machine's acks and turns into "Running · 4 s" in place, and the failure, said neutrally
// with one small ✕, its command in a well, and the honest ways on (Start in Safe instead,
// Edit and start again).
import { type ControlActivity, type MachineControl, type SessionKey, sessionKey, splitKey } from "@shared/api";
import { useCallback, useMemo, useState } from "react";
import { ActionButton, CommandWell, Since } from "../components/bits";
import { useMachines } from "../data/hooks";
import { bytes, harnessMark, rememberStartTitles } from "../lib/format";
import { navigate, sessionPath } from "../lib/router";
import { rpId } from "./api";
import { uuid } from "./bytes";
import { sendCommand } from "./command";
import { useControlActivity } from "./hooks";
import "./newSession.css";
import { openNewSession } from "./newSessionState";
import {
  harnessCommand,
  isFinal,
  outcomeWords,
  PERMISSION_LABEL,
  refusalWords,
  sendErrorWords,
  sentLine,
  shownState,
  startFailureWords,
} from "./words";

/** The start this device (or another) sent that names `key`, newest first. */
export function useStartOf(key: string): ControlActivity | undefined {
  const mine = useCallback((a: ControlActivity) => a.kind === "start" && a.session === key, [key]);
  return useControlActivity(mine)[0];
}

/** The title a start gives its session until the session names itself: the first line of
 *  the message, up to 80 characters, never the folder's name. */
export function startTitle(a: ControlActivity | undefined): string | undefined {
  const first = (a?.text ?? "").split("\n")[0]!.trim();
  if (!first) return undefined;
  return first.length > 80 ? `${first.slice(0, 79).replace(/\s+\S*$/, "")}…` : first;
}

/** Every start's title by the session it made, for surfaces that list sessions (the
 *  split panel's tabs, the board): a session started here is called by its first message. */
export function useStartTitles(): ReadonlyMap<SessionKey, string> {
  const starts = useControlActivity(isStart);
  return useMemo(() => {
    const out = new Map<SessionKey, string>();
    for (const a of starts) {
      const t = startTitle(a);
      if (a.session && t && !out.has(a.session as SessionKey)) out.set(a.session as SessionKey, t);
    }
    rememberStartTitles(out);
    return out;
  }, [starts]);
}
const isStart = (a: ControlActivity) => a.kind === "start";

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

/** Whether a refused start can be offered again at Safe: the machine refused the level,
 *  and its hello offers Safe for this agent. */
export function safeOffered(a: ControlActivity, control: MachineControl | undefined): boolean {
  if (a.kind !== "start" || a.outcome !== "refused" || !a.session) return false;
  if (a.code !== "permission" && a.code !== "mode") return false;
  if (a.permission === "safe") return false;
  return !!control?.start?.[splitKey(a.session).harness]?.permissions.includes("safe");
}

/** Signs the same start again at Safe, under a new session id, and opens it in place of
 *  the refused one. Throws what the receiver or the passkey said. */
async function startAtSafe(a: ControlActivity, control: MachineControl): Promise<void> {
  const harness = splitKey(a.session!).harness;
  const rp = await rpId();
  const sid = uuid();
  await sendCommand(rp, control.machineId, {
    kind: "start",
    session: sessionKey(harness, sid),
    text: a.text ?? "",
    cwd: a.cwd ?? "",
    permission: "safe",
    ...(a.model ? { model: a.model } : {}),
    ...(a.files?.length ? { files: a.files } : {}),
  });
  navigate(sessionPath(harness, sid), { replace: true });
}

/** The files a start carried, as quiet chips under its message. */
export function SentFiles({ files }: { files: ControlActivity["files"] }) {
  if (!files?.length) return null;
  return (
    <ul className="starting-files" aria-label="Files">
      {files.map((f) => (
        <li key={f.sha256} className="starting-file">
          <span className="ellipsis">{f.name}</span>
          <span className="num">{bytes(f.size)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The one status row of a message on its way, or of a turn running: a neutral glyph, the
 *  words and, once the agent is at it, a live timer. The receiver's plumbing ("delivered ·
 *  sdk") is its tooltip. `chat` draws it as the chat's quiet line, else a timeline row.
 *  Each step ("Sent to studio-mac" → "Starting claude on studio-mac…" → "Running · 2 s")
 *  takes the row's place in one short cross-fade, the words keyed by what they say, so the
 *  started moment reads as one line that moves on, never a row that jumps; the timer
 *  ticks inside it without a fade. */
export function StatusRow({
  text,
  since,
  spinning,
  tip,
  chat,
  state,
}: {
  text: string;
  since?: string;
  spinning: boolean;
  tip?: string;
  chat: boolean;
  state?: string;
}) {
  const body = (
    <span className="starting-state" key={text}>
      {text}
      {since ? (
        <span className="status-since">
          {" · "}
          <Since iso={since} />
        </span>
      ) : null}
    </span>
  );
  if (chat)
    return (
      <p className="chat-working status-row" title={tip} aria-live="polite" data-sent-state={state}>
        {spinning ? <span className="spinner spinner--sm" aria-hidden="true" /> : <span className="status-gap" />}
        {body}
      </p>
    );
  return (
    <li className="marker marker--status status-row" title={tip} aria-live="polite" data-sent-state={state}>
      <span className="marker-glyph">
        {spinning ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
      </span>
      <span className="marker-body">{body}</span>
    </li>
  );
}

/** Where a message sent from here stands, as its status row's props; null once it
 *  failed (the failure says it). */
export function sentRow(
  a: ControlActivity,
  o: { machine: string; online: boolean },
): { text: string; since?: string; spinning: boolean; tip?: string; state?: string } | null {
  const harness = a.session ? splitKey(a.session).harness : "";
  const line = sentLine(a, { ...o, command: harnessCommand(harness, harnessMark(harness).label) });
  if (!line) return null;
  return {
    text: line.text,
    since: line.running ? (a.takenAt ?? a.at) : undefined,
    spinning: !isFinal(a),
    tip: outcomeWords(a, o),
    state: shownState(a),
  };
}

/** A prompt that did not reach its session, in the words the timeline shows under it. */
export function promptFailureWords(a: ControlActivity, machine: string): string | null {
  const detail = a.detail?.trim();
  switch (a.outcome) {
    case "refused":
      return `${machine} refused it: ${refusalWords(a.code)}.`;
    case "failed":
      return `It didn't reach the session${detail ? `: ${detail.replace(/[.!?…]?$/, ".")}` : "."}`;
    case "expired":
      return `${machine} didn't take it in time.`;
    case "unsupported":
      return `${machine} can't hand messages to this session's agent.`;
    default:
      return null;
  }
}

/** The `backticked` command a machine's words carry, the first one. */
const commandIn = (text: string): string | null => /`([^`]+)`/.exec(text)?.[1] ?? null;

/** A message that didn't make it: a neutral sentence after one small ✕ (a policy answer is
 *  not a crash, so the words stay in the body tier), the command it names in a well with
 *  Copy, and the ways on the machine allows. */
export function SentFailure({
  a,
  machine,
  control,
  onEdit,
}: {
  a: ControlActivity;
  machine: string;
  control?: MachineControl;
  /** A prompt's "Edit and send again": its words back in the composer. */
  onEdit?: (text: string) => void;
}) {
  const machines = useMachines();
  const harness = a.session ? splitKey(a.session).harness : "";
  const words =
    a.kind === "start" ? startFailureWords(a, machine, harnessMark(harness).label) : promptFailureWords(a, machine);
  const [err, setErr] = useState<string | null>(null);
  if (!words) return null;
  const command = commandIn(words);
  const safe = control && safeOffered(a, control);
  const name = machines.find((m) => m.control?.machineId === a.machineId)?.name;
  return (
    <div className="starting-failed" role="alert">
      <p className="sent-failed-text">
        <svg className="sent-x" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span>
          <InlineCode text={words} />
        </span>
      </p>
      {command && <CommandWell command={command} label="Copy the command" />}
      <span className="sent-failed-actions">
        {safe && (
          <ActionButton
            className="btn btn--sm"
            pendingLabel="Starting…"
            onClick={() =>
              startAtSafe(a, control).catch((e) => setErr(sendErrorWords(e).replace(/^not sent · /, "Not sent: ")))
            }
          >
            Start in Safe instead
          </ActionButton>
        )}
        {a.kind === "start" ? (
          <button type="button" className="btn btn--sm" onClick={() => editAgain(a, name)} data-edit-again>
            Edit and start again
          </button>
        ) : onEdit && a.text ? (
          <button type="button" className="btn btn--sm" onClick={() => onEdit(a.text ?? "")}>
            Edit and send again
          </button>
        ) : null}
      </span>
      {err && <p className="sent-failed-err">{err}</p>}
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
