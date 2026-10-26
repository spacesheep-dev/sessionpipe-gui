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

/** A title cut upstream ("Why does the staging deploy take 14 minutes?...") keeps its
 *  honest mark of a cut, as the one ellipsis glyph after the last whole word; CSS cuts
 *  the rest at the real column width. */
export function cleanTitle(t: string): string {
  const s = t.trim();
  const cut = s.replace(/\s*(?:\.{3}|…)$/, "");
  if (cut === s) return s;
  // A cut right after a whole sentence ("…take 14 minutes?...") lost nothing it says.
  if (/[?!.]$/.test(cut)) return cut;
  return `${cut.replace(/[\s,;:–—-]+$/, "")}…`;
}

/** A title the summariser cut ("Before I merge the BM25 cache, review it from...") is the
 *  start of the session's first ask. While that ask is still the prompt the summary
 *  carries, its whole first line is the title, so CSS cuts it at the real column width
 *  and not 45 characters in. Undefined when the ask is not here or is something else. */
export function uncutTitle(s: Pick<SessionSummary, "title" | "lastUser" | "progress">): string | undefined {
  const t = s.title?.trim() ?? "";
  const stem = t.replace(/\s*(?:\.{3}|…)$/, "");
  if (stem === t || stem.length < 8) return undefined;
  const ask = (s.progress?.user || s.lastUser || "").trim().split("\n")[0]!.trim();
  if (ask.length <= stem.length || !ask.startsWith(stem)) return undefined;
  return ask.length > 240 ? `${ask.slice(0, 239).replace(/\s+\S*$/, "")}…` : ask;
}

/** The first message of each session started from this app, by session key, kept by
 *  control/Starting.tsx useStartTitles: until the agent reports a title, a session
 *  started here is called by what it was asked, not by its folder ("billing" ×4). */
let startTitles: ReadonlyMap<string, string> = new Map();
export function rememberStartTitles(m: ReadonlyMap<string, string>): void {
  startTitles = m;
}

/** Each session's uncut title once seen, by key and cut title: the next turn's prompt
 *  takes the first ask's place in the summary, and the title must not shrink back to the
 *  cut one then (a row that changes its name mid-session, the board and the panel
 *  disagreeing). The oldest go first past UNCUT_KEEP. */
const uncutSeen = new Map<string, string>();
const UNCUT_KEEP = 2000;

function keptUncut(s: Pick<SessionSummary, "title" | "lastUser" | "progress"> & { key?: string }) {
  const full = uncutTitle(s);
  if (!s.key) return full;
  const k = `${s.key}\n${s.title?.trim() ?? ""}`;
  const seen = uncutSeen.get(k);
  if (seen || !full) return seen;
  if (uncutSeen.size >= UNCUT_KEEP) uncutSeen.delete(uncutSeen.keys().next().value!);
  uncutSeen.set(k, full);
  return full;
}

export function sessionTitle(
  s: Pick<SessionSummary, "title" | "cwd" | "id" | "lastUser" | "progress"> & { key?: string },
): string {
  if (s.title?.trim()) return keptUncut(s) ?? cleanTitle(s.title);
  const started = s.key ? startTitles.get(s.key) : undefined;
  if (started) return started;
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
  devin: { glyph: "De", label: "Devin", hue: 20 },
  "copilot-cli": { glyph: "Cp", label: "Copilot CLI", hue: 230 },
  droid: { glyph: "Dr", label: "Droid", hue: 120 },
  kiro: { glyph: "Ki", label: "Kiro", hue: 330 },
  opencode: { glyph: "Oc", label: "OpenCode", hue: 180 },
  conformance: { glyph: "Cf", label: "conformance", hue: 0 },
};

/** Labels for harness names the table above lacks, added by the pages that list a machine's
 *  agents (lib/acp.ts, the ACP registry's): their monogram and hue still come from the name. */
const MORE_LABELS = new Map<string, string>();
/** `name:Label name:Label`, a space in a label written `_`. */
export function addHarnessLabels(list: string): void {
  for (const e of list.split(" ")) {
    const [name, label] = e.split(":");
    if (name && label) MORE_LABELS.set(name, label.replace(/_/g, " "));
  }
}

export function harnessMark(name: string): HarnessMark {
  const known = HARNESSES[name];
  if (known) return known;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const parts = name.split(/[-_.]/);
  // One word gives its first two letters ("goose" → Go), several their initials (qwen-code → Qc).
  const letters = (parts.length > 1 ? parts.map((p) => p[0] ?? "").join("") : name).slice(0, 2);
  return {
    glyph: letters ? letters[0]!.toUpperCase() + (letters[1] ?? "") : "?",
    label: MORE_LABELS.get(name) ?? name,
    hue: h,
  };
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
      // The reply in words; the turn's number is the event's, not the person's.
      return oneLine(str(d.assistant), 120) || "Reply";
    }
    case "tool.started":
      return toolLabel(str(d.tool));
    case "tool.ended": {
      // "Edit · 0.4 s"; a failure says what failed, never a bare "ok" or "error".
      const bits = [toolLabel(str(d.tool))];
      if (num(d.ms) !== undefined) bits.push(durShort(num(d.ms)));
      if (d.ok === false) bits.push(d.error ? oneLine(str(d.error), 80) : "failed");
      return bits.join(" · ");
    }
    case "files.changed": {
      const paths = Array.isArray(d.paths) ? (d.paths as unknown[]).map(str) : [];
      return paths.length <= 2 ? paths.join(", ") : `${paths.slice(0, 2).join(", ")} +${paths.length - 2}`;
    }
    case "attention.needed":
      return [
        ATTENTION_LABEL[str(d.kind)] ?? str(d.kind),
        d.tool ? toolLabel(str(d.tool)) : "",
        oneLine(str(d.message), 100),
      ]
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

/** Gemini CLI's and Codex's built-in tools, named the way Claude Code names its own, so
 *  one board reads one vocabulary ("Shell", not "run_shell_command"). The raw name stays
 *  in the tooltip and in "Copy tool name". An unknown name is left as it came. */
const SNAKE_TOOLS: Record<string, string> = {
  run_shell_command: "Shell",
  shell: "Shell",
  local_shell: "Shell",
  exec_command: "Shell",
  run_terminal_cmd: "Shell",
  read_file: "Read",
  read_many_files: "Read files",
  write_file: "Write",
  replace: "Edit",
  edit_file: "Edit",
  apply_patch: "Edit",
  list_directory: "List",
  list_dir: "List",
  glob: "Glob",
  search_file_content: "Search",
  grep_search: "Search",
  web_fetch: "Fetch",
  google_web_search: "Web search",
  web_search: "Web search",
  save_memory: "Memory",
  update_plan: "Plan",
};

/** A tool's name as a person reads it. An MCP tool arrives as `mcp__<server>__<tool>`
 *  and reads "github · search_issues"; a claude.ai connector's server drops its
 *  `claude_ai_` prefix ("Linear · list_issues") and a plugin's its `plugin_<name>_`.
 *  Anything else is its own name. The raw name stays in "Copy tool name". */
export function toolLabel(name: string): string {
  const word = SNAKE_TOOLS[name];
  if (word) return word;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return name;
  const server = m[1]!.replace(/^claude_ai_/, "").replace(/^plugin_[^_]+_/, "");
  return `${server || m[1]} · ${m[2]}`;
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
