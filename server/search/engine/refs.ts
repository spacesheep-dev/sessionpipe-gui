// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. A hit's `ref` (SEARCH-SPEC D4): opaque, URL-safe ([A-Za-z0-9_-]),
// stable while its file is unchanged: `h|e` (the index) + file id + record offset (+ the n-th
// doc of that record), base 36, `-` separated. A file id is the manifest's (never reused), or,
// for a file only the live tail has read so far, a provisional id derived from its path
// (2^40 + crc32) that the reader maps to the manifest id once the file is committed.
import type { SearchSource } from "../types.js";
import { crc32, utf8 } from "./codec.js";

export const PROVISIONAL = 2 ** 40;

export const provisionalId = (path: string): number => PROVISIONAL + crc32(utf8.encode(path));

export interface RefParts {
  source: SearchSource;
  file: number;
  offset: number;
  sub: number;
}

export function encodeRef(source: SearchSource, file: number, offset: number, sub = 0): string {
  const s = `${source === "history" ? "h" : "e"}${file.toString(36)}-${Math.max(0, Math.floor(offset)).toString(36)}`;
  return sub > 0 ? `${s}-${sub.toString(36)}` : s;
}

const REF_RE = /^([he])([0-9a-z]{1,12})-([0-9a-z]{1,12})(?:-([0-9a-z]{1,6}))?$/;

export function decodeRef(ref: string | undefined): RefParts | undefined {
  if (!ref || ref.length > 40) return undefined;
  const m = REF_RE.exec(ref);
  if (!m) return undefined;
  const file = Number.parseInt(m[2]!, 36);
  const offset = Number.parseInt(m[3]!, 36);
  if (!Number.isSafeInteger(file) || !Number.isSafeInteger(offset)) return undefined;
  return { source: m[1] === "h" ? "history" : "sessionpipe", file, offset, sub: m[4] ? Number.parseInt(m[4], 36) : 0 };
}
