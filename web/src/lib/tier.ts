// SPDX-License-Identifier: Apache-2.0
// The tier lens: what a receiver at tier N would have got, applied client-side to events
// that arrived at a higher tier (spec PROTOCOL.md §4 per-type tiers and §5 table). Removal
// is by allowlist per type, like the client's own filter.
import type { StoredEvent, Tier } from "@shared/api";

/** Lowest tier that carries each type (PROTOCOL.md §4). Unknown types are kept at every tier. */
export const TYPE_TIER: Record<string, Tier> = {
  "session.started": 0,
  "session.heartbeat": 0,
  "session.ended": 0,
  "session.backfill": 0,
  "session.forgotten": 0,
  "turn.started": 0,
  "turn.ended": 0,
  "turn.transcript": 2,
  "turn.progress": 2,
  "tool.started": 1,
  "tool.ended": 1,
  "files.changed": 1,
  "attention.needed": 0,
  "attention.cleared": 0,
  "subagent.started": 1,
  "subagent.ended": 1,
  "context.compacted": 1,
  "limits.observed": 1,
  native: 3,
};

const ALWAYS = ["turn_id", "call_id", "agent_id", "attention_id", "agent_type"];

/** Keys of `data` allowed per type at tiers 0..3, cumulative. */
const ALLOW: Record<string, Partial<Record<Tier, string[]>>> = {
  "turn.started": { 0: ["turn_id"], 1: ["prompt_chars"] },
  "turn.ended": { 0: ["turn_id", "reason", "ms"], 1: ["error"] },
  "tool.started": { 1: ["tool", "call_id", "turn_id", "agent_id"], 3: ["input"] },
  "tool.ended": { 1: ["tool", "call_id", "turn_id", "agent_id", "ms", "ok", "error"], 3: ["input", "output"] },
  "attention.needed": { 0: ["attention_id", "kind"], 1: ["tool", "message"] },
};

/** The event as a tier-`lens` receiver would hold it, or null when it would not get it at all. */
export function atTier(e: StoredEvent, lens: Tier): StoredEvent | null {
  if (lens >= 3 || e.tier <= lens) return e;
  const min = TYPE_TIER[e.type];
  if (min !== undefined && min > lens) return null;
  const allow = ALLOW[e.type];
  if (!allow) return { ...e, tier: lens };
  const keep = new Set<string>(ALWAYS);
  for (let t = 0 as Tier; t <= lens; t = (t + 1) as Tier) for (const k of allow[t] ?? []) keep.add(k);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.data)) if (keep.has(k)) data[k] = v;
  return { ...e, tier: lens, data };
}

export const TIER_LABEL: Record<Tier, string> = {
  0: "presence",
  1: "actions",
  2: "conversation",
  3: "everything",
};

export const TIER_HINT: Record<Tier, string> = {
  0: "Session ids, state, timing, machine, repo, model, title; the kind of attention.",
  1: "+ tool names, durations, ok/error, file paths, attention messages, subagents, compactions.",
  2: "+ your prompts and the assistant's text.",
  3: "+ tool input and output. Your own server only.",
};
