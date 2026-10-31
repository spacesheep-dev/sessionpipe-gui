// SPDX-License-Identifier: Apache-2.0
// Which file a tool call is about, read from its input, and the touches a session's
// events make on each file. One implementation for both sides: the store's Review
// readings (server/store/paths.ts), the session files route (server/ui/files.ts) and the
// mock transport all name files by these rules, so the Review page, the Files drawer and
// the demo agree. Pure functions over protocol events; nothing here reads a disk.
import type { ProtocolEvent, SessionFile, SessionFileTouch } from "./api.js";

/** Tools that write a file and name it in their input: Claude Code, then Codex / Gemini
 *  CLI / Antigravity. Bash is left alone: a shell command's targets are not knowable. */
export const WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "write_file",
  "replace",
  "apply_patch",
  "edit_file",
]);
/** Tools that read a file and name it in their input: Claude Code, Gemini CLI, Antigravity. */
export const READ_TOOLS = new Set(["Read", "read_file", "view_file", "ReadFile", "view"]);

export type TouchKind = SessionFileTouch["kind"];

/** The input keys a path sits under, in the order the harnesses use them. */
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;
/** A cut JSON string still shows its first keys: `"file_path":"…"`. */
const PATH_RE = /"(?:file_path|notebook_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
/** Codex's apply_patch names its files in the patch text. */
const PATCH_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
/** A `files.changed` this close after a write tool's touch of the same path is that touch. */
const FOLD_MS = 10_000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** An input as an object: the hook's object, or the JSON string some harnesses send. A
 *  preview cut mid-way no longer parses and reads as null; the regexes below still find
 *  the path in it. */
export function inputObject(input: unknown): Record<string, unknown> | null {
  if (!input) return null;
  if (typeof input === "object") return input as Record<string, unknown>;
  if (typeof input !== "string") return null;
  try {
    const v: unknown = JSON.parse(input);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function patchFiles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATCH_RE)) if (m[1]) out.push(m[1].trim());
  return out;
}

/** The paths a tool's input names, as given: for `tools` (the write tools, or the read
 *  tools too), from the object or from a cut JSON preview, each once. */
export function pathsIn(tool: string, input: unknown, tools: ReadonlySet<string> = ALL_TOOLS): string[] {
  if (!tools.has(tool) || input === undefined || input === null) return [];
  const o = inputObject(input);
  const out: string[] = [];
  if (o) {
    for (const k of PATH_KEYS) {
      const p = str(o[k]);
      if (p) {
        out.push(p.trim());
        break;
      }
    }
    if (tool === "apply_patch") for (const v of Object.values(o)) if (typeof v === "string") out.push(...patchFiles(v));
  } else if (typeof input === "string") {
    const m = PATH_RE.exec(input);
    if (m?.[1]) {
      try {
        out.push((JSON.parse(`"${m[1]}"`) as string).trim());
      } catch {
        // a path cut mid-escape: nothing to show for it
      }
    }
    if (tool === "apply_patch") out.push(...patchFiles(input.replace(/\\n/g, "\n")));
  }
  return [...new Set(out.filter(Boolean))];
}

const ALL_TOOLS: ReadonlySet<string> = new Set([...WRITE_TOOLS, ...READ_TOOLS]);

/** What a tool does to the file it names. */
export function kindOf(tool: string): Exclude<TouchKind, "changed"> {
  if (READ_TOOLS.has(tool)) return "read";
  if (tool === "apply_patch") return "patch";
  if (tool === "NotebookEdit") return "notebook";
  if (tool === "Write" || tool === "write_file") return "write";
  return "edit";
}

