// SPDX-License-Identifier: Apache-2.0
// Readings of the wire shapes for display: titles, monograms, one-line event summaries.
import type { ProtocolEvent, SessionState, SessionSummary, StoredEvent } from "@shared/api";
import { durShort } from "./time";

export const STATE_LABEL: Record<SessionState, string> = {
  needs_you: "needs you",
  working: "working",
  stale: "stale",
  idle: "idle",
  done: "done",
};

/** Group headings on the board: "Needs you · 1", "Working · 3". The state's name, the
 *  same word the session bar and the machines use, whatever the count. */
export const STATE_HEADING: Record<SessionState, (n: number) => string> = {
  needs_you: () => "Needs you",
  working: () => "Working",
  stale: () => "Stale",
  idle: () => "Idle",
  done: () => "Done",
};

export const STATE_HINT: Record<SessionState, string> = {
  needs_you: "A permission, a question or an error is waiting for an answer.",
  working: "A turn is running and events are still arriving.",
  stale: "A turn started but nothing has arrived for over ten minutes.",
  idle: "The last turn ended; the session is open and waiting for a prompt.",
  done: "Ended, or silent for six hours, or only known from backfill.",
};

export function sessionTitle(s: Pick<SessionSummary, "title" | "cwd" | "id">): string {
  if (s.title?.trim()) return s.title.trim();
  if (s.cwd) return basename(s.cwd);
  return s.id.slice(0, 8);
}

export function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, "");
  const i = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return i >= 0 ? clean.slice(i + 1) || clean : clean;
}

