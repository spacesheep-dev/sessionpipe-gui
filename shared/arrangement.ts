// SPDX-License-Identifier: Apache-2.0
// The person's arrangement of the session tree (api.ts Arrangement): the rules a change
// is held to. The receiver keeps it (server/ui/arrangementCore.ts), a page on a spacesheep
// account keeps it by the same code, and a page applies a change with it before the
// answer comes (web/src/data/store.ts). It is display only: nothing here is ever sent to
// a machine, and nothing here changes what a session's own events say.
import {
  ARRANGEMENT_FOLDER_NAME_MAX,
  ARRANGEMENT_FOLDERS_MAX,
  ARRANGEMENT_PINNED_MAX,
  ARRANGEMENT_PLACED_MAX,
  type Arrangement,
  type ArrangementFolder,
  type ArrangementPatch,
  FOLDER_ID_RE,
  LABEL_COLORS,
  type LabelColor,
  type SessionKey,
} from "./api.js";

/** A session key in the store's shape: a harness name, a colon, the session's id (the
 *  receiver's own envelope rules, server/receiver/validate.ts). */
export const SESSION_KEY_RE = /^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$/;
export const isSessionKey = (k: unknown): k is SessionKey => typeof k === "string" && SESSION_KEY_RE.test(k);

/** Why a change was refused, as the route's `reason`. */
export class ArrangementError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

const FIELDS = new Set<string>(["placed", "follow", "pinned", "folders", "inFolder"]);
const FOLDER_FIELDS = new Set<string>(["id", "name", "color"]);
const COLORS = new Set<string>(LABEL_COLORS);
const BAD_FOLDER_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control, zero-width, and bidi override characters are stripped from folder names
  /[\u0000-\u001f\u007f-\u009f\u00ad\u200b\u200e\u200f\u061c\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o: object, k: string) => Object.hasOwn(o, k);

/** Strips control, zero-width, and bidi override characters, trims whitespace, and
 *  rejects names with no visible non-format character (e.g. lone ZWJ). */
export function sanitizeFolderName(raw: string): string {
  const s = raw.replace(BAD_FOLDER_CHARS, "").trim();
  if (!s.replace(/\p{Cf}/gu, "").trim()) return "";
  return s;
}

