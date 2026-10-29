// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Where a session another one asked goes on the board (`delegatedBy`:
// sessionpipe ask, a handoff): under the asking session, the way a subagent nests, as
// long as that session is drawn as a root. A chain of asks (A asked B, B asked C: the
// daemon allows one nested ask) hangs every link under the top of the chain, since a kid
// row draws no kids of its own; a loop in the hooks' say-so (A says B, B says A) nests
// nobody, since neither would be drawn; a parent off the board (another machine, a
// filter, a subagent's child session) ends the climb where it is. Nothing vanishes.
import type { SessionKey, SessionSummary } from "@shared/api";

/** Whether a parent drawn in a folded Done would take the child out of sight: the parent
 *  is done and Done is folded while the child still runs or needs you. A done child under
 *  a done parent folds with it, as a subagent's row does. */
export const foldsAway = (
  child: Pick<SessionSummary, "state">,
  parent: Pick<SessionSummary, "state">,
  showDone: boolean,
): boolean => parent.state === "done" && !showDone && child.state !== "done";

export interface Nested {
  /** The sessions drawn as roots, in the order given. */
  roots: SessionSummary[];
  /** The asked sessions under each root, in the order given. */
  nested: Map<SessionKey, SessionSummary[]>;
}

/** `roots` with the asked ones moved under the session that asked them. `hangs(child,
 *  parent)` says whether a child may hang under that parent at all (the same machine, the
 *  parent shown): the last parent it may hang under is where it goes. */
export function nestDelegated(
  roots: readonly SessionSummary[],
  all: readonly SessionSummary[],
  hangs: (child: SessionSummary, parent: SessionSummary) => boolean,
): Nested {
  const rootKeys = new Set(roots.map((s) => s.key));
  const byKey = new Map(all.map((s) => [s.key, s]));
  /** The root `s` hangs under, or undefined when it is drawn as one itself. */
  const anchorOf = (s: SessionSummary): SessionSummary | undefined => {
    let top: SessionSummary | undefined;
    const seen = new Set<SessionKey>([s.key]);
    for (let cur = s; cur.delegatedBy; ) {
      const parent = byKey.get(cur.delegatedBy);
      if (!parent || !rootKeys.has(parent.key) || !hangs(s, parent)) break;
      // A loop: nobody in it is drawn as a root, so nobody hangs.
      if (seen.has(parent.key)) return undefined;
      seen.add(parent.key);
      top = parent;
      cur = parent;
    }
    return top;
  };
  const anchors = new Map(roots.map((s) => [s.key, anchorOf(s)]));
  const out: SessionSummary[] = [];
  const nested = new Map<SessionKey, SessionSummary[]>();
  for (const s of roots) {
    // The anchor must be drawn as a root itself: one that hangs elsewhere (its chain ended
    // at a parent this child may not hang under) is no anchor; the child stays a root.
    const anchor = anchors.get(s.key);
    if (!anchor || anchors.get(anchor.key)) {
      out.push(s);
      continue;
    }
    const list = nested.get(anchor.key) ?? [];
    list.push(s);
    nested.set(anchor.key, list);
  }
  return { roots: out, nested };
}
