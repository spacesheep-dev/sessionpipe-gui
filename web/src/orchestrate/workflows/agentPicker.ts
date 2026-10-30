// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The editor's Agent pop-up, as options (UX-SPEC §4.2): under
// each paired machine, a new session of every harness its hello lists, then that machine's
// live sessions, newest first. A step's agent is one value in the list, `<machineId>|h:
// <harness>` or `<machineId>|s:<session key>`, read back with `parseAgentValue`. Only
// machines with `control` are listed; an offline one keeps its options with "offline"; a
// step whose machine lost its pairing shows the saved words with "not paired". Pure, so
// the list can be tested without a page.
import type { MachineSummary, SessionSummary, StepAgent, WorkflowStep } from "@shared/api";
import { DONE_AFTER_MS } from "@shared/api";
import type { SelectOption } from "../../components/Select";
import { harnessMark, STATE_LABEL, sessionTitle } from "../../lib/format";
import { ago } from "../../lib/time";

/** How many live sessions a machine lists under its harnesses. */
export const SESSIONS_MAX = 12;

export const agentValue = (machineId: string, agent: StepAgent): string =>
  "harness" in agent ? `${machineId}|h:${agent.harness}` : `${machineId}|s:${agent.session}`;

export function parseAgentValue(v: string): { machineId: string; agent: StepAgent } | null {
  const bar = v.indexOf("|");
  if (bar < 0) return null;
  const machineId = v.slice(0, bar);
  const rest = v.slice(bar + 1);
  if (rest.startsWith("h:")) return { machineId, agent: { harness: rest.slice(2) } };
  if (rest.startsWith("s:")) return { machineId, agent: { session: rest.slice(2) } };
  return null;
}

/** The sessions on a machine a step may prompt: not a subagent, not done for over a
 *  day, newest first, at most SESSIONS_MAX. */
export function promptableSessions(sessions: Iterable<SessionSummary>, machine: string, now: number): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const s of sessions) {
    if (s.machine !== machine || s.parentId) continue;
    if (s.state === "done" && now - Date.parse(s.lastAt) > DONE_AFTER_MS) continue;
    out.push(s);
  }
  return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0)).slice(0, SESSIONS_MAX);
}

/** The pop-up's options: the machines in name order, each a divider-led section. The
 *  value held by `step` is kept in the list even when its machine is gone, so the row
 *  never reads empty. `icon` is the caller's (a HarnessGlyph), since this file renders
 *  nothing. */
export function agentOptions(
  machines: readonly MachineSummary[],
  sessions: Iterable<SessionSummary>,
  step: Pick<WorkflowStep, "machineId" | "agent"> | null,
  now: number,
  icon?: (harness: string) => SelectOption<string>["icon"],
): SelectOption<string>[] {
  const out: SelectOption<string>[] = [];
  const paired = machines.filter((m) => m.control);
  const all = [...sessions];
  for (const m of paired) {
    const c = m.control!;
    const offline = !c.online;
    const first = out.length;
    for (const h of c.harnesses ?? []) {
      out.push({
        value: agentValue(c.machineId, { harness: h }),
        label: `${m.name} › ${harnessMark(h).label} · new session`,
        ...(offline ? { hint: "offline" } : {}),
        ...(icon ? { icon: icon(h) } : {}),
      });
    }
    for (const s of promptableSessions(all, m.name, now)) {
      out.push({
        value: agentValue(c.machineId, { session: s.key }),
        label: `${m.name} › ${sessionTitle(s)}`,
        hint: offline ? "offline" : `${STATE_LABEL[s.state]} · ${ago(s.lastAt, now).replace(/ ago$/, "")}`,
        ...(icon ? { icon: icon(s.harness) } : {}),
      });
    }
    if (out.length > first && first > 0) out[first]!.divider = true;
  }
  if (step?.machineId && !out.some((o) => o.value === agentValue(step.machineId, step.agent))) {
    const h = "harness" in step.agent ? step.agent.harness : (step.agent.session.split(":")[0] ?? "");
    const label = "harness" in step.agent ? `${harnessMark(h).label} · new session` : step.agent.session;
    out.push({
      value: agentValue(step.machineId, step.agent),
      label,
      hint: "not paired",
      divider: out.length > 0,
      ...(icon ? { icon: icon(h) } : {}),
    });
  }
  return out;
}
