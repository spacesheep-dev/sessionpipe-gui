// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. ⌘K's "Files" section: go to a file any session changed in the last
// thirty days, from the Review page's reading (GET /api/ui/files, store/review.ts). The
// list is read once per dialog and matched here as the person types: a leading `/` asks
// for files only; without it, a query that reads as a path (a slash in it, or an
// extension at its end) brings the files in beside the sessions. A row opens the newest
// session that touched the file, on that file, in its Files drawer.
import type { FilesPage, FilesSession } from "@shared/api";
import { useEffect, useRef, useState } from "react";
import type { Store } from "../data/store";
import { repoShort } from "../lib/format";
import { fuzzy } from "../lib/fuzzy";

/** How far back the files reach. */
const DAYS = 30;
/** Rows shown at most. */
export const FILES_MAX = 12;

export interface FileRow {
  repo: string;
  path: string;
  lastAt: string;
  /** Newest first. */
  sessions: FilesSession[];
}

export interface FileHit {
  row: FileRow;
  score: number;
  /** Matched indexes into the path, for underlining. */
  at: number[];
}

/** Whether a plain query (no `/` prefix) reads as a path: a slash inside it, or a short
 *  extension at its end ("outbox.ts", "src/out"). A bare word stays a session query. */
export const looksLikePath = (text: string): boolean =>
  text.length >= 2 && (text.includes("/") || /\.[a-z0-9]{1,5}$/i.test(text));

/** The page as flat rows, newest first. */
export function fileRows(page: FilesPage): FileRow[] {
  const rows: FileRow[] = [];
  for (const r of page.repos)
    for (const p of r.paths) rows.push({ repo: r.repo, path: p.path, lastAt: p.lastAt, sessions: p.sessions });
  rows.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return rows;
}

/** The rows `text` finds: the path first, the repo's short name as a weaker field; the
 *  best score first, the newest on a tie; everything (newest first) for an empty query. */
export function matchFiles(rows: readonly FileRow[], text: string, limit = FILES_MAX): FileHit[] {
  const q = text.trim();
  if (!q) return rows.slice(0, limit).map((row) => ({ row, score: 0, at: [] }));
  const hits: FileHit[] = [];
  for (const row of rows) {
    const onPath = fuzzy(q, row.path);
    if (onPath) {
      hits.push({ row, score: onPath.score + 1, at: onPath.positions });
      continue;
    }
    const onRepo = fuzzy(q, repoShort(row.repo));
    if (onRepo) hits.push({ row, score: onRepo.score * 0.5, at: [] });
  }
  hits.sort((a, b) => b.score - a.score || b.row.lastAt.localeCompare(a.row.lastAt));
  return hits.slice(0, limit);
}

/** The files changed in the last DAYS days, read once while the dialog lives (the first
 *  render that wants them asks; later ones share the answer); null until they are in or
 *  while `on` is false. */
export function usePaletteFiles(store: Store, on: boolean): FileRow[] | null {
  const [rows, setRows] = useState<FileRow[] | null>(null);
  const asked = useRef<Promise<FileRow[]> | null>(null);
  useEffect(() => {
    if (!on || rows) return;
    let live = true;
    asked.current ??= store.transport
      .files({ since: new Date(Date.now() - DAYS * 86_400_000).toISOString() })
      .then(fileRows)
      .catch(() => {
        asked.current = null;
        return [];
      });
    asked.current.then((r) => live && setRows(r));
    return () => {
      live = false;
    };
  }, [store, on, rows]);
  return on ? rows : null;
}

/** A small page with a folded corner: the mark of a file row. */
export const FileMark = () => (
  <span className="pal-glyph" aria-hidden="true">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M4 1.5h5l3.5 3.5v9a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  </span>
);
