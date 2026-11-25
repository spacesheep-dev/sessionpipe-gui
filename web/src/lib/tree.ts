// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The one session tree: which session is drawn under which, for the Board
// and the sidebar alike (pages/Board.tsx, components/SessionTree.tsx). It starts from what
// the sessions' own events say and then lays the person's arrangement over it
// (shared/api.ts Arrangement), and it is pure: the same sessions and arrangement always
// give the same tree.
//
// What the events say: a subagent's own session (`parentId`) hangs under its parent while
// the list holds that parent; a session another one asked (`delegatedBy`) hangs under the
// asking session when that one is drawn on this surface and runs on the same computer
// (lib/delegated.ts askedBy); a surface may refuse a parent for its own reasons
// (`hangs`: the Board's folded Done). What the person says wins over that: a placement
// puts a session under another (`placed[child] = parent`) whatever their computers, or at
// the top level (`null`); a pinned session is always at the top level, in the sidebar's
// Pinned group. A placement whose parent is not drawn here (gone, hidden, filtered off) is
// kept and does nothing: the child is at the top level. A loop (the events and the
// placements disagree) is cut where the events made it, and a loop of the person's own
// (which the receiver refuses) nests nobody. The tree is drawn four levels deep; what is
// deeper is drawn at the fourth, after its ancestor there. Nothing ever leaves the tree.
//
// The arrangement is display only. It is never sent to a machine, it changes nothing a
// session's events say, and it lets no session reach another (`placed` on a node is how
// the surfaces say so: "Placed here by you").
import type { Arrangement, SessionKey, SessionState, SessionSummary } from "@shared/api";
import { bySectionThenRecent, byStateThenRecent } from "../data/hooks";
import { askedBy, sectionOf } from "./delegated";

/** How many levels the tree draws; a deeper session is drawn at the last. */
export const TREE_LEVELS = 4;

export interface TreeNode {
  s: SessionSummary;
  /** 0 at the top level, at most TREE_LEVELS - 1. */
  level: number;
  /** The sessions drawn under it, newest first within each state (the Board's kids' order). */
  kids: TreeNode[];
  /** The session it is drawn under, when it is drawn under one. */
  parent?: SessionKey;
  /** Under its parent because the person put it there, not because its events say so. */
  placed: boolean;
}

export interface Tree {
  /** The top level, in the Board's order: by the section a row is drawn in (a row a
   *  session under it needs you for is in Needs you), then the newest started. Pinned
   *  sessions are among them. */
  roots: TreeNode[];
  /** Every session's node, by key. */
  nodes: ReadonlyMap<SessionKey, TreeNode>;
  /** Each top-level session's sessions at every depth, flattened in the Board's kids'
   *  order: what a Board row draws under it. */
  childrenOf: ReadonlyMap<SessionKey, SessionSummary[]>;
  /** The section each top-level row is drawn in. */
  sectionOf: (s: SessionSummary) => SessionState;
}

export interface TreeInput {
  /** The sessions the list holds (data/hooks.ts useSessionTree `all`). */
  all: readonly SessionSummary[];
  arrangement: Pick<Arrangement, "placed" | "pinned">;
  /** Whether a session is drawn on this surface, so that one asked by it or placed under
   *  it may hang there (the filters, hidden on this device). Default: all are. */
  drawn?: (p: SessionSummary) => boolean;
  /** A surface's own refusal of a parent for a child it would otherwise hold (the Board's
   *  folded Done, lib/delegated.ts foldsAway). Default: none. */
  hangs?: (child: SessionSummary, parent: SessionSummary) => boolean;
  /** Whether a session under a row lifts that row into Needs you (the Board's needsHere). */
  needs?: (s: SessionSummary) => boolean;
}

const yes = () => true;
const no = () => false;

