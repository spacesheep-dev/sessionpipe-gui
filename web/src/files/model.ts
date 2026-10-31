// SPDX-License-Identifier: Apache-2.0
// Owned by: web. One file of a session, as the events already sent describe it: nothing
// is asked of the machine. The index (shared/files.ts `indexTouches`, the same pairing
// the receiver's `/files` route runs over its whole index) names the files and each tool
// call on them; the full events behind the touches of one file carry the text: a Read's
// output (the file as the agent saw it, numbered), an Edit's old and new strings, a
// Write's content. From those this module rebuilds the text at any point of the file's
// history (the last Read or Write before that point as the base, the Edits after it
// applied in order), lays the result beside its base as a diff, lists the session's
// problems (a tool that failed), and writes the review message a comment on a line
// becomes. Pure functions, tested in model.test.ts; FilesDrawer.tsx draws them.
import type { SessionFile, SessionFileTouch, StoredEvent } from "@shared/api";
import { PROMPT_MAX_CHARS } from "@shared/attachments";
import { indexTouches, inputObject, normalizeRel, pathsIn, relativePath } from "@shared/files";

export type Touch = SessionFileTouch;

/** The full events behind a file's touches, by seq (the drawer fetches them as a file opens). */
export type EventsBySeq = ReadonlyMap<number, StoredEvent>;

export interface FileEntry extends SessionFile {
  /** The folder part of `path` ("" at the root) and its last segment. */
  dir: string;
  name: string;
  reads: number;
  edits: number;
  writes: number;
  failed: number;
  /** A tool still running on it. */
  pending: boolean;
  lastAt: string;
  lastSeq: number;
  /** Written before it was ever read: new in this session, as far as the events say. */
  created: boolean;
}

const splitPath = (p: string): { dir: string; name: string } => {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
};

/** A file's counts and names from its touches. */
export function entryOf(f: SessionFile): FileEntry {
  const path = normalizeRel(f.path);
  const e: FileEntry = {
    ...f,
    path,
    ...splitPath(path),
    reads: 0,
    edits: 0,
    writes: 0,
    failed: 0,
    pending: false,
    lastAt: f.touches[f.touches.length - 1]?.at ?? "",
    lastSeq: f.touches[f.touches.length - 1]?.seq ?? -1,
    created: false,
  };
  for (const t of f.touches) {
    if (t.pending) e.pending = true;
    if (t.failed) e.failed++;
    else if (t.kind === "read") e.reads++;
    else if (t.kind === "write") e.writes++;
    else if (t.kind !== "changed") e.edits++;
  }
  const first = f.touches.find((t) => !t.failed && t.kind !== "changed");
  e.created = first?.kind === "write";
  return e;
}

/** The receiver's index of the whole session and the touches the live events made since
 *  it was read, as one list by path: a path once, its touches by seq, a seq once. */
export function mergeFiles(index: readonly SessionFile[], live: readonly SessionFile[]): FileEntry[] {
  const by = new Map<string, SessionFile>();
  for (const f of [...index, ...live]) {
    const path = normalizeRel(f.path);
    const have = by.get(path);
    if (!have) {
      by.set(path, { ...f, path, touches: [...f.touches] });
      continue;
    }
    const seen = new Set(have.touches.map((t) => t.seq));
    for (const t of f.touches) if (!seen.has(t.seq)) have.touches.push(t);
    have.touches.sort((a, b) => a.seq - b.seq);
  }
  return [...by.values()].map(entryOf).sort((a, b) => a.path.localeCompare(b.path));
}

/** The files the loaded events alone name (a session with no index yet, the mock). */
export const indexFiles = (events: readonly StoredEvent[], cwd?: string): FileEntry[] =>
  mergeFiles(indexTouches(events, cwd), []);

// ---------- the text of one file ----------

/** A Read's output as Claude Code numbers it (`     1→text`, older builds `     1\ttext`),
 *  or plain text (Gemini's read_file). A <system-reminder> block is the harness's, not
 *  the file's, wherever it sits; CRLF endings are the file's and go. */
