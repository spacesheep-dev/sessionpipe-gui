// SPDX-License-Identifier: Apache-2.0
// A subagent as one row, the grammar every list shares (ORGANIZE-SPEC.md §4.1): the agent
// glyph (the status glyph at 8 px: turning while it runs, dashed when it went quiet, a
// check once done), "Type · description", then what it is doing now or how long it ran.
// On the board it hangs off its parent on the tree guide; a click or Enter opens it beside.
// Nothing it shows is guessed: no tools for a harness that does not mark them, no
// description that was never sent.
import type { AgentRun, SessionSummary } from "@shared/api";
import { useSyncExternalStore } from "react";
import { useStore } from "../data/hooks";
import {
  agentGlyph,
  agentLabel,
  agentNow,
  agentsChoice,
  agentTip,
  agentType,
  openAgent,
  subscribeAgentsChoice,
} from "../lib/agents";
import { sessionTitle } from "../lib/format";
import { agentItems, sessionItems, sessionMenuSubtitle } from "../lib/menus";
import { agentPath, Link, sessionPath } from "../lib/router";
import { useNow } from "../lib/time";
import { StateDot } from "./bits";
import { useContextMenu } from "./ContextMenu";
import { LabelDot } from "./LabelDot";

/** The agent glyph: the session glyph's shapes, at 8 px. */
export function AgentGlyph({ a, size = 8 }: { a: Pick<AgentRun, "state">; size?: number }) {
  return <StateDot state={agentGlyph(a)} size={size} decorative />;
}

/** "Grep · 4 s", "Thinking", "Quiet for 2 m", or how long it ran: ticking only while it
 *  runs (every ten seconds once it went quiet). Errors, when it had some, are the one small
 *  red ✕ before it (the board's error mark), the count in its name and tooltip. */
export function AgentNow({ a, className = "agent-now" }: { a: AgentRun; className?: string }) {
  const now = useNow(a.state === "running" ? "fine" : a.state === "stale" ? "coarse" : "off");
  const errors = a.attributed && a.toolErrors > 0 ? `${a.toolErrors} tool error${a.toolErrors === 1 ? "" : "s"}` : "";
  return (
    <span className={`${className} num`}>
      {errors && (
        <span className="agent-errs" role="img" aria-label={errors} title={errors}>
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
      )}
      {agentNow(a, now)}
    </span>
  );
}

/** "Type · description", the type in the row's weight and the description a tier down. */
export function AgentText({ a }: { a: Pick<AgentRun, "type" | "description"> }) {
  const d = a.description?.trim();
  return (
    <span className="agent-text ellipsis">
      <span className="agent-type">{agentType(a)}</span>
      {d && <span className="agent-desc"> · {d}</span>}
    </span>
  );
}

/** Whether a parent's agents show under it: the person's choice on this device, else open
 *  while any agent is open. */
export function useAgentsOpen(s: SessionSummary): boolean {
  const choice = useSyncExternalStore(
    subscribeAgentsChoice,
    () => agentsChoice(s.key),
    () => undefined,
  );
  return choice ?? (s.counts.agentsRunning ?? 0) > 0;
}

/** One agent under its parent on the board: a 32 px row (44 on a phone) on the tree guide,
 *  outside the list's j/k order (Tab reaches it). `open` while its tab is the panel's. */
export function AgentRow({
  s,
  a,
  open = false,
  flip,
  gone = false,
}: {
  s: SessionSummary;
  a: AgentRun;
  open?: boolean;
  /** The tree's FLIP key (lib/motion.ts useFlip), and whether the held tree kept it after it left. */
  flip?: string;
  gone?: boolean;
}) {
  const store = useStore();
  // A child session (the `parent_id` shape) is a session: its own menu, with its label.
  const child = a.session ? store.get().sessions.get(a.session) : undefined;
  const menu = useContextMenu(() => (child ? sessionItems(child, { store, surface: "list" }) : agentItems(s, a)), {
    title: () => (child ? sessionTitle(child) : agentLabel(a)),
    subtitle: () => (child ? sessionMenuSubtitle(child) : sessionTitle(s)),
  });
  const to = child ? sessionPath(child.harness, child.id) : agentPath(s.harness, s.id, a.id);
  return (
    <li
      {...menu}
      data-agent={a.id}
      data-open={open ? "" : undefined}
      data-flip={flip}
      data-gone={gone ? "" : undefined}
    >
      <Link
        to={to}
        className="kid agent-row"
        title={agentTip(a) ?? agentLabel(a)}
        plainClick={() => openAgent(s, a, "beside")}
        modClick={(o) => openAgent(s, a, "beside", { background: o.background })}
      >
        <AgentGlyph a={a} />
        {a.session && <LabelDot session={a.session} />}
        {/* A child session's own title says what it was asked, when its launch did not. */}
        <AgentText a={child && !a.description ? { type: a.type, description: sessionTitle(child) } : a} />
        <span className="sr-only">, {a.state === "running" ? "running" : a.state === "stale" ? "quiet" : "done"}</span>
        <AgentNow a={a} />
      </Link>
    </li>
  );
}