/** The session its events hang `s` under here, or undefined. */
function realParent(
  s: SessionSummary,
  byKey: ReadonlyMap<SessionKey, SessionSummary>,
  drawn: (p: SessionSummary) => boolean,
  hangs: (c: SessionSummary, p: SessionSummary) => boolean,
): SessionKey | undefined {
  if (s.parentId) {
    const pk: SessionKey = `${s.harness}:${s.parentId}`;
    if (pk !== s.key && byKey.has(pk)) return pk;
  }
  if (s.delegatedBy && s.delegatedBy !== s.key) {
    const p = byKey.get(s.delegatedBy);
    if (p && askedBy(s, p) && drawn(p) && hangs(s, p)) return p.key;
  }
  return undefined;
}

/** The parent `s` would have by its events alone on a surface that draws every session:
 *  what "Move to top level" and a drop at the top level undo (lib/arrange.ts). */
export function eventParent(s: SessionSummary, all: readonly SessionSummary[]): SessionKey | undefined {
  return realParent(s, new Map(all.map((x) => [x.key, x])), yes, yes);
}

export function arrangeTree(input: TreeInput): Tree {
  const drawn = input.drawn ?? yes;
  const hangs = input.hangs ?? yes;
  const needs = input.needs ?? no;
  const { placed, pinned } = input.arrangement;
  const pins = new Set(pinned);
  const byKey = new Map(input.all.map((s) => [s.key, s]));

  // Each session's parent here, and whether the person made it.
  const parent = new Map<SessionKey, { key: SessionKey; placed: boolean }>();
  for (const s of input.all) {
    if (pins.has(s.key)) continue;
    if (Object.hasOwn(placed, s.key)) {
      const pk = placed[s.key];
      const p = pk ? byKey.get(pk) : undefined;
      if (p && p.key !== s.key && drawn(p) && hangs(s, p)) parent.set(s.key, { key: p.key, placed: true });
      continue;
    }
    const pk = realParent(s, byKey, drawn, hangs);
    if (pk) parent.set(s.key, { key: pk, placed: false });
  }

  // Loops: cut where the events made them; a loop of placements alone nests nobody.
  for (const s of input.all) {
    const path: SessionKey[] = [];
    const on = new Set<SessionKey>();
    for (let cur: SessionKey | undefined = s.key; cur; cur = parent.get(cur)?.key) {
      if (on.has(cur)) {
        const loop = path.slice(path.indexOf(cur));
        const made = loop.filter((k) => !parent.get(k)?.placed);
        for (const k of made.length ? made : loop) parent.delete(k);
        break;
      }
      on.add(cur);
      path.push(cur);
    }
  }

  const kidsOf = new Map<SessionKey, SessionSummary[]>();
  for (const s of input.all) {
    const p = parent.get(s.key);
    if (!p) continue;
    const list = kidsOf.get(p.key) ?? [];
    list.push(s);
    kidsOf.set(p.key, list);
  }
  for (const list of kidsOf.values()) list.sort(byStateThenRecent);

  const nodes = new Map<SessionKey, TreeNode>();
  const node = (s: SessionSummary, level: number): TreeNode => {
    const p = parent.get(s.key);
    const n: TreeNode = { s, level, kids: [], placed: !!p?.placed, ...(p ? { parent: p.key } : {}) };
    nodes.set(s.key, n);
    return n;
  };
  /** `n`'s kids, and theirs; past the last level each is drawn at it, after its ancestor. */
  const grow = (n: TreeNode): void => {
    for (const k of kidsOf.get(n.s.key) ?? []) {
      if (n.level + 1 < TREE_LEVELS - 1) {
        const kid = node(k, n.level + 1);
        n.kids.push(kid);
        grow(kid);
      } else {
        // The last level: the kid and everything under it, in order, side by side.
        const flat = (x: SessionSummary): void => {
          n.kids.push(node(x, TREE_LEVELS - 1));
          for (const y of kidsOf.get(x.key) ?? []) flat(y);
        };
        flat(k);
      }
    }
  };
  const tops = input.all.filter((s) => !parent.has(s.key)).map((s) => node(s, 0));
  for (const t of tops) grow(t);

  const childrenOf = new Map<SessionKey, SessionSummary[]>();
  for (const t of tops) {
    const all: SessionSummary[] = [];
    const walk = (n: TreeNode) => {
      for (const k of n.kids) {
        all.push(k.s);
        walk(k);
      }
    };
    walk(t);
    if (all.length) childrenOf.set(t.s.key, all.sort(byStateThenRecent));
  }
  const section = (s: SessionSummary) => sectionOf(s, childrenOf.get(s.key), needs);
  tops.sort((a, b) => bySectionThenRecent(section)(a.s, b.s));
  return { roots: tops, nodes, childrenOf, sectionOf: section };
}

