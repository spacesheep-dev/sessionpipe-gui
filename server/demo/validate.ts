// SPDX-License-Identifier: Apache-2.0
// Owned by: demo. Checks an event against the sessionpipe v1 rules the demo and the
// replay promise to honour: the envelope (PROTOCOL.md §2), the session block (§3), the
// per-type data (schemas/v1/event-data.json) and the tier a type needs (§4, §5). The
// tests run it on every generated event; the replay uses it to drop lines that are not
// events. It returns the problems it found, so a test failure names the field.
import type { ProtocolEvent } from "../../shared/api.js";

/** The lowest tier that carries each type (PROTOCOL.md §4). */
export const TYPE_TIER: Record<string, 0 | 1 | 2 | 3> = {
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
  native: 3,
};

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;
export const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const HARNESS_RE = /^[a-z0-9-]+$/;
export const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const TOOL_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

const ENVELOPE_KEYS = ["protocol", "id", "type", "time", "tier", "harness", "session", "privacy", "data"];
const TITLE_SOURCES = ["custom", "harness", "first-ask"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min;
const isTime = (v: unknown): boolean => typeof v === "string" && TIME_RE.test(v) && !Number.isNaN(Date.parse(v));

/** A field rule for one key of a type's `data`. */
type Rule =
  | { kind: "enum"; values: string[] }
  | { kind: "string"; max?: number; pattern?: RegExp }
  | { kind: "int" }
  | { kind: "bool" }
  | { kind: "time" }
  | { kind: "paths" }
  | { kind: "any" };

const DATA_RULES: Record<string, { required: string[]; fields: Record<string, Rule> }> = {
  "session.started": {
    required: ["source"],
    fields: { source: { kind: "enum", values: ["startup", "resume", "clear", "compact", "fork", "unknown"] } },
  },
  "session.heartbeat": { required: [], fields: {} },
  "session.ended": {
    required: ["reason"],
    fields: { reason: { kind: "enum", values: ["clear", "logout", "exit", "other"] } },
  },
  "session.backfill": {
    required: ["started_at", "last_at"],
    fields: { started_at: { kind: "time" }, last_at: { kind: "time" }, turns: { kind: "int" } },
  },
  "session.forgotten": { required: [], fields: {} },
  "turn.started": {
    required: [],
    fields: {
      turn_id: { kind: "string", max: 128 },
      prompt_chars: { kind: "int" },
      submitted_by: { kind: "string", pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/ },
      injected: { kind: "bool" },
    },
  },
  "turn.ended": {
    required: ["reason"],
    fields: {
      turn_id: { kind: "string", max: 128 },
      reason: { kind: "enum", values: ["stop", "interrupt", "error"] },
      error: { kind: "string", max: 200 },
      ms: { kind: "int" },
      background: { kind: "int" },
    },
  },
  "turn.transcript": {
    required: ["turn", "user", "assistant", "at"],
    fields: {
      turn: { kind: "int" },
      user: { kind: "string", max: 20000 },
      assistant: { kind: "string", max: 20000 },
      at: { kind: "time" },
    },
  },
  "turn.progress": {
    required: ["turn", "user", "assistant", "at"],
    fields: {
      turn: { kind: "int" },
      user: { kind: "string", max: 20000 },
      assistant: { kind: "string", max: 20000 },
      at: { kind: "time" },
    },
  },
  "tool.started": {
    required: ["tool"],
    fields: {
      tool: { kind: "string", pattern: TOOL_RE },
      call_id: { kind: "string", max: 128 },
      turn_id: { kind: "string", max: 128 },
      agent_id: { kind: "string", max: 128 },
      input: { kind: "any" },
    },
  },
  "tool.ended": {
    required: ["tool", "ok"],
    fields: {
      tool: { kind: "string", pattern: TOOL_RE },
      call_id: { kind: "string", max: 128 },
      turn_id: { kind: "string", max: 128 },
      agent_id: { kind: "string", max: 128 },
      ms: { kind: "int" },
      ok: { kind: "bool" },
      error: { kind: "string", max: 2000 },
      input: { kind: "any" },
      output: { kind: "any" },
    },
  },
  "files.changed": { required: ["paths"], fields: { paths: { kind: "paths" } } },
  "attention.needed": {
    required: ["attention_id", "kind"],
    fields: {
      attention_id: { kind: "string", max: 128 },
      kind: { kind: "enum", values: ["permission", "question", "elicitation", "idle", "error"] },
      tool: { kind: "string", pattern: TOOL_RE },
      message: { kind: "string", max: 200 },
    },
  },
  "attention.cleared": {
    required: ["attention_id", "how"],
    fields: {
      attention_id: { kind: "string", max: 128 },
      how: { kind: "enum", values: ["answered", "cancelled", "timeout", "unknown"] },
    },
  },
  "subagent.started": {
    required: ["agent_id"],
    fields: { agent_id: { kind: "string", max: 128 }, agent_type: { kind: "string", max: 128 } },
  },
  "subagent.ended": {
    required: ["agent_id"],
    fields: { agent_id: { kind: "string", max: 128 }, agent_type: { kind: "string", max: 128 } },
  },
  "context.compacted": { required: ["trigger"], fields: { trigger: { kind: "enum", values: ["manual", "auto"] } } },
  native: { required: [], fields: {} },
};

/** Fields the tiers add on top of the type's tier-0 shape; a sender below the tier
 *  must not have sent them (PROTOCOL.md §4, §5: filtering is an allowlist). */
const TIERED_FIELDS: Record<string, Record<string, number>> = {
  "turn.started": { prompt_chars: 1 },
  "turn.ended": { error: 1 },
  "tool.started": { input: 3 },
  "tool.ended": { input: 3, output: 3 },
  "attention.needed": { tool: 1, message: 1 },
};

function checkField(key: string, value: unknown, rule: Rule, out: string[]): void {
  switch (rule.kind) {
    case "enum":
      if (typeof value !== "string" || !rule.values.includes(value)) out.push(`data.${key}: not one of ${rule.values}`);
      return;
    case "string":
      if (typeof value !== "string") out.push(`data.${key}: not a string`);
      else if (rule.max !== undefined && value.length > rule.max) out.push(`data.${key}: longer than ${rule.max}`);
      else if (rule.pattern && !rule.pattern.test(value)) out.push(`data.${key}: does not match ${rule.pattern}`);
      return;
    case "int":
      if (!isInt(value)) out.push(`data.${key}: not an integer >= 0`);
      return;
    case "bool":
      if (typeof value !== "boolean") out.push(`data.${key}: not a boolean`);
      return;
    case "time":
      if (!isTime(value)) out.push(`data.${key}: not an RFC 3339 time with ms and Z`);
      return;
    case "paths":
      if (!Array.isArray(value) || value.length > 500 || !value.every((p) => typeof p === "string" && p.length <= 1024))
        out.push(`data.${key}: not an array of <= 500 paths`);
      return;
    case "any":
      return;
  }
}

/** Every rule the event breaks, as one line each; an empty array means it is valid. */
export function validate(event: unknown): string[] {
  const out: string[] = [];
  if (!isObj(event)) return ["event: not an object"];
  const e = event as Obj;
  for (const k of Object.keys(e)) if (!ENVELOPE_KEYS.includes(k)) out.push(`${k}: not an envelope member`);
  for (const k of ENVELOPE_KEYS) if (!(k in e)) out.push(`${k}: missing`);

  if (e.protocol !== 1) out.push("protocol: not 1");
  if (typeof e.id !== "string" || !ULID_RE.test(e.id)) out.push("id: not a ULID");
  const type = e.type;
  if (typeof type !== "string" || !(type === "native" || TYPE_RE.test(type))) out.push("type: not dotted lowercase");
  if (!isTime(e.time)) out.push("time: not an RFC 3339 time with ms and Z");
  const tier = e.tier;
  if (!isInt(tier) || tier > 3) out.push("tier: not 0..3");

  if (!isObj(e.harness)) out.push("harness: not an object");
  else {
    const h = e.harness;
    if (typeof h.name !== "string" || !HARNESS_RE.test(h.name)) out.push("harness.name: not [a-z0-9-]");
    if (h.version !== undefined && typeof h.version !== "string") out.push("harness.version: not a string");
    if (h.event !== undefined && typeof h.event !== "string") out.push("harness.event: not a string");
  }

  if (!isObj(e.session)) out.push("session: not an object");
  else {
    const s = e.session;
    if (typeof s.id !== "string" || !SESSION_ID_RE.test(s.id)) out.push("session.id: not [A-Za-z0-9._:-]{1,128}");
    if (!isInt(s.seq)) out.push("session.seq: not an integer >= 0");
    for (const k of ["machine", "cwd", "repo", "branch", "model", "title", "url", "account_id"])
      if (s[k] !== undefined && typeof s[k] !== "string") out.push(`session.${k}: not a string`);
    if (s.title_source !== undefined && !TITLE_SOURCES.includes(s.title_source as string))
      out.push("session.title_source: not custom|harness|first-ask");
    if (s.parent_id !== undefined && s.parent_id !== null && typeof s.parent_id !== "string")
      out.push("session.parent_id: not a string or null");
    if (s.attended !== undefined && typeof s.attended !== "boolean") out.push("session.attended: not a boolean");
  }

  if (!isObj(e.privacy)) out.push("privacy: not an object");
  else {
    const p = e.privacy;
    if (!Array.isArray(p.rulesets) || !p.rulesets.every((r) => typeof r === "string"))
      out.push("privacy.rulesets: not a string array");
    else if (isInt(tier) && tier > 0 && !p.rulesets.includes("secrets@1"))
      out.push("privacy.rulesets: secrets@1 missing above tier 0");
    if (typeof p.pii !== "boolean") out.push("privacy.pii: not a boolean");
  }

  if (!isObj(e.data)) out.push("data: not an object");
  else if (typeof type === "string") {
    const d = e.data;
    const need = TYPE_TIER[type];
    if (need !== undefined && isInt(tier) && tier < need) out.push(`tier: ${type} needs tier ${need}`);
    const rules = DATA_RULES[type];
    if (rules) {
      for (const k of rules.required) if (d[k] === undefined) out.push(`data.${k}: missing`);
      for (const [k, rule] of Object.entries(rules.fields)) if (d[k] !== undefined) checkField(k, d[k], rule, out);
      const tiered = TIERED_FIELDS[type];
      if (tiered && isInt(tier))
        for (const [k, t] of Object.entries(tiered))
          if (d[k] !== undefined && tier < t) out.push(`data.${k}: needs tier ${t}`);
    }
  }
  return out;
}

/** Throws with every problem listed when the event is not valid. */
export function assertValid(event: unknown): asserts event is ProtocolEvent {
  const problems = validate(event);
  if (problems.length) throw new Error(`invalid event: ${problems.join("; ")}\n${JSON.stringify(event).slice(0, 600)}`);
}
