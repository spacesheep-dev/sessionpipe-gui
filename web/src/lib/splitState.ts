// SPDX-License-Identifier: Apache-2.0
// The side panel's tabs as a value: what `?s=<key>,<key>&t=<active>` says, and the one
// rule for a tab that leaves the strip. Pure, and nothing of the router is imported here:
// the router (a session's own page takes its tab out) and lib/split.ts (a tab closed)
// both read it.
import type { SessionKey } from "@shared/api";

export interface SplitState {
  tabs: SessionKey[];
  active: number;
}

/** Whether a string can be a tab: a session's key, `<harness>:<id>`. */
export const isKey = (k: string): k is SessionKey => k.includes(":");

/** The separator of a tab that holds one subagent of a session: `<sessionKey>#<agentId>`
 *  (ORGANIZE-SPEC.md §4.5). Its view is the session's, opened on that agent. */
export const AGENT_TAB_SEP = "#";

/** The tab of one agent of a session. */
export const agentTabKey = (session: SessionKey, agentId: string): SessionKey =>
  `${session}${AGENT_TAB_SEP}${agentId}` as SessionKey;

/** Parses `s` and `t` as the URL carries them. */
export function parseSplit(s: string | null, t: string | null): SplitState {
  const tabs = (s ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(isKey)
    .filter((k, i, all) => all.indexOf(k) === i);
  const n = Number(t);
  const active = tabs.length === 0 ? 0 : Number.isInteger(n) ? Math.max(0, Math.min(tabs.length - 1, n)) : 0;
  return { tabs, active };
}

/** The state as the URL carries it: no `s` without a tab, and `t` only where it says
 *  something (two tabs or more, or an index past the first). */
export function splitParams(state: SplitState): { s: string | null; t: string | null } {
  const { tabs, active } = state;
  return {
    s: tabs.length ? tabs.join(",") : null,
    t: tabs.length > 1 || active > 0 ? String(active) : null,
  };
}

/** The state without the tab at `index`. A tab before the active one takes the index
 *  down with it, so the same tab stays active; the active one hands over to its right
 *  neighbour, else the left; the last one leaves no tab. */
export function dropTab(state: SplitState, index: number): SplitState {
  if (index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  let active = state.active;
  if (index < active) active -= 1;
  else if (index === active) active = Math.min(index, tabs.length - 1);
  return { tabs, active: Math.max(0, active) };
}