export function parseRead(output: string): { lines: string[]; start: number } {
  const text = output
    .replace(/\n?<system-reminder>[\s\S]*?<\/system-reminder>[ \t]*(?:\n|$)/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  const raw = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const NUM = /^\s*(\d+)(?:→|\t)(.*)$/;
  let numbered = 0;
  for (const l of raw) if (NUM.test(l)) numbered++;
  // Numbered when (nearly) every line is: a blank line keeps its number too, so a file of
  // text should hit on all of them; a plain file that happens to start with digits does not.
  if (raw.length > 0 && numbered >= Math.max(1, Math.ceil(raw.length * 0.9))) {
    const lines: string[] = [];
    let start = 1;
    let first = true;
    for (const l of raw) {
      const m = NUM.exec(l);
      if (!m) continue;
      if (first) {
        start = Number(m[1]);
        first = false;
      }
      lines.push(m[2]!);
    }
    return { lines, start };
  }
  return { lines: raw, start: 1 };
}

/** One edit the agent made to the text, as its input said it. */
export interface Hunk {
  seq: number;
  at: string;
  tool: string;
  /** The text replaced and what replaced it (an Edit); a patch has `patch` instead; a
   *  notebook edit names its cell. */
  old?: string;
  new?: string;
  patch?: string;
  cell?: string;
  /** The hunk was applied to the base text (its `old` was found there). */
  applied: boolean;
  /** Where the replacement sits in the result, by line number, once applied. */
  from?: number;
  to?: number;
  failed: boolean;
}

export interface FileText {
  /** The rebuilt text, by line, or null when no Read or Write gave a base. */
  lines: string[] | null;
  /** The line number of `lines[0]` (a Read with an offset starts past 1). */
  start: number;
  /** The base's own lines, for the diff against `lines`. */
  base: string[] | null;
  /** What the base is: the last whole Read, or the last Write. */
  basis: { kind: "read" | "write"; seq: number; at: string } | null;
  /** Every edit after the base, in order; `applied` says whether it landed in `lines`. */
  hunks: Hunk[];
  /** Line numbers an applied hunk wrote. */
  changed: Set<number>;
  /** Touches whose full event is not here (not fetched, or still a cut preview): the
   *  text may be short of them. */
  missing: number;
  /** The last write tool's own output said it failed: the text may not be the file's. */
  failed: boolean;
}

interface Edit {
  old: string;
  new: string;
  all: boolean;
}

/** The edits a tool's input holds: one for Edit / replace / edit_file, several for MultiEdit. */
export function editsIn(tool: string, input: unknown): Edit[] {
  const o = inputObject(input);
  if (!o) return [];
  const one = (x: Record<string, unknown>): Edit | null => {
    const oldS = typeof x.old_string === "string" ? x.old_string : typeof x.old_str === "string" ? x.old_str : null;
    const newS = typeof x.new_string === "string" ? x.new_string : typeof x.new_str === "string" ? x.new_str : null;
    if (oldS === null || newS === null) return null;
    return { old: oldS, new: newS, all: x.replace_all === true || x.expected_replacements === -1 };
  };
  if (tool === "MultiEdit" && Array.isArray(o.edits)) {
    return o.edits
      .map((x) => (x && typeof x === "object" ? one(x as Record<string, unknown>) : null))
      .filter((x): x is Edit => !!x);
  }
  const e = one(o);
  return e ? [e] : [];
}

/** The content a Write's input carries. */
export function contentIn(input: unknown): string | null {
  const o = inputObject(input);
  if (!o) return null;
  return typeof o.content === "string" ? o.content : typeof o.contents === "string" ? o.contents : null;
}

/** The patch text an apply_patch input carries. */
function patchIn(input: unknown): string | null {
  const o = inputObject(input);
  if (!o) return typeof input === "string" && input.includes("*** Begin Patch") ? input : null;
  for (const v of Object.values(o)) if (typeof v === "string" && v.includes("***")) return v;
  return null;
}

const splitLines = (s: string): string[] => (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n");

/** A full event behind a touch, when it is here and whole. */
const whole = (events: EventsBySeq, t: Touch): StoredEvent | undefined => {
  const e = events.get(t.seq);
  return e && e.preview?.input === undefined && e.preview?.output === undefined ? e : undefined;
};

/** Whether a touch gives a base: a Read that returned text, a Write with content. A touch
 *  whose event is not here yet is taken to (the stepper names it; the text waits). */
const isBase = (events: EventsBySeq, t: Touch): boolean => {
  if (t.pending || t.failed) return false;
  const e = events.get(t.seq);
  if (t.kind === "read") return !e || (typeof e.data.output === "string" && e.data.output !== "");
  if (t.kind === "write") return !e || contentIn(e.data.input) !== null;
  return false;
};

/** One version of a file: a base the agent read or wrote, up to the next one. The
 *  drawer steps through them; the last is the file as it stands. */
export interface FileVersion {
  /** The base touch's seq, or null for edits before any base. */
  seq: number | null;
  at: string;
  kind: "read" | "write" | "edits";
  /** The seq of the last touch this version covers (the next base is the next version). */
  until: number;
}

/** The versions a file went through here, oldest first: one per Read or Write that gave a
 *  base, plus one before the first base when edits came without one. */
export function versionsOf(entry: SessionFile, events: EventsBySeq): FileVersion[] {
  const out: FileVersion[] = [];
  for (const t of entry.touches) {
    if (t.pending || t.failed || t.kind === "changed") continue;
    if (isBase(events, t)) out.push({ seq: t.seq, at: t.at, kind: t.kind as "read" | "write", until: t.seq });
    else if (out.length === 0) out.push({ seq: null, at: t.at, kind: "edits", until: t.seq });
    else out[out.length - 1]!.until = t.seq;
  }
  return out;
}

/** The text of a file up to `until` (a touch's seq; the newest by default), rebuilt from
 *  the full events: the last Read (from line 1, or a page of it) or Write before that
 *  point as the base, then each Edit after it applied where its `old` is found, once or
 *  everywhere as it asked. A Read of a page is a base too, numbered from where it
 *  started; an Edit whose text is not in that page stays a hunk to read on its own. A
 *  failed tool changes nothing; a touch whose event is missing counts as such. */
export function fileText(entry: SessionFile, events: EventsBySeq, until = Number.POSITIVE_INFINITY): FileText {
  let lines: string[] | null = null;
  let base: string[] | null = null;
  let start = 1;
  let basis: FileText["basis"] = null;
  let hunks: Hunk[] = [];
  let changed = new Set<number>();
  let missing = 0;
  let failed = false;
  for (const t of entry.touches) {
    if (t.seq > until) break;
    if (t.pending || t.kind === "changed") continue;
    const e = whole(events, t);
    if (!e) {
      missing++;
      continue;
    }
    const d = e.data;
    if (t.kind === "read") {
      if (t.failed || typeof d.output !== "string" || !d.output) continue;
      // A read after the base is the truth from then on: the edits before it are in it.
      const r = parseRead(d.output);
      lines = r.lines;
      base = r.lines;
      start = r.start;
      basis = { kind: "read", seq: t.seq, at: t.at };
      hunks = [];
      changed = new Set();
      failed = false;
      continue;
    }
    if (t.kind === "write") {
      const content = contentIn(d.input);
      if (t.failed) {
        hunks.push({ seq: t.seq, at: t.at, tool: t.tool, new: content ?? undefined, applied: false, failed: true });
        failed = true;
        continue;
      }
      if (content === null) continue;
      // A write over a known text is one change against it; a first write is all new.
      base = lines ?? [];
      lines = splitLines(content);
      start = 1;
      basis = { kind: "write", seq: t.seq, at: t.at };
      hunks = [];
      changed = new Set(lines.map((_, i) => i + 1));
      failed = false;
      continue;
    }
    if (t.kind === "patch") {
      const patch = patchIn(d.input);
      hunks.push({ seq: t.seq, at: t.at, tool: t.tool, patch: patch ?? undefined, applied: false, failed: !!t.failed });
      if (t.failed) failed = true;
      continue;
    }
    const edits = editsIn(t.tool, d.input);
    if (edits.length === 0) {
      if (t.kind === "notebook") {
        const o = inputObject(d.input);
        const cell = o && typeof o.cell_id === "string" ? o.cell_id : undefined;
        hunks.push({ seq: t.seq, at: t.at, tool: t.tool, cell, applied: false, failed: !!t.failed });
      }
      continue;
    }
    for (const ed of edits) {
      const hunk: Hunk = {
        seq: t.seq,
        at: t.at,
        tool: t.tool,
        old: ed.old,
        new: ed.new,
        applied: false,
        failed: !!t.failed,
      };
      if (!t.failed && lines && ed.old) {
        const r = apply(lines, ed, start);
        if (r) {
          lines = r.lines;
          hunk.applied = true;
          hunk.from = r.from;
          hunk.to = r.to;
          // Marks inside the replaced range are gone with it; those after it move with the text.
          changed = shift(changed, r.from, r.oldLines, r.delta);
          for (let n = r.from; n <= r.to; n++) changed.add(n);
        }
      }
      hunks.push(hunk);
    }
    if (t.failed) failed = true;
  }
  return { lines, start, base, basis, hunks, changed, missing, failed };
}

/** Replaces `ed.old` in the text (once, or everywhere), by line: the lines the first
 *  replacement wrote, as numbers from `start`, how many lines it replaced, and how many
 *  lines the text grew by. */
function apply(
  lines: string[],
  ed: Edit,
  start: number,
): { lines: string[]; from: number; to: number; oldLines: number; delta: number } | null {
  const text = lines.join("\n");
  const at = text.indexOf(ed.old);
  if (at < 0) return null;
  const next = ed.all ? text.split(ed.old).join(ed.new) : text.slice(0, at) + ed.new + text.slice(at + ed.old.length);
  const out = next.split("\n");
  const from = start + (text.slice(0, at).split("\n").length - 1);
  const to = from + Math.max(0, ed.new.split("\n").length - 1);
  return { lines: out, from, to, oldLines: ed.old.split("\n").length, delta: out.length - lines.length };
}

function shift(set: Set<number>, from: number, oldLines: number, delta: number): Set<number> {
  const out = new Set<number>();
  for (const n of set) {
    if (n >= from && n < from + oldLines) continue;
    out.add(n >= from + oldLines ? n + delta : n);
  }
  return out;
}

// ---------- the diff ----------

/** One row of the Changes view: a line kept, taken out or put in, or a fold of lines
 *  that did not change. Numbers are the base's and the result's. */
export type SameRow = { kind: "same"; text: string; oldNo: number; newNo: number };
export type DiffRow =
  | SameRow
  | { kind: "del"; text: string; oldNo: number }
  | { kind: "add"; text: string; newNo: number }
  /** `lines` are the rows folded away, for opening the fold in place. */
  | { kind: "fold"; count: number; oldNo: number; newNo: number; lines: SameRow[] };

/** Lines of context kept on each side of a change before the rest folds. */
export const DIFF_CONTEXT = 3;
/** Past this many lines a side, the diff is by whole blocks, not a line matrix. */
const DIFF_LCS_MAX = 4000;

/** The result beside its base, line by line (a longest common subsequence, with runs of
 *  unchanged lines folded past DIFF_CONTEXT on each side of a change). Both texts number
 *  from `start`. */
export function diffRows(base: readonly string[], result: readonly string[], start = 1): DiffRow[] {
  const n = base.length;
  const m = result.length;
  const ops: ("same" | "del" | "add")[] = [];
  if (n * m > DIFF_LCS_MAX * DIFF_LCS_MAX) {
    // Too big for the matrix: the common head and tail, and the middle as one change.
    let head = 0;
    while (head < n && head < m && base[head] === result[head]) head++;
    let tail = 0;
    while (tail < n - head && tail < m - head && base[n - 1 - tail] === result[m - 1 - tail]) tail++;
    for (let i = 0; i < head; i++) ops.push("same");
    for (let i = head; i < n - tail; i++) ops.push("del");
    for (let i = head; i < m - tail; i++) ops.push("add");
    for (let i = 0; i < tail; i++) ops.push("same");
  } else {
    // The classic table, walked back from the end.
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) {
        const here = i * w + j;
        dp[here] = base[i] === result[j] ? dp[here + w + 1]! + 1 : Math.max(dp[here + w]!, dp[here + 1]!);
      }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (base[i] === result[j]) {
        ops.push("same");
        i++;
        j++;
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
        ops.push("del");
        i++;
      } else {
        ops.push("add");
        j++;
      }
    }
    while (i++ < n) ops.push("del");
    while (j++ < m) ops.push("add");
  }
  // Number the rows, then fold the long runs of unchanged lines.
  const rows: DiffRow[] = [];
  let oi = 0;
  let ni = 0;
  for (const op of ops) {
    if (op === "same") rows.push({ kind: "same", text: base[oi]!, oldNo: start + oi++, newNo: start + ni++ });
    else if (op === "del") rows.push({ kind: "del", text: base[oi]!, oldNo: start + oi++ });
    else rows.push({ kind: "add", text: result[ni]!, newNo: start + ni++ });
  }
  const out: DiffRow[] = [];
  let run: SameRow[] = [];
  const flush = (atEnd: boolean) => {
    const keepHead = out.length === 0 ? 0 : DIFF_CONTEXT;
    const keepTail = atEnd ? 0 : DIFF_CONTEXT;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead));
      const folded = run.slice(keepHead, run.length - keepTail);
      out.push({ kind: "fold", count: folded.length, oldNo: folded[0]!.oldNo, newNo: folded[0]!.newNo, lines: folded });
      out.push(...run.slice(run.length - keepTail));
    } else out.push(...run);
    run = [];
  };
  for (const r of rows) {
    if (r.kind === "same") run.push(r);
    else {
      if (run.length) flush(false);
      out.push(r);
    }
  }
  if (run.length) flush(true);
  return out;
}

