// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Where a new session may run (STEER-SPEC B.3, "Folder"): this
// machine's recent folders that sit under one it allows, then the folders its hello lists,
// then a path typed by hand. Events report a folder as `~/…` (EVENTS.md). sessionpipe 0.10's
// hello carries no home folder: a machine whose daemon expands `~/…` itself takes such a
// folder as it is (`MachineControl.tilde`; `home` below is then `~`), and on any other a
// start's folder is absolute and a `~/` one is not offered. "Under" is the daemon's own
// rule, by path segments: `/a/web` allows `/a/web/app` and never `/a/webx`; a `~/…` folder
// and an absolute allowed one can't be compared here, so that check is the machine's. The
// daemon checks again with realpath; this is only so the sheet never offers what the
// machine would refuse. Pure functions, tested.

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

/** The `home` the functions below take for a machine: `~` where it expands `~/…` itself
 *  (sessionpipe 0.10), else none. Never an absolute path: no hello sends one. */
export const machineHome = (c: { tilde?: boolean } | undefined): string | undefined => (c?.tilde ? "~" : undefined);

/** Whether `p` is allowed by `roots` as far as this page can tell: under one of them, or
 *  any at all when none is listed. A `~/…` path against absolute roots is the machine's call. */
const allowedBy = (roots: readonly string[], p: string): boolean =>
  roots.length === 0 || roots.some((r) => r.startsWith("~") !== p.startsWith("~") || under(r, p));

/** The absolute path `p` means on a machine whose home is `home`: `~` and `~/…` expanded,
 *  an absolute path as it is; null for anything else (a relative path, `~` with no home). */
export function expandHome(p: string, home?: string | null): string | null {
  const t = p.trim();
  if (t === "~" || t.startsWith("~/")) return home ? normalizePath(`${home}/${t.slice(1)}`) : null;
  if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) return normalizePath(t);
  return null;
}

/** `p` is a `~/…` folder this page can't name: the machine expands none itself and no home
 *  is known (a computer reached through spacesheep, whose sessions report `~/…`). Such a
 *  folder says nothing about the machine's own; a sheet starts from those instead. */
export const unnamedHere = (p: string, home?: string | null): boolean => {
  const t = p.trim();
  return (t === "~" || t.startsWith("~/")) && !home;
};

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

export interface FormattedFolder {
  /** Primary display name: the basename, or `~` / `/` / `C:\` for roots. */
  name: string;
  /** Full parent directory path, or `""` for roots. */
  parent: string;
  /** Compact parent directory path (middle-elided when longer than 34 chars), or `""`. */
  compactParent: string;
  /** Full normalized display path (for tooltips). */
  full: string;
}

const COMPACT_PARENT_LIMIT = 34;
const COMPACT_TWO_SEG_LIMIT = 28;

/** Splits a tildified or absolute folder path into its basename, full parent, and compact
 *  parent (`~/.bb-machines/startrise.getbb.app/checkouts/sessionpipe` → name `sessionpipe`,
 *  parent `~/.bb-machines/startrise.getbb.app/checkouts`, compactParent `~/…/checkouts`). */
export function formatFolder(display: string, repo?: string): FormattedFolder {
  const trimmed = display.trim();
  if (!trimmed) {
    const fallback = repo ? (repo.split("/").filter(Boolean).pop() ?? "") : "";
    return { name: fallback, parent: "", compactParent: "", full: "" };
  }
  const isWin = /^[A-Za-z]:[\\/]/.test(trimmed);
  let full: string;
  if (trimmed === "~" || /^~[\\/]+$/.test(trimmed)) {
    full = "~";
  } else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    const tail = trimmed
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean);
    full = tail.length ? `~/${tail.join("/")}` : "~";
  } else if (trimmed.startsWith("/") || isWin) {
    full = normalizePath(trimmed);
  } else {
    full = trimmed.replace(/[\\/]+$/, "") || trimmed;
  }

  if (full === "~" || full === "/" || (isWin && full.length <= 3)) {
    return { name: full, parent: "", compactParent: "", full };
  }

  const sep = isWin ? "\\" : "/";
  const idx = full.lastIndexOf(sep);
  if (idx < 0) return { name: full, parent: "", compactParent: "", full };
  const name = full.slice(idx + 1);
  const parent = isWin && idx === 2 ? full.slice(0, 3) : idx === 0 ? "/" : full.slice(0, idx);
  return { name, parent, compactParent: compactParentPath(parent), full };
}

function compactParentPath(parent: string): string {
  if (!parent || parent.length <= COMPACT_PARENT_LIMIT) return parent;
  let prefix = "";
  let sep = "/";
  let rest: string[];
  if (parent.startsWith("~/")) {
    prefix = "~/";
    rest = parent.slice(2).split("/").filter(Boolean);
  } else if (parent.startsWith("/")) {
    prefix = "/";
    rest = parent.slice(1).split("/").filter(Boolean);
  } else if (/^[A-Za-z]:\\/.test(parent)) {
    prefix = parent.slice(0, 3);
    sep = "\\";
    rest = parent.slice(3).split("\\").filter(Boolean);
  } else {
    rest = parent.split("/").filter(Boolean);
  }
  if (rest.length <= 1) return parent;
  if (rest.length > 2) {
    const two = `${prefix}…${sep}${rest.slice(-2).join(sep)}`;
    if (two.length <= COMPACT_TWO_SEG_LIMIT && two.length < parent.length) return two;
  }
  const one = `${prefix}…${sep}${rest[rest.length - 1]}`;
  return one.length < parent.length ? one : parent;
}

