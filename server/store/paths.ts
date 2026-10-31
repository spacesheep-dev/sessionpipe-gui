// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Which files a session changed. The protocol has `files.changed`
// for it (PROTOCOL.md §4), but the Claude Code adapter never sends one, so the store also
// reads the path out of a write tool's input on its `tool.ended` (tier 3 carries the
// input). Both readings land in the same per-session set, as repo-relative paths, so
// counts.filesChanged, the Review page and the digest all agree (docs/upstream-notes.md).
// The naming rules themselves live in shared/files.ts, where the Files drawer and the
// mock read the same ones.
import type { ProtocolEvent } from "../../shared/api.js";
import { pathsIn, relativePath, WRITE_TOOLS } from "../../shared/files.js";

export { relativePath, tildify, WRITE_TOOLS } from "../../shared/files.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The paths a write tool's input names, as given. The input may be the object the hook
 *  carried, or the index's slim copy: its JSON cut to a preview, which still begins with
 *  the path. Empty for anything that is not a write tool or carries no input. */
export function pathsInInput(tool: string | undefined, input: unknown): string[] {
  return tool ? pathsIn(tool, input, WRITE_TOOLS) : [];
}

/** Every path an event says the session changed, repo-relative: a `files.changed`'s
 *  `paths`, or the file a successful write tool named in its input. */
export function changedPaths(ev: Pick<ProtocolEvent, "type" | "data">, cwd?: string): string[] {
  const d = ev.data;
  if (ev.type === "files.changed") {
    const paths = Array.isArray(d.paths) ? d.paths : [];
    return [
      ...new Set(paths.filter((p): p is string => typeof p === "string" && p !== "").map((p) => relativePath(p, cwd))),
    ];
  }
  if (ev.type === "tool.ended" && d.ok !== false) {
    return [...new Set(pathsInInput(str(d.tool), d.input).map((p) => relativePath(p, cwd)))];
  }
  return [];
}