const sameFolders = (a: readonly ArrangementFolder[], b: readonly ArrangementFolder[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.name === b[i]!.name && x.color === b[i]!.color);

const sameInFolder = (
  a: Readonly<Record<SessionKey, string>> | undefined,
  b: Readonly<Record<SessionKey, string>>,
): boolean => {
  const ak = a ? Object.keys(a) : [];
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return bk.every((k) => !!a && has(a, k) && a[k] === b[k]);
};

function buildDoc(
  rev: number,
  placed: Record<SessionKey, SessionKey | null>,
  pinned: SessionKey[],
  folders: ArrangementFolder[],
  inFolder: Record<SessionKey, string>,
): Arrangement {
  const out: Arrangement = { rev, placed, pinned };
  if (folders.length > 0) out.folders = folders;
  if (Object.keys(inFolder).length > 0) out.inFolder = inFolder;
  return out;
}

/** Whether following the placements up from `start` comes back to it. */
export function placedLoop(placed: Readonly<Record<SessionKey, SessionKey | null>>, start: SessionKey): boolean {
  const seen = new Set<SessionKey>();
  for (let cur = placed[start]; cur; cur = has(placed, cur) ? placed[cur] : null) {
    if (cur === start) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
  }
  return false;
}

/** The arrangement after `patch`; the same object when nothing changes. Throws
 *  ArrangementError: 400 `malformed` (an unknown field, a value of the wrong kind, a key
 *  not in the store's shape, a pin twice, a key both placed and followed, an invalid folder),
 *  400 `bad_place` (a session under itself, or a loop of placements), 400 `bad_folder` (an
 *  `inFolder` id not in the resulting folders), 404 `not_found` (a session `known` says the
 *  store does not hold: placing it, under it, pinning it, or assigning it to a folder),
 *  413 `too_many` (over ARRANGEMENT_PLACED_MAX placements/inFolder, ARRANGEMENT_PINNED_MAX
 *  pins, or ARRANGEMENT_FOLDERS_MAX folders).
 *  Following a session that has no placement, and keeping a pin the store has since
 *  forgotten, are fine. */
export function applyArrangement(
  doc: Arrangement,
  patch: ArrangementPatch | unknown,
  known: (key: SessionKey) => boolean,
): Arrangement {
  if (!isObject(patch)) throw new ArrangementError(400, "malformed");
  for (const k of Object.keys(patch)) if (!FIELDS.has(k)) throw new ArrangementError(400, "malformed");
  const p = patch as ArrangementPatch;
  const placed: Record<SessionKey, SessionKey | null> = { ...doc.placed };
  let pinned = doc.pinned;
  let folders: ArrangementFolder[] = doc.folders ? doc.folders.map((f) => ({ ...f })) : [];
  const inFolder: Record<SessionKey, string> = { ...(doc.inFolder ?? {}) };
  let changed = false;
  const follow = p.follow;
  if (follow !== undefined) {
    if (!Array.isArray(follow) || !follow.every(isSessionKey)) throw new ArrangementError(400, "malformed");
    for (const k of follow)
      if (has(placed, k)) {
        delete placed[k];
        changed = true;
      }
  }
  if (p.placed !== undefined) {
    if (!isObject(p.placed)) throw new ArrangementError(400, "malformed");
    const entries = Object.entries(p.placed);
    for (const [child, parent] of entries) {
      if (!isSessionKey(child) || (parent !== null && !isSessionKey(parent)))
        throw new ArrangementError(400, "malformed");
      if (follow?.includes(child)) throw new ArrangementError(400, "malformed");
      if (parent === child) throw new ArrangementError(400, "bad_place");
      if (!known(child) || (parent !== null && !known(parent))) throw new ArrangementError(404, "not_found");
      if (!has(placed, child) || placed[child] !== parent) {
        placed[child] = parent;
        changed = true;
      }
    }
    for (const [child] of entries) if (placedLoop(placed, child)) throw new ArrangementError(400, "bad_place");
    if (Object.keys(placed).length > ARRANGEMENT_PLACED_MAX) throw new ArrangementError(413, "too_many");
  }
  if (p.pinned !== undefined) {
    const next = p.pinned;
    if (!Array.isArray(next) || !next.every(isSessionKey) || new Set(next).size !== next.length)
      throw new ArrangementError(400, "malformed");
    if (next.length > ARRANGEMENT_PINNED_MAX) throw new ArrangementError(413, "too_many");
    for (const k of next) if (!known(k) && !doc.pinned.includes(k)) throw new ArrangementError(404, "not_found");
    if (next.length !== pinned.length || next.some((k, i) => k !== pinned[i])) {
      pinned = [...next];
      changed = true;
    }
  }
  if (p.folders !== undefined) {
    if (!Array.isArray(p.folders)) throw new ArrangementError(400, "malformed");
    if (p.folders.length > ARRANGEMENT_FOLDERS_MAX) throw new ArrangementError(413, "too_many");
    const seenIds = new Set<string>();
    const nextFolders: ArrangementFolder[] = [];
    for (const raw of p.folders) {
      if (!isObject(raw)) throw new ArrangementError(400, "malformed");
      for (const k of Object.keys(raw)) if (!FOLDER_FIELDS.has(k)) throw new ArrangementError(400, "malformed");
      if (typeof raw.id !== "string" || !FOLDER_ID_RE.test(raw.id) || seenIds.has(raw.id))
        throw new ArrangementError(400, "malformed");
      if (typeof raw.name !== "string") throw new ArrangementError(400, "malformed");
      const name = sanitizeFolderName(raw.name);
      if (name.length < 1 || name.length > ARRANGEMENT_FOLDER_NAME_MAX) throw new ArrangementError(400, "malformed");
      let color: LabelColor | undefined;
      if (raw.color !== undefined) {
        if (typeof raw.color !== "string" || !COLORS.has(raw.color)) throw new ArrangementError(400, "malformed");
        color = raw.color as LabelColor;
      }
      seenIds.add(raw.id);
      nextFolders.push(color !== undefined ? { id: raw.id, name, color } : { id: raw.id, name });
    }
    if (!sameFolders(folders, nextFolders)) {
      folders = nextFolders;
      changed = true;
    }
    // Prune any inFolder entries referencing removed folder IDs (zero orphans).
    for (const [k, fid] of Object.entries(inFolder)) {
      if (!seenIds.has(fid)) delete inFolder[k];
    }
  }
  const folderIds = new Set(folders.map((f) => f.id));
  if (p.inFolder !== undefined) {
    if (!isObject(p.inFolder)) throw new ArrangementError(400, "malformed");
    for (const [key, fid] of Object.entries(p.inFolder)) {
      if (!isSessionKey(key)) throw new ArrangementError(400, "malformed");
      if (fid === null) {
        if (has(inFolder, key)) delete inFolder[key];
        continue;
      }
      if (typeof fid !== "string") throw new ArrangementError(400, "malformed");
      if (!folderIds.has(fid)) throw new ArrangementError(400, "bad_folder");
      if (!known(key)) throw new ArrangementError(404, "not_found");
      inFolder[key] = fid;
    }
    if (Object.keys(inFolder).length > ARRANGEMENT_PLACED_MAX) throw new ArrangementError(413, "too_many");
  }
  // A pinned or nested session never coexists with custom folder membership.
  const pinSet = new Set(pinned);
  for (const k of Object.keys(inFolder)) {
    if (pinSet.has(k) || (has(placed, k) && placed[k] !== null)) delete inFolder[k];
  }
  if (!sameInFolder(doc.inFolder, inFolder)) changed = true;
  return changed ? buildDoc(doc.rev + 1, placed, pinned, folders, inFolder) : doc;
}

/** The arrangement once the store forgot `key`: its own placement, its pin and its folder
 *  membership go (as its label does); a placement under it stays, inert, and works again
 *  if it comes back. */
export function forgetInArrangement(doc: Arrangement, key: SessionKey): Arrangement {
  const pinnedHere = doc.pinned.includes(key);
  const inFolderHere = !!doc.inFolder && has(doc.inFolder, key);
  if (!has(doc.placed, key) && !pinnedHere && !inFolderHere) return doc;
  const placed = { ...doc.placed };
  delete placed[key];
  const inFolder = { ...(doc.inFolder ?? {}) };
  delete inFolder[key];
  return buildDoc(
    doc.rev + 1,
    placed,
    pinnedHere ? doc.pinned.filter((k) => k !== key) : doc.pinned,
    doc.folders ? doc.folders.map((f) => ({ ...f })) : [],
    inFolder,
  );
}

/** What was kept, read back: entries that do not hold to the rules are dropped (a broken
 *  key, a session under itself, a loop, an invalid or orphan folder, past the caps), never
 *  the whole document. */
export function cleanArrangement(raw: unknown): Arrangement {
  const r = isObject(raw) ? raw : {};
  const rev = typeof r.rev === "number" && Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  const placed: Record<SessionKey, SessionKey | null> = {};
  if (isObject(r.placed))
    for (const [child, parent] of Object.entries(r.placed)) {
      if (Object.keys(placed).length >= ARRANGEMENT_PLACED_MAX) break;
      if (!isSessionKey(child) || (parent !== null && (!isSessionKey(parent) || parent === child))) continue;
      placed[child] = parent;
      if (placedLoop(placed, child)) delete placed[child];
    }
  const pinned = Array.isArray(r.pinned)
    ? [...new Set(r.pinned.filter(isSessionKey))].slice(0, ARRANGEMENT_PINNED_MAX)
    : [];
  const folders: ArrangementFolder[] = [];
  const folderIds = new Set<string>();
  if (Array.isArray(r.folders)) {
    for (const item of r.folders) {
      if (folders.length >= ARRANGEMENT_FOLDERS_MAX) break;
      if (!isObject(item)) continue;
      if (typeof item.id !== "string" || !FOLDER_ID_RE.test(item.id) || folderIds.has(item.id)) continue;
      if (typeof item.name !== "string") continue;
      const name = sanitizeFolderName(item.name);
      if (name.length < 1 || name.length > ARRANGEMENT_FOLDER_NAME_MAX) continue;
      const color = typeof item.color === "string" && COLORS.has(item.color) ? (item.color as LabelColor) : undefined;
      folderIds.add(item.id);
      folders.push(color !== undefined ? { id: item.id, name, color } : { id: item.id, name });
    }
  }
  const pinSet = new Set(pinned);
  const inFolder: Record<SessionKey, string> = {};
  if (isObject(r.inFolder)) {
    for (const [key, fid] of Object.entries(r.inFolder)) {
      if (Object.keys(inFolder).length >= ARRANGEMENT_PLACED_MAX) break;
      if (!isSessionKey(key) || typeof fid !== "string" || !folderIds.has(fid)) continue;
      if (pinSet.has(key) || (has(placed, key) && placed[key] !== null)) continue;
      inFolder[key] = fid;
    }
  }
  return buildDoc(rev, placed, pinned, folders, inFolder);
}
