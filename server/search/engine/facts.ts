// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Session facts, folded. Sources emit `SessionFacts` whenever they
// learn something; the builder folds them per segment and the reader folds the segments in
// commit order: the newest value wins per field, the title by TITLE_RANK (equal rank: the
// newer), `firstAt` the minimum and `lastAt` the maximum.
import type { ResumeSpec, SessionFacts } from "../types.js";

/** The folded facts of one session (as stored in a segment's meta). */
export interface Facts {
  harness: string;
  id: string;
  title?: string;
  titleRank: number;
  cwd?: string;
  branch?: string;
  repo?: string;
  model?: string;
  machine?: string;
  account?: string;
  /** Epoch ms; 0 unknown. */
  firstAt: number;
  lastAt: number;
  forkOf?: string;
  resume?: ResumeSpec;
  path?: string;
}

export function emptyFacts(harness: string, id: string): Facts {
  return { harness, id, titleRank: 0, firstAt: 0, lastAt: 0 };
}

const FIELDS = ["cwd", "branch", "repo", "model", "machine", "account", "forkOf", "resume", "path"] as const;

/** Fold `f` (newer) into `into`. */
export function foldFacts(into: Facts, f: SessionFacts | Facts): void {
  if (f.harness) into.harness = f.harness;
  if (f.id) into.id = f.id;
  const title = "titleRank" in f ? (f.title ? { text: f.title, rank: f.titleRank } : undefined) : f.title;
  if (title?.text && title.rank >= into.titleRank) {
    into.title = title.text;
    into.titleRank = title.rank;
  }
  for (const k of FIELDS) {
    const v = f[k];
    if (v !== undefined && v !== null && v !== "") (into as unknown as Record<string, unknown>)[k] = v;
  }
  foldTimes(into, f.firstAt ?? 0, f.lastAt ?? 0);
}

export function foldTimes(into: Facts, first: number, last: number): void {
  if (first > 0 && (into.firstAt === 0 || first < into.firstAt)) into.firstAt = first;
  if (last > 0 && last > into.lastAt) into.lastAt = last;
  if (into.firstAt === 0 && last > 0) into.firstAt = last;
  if (into.lastAt === 0 && first > 0) into.lastAt = first;
}

/** Only who the session is (a segment on disk keeps the rest per file, in `ff`). */
export function headFacts(f: Facts): Facts {
  return { harness: f.harness, id: f.id, titleRank: 0, firstAt: 0, lastAt: 0 };
}

export function cloneFacts(f: Facts): Facts {
  return { ...f };
}