// ----- per-machine pinned / favorite folders -----

export const FAV_FOLDERS_KEY = "sp.newSession.favFolders";
export const FAV_FOLDERS_MAX = 12;

function readAllFavorites(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(FAV_FOLDERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const list = [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim().length > 0))].slice(
        0,
        FAV_FOLDERS_MAX,
      );
      if (list.length) out[k] = list;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAllFavorites(all: Record<string, string[]>): void {
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(FAV_FOLDERS_KEY);
    else localStorage.setItem(FAV_FOLDERS_KEY, JSON.stringify(all));
  } catch {
    // Private window or storage full: favorites stay in memory for this open.
  }
}

/** Pinned folder paths for `machine` (at most FAV_FOLDERS_MAX), resilient to storage errors. */
export function readFavoriteFolders(machine: string): string[] {
  if (!machine) return [];
  return readAllFavorites()[machine] ?? [];
}

/** Pins `path` at the top of `machine`'s favorites, or unpins it when already present. */
export function toggleFavoriteFolder(machine: string, path: string): string[] {
  const norm = normalizePath(path.trim());
  if (!machine || !norm) return readFavoriteFolders(machine);
  const all = readAllFavorites();
  const prev = all[machine] ?? [];
  const exists = prev.some((p) => normalizePath(p) === norm);
  const next = exists
    ? prev.filter((p) => normalizePath(p) !== norm)
    : [norm, ...prev.filter((p) => normalizePath(p) !== norm)].slice(0, FAV_FOLDERS_MAX);
  if (next.length) all[machine] = next;
  else delete all[machine];
  writeAllFavorites(all);
  return next;
}

/** Whether `path` is among `favorites`, comparing normalized paths. */
export function isFavoriteFolder(favorites: readonly string[], path: string): boolean {
  const norm = path.trim() ? normalizePath(path.trim()) : "";
  if (!norm) return false;
  return favorites.some((p) => normalizePath(p) === norm);
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

/** The folder list's sections. `pinned`: this machine's pinned folders under an allowed root.
 *  `recent`: this machine's sessions' folders, newest first, one each, at most eight, less any
 *  pinned. `allowed`: the hello's folders, as listed, less any already pinned or recent. */
export function folderChoices(o: {
  sessions: readonly SessionFolder[];
  machine: string;
  folders?: readonly string[] | null;
  home?: string | null;
  favorites?: readonly string[];
}): { pinned: FolderChoice[]; recent: FolderChoice[]; allowed: FolderChoice[] } {
  const roots = (o.folders ?? []).map(normalizePath);
  const seen = new Set<string>();
  const mine = o.sessions
    .filter((s) => s.machine === o.machine && s.cwd)
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  const repoByPath = new Map<string, string>();
  for (const s of mine) {
    const abs = expandHome(s.cwd!, o.home);
    const repo = repoName(s.repo);
    if (abs && repo && !repoByPath.has(abs)) repoByPath.set(abs, repo);
  }
  const pinned: FolderChoice[] = [];
  for (const fav of o.favorites ?? []) {
    const abs = expandHome(fav, o.home);
    if (!abs || seen.has(abs) || !allowedBy(roots, abs)) continue;
    seen.add(abs);
    const repo = repoByPath.get(abs);
    pinned.push({ path: abs, display: tildify(abs, o.home), ...(repo ? { repo } : {}) });
  }
  const recent: FolderChoice[] = [];
  for (const s of mine) {
    const abs = expandHome(s.cwd!, o.home);
    if (!abs || seen.has(abs) || !allowedBy(roots, abs)) continue;
    seen.add(abs);
    recent.push({ path: abs, display: tildify(abs, o.home), repo: repoName(s.repo) });
    if (recent.length >= RECENT_MAX) break;
  }
  const allowed = [...new Set(roots)]
    .filter((r) => !seen.has(r))
    .map((r) => ({ path: r, display: tildify(r, o.home) }));
  return { pinned, recent, allowed };
}

/** A path typed by hand: its absolute form, or why the machine would not take it. */
export function typedFolder(
  text: string,
  o: { folders?: readonly string[] | null; home?: string | null; machine: string },
): { ok: true; path: string } | { ok: false; reason: string } {
  const t = text.trim();
  if (!t) return { ok: false, reason: "Choose a folder" };
  if (unnamedHere(t, o.home)) return { ok: false, reason: `${o.machine} needs the full path; type it starting with /` };
  const abs = expandHome(t, o.home);
  if (!abs) return { ok: false, reason: "Type the folder's full path, starting with / or ~/" };
  if (segments(abs).some((x) => x === ".." || x === "."))
    return { ok: false, reason: "Type the folder's own path, without . or .." };
  if (!allowedBy(o.folders ?? [], abs)) return { ok: false, reason: `${o.machine} doesn't allow that folder` };
  return { ok: true, path: abs };
}
