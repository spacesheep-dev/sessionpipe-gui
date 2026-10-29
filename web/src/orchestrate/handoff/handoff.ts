// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The Handoff sheet's pure parts (DESIGN §3.2, UX-SPEC §2):
// who a session may ask (the other sessions on its machine, newest first, then a new
// session of each agent the hello lists), which of them the sheet opens on, the text it
// is prefilled with (one line of ours over the last reply), the signed command that goes
// (a `prompt` to a session, a `start` for a new one, `reply_to` when the answer is to
// come back), and the words of each entry point's disabled state. No React, no DOM, no
// storage: HandoffSheet.tsx reads these and the tests pin them.
import type { MachineControl, SessionKey, SessionSummary, StartPermission } from "@shared/api";
import { sessionKey } from "@shared/api";
import { ControlError } from "../../control/api";
import type { CommandFields } from "../../control/command";
import { ms } from "../../lib/time";

/** Who is asked: a session on the same machine (a `prompt`), or a new session of a harness
 *  the hello lists (a `start`). A handoff is same-machine by protocol (CONTROL.md §3.1). */
export type Target = { kind: "session"; key: SessionKey } | { kind: "new"; harness: string };

/** A target as the Agent picker's value (`s:<key>`, `h:<harness>`), and back. */
export const targetValue = (t: Target): string => (t.kind === "session" ? `s:${t.key}` : `h:${t.harness}`);
export function parseTarget(v: string | undefined | null): Target | null {
  if (!v) return null;
  if (v.startsWith("s:") && v.length > 2) return { kind: "session", key: v.slice(2) };
  if (v.startsWith("h:") && v.length > 2) return { kind: "new", harness: v.slice(2) };
  return null;
}

/** A `done` session older than this is not offered: it is history, not an agent to ask. */
export const DONE_OFFERED_MS = 24 * 3600_000;

export type Askable = Pick<SessionSummary, "key" | "harness" | "machine" | "state" | "lastAt" | "parentId">;

/** The sessions `self` may ask: on its machine, not itself, no subagent (a subagent's
 *  session is its parent's work, not an agent of its own), no `done` one older than a
 *  day; newest `lastAt` first. */
export function askableSessions<S extends Askable>(
  sessions: Iterable<S>,
  self: { key: SessionKey; machine?: string },
  now: number,
): S[] {
  if (!self.machine) return [];
  const out: S[] = [];
  for (const s of sessions) {
    if (s.machine !== self.machine || s.key === self.key || s.parentId) continue;
    if (s.state === "done" && now - ms(s.lastAt) > DONE_OFFERED_MS) continue;
    out.push(s);
  }
  return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/** Where the Agent picker opens: the agent remembered for this machine when the hello
 *  still lists it, else a new session of the first harness that is not the asking
 *  session's own (Codex when asked from Claude Code), else the first harness, else the
 *  newest session; null when there is nobody to ask. */
export function defaultTarget(o: {
  harnesses: readonly string[];
  selfHarness: string;
  sessions: readonly Pick<Askable, "key">[];
  remembered?: string | null;
}): Target | null {
  if (o.remembered && o.harnesses.includes(o.remembered)) return { kind: "new", harness: o.remembered };
  const other = o.harnesses.find((h) => h !== o.selfHarness) ?? o.harnesses[0];
  if (other) return { kind: "new", harness: other };
  const s = o.sessions[0];
  return s ? { kind: "session", key: s.key } : null;
}

/** The one line of ours over the reply; the person edits it. */
export const ASK_LINE = "Give a second opinion on the reply below. Point out what you'd do differently and why.";
/** A reply longer than this is cut, with the cut marked on its own line. */
export const REPLY_CUT = 8_000;

/** The sheet's text at open: the line, a rule, the reply; empty with no reply (a fresh
 *  session), so the placeholder asks what the agent should do. */
export function prefillText(reply: string | undefined | null): string {
  const r = reply?.trim() ?? "";
  if (!r) return "";
  const body = r.length > REPLY_CUT ? `${r.slice(0, REPLY_CUT).trimEnd()}…\n(cut)` : r;
  return `${ASK_LINE}\n\n---\n${body}`;
}

/** The newest reply a session's events hold, for the prefill: the last `turn.transcript`'s
 *  `assistant`, else the running turn's reading (`progress`), else the summary's snippet.
 *  Events arrive in seq order; the newest wins. Empty when it never answered. */
export function lastReplyOf(
  s: Pick<SessionSummary, "progress" | "lastAssistant">,
  events: readonly { type: string; data: Record<string, unknown> }[] = [],
): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "turn.transcript") continue;
    const a = e.data.assistant;
    if (typeof a === "string" && a.trim()) return a;
  }
  return s.progress?.assistant?.trim() || s.lastAssistant?.trim() || "";
}

/** The command the sheet signs (UX-SPEC §2.6): a `prompt` to a session, or a `start`
 *  for a new one under `newId`, with `reply_to` = the asking session only when the
 *  answer is to come back. `permission` and `model` ride only when given (the sheet
 *  passes them only when the hello advertised them, as New session does). */
export function handoffFields(o: {
  target: Target;
  text: string;
  from: SessionKey;
  bringBack: boolean;
  newId: string;
  cwd?: string;
  permission?: StartPermission;
  model?: string;
}): CommandFields {
  const replyTo = o.bringBack ? { replyTo: o.from } : {};
  if (o.target.kind === "session") return { kind: "prompt", session: o.target.key, text: o.text, ...replyTo };
  return {
    kind: "start",
    session: sessionKey(o.target.harness, o.newId),
    text: o.text,
    cwd: o.cwd ?? "",
    ...(o.permission ? { permission: o.permission } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...replyTo,
  };
}

/** Why "Ask another agent…" is off for a session, in the menu's words (UX-SPEC §2.1), or
 *  null when it can open: its machine is not paired here, or its daemon predates asking
 *  (a hello with neither `ask` nor `handoff`). */
export function askOff(s: { machine?: string }, control: MachineControl | undefined): string | null {
  const name = s.machine ?? "this machine";
  if (!control) return `Pair ${name} to ask from here`;
  if (control.ask === undefined && control.handoff === undefined) return `${name} needs a newer sessionpipe for this`;
  return null;
}

/** Whether the strip shows its "Ask another agent…" button: the machine is paired, its
 *  daemon can ask (`askOff`, the same reading the menu item makes) and there is someone
 *  to ask there (a harness in the hello, or another session). Hidden otherwise, never
 *  disabled: the strip's own line already says why sending is off. */
export function canAskFrom(
  s: { key: SessionKey; machine?: string },
  control: MachineControl | undefined,
  sessions: Iterable<Askable>,
  now: number,
): boolean {
  if (!control || askOff(s, control) !== null) return false;
  if (control.harnesses?.length) return true;
  return askableSessions(sessions, s, now).length > 0;
}

/** A refusal only a handoff meets, in words (the rest are `sendErrorWords`): the machine
 *  did not say it takes answers back (`handoff`, the receiver's own check), or this
 *  receiver's sessionpipe-core predates `reply_to` and refused the field (`bad_fields`
 *  with the switch on). Null for any other error. */
export function handoffRefusalWords(e: unknown, machine: string, bringBack: boolean): string | null {
  if (!(e instanceof ControlError) || e.status !== 422) return null;
  if (e.code === "handoff")
    return `Not sent: ${machine} didn't say it brings answers back. Turn the switch off to ask without that.`;
  if (e.code === "bad_fields" && bringBack)
    return "Not sent: this receiver's sessionpipe is older than bringing answers back. Turn the switch off, or update it.";
  return null;
}
