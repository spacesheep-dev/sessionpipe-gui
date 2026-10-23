// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Where a new session may run (STEER-SPEC B.3, "Folder"): this
// machine's recent folders that sit under one it allows, then the folders its hello lists,
// then a path typed by hand. Events report a folder as `~/…` (EVENTS.md); a start needs it
// absolute (CONTROL.md §3.1 `cwd`), so `~` is the hello's `home`, and without one a `~/`
// folder is not offered. "Under" is the daemon's own rule, by path segments: `/a/web`
// allows `/a/web/app` and never `/a/webx`. The daemon checks again with realpath; this is
// only so the sheet never offers what the machine would refuse. Pure functions, tested.

/** `/a//b/` → `/a/b`; the root stays `/`. Backslashes are a Windows path's own. */
export function normalizePath(p: string): string {
  const win = /^[A-Za-z]:[\\/]/.test(p);
  const sep = win ? "\\" : "/";
  const parts = p.split(/[\\/]+/).filter((x, i) => x !== "" || i === 0);
  const out = parts.join(sep);
  if (win) return out.length <= 2 ? `${out}\\` : out;
  return out === "" ? "/" : out;
}

const segments = (p: string): string[] => normalizePath(p).split(/[\\/]/).filter(Boolean);

/** The absolute path `p` means on a machine whose home is `home`: `~` and `~/…` expanded,
 *  an absolute path as it is; null for anything else (a relative path, `~` with no home). */
export function expandHome(p: string, home?: string | null): string | null {
  const t = p.trim();
  if (t === "~" || t.startsWith("~/")) return home ? normalizePath(`${home}/${t.slice(1)}`) : null;
  if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) return normalizePath(t);
  return null;
}

/** `p` is `root` or inside it, by whole path segments (case-sensitive, as the daemon is). */
export function under(root: string, p: string): boolean {
  const r = segments(root);
  const s = segments(p);
  if (s.length < r.length) return false;
  if (/^[A-Za-z]:/.test(root) !== /^[A-Za-z]:/.test(p)) return false;
  return r.every((x, i) => x === s[i]);
}

/** `/Users/misha/acme/web` → `~/acme/web` when `home` is `/Users/misha`. */
export function tildify(p: string, home?: string | null): string {
  if (!home) return p;
  const h = normalizePath(home);
  const n = normalizePath(p);
  if (n === h) return "~";
  return under(h, n) ? `~/${segments(n).slice(segments(h).length).join("/")}` : n;
}

export interface FolderChoice {
  /** Absolute: what a start's `cwd` carries. */
  path: string;
  /** With `~` for anything under home. */
  display: string;
  /** The repo the store saw there ("acme/web"), as secondary text. */
  repo?: string;
}

/** The fields of a session the folder list reads. */
export interface SessionFolder {
  machine?: string;
  cwd?: string;
  repo?: string;
  lastAt: string;
}

export const RECENT_MAX = 8;

const repoName = (repo: string | undefined): string | undefined => {
  if (!repo) return undefined;
  const parts = repo
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : parts[0];
};

/** The folder list's first two sections. `recent`: this machine's sessions' folders, newest
 *  first, one each, at most eight, only those under an allowed folder (any, when the machine
 *  listed none). `allowed`: the hello's folders, as listed, less any already among the recent. */
export function folderChoices(o: {
  sessions: readonly SessionFolder[];
  machine: string;
  folders?: readonly string[] | null;
  home?: string | null;
}): { recent: FolderChoice[]; allowed: FolderChoice[] } {
  const roots = (o.folders ?? []).map(normalizePath);
  const allowedBy = (p: string) => roots.length === 0 || roots.some((r) => under(r, p));
  const seen = new Set<string>();
  const recent: FolderChoice[] = [];
  const mine = o.sessions
    .filter((s) => s.machine === o.machine && s.cwd)
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  for (const s of mine) {
    const abs = expandHome(s.cwd!, o.home);
    if (!abs || seen.has(abs) || !allowedBy(abs)) continue;
    seen.add(abs);
    recent.push({ path: abs, display: tildify(abs, o.home), repo: repoName(s.repo) });
    if (recent.length >= RECENT_MAX) break;
  }
  const allowed = [...new Set(roots)]
    .filter((r) => !seen.has(r))
    .map((r) => ({ path: r, display: tildify(r, o.home) }));
  return { recent, allowed };
}

/** A path typed by hand: its absolute form, or why the machine would not take it. */
export function typedFolder(
  text: string,
  o: { folders?: readonly string[] | null; home?: string | null; machine: string },
): { ok: true; path: string } | { ok: false; reason: string } {
  const t = text.trim();
  if (!t) return { ok: false, reason: "Choose a folder" };
  if ((t === "~" || t.startsWith("~/")) && !o.home)
    return { ok: false, reason: `${o.machine} didn't say where its home folder is; type the full path` };
  const abs = expandHome(t, o.home);
  if (!abs) return { ok: false, reason: "Type the folder's full path, starting with / or ~/" };
  if (segments(abs).some((x) => x === ".." || x === "."))
    return { ok: false, reason: "Type the folder's own path, without . or .." };
  const roots = o.folders ?? [];
  if (roots.length && !roots.some((r) => under(r, abs)))
    return { ok: false, reason: `${o.machine} doesn't allow that folder` };
  return { ok: true, path: abs };
}
