// SPDX-License-Identifier: Apache-2.0
// The person's arrangement of the session tree (api.ts Arrangement): the rules a change
// is held to. The receiver keeps it (server/ui/arrangementCore.ts), a page on a spacesheep
// account keeps it by the same code, and a page applies a change with it before the
// answer comes (web/src/data/store.ts). It is display only: nothing here is ever sent to
// a machine, and nothing here changes what a session's own events say.
import {
  ARRANGEMENT_PINNED_MAX,
  ARRANGEMENT_PLACED_MAX,
  type Arrangement,
  type ArrangementPatch,
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

const FIELDS = new Set<string>(["placed", "follow", "pinned"]);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o: object, k: string) => Object.hasOwn(o, k);

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
 *  not in the store's shape, a pin twice, a key both placed and followed), 400
 *  `bad_place` (a session under itself, or a loop of placements), 404 `not_found` (a
 *  session `known` says the store does not hold: placing it, under it, or pinning it), 413
 *  `too_many` (over ARRANGEMENT_PLACED_MAX placements or ARRANGEMENT_PINNED_MAX pins).
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
  return changed ? { rev: doc.rev + 1, placed, pinned } : doc;
}

/** The arrangement once the store forgot `key`: its own placement and its pin go (as its
 *  label does); a placement under it stays, inert, and works again if it comes back. */
export function forgetInArrangement(doc: Arrangement, key: SessionKey): Arrangement {
  const pinnedHere = doc.pinned.includes(key);
  if (!has(doc.placed, key) && !pinnedHere) return doc;
  const placed = { ...doc.placed };
  delete placed[key];
  return { rev: doc.rev + 1, placed, pinned: pinnedHere ? doc.pinned.filter((k) => k !== key) : doc.pinned };
}

/** What was kept, read back: entries that do not hold to the rules are dropped (a broken
 *  key, a session under itself, a loop, past the caps), never the whole document. */
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
  return { rev, placed, pinned };
}