/** How loud a session is, as the sidebar's lamp tells it: what needs you, then what works,
 *  then what is quiet, then news unread, then nothing. */
export type Loud = "needs_you" | "working" | "stale" | "unread" | "none";
const LOUD_RANK: Record<Loud, number> = { needs_you: 4, working: 3, stale: 2, unread: 1, none: 0 };
export const louder = (a: Loud, b: Loud): Loud => (LOUD_RANK[b] > LOUD_RANK[a] ? b : a);

/** A session's own loudness. */
export function loudOf(s: SessionSummary, unread: (s: SessionSummary) => boolean): Loud {
  if (s.state === "needs_you" || s.state === "working" || s.state === "stale") return s.state;
  return unread(s) ? "unread" : "none";
}

/** What is under a row, rolled up: the loudest of the sessions under it, and how many
 *  there are of each kind (each counted once, at any depth). */
export interface Rolled {
  /** The loudest of the sessions under it (not itself). */
  loud: Loud;
  inside: number;
  needs: number;
  working: number;
  stale: number;
  unread: number;
}

/** One post-order walk over the tree: per session, what is under it (rolled up). `drawn`
 *  leaves out sessions this surface does not draw (hidden here), and everything under them. */
export function rollUp(
  roots: readonly TreeNode[],
  o: { unread: (s: SessionSummary) => boolean; drawn?: (s: SessionSummary) => boolean },
): Map<SessionKey, Rolled> {
  const drawn = o.drawn ?? (() => true);
  const out = new Map<SessionKey, Rolled>();
  const walk = (n: TreeNode): Rolled => {
    const r: Rolled = { loud: "none", inside: 0, needs: 0, working: 0, stale: 0, unread: 0 };
    for (const k of n.kids) {
      if (!drawn(k.s)) continue;
      const own = loudOf(k.s, o.unread);
      const below = walk(k);
      r.inside += 1 + below.inside;
      r.needs += below.needs + (own === "needs_you" ? 1 : 0);
      r.working += below.working + (own === "working" ? 1 : 0);
      r.stale += below.stale + (own === "stale" ? 1 : 0);
      r.unread += below.unread + (own === "unread" ? 1 : 0);
      r.loud = louder(louder(r.loud, own), below.loud);
    }
    out.set(n.s.key, r);
    return r;
  };
  for (const r of roots) walk(r);
  return out;
}

/** Whether a row is drawn with the computer mark: its session runs on another computer
 *  than the session it hangs under. A top-level row (a pinned one too) never is: its
 *  computer is in its tooltip. */
export function runsElsewhere(tree: Pick<Tree, "nodes">, key: SessionKey): boolean {
  const n = tree.nodes.get(key);
  const up = n?.parent ? tree.nodes.get(n.parent)?.s : undefined;
  return !!n && !!up && !!n.s.machine && !!up.machine && n.s.machine !== up.machine;
}

/** Every session drawn under `key`, at any depth (the drops it may not take). */
export function descendants(tree: Pick<Tree, "nodes">, key: SessionKey): Set<SessionKey> {
  const kids = new Map<SessionKey, SessionKey[]>();
  for (const n of tree.nodes.values())
    if (n.parent) {
      const list = kids.get(n.parent) ?? [];
      list.push(n.s.key);
      kids.set(n.parent, list);
    }
  const out = new Set<SessionKey>();
  const todo = [...(kids.get(key) ?? [])];
  for (let k = todo.pop(); k !== undefined; k = todo.pop()) {
    if (out.has(k) || k === key) continue;
    out.add(k);
    todo.push(...(kids.get(k) ?? []));
  }
  return out;
}