/** `/Users/me/…` and `/home/me/…` → `~/…` (the client already writes `cwd` that way). */
export function tildify(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** A path as the repo sees it: under the session's cwd it loses that prefix; a path
 *  elsewhere keeps its place, with the home directory as `~`. Already-relative paths
 *  stay as they are. */
export function relativePath(p: string, cwd?: string): string {
  const path = p.trim();
  if (!path.startsWith("/") && !path.startsWith("~")) return path;
  const tp = tildify(path);
  if (cwd) {
    const base = tildify(cwd.trim()).replace(/\/+$/, "");
    if (base && tp.startsWith(`${base}/`)) return tp.slice(base.length + 1);
    if (tp === base) return ".";
  }
  return tp;
}

/** A relative path with its spelling settled: `\` as `/`, no leading `./`. For callers
 *  that would otherwise list `./src/a.ts` and `src/a.ts` as two files; `relativePath`
 *  itself leaves a relative path alone, as the Review page has always counted them. */
export function normalizeRel(p: string): string {
  let out = p.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/** Every file the events name, each with its touches in seq order. A tool is one touch:
 *  its start while it runs, replaced in place by its end (the end's seq and time) when
 *  that arrives; a second end of the same call changes nothing. A `files.changed` within
 *  FOLD_MS after a write touch of the same path is that write; otherwise its own touch.
 *  `cut` marks an event whose input or output the index cut to a preview (`preview` on
 *  the slim copy). Files come newest-touched first. */
export function indexTouches(
  events: readonly (ProtocolEvent & { preview?: Record<string, number> })[],
  cwd?: string,
): SessionFile[] {
  const by = new Map<string, SessionFile>();
  const started = new Map<string, SessionFileTouch[]>();
  const ended = new Set<string>();
  const file = (given: string): SessionFile => {
    const path = relativePath(given, cwd);
    let f = by.get(path);
    if (!f) {
      f = { path, given, touches: [] };
      by.set(path, f);
    }
    return f;
  };
  const isCut = (e: { preview?: Record<string, number> }) =>
    e.preview?.input !== undefined || e.preview?.output !== undefined;
  for (const e of events) {
    const d = e.data;
    if (e.type === "files.changed") {
      const paths = Array.isArray(d.paths) ? d.paths.filter((p): p is string => typeof p === "string" && p !== "") : [];
      for (const p of paths) {
        const f = file(p);
        const last = f.touches[f.touches.length - 1];
        if (last && last.kind !== "read" && Math.abs(Date.parse(e.time) - Date.parse(last.at)) < FOLD_MS) continue;
        f.touches.push({ seq: e.session.seq, at: e.time, tool: "files.changed", kind: "changed" });
      }
      continue;
    }
    if (e.type !== "tool.started" && e.type !== "tool.ended") continue;
    const tool = str(d.tool);
    if (!tool) continue;
    const callId = str(d.call_id);
    if (e.type === "tool.ended" && callId) {
      if (ended.has(callId)) continue;
      ended.add(callId);
      const open = started.get(callId);
      if (open) {
        started.delete(callId);
        for (const t of open) {
          t.seq = e.session.seq;
          t.at = e.time;
          delete t.pending;
          if (d.ok === false) t.failed = true;
          if (isCut(e)) t.cut = true;
          else delete t.cut;
        }
        continue;
      }
    }
    const paths = pathsIn(tool, d.input);
    if (paths.length === 0) continue;
    const kind = kindOf(tool);
    const made: SessionFileTouch[] = [];
    for (const given of paths) {
      const t: SessionFileTouch = { seq: e.session.seq, at: e.time, tool, kind };
      if (e.type === "tool.started") t.pending = true;
      else if (d.ok === false) t.failed = true;
      if (isCut(e)) t.cut = true;
      file(given).touches.push(t);
      made.push(t);
    }
    if (e.type === "tool.started" && callId) started.set(callId, made);
  }
  const out = [...by.values()];
  for (const f of out) f.touches.sort((a, b) => a.seq - b.seq);
  const lastAt = (f: SessionFile) => f.touches[f.touches.length - 1]?.at ?? "";
  out.sort((a, b) => lastAt(b).localeCompare(lastAt(a)) || a.path.localeCompare(b.path));
  return out;
}
