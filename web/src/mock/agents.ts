// SPDX-License-Identifier: Apache-2.0
// The mock's reading of subagents: server/store/readings.ts's, ported, so `?mock=1` shows
// what the receiver would (ORGANIZE-SPEC.md §6). Claude Code keeps a subagent inside its
// parent's session: `subagent.started` / `.ended`, `agent_id` on its tools, the Agent /
// Task call that launched it (its description, and its result when it ran in the
// foreground), and for a background agent the `<task-notification>` turn that carries
// its result. A child session with `parent_id` is merged in by the World.
import { AGENTS_MAX, type AgentRun, SNIPPET_CHARS, STALE_AFTER_MS, type StoredEvent } from "@shared/api";

/** The tools that launch a subagent: Claude Code's Agent (Task before 2.1), Cursor's Task. */
const LAUNCH_TOOLS = new Set(["Agent", "Task"]);
/** An agent's own recent tools kept. */
const AGENT_RECENT = 4;

interface Launch {
  callId?: string;
  turnId?: string;
  description?: string;
  agentType?: string;
  agentId?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const cut = (s: string) => (s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS - 1)}…` : s);

/** A synchronous Agent call's output: a string, `result`, or the text parts of `content`. */
function agentResult(output: unknown): string | undefined {
  if (typeof output === "string") return str(output);
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  if (o.isAsync === true || o.status === "async_launched") return undefined;
  if (typeof o.result === "string") return str(o.result);
  if (Array.isArray(o.content))
    return str(
      o.content
        .map((c) => (c && typeof c === "object" && typeof c.text === "string" ? (c.text as string) : ""))
        .join("\n"),
    );
  return undefined;
}

const TASK_NOTIFICATION = /^\s*<task-notification>[\s\S]*?<task-id>([^<\s]+)<\/task-id>/;
const TASK_RESULT = /<result>([\s\S]*?)(?:<\/result>|$)/;

/** One session's agents, read event by event. */
export class AgentReading {
  agents: AgentRun[] = [];
  private launches: Launch[] = [];
  /** The turn open right now (the one an agent started in). */
  turnId?: string;

  private get(id: string, at: string): AgentRun {
    let a = this.agents.find((x) => x.id === id);
    if (!a) {
      a = {
        id,
        state: "running",
        startedAt: at,
        lastAt: at,
        tools: 0,
        toolErrors: 0,
        attributed: false,
        recentTools: [],
      };
      this.agents.push(a);
    }
    return a;
  }

  private link(a: AgentRun, l: Launch): void {
    l.agentId = a.id;
    if (l.callId && !a.callId) a.callId = l.callId;
    if (l.description && !a.description) a.description = l.description;
    if (l.agentType && !a.type) a.type = l.agentType;
    if (l.turnId && !a.turnId) a.turnId = l.turnId;
  }

  /** Reads one event; true when it was a subagent's own tool (the session's current tool
   *  and recent tools leave it out). */
  apply(e: StoredEvent): boolean {
    const d = e.data;
    const at = e.time;
    const agentId = str(d.agent_id);
    switch (e.type) {
      case "turn.started":
        this.turnId = str(d.turn_id);
        return false;
      case "turn.ended":
        this.turnId = undefined;
        return false;
      case "session.ended":
        this.close(at);
        return false;
      case "turn.transcript": {
        const m = typeof d.user === "string" ? TASK_NOTIFICATION.exec(d.user) : null;
        const a = m ? this.agents.find((x) => x.id === m[1]) : undefined;
        const result = a && typeof d.user === "string" ? str(TASK_RESULT.exec(d.user)?.[1]?.trim()) : undefined;
        if (a && result && !a.result) a.result = cut(result);
        return false;
      }
      case "tool.started": {
        const tool = str(d.tool);
        if (agentId) {
          const a = this.get(agentId, at);
          a.attributed = true;
          a.lastAt = at;
          if (a.state === "stale") a.state = "running";
          if (tool) a.currentTool = { tool, callId: str(d.call_id), since: at };
          a.turnId ??= str(d.turn_id);
          return true;
        }
        if (tool && LAUNCH_TOOLS.has(tool)) {
          const input = (d.input && typeof d.input === "object" ? d.input : {}) as Record<string, unknown>;
          this.launches.push({
            callId: str(d.call_id),
            turnId: str(d.turn_id) ?? this.turnId,
            description: str(input.description),
            agentType: str(input.subagent_type),
          });
          if (this.launches.length > AGENTS_MAX) this.launches.shift();
        }
        return false;
      }
      case "tool.ended": {
        const tool = str(d.tool) ?? "?";
        if (agentId) {
          const a = this.get(agentId, at);
          const ok = d.ok !== false;
          a.attributed = true;
          a.lastAt = at;
          if (a.state === "stale") a.state = "running";
          a.tools++;
          if (!ok) a.toolErrors++;
          const ms = num(d.ms);
          a.recentTools = [...a.recentTools, { tool, ok, ...(ms !== undefined ? { ms } : {}) }].slice(-AGENT_RECENT);
          const callId = str(d.call_id);
          if (a.currentTool && ((callId && a.currentTool.callId === callId) || a.currentTool.tool === tool))
            a.currentTool = undefined;
          return true;
        }
        if (LAUNCH_TOOLS.has(tool)) {
          const callId = str(d.call_id);
          const l = callId ? this.launches.find((x) => x.callId === callId) : undefined;
          const out = d.output && typeof d.output === "object" ? (d.output as Record<string, unknown>) : undefined;
          const named = str(out?.agentId) ?? l?.agentId;
          if (l && named) l.agentId = named;
          const a = named ? this.agents.find((x) => x.id === named) : undefined;
          if (a) {
            if (l) this.link(a, l);
            else if (callId) a.callId ??= callId;
            const result = agentResult(d.output);
            if (result) a.result = cut(result);
          }
        }
        return false;
      }
      case "subagent.started": {
        if (!agentId) return false;
        const a = this.get(agentId, at);
        Object.assign(a, { state: "running", startedAt: at, lastAt: at, endedAt: undefined });
        const type = str(d.agent_type);
        if (type) a.type = type;
        a.turnId ??= this.turnId;
        const open = this.launches.filter((l) => !l.agentId);
        const l =
          this.launches.find((x) => x.agentId === agentId) ??
          [...open].reverse().find((x) => !x.agentType || !type || x.agentType === type) ??
          open[open.length - 1];
        if (l) this.link(a, l);
        return false;
      }
      case "subagent.ended": {
        if (!agentId) return false;
        const a = this.get(agentId, at);
        Object.assign(a, { state: "done", endedAt: at, lastAt: at, currentTool: undefined });
        a.type ??= str(d.agent_type);
        return false;
      }
    }
    return false;
  }

  /** Every open agent closed (the session ended). */
  close(at: string): void {
    for (const a of this.agents)
      if (a.state !== "done") Object.assign(a, { state: "done", endedAt: at, currentTool: undefined });
  }

  /** The reading at `now`: a silent agent reads stale; a session read done closes them.
   *  Open ones first (oldest start first), then ended ones newest first. */
  settle(now: number, sessionDone: boolean, doneAt: string): AgentRun[] {
    if (sessionDone) this.close(doneAt);
    for (const a of this.agents)
      if (a.state !== "done" && !a.session)
        a.state = now - Date.parse(a.lastAt) >= STALE_AFTER_MS ? "stale" : "running";
    const open = this.agents.filter((a) => a.state !== "done").sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
    const ended = this.agents
      .filter((a) => a.state === "done")
      .sort((a, b) => ((b.endedAt ?? b.lastAt) < (a.endedAt ?? a.lastAt) ? -1 : 1));
    return [...open, ...ended.slice(0, Math.max(0, AGENTS_MAX - open.length))].map((a) => ({ ...a }));
  }
}
