// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. A hit's `ref` (SEARCH-SPEC D4): opaque, URL-safe ([A-Za-z0-9_-]),
// stable while its file is unchanged. `h|e` (the index) + file id + offset (+ seq), base 36,
// `-` separated. A file id is the manifest's (never reused), or for a file only the live tail
// has read so far, a provisional id derived from its path (2^40 + crc32), which the reader maps
// to the manifest id once the file is committed.
import type { SearchSource } from "../types.js";
import { crc32, utf8 } from "./codec.js";

export const PROVISIONAL = 2 ** 40;

export const provisionalId = (path: string): number => PROVISIONAL + crc32(utf8.encode(path));

export interface RefParts {
  source: SearchSource;
  file: number;
  offset: number;
  seq?: number;
}

export function encodeRef(source: SearchSource, file: number, offset: number, seq?: number): string {
  const s = `${source === "history" ? "h" : "e"}${file.toString(36)}-${Math.max(0, Math.floor(offset)).toString(36)}`;
  return seq !== undefined && seq >= 0 ? `${s}-${Math.floor(seq).toString(36)}` : s;
}

const REF_RE = /^([he])([0-9a-z]{1,12})-([0-9a-z]{1,12})(?:-([0-9a-z]{1,12}))?$/;

export function decodeRef(ref: string | undefined): RefParts | undefined {
  if (!ref || ref.length > 48) return undefined;
  const m = REF_RE.exec(ref);
  if (!m) return undefined;
  const file = Number.parseInt(m[2]!, 36);
  const offset = Number.parseInt(m[3]!, 36);
  if (!Number.isSafeInteger(file) || !Number.isSafeInteger(offset)) return undefined;
  const out: RefParts = { source: m[1] === "h" ? "history" : "sessionpipe", file, offset };
  if (m[4]) out.seq = Number.parseInt(m[4], 36);
  return out;
}
