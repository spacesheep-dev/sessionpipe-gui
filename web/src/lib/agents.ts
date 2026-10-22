// SPDX-License-Identifier: Apache-2.0
// A session's subagents as every surface reads them (ORGANIZE-SPEC.md §4): what an agent
// is called, what it is doing now, its glyph, the parent's "2 subagents running", and
// where opening one goes (the panel's agent tab beside, the session page on the agent).
// Everything here reads `SessionSummary.agents` (shared/api.ts AgentRun) and never
// guesses: a fact the events did not carry is left out.
import type { AgentRun, SessionKey, SessionState, SessionSummary } from "@shared/api";
import { splitKey } from "@shared/api";
import { agentPath, navigate, sessionPath } from "./router";
import { agentTabKey, type OpenSplitOptions, openSplit } from "./split";
import { dur } from "./time";

export { AGENT_TAB_SEP, agentTabKey, parseTab } from "./split";

/** The §5.1 glyph an agent draws: running turns, stale is dashed, done is a check. */
export const agentGlyph = (a: Pick<AgentRun, "state">): SessionState =>
  a.state === "running" ? "working" : a.state === "stale" ? "stale" : "done";

/** What an agent is called: its type ("Explore"), else "Subagent". */
export const agentType = (a: Pick<AgentRun, "type">): string => a.type?.trim() || "Subagent";

/** "Explore · Find ad-hoc money formatting", or the type alone when nothing described it. */
export function agentLabel(a: Pick<AgentRun, "type" | "description">): string {
  const d = a.description?.trim();
  return d ? `${agentType(a)} · ${d}` : agentType(a);
}

/** How long it ran (or has run so far, at `now`). */
export function agentDuration(a: Pick<AgentRun, "startedAt" | "endedAt" | "lastAt" | "state">, now: number): number {
  const start = Date.parse(a.startedAt);
  const end = a.state === "done" ? Date.parse(a.endedAt ?? a.lastAt) : now;
  return Math.max(0, end - start);
}

/** What the agent is doing now, in a few words: "Grep · 4 s", "Thinking", "Quiet for
 *  12 m 04 s", or, once done, how long it ran. A harness that does not mark a subagent's
 *  tools (`attributed` false, Codex) gets no tool facts: "Running", or the duration. */
export function agentNow(a: AgentRun, now: number): string {
  if (a.state === "done") return dur(agentDuration(a, now));
  if (a.state === "stale") return `Quiet for ${dur(now - Date.parse(a.lastAt))}`;
  if (!a.attributed) return "Running";
  if (a.currentTool) return `${a.currentTool.tool} · ${dur(now - Date.parse(a.currentTool.since))}`;
  return "Thinking";
}

/** Why an agent row says so little, when it does: its tooltip. */
export const agentTip = (a: AgentRun): string | undefined =>
  a.attributed || a.session ? undefined : "Codex doesn't report a subagent's tools separately";

/** The parent row's trailing fact while any agent is open: "2 subagents running", or
 *  "2 subagents · 1 quiet" when some went silent. Null when none is open. */
export function agentsFact(s: Pick<SessionSummary, "agents" | "counts">): string | null {
  const open = s.counts.agentsRunning ?? 0;
  if (open <= 0) return null;
  const quiet = (s.agents ?? []).filter((a) => a.state === "stale").length;
  const n = `${open} subagent${open === 1 ? "" : "s"}`;
  return quiet > 0 ? `${n} · ${quiet} quiet` : `${n} running`;
}

/** Whether a search word finds an agent (its type or what it was asked). */
export const agentMatches = (a: AgentRun, word: string): boolean =>
  `${a.type ?? ""} ${a.description ?? ""}`.toLowerCase().includes(word);

const phone = () => typeof matchMedia === "function" && matchMedia("(max-width: 839px)").matches;

/** Open an agent: beside, as the panel's agent tab (a phone opens the page, which is how
 *  a phone opens one); as a page, the parent's page on the agent. An agent that came as a
 *  session of its own (`parent_id`) opens that session. */
export function openAgent(
  s: Pick<SessionSummary, "key" | "harness" | "id">,
  a: Pick<AgentRun, "id" | "session">,
  how: "beside" | "page" = "beside",
  opts: OpenSplitOptions = {},
): void {
  if (a.session) {
    const { harness, id } = splitKey(a.session);
    if (how === "beside" && !phone()) openSplit(a.session, opts);
    else navigate(sessionPath(harness, id));
    return;
  }
  if (how === "beside" && !phone()) openSplit(agentTabKey(s.key, a.id), opts);
  else navigate(agentPath(s.harness, s.id, a.id));
}

/** The agent a `<task-notification>` prompt reports on: Claude Code's own follow-up turn
 *  when a background agent stops (its `<task-id>`). Undefined for a person's prompt. */
export function taskNotification(text: string | undefined): { agentId: string; summary?: string } | undefined {
  if (!text) return undefined;
  const m = /^\s*<task-notification>[\s\S]*?<task-id>([^<\s]+)<\/task-id>/.exec(text);
  if (!m) return undefined;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
  return { agentId: m[1]!, summary: summary || undefined };
}

/** A parent's agents for a list: every open one, then the newest `done` finished ones,
 *  and how many finished ones that leaves out. */
export function agentsShown(agents: readonly AgentRun[], done: number): { shown: AgentRun[]; more: number } {
  const open = agents.filter((a) => a.state !== "done");
  const ended = agents.filter((a) => a.state === "done");
  return { shown: [...open, ...ended.slice(0, done)], more: Math.max(0, ended.length - done) };
}

// ----- the board's disclosure, per device -----

const KEY_OPEN = "sessionpipe-gui.agentsOpen";
/** Parents whose disclosure the person set, at most this many (the oldest choice goes). */
export const DISCLOSURE_MAX = 500;
let choices: [SessionKey, boolean][] | null = null;
const choiceListeners = new Set<() => void>();

function readChoices(): [SessionKey, boolean][] {
  if (choices) return choices;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_OPEN) ?? "[]") as unknown;
    choices = Array.isArray(raw)
      ? raw.filter(
          (x): x is [SessionKey, boolean] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "boolean",
        )
      : [];
  } catch {
    choices = [];
  }
  return choices;
}

/** The person's choice for a parent's disclosure, or undefined when they made none (the
 *  row then opens while any agent is open). */
export const agentsChoice = (key: SessionKey): boolean | undefined => readChoices().find(([k]) => k === key)?.[1];

/** Remember opening or closing a parent's agents on this device. */
export function setAgentsChoice(key: SessionKey, open: boolean): void {
  const next = readChoices().filter(([k]) => k !== key);
  next.push([key, open]);
  choices = next.slice(-DISCLOSURE_MAX);
  try {
    localStorage.setItem(KEY_OPEN, JSON.stringify(choices));
  } catch {
    // this page only
  }
  for (const l of choiceListeners) l();
}

export function subscribeAgentsChoice(l: () => void): () => void {
  choiceListeners.add(l);
  return () => {
    choiceListeners.delete(l);
  };
}