// ---------- problems ----------

export interface Problem {
  seq: number;
  at: string;
  /** A tool that failed, or an error the harness raised. */
  kind: "tool" | "error";
  tool?: string;
  /** The path (repo-relative) or command it was about, when the input says. */
  subject?: string;
  /** The error, cut to a line or two. */
  text: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

const subjectOf = (tool: string | undefined, input: unknown, cwd: string | undefined): string | undefined => {
  const o = inputObject(input);
  if (!o) return undefined;
  for (const k of ["file_path", "notebook_path", "path"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return normalizeRel(relativePath(v.trim(), cwd));
  }
  for (const k of ["command", "pattern", "url"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.split("\n")[0]!.trim();
  }
  return tool && pathsIn(tool, input)[0];
};

/** Every tool that failed and every error attention, oldest first. */
export function problemsOf(events: readonly StoredEvent[], cwd?: string): Problem[] {
  const out: Problem[] = [];
  for (const e of events) {
    const d = e.data;
    if (e.type === "tool.ended" && d.ok === false) {
      const err = typeof d.error === "string" ? d.error : typeof d.output === "string" ? d.output : "";
      out.push({
        seq: e.session.seq,
        at: e.time,
        kind: "tool",
        tool: str(d.tool),
        subject: subjectOf(str(d.tool), d.input, cwd),
        text: firstLines(err || "failed", 2),
      });
    } else if (e.type === "attention.needed" && d.kind === "error") {
      out.push({ seq: e.session.seq, at: e.time, kind: "error", text: firstLines(str(d.message) ?? "Error", 2) });
    }
  }
  return out;
}

export function firstLines(s: string, n: number): string {
  const lines = s.trim().split("\n");
  const head = lines.slice(0, n).join("\n").trim();
  return lines.length > n ? `${head}…` : head;
}

// ---------- comments → a message ----------

export interface LineComment {
  id: string;
  path: string;
  /** The lines commented on; absent for a comment on the whole file. */
  from?: number;
  to?: number;
  /** The lines commented on, as shown. */
  excerpt: string;
  text: string;
  /** What the lines should become, when the comment is a suggestion. */
  suggestion?: string;
}

/** Characters of excerpt kept per comment, so a long message stays under the command's cap. */
const EXCERPT_MAX = 1200;

const LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  css: "css",
  scss: "scss",
  html: "html",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  md: "md",
  sql: "sql",
};
/** The fence's language tag, from the extension. */
export const langOf = (path: string): string => LANG[path.split(".").pop()?.toLowerCase() ?? ""] ?? "";

/** The longest run of backticks in a text. */
const backticks = (text: string): number => {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return longest;
};
/** A fence longer than any run of backticks inside. */
const fenceFor = (text: string): string => "`".repeat(Math.max(3, backticks(text) + 1));
/** A code span that survives backticks in the path. */
const span = (s: string): string => {
  const n = backticks(s);
  return n ? `${"`".repeat(n + 1)} ${s} ${"`".repeat(n + 1)}` : `\`${s}\``;
};

/** The one message the comments become: each names its file and lines the way every
 *  harness's tools read a location (`path:from-to`), quotes them in a fence tagged by the
 *  extension, and says what should change, a suggestion as "Replace with:" and the new
 *  text. One numbered list keeps a review in one turn, and the first line asks for a
 *  reply per item, so what the agent did can be read back against it. */
export function reviewPrompt(comments: readonly LineComment[]): string {
  if (comments.length === 0) return "";
  const n = comments.length;
  const head =
    n === 1
      ? "A review comment on your changes. Please address it, then say what you changed."
      : `Review comments on your changes (${n}). Please address each, then say what you changed per item.`;
  const parts = comments.map((c, i) => {
    const where =
      c.from === undefined
        ? `${c.path} (whole file)`
        : c.from === c.to
          ? `${c.path}:${c.from}`
          : `${c.path}:${c.from}-${c.to}`;
    const excerpt = c.excerpt.length > EXCERPT_MAX ? `${c.excerpt.slice(0, EXCERPT_MAX)}\n…` : c.excerpt;
    const lang = langOf(c.path);
    const block = (text: string) => {
      const f = fenceFor(text);
      return `${f}${lang}\n${text}\n${f}`;
    };
    const lines = [n > 1 ? `${i + 1}. ${span(where)}` : span(where)];
    if (excerpt) lines.push(block(excerpt));
    if (c.text.trim()) lines.push(c.text.trim());
    if (c.suggestion !== undefined) lines.push("Replace with:", block(c.suggestion));
    return lines.join("\n");
  });
  const text = `${head}\n\n${parts.join("\n\n")}`;
  return text.length > PROMPT_MAX_CHARS ? `${text.slice(0, PROMPT_MAX_CHARS - 1)}…` : text;
}

// ---------- an editor on this machine ----------

export type Editor = "vscode" | "cursor" | "zed" | "windsurf";
export const EDITORS: { id: Editor; label: string }[] = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
  { id: "windsurf", label: "Windsurf" },
];

/** The URL that opens a file in an editor on this machine, at a line. Only an absolute
 *  path can be opened: `~` means nothing to a browser, and a relative one needs a cwd
 *  that is absolute. Null when there is no such path. */
export function editorHref(editor: Editor, given: string, cwd: string | undefined, line?: number): string | null {
  let abs: string | null = null;
  const isAbs = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
  if (isAbs(given)) abs = given;
  else if (!given.startsWith("~") && cwd && isAbs(cwd)) abs = `${cwd.replace(/[\\/]+$/, "")}/${normalizeRel(given)}`;
  if (!abs) return null;
  const path = abs.replace(/\\/g, "/");
  const where = (path.startsWith("/") ? path : `/${path}`)
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/%3A/g, ":").replace(/%2B/g, "+"))
    .join("/");
  const at = line && line > 0 ? `:${line}` : "";
  return `${editor}://file${where}${at}`;
}