/** "github.com/org/repo" → "org/repo"; keeps unknown hosts intact. */
export function repoShort(repo: string | undefined): string {
  if (!repo) return "";
  const noScheme = repo.replace(/^[a-z]+:\/\//i, "").replace(/\.git$/, "");
  const parts = noScheme.split("/").filter(Boolean);
  if (parts.length >= 3) return parts.slice(-2).join("/");
  return noScheme;
}

export function repoBranch(s: Pick<SessionSummary, "repo" | "branch">): string {
  const r = repoShort(s.repo);
  if (r && s.branch) return `${r} @ ${s.branch}`;
  return r || s.branch || "";
}

/** "claude-fable-5-1" → "fable 5.1", "gpt-5-codex" → "gpt-5 codex", "gemini-2.5-pro" → "gemini 2.5 pro". */
export function modelShort(model: string | undefined): string {
  if (!model) return "";
  let m = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  m = m.replace(/(\d)-(\d)/g, "$1.$2");
  return m.replace(/-/g, " ");
}

export interface HarnessMark {
  /** One or two letters for the monogram. */
  glyph: string;
  label: string;
  /** An oklch hue so each harness keeps its own colour everywhere. */
  hue: number;
}

const HARNESSES: Record<string, HarnessMark> = {
  "claude-code": { glyph: "Cl", label: "Claude Code", hue: 40 },
  codex: { glyph: "Cx", label: "Codex", hue: 150 },
  "gemini-cli": { glyph: "Ge", label: "Gemini CLI", hue: 265 },
  antigravity: { glyph: "Ag", label: "Antigravity", hue: 300 },
  cursor: { glyph: "Cu", label: "Cursor", hue: 200 },
  "copilot-cli": { glyph: "Cp", label: "Copilot CLI", hue: 230 },
  droid: { glyph: "Dr", label: "Droid", hue: 120 },
  kiro: { glyph: "Ki", label: "Kiro", hue: 330 },
  opencode: { glyph: "Oc", label: "OpenCode", hue: 180 },
  conformance: { glyph: "Cf", label: "conformance", hue: 0 },
};

export function harnessMark(name: string): HarnessMark {
  const known = HARNESSES[name];
  if (known) return known;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const letters = name
    .split(/[-_.]/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2);
  return { glyph: letters ? letters[0]!.toUpperCase() + (letters[1] ?? "") : "?", label: name, hue: h };
}

export const ATTENTION_LABEL: Record<string, string> = {
  permission: "permission",
  question: "question",
  elicitation: "input wanted",
  idle: "idle prompt",
  error: "error",
};

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** One line per event, like `sessionpipe tail`. */
export function eventSummary(e: ProtocolEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case "session.started":
      return `source=${str(d.source) || "unknown"}`;
    case "session.ended":
      return `reason=${str(d.reason) || "other"}`;
    case "session.backfill":
      return ["backfill", span(str(d.started_at), str(d.last_at)), d.turns !== undefined ? `${str(d.turns)} turns` : ""]
        .filter(Boolean)
        .join(" · ");
    case "session.forgotten":
      return "forgotten";
    case "session.heartbeat":
      return "heartbeat";
    case "turn.started":
      return d.prompt_chars !== undefined ? `prompt ${str(d.prompt_chars)} chars` : "prompt";
    case "turn.ended": {
      const bits = [str(d.reason) || "stop"];
      if (num(d.ms) !== undefined) bits.push(durShort(num(d.ms)));
      if (d.error) bits.push(str(d.error));
      return bits.join(" · ");
    }
    case "turn.transcript":
    case "turn.progress": {
      const text = oneLine(str(d.assistant), 120);
      return text ? `turn ${str(d.turn)} · ${text}` : `turn ${str(d.turn)}`;
    }
    case "tool.started":
      return `${str(d.tool)}${d.agent_id ? " · subagent" : ""}`;
    case "tool.ended": {
      const bits = [str(d.tool), d.ok === false ? "error" : "ok"];
      if (num(d.ms) !== undefined) bits.push(durShort(num(d.ms)));
      if (d.error) bits.push(oneLine(str(d.error), 80));
      return bits.join(" ");
    }
    case "files.changed": {
      const paths = Array.isArray(d.paths) ? (d.paths as unknown[]).map(str) : [];
      return paths.length <= 2 ? paths.join(", ") : `${paths.slice(0, 2).join(", ")} +${paths.length - 2}`;
    }
    case "attention.needed":
      return [ATTENTION_LABEL[str(d.kind)] ?? str(d.kind), str(d.tool), oneLine(str(d.message), 100)]
        .filter(Boolean)
        .join(" · ");
    case "attention.cleared":
      return `cleared · ${str(d.how) || "unknown"}`;
    case "subagent.started":
      return `${str(d.agent_type) || "subagent"} started`;
    case "subagent.ended":
      return `${str(d.agent_type) || "subagent"} ended`;
    case "context.compacted":
      return `compacted · ${str(d.trigger) || "auto"}`;
    case "native":
      return "native hook payload";
    default:
      return Object.keys(d).slice(0, 3).join(", ");
  }
}

/** "3 Oct 14:02 → 16:40", or across days "3 Oct → 5 Oct". */
function span(from: string, to: string): string {
  const a = from ? new Date(from) : null;
  const b = to ? new Date(to) : null;
  if (!a || Number.isNaN(a.getTime())) return "";
  const day = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const hm = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (!b || Number.isNaN(b.getTime())) return `${day(a)} ${hm(a)}`;
  return a.toDateString() === b.toDateString() ? `${day(a)} ${hm(a)} → ${hm(b)}` : `${day(a)} → ${day(b)}`;
}

/** An attention's message without the tool name it sometimes starts with ("Bash rm -rf
 *  …"), for places that already show the tool beside it. */
export function attentionMessage(a: { message?: string; tool?: string }): string | undefined {
  const m = a.message;
  if (!m || !a.tool) return m;
  const t = a.tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rest = m.replace(new RegExp(`^${t}(:\\s*|\\s+)`), "");
  return rest || m;
}

export function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const eventKind = (type: string) => type.split(".")[0] ?? type;

export const isSubagent = (s: SessionSummary) => !!s.parentId;

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function storedKey(e: StoredEvent): string {
  return `${e.harness.name}:${e.session.id}`;
}
