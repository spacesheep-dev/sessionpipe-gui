// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Where a session another one asked goes on the board (`delegatedBy`:
// sessionpipe ask, a handoff): under the asking session, the way a subagent nests, as
// long as that session is drawn as a root. A chain of asks (A asked B, B asked C: the
// daemon allows one nested ask) hangs every link under the top of the chain, since a kid
// row draws no kids of its own; a loop in the hooks' say-so (A says B, B says A) nests
// nobody, since neither would be drawn; a parent off the board (another machine, a
// filter, a subagent's child session) ends the climb where it is. Nothing vanishes.
// A child that needs you takes its parent's row into Needs you (`sectionOf`), and that
// section counts sessions, a child under its parent included (`waitingIn`): the number
// the Inbox badge has. And which sessions a session's page lists as the ones it asked
// (AskedSessions).
import type { SessionKey, SessionState, SessionSummary } from "@shared/api";

/** Whether `child` names `parent` as the session that asked it (`delegatedBy`) on the
 *  same machine: the daemon only ever asks there, so a child naming a parent elsewhere is
 *  a hook's say-so, not lineage. The board nests by it, a page lists by it, the Inbox says
 *  "for" by it; a later stage that asks across computers widens this one test. */
export const askedBy = (
  child: Pick<SessionSummary, "delegatedBy" | "machine">,
  parent: Pick<SessionSummary, "key" | "machine">,
): boolean => child.delegatedBy === parent.key && child.machine === parent.machine;

/** Whether a parent drawn in a folded Done would take the child out of sight: the parent
 *  is done and Done is folded while the child still runs or needs you. A done child under
 *  a done parent folds with it, as a subagent's row does. A child that `needs` you (the
 *  test sectionOf is given) never does: it lifts its parent into Needs you, so it stays
 *  under it whether Done is folded or not. */
export const foldsAway = <C extends Pick<SessionSummary, "state">>(
  child: C,
  parent: Pick<SessionSummary, "state">,
  showDone: boolean,
  needs: (child: C) => boolean = () => false,
): boolean => parent.state === "done" && !showDone && child.state !== "done" && !needs(child);

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

/** The section a row is drawn in: its own state's, or Needs you while a session under it
 *  (`kids`: its subagents' sessions and the ones it asked) `needs` you. The row keeps its
 *  own words and lamp; it is there for its child. */
export const sectionOf = (
  s: SessionSummary,
  kids: readonly SessionSummary[] | undefined,
  needs: (kid: SessionSummary) => boolean,
): SessionState => (s.state !== "needs_you" && kids?.some(needs) ? "needs_you" : s.state);

/** How many sessions the rows of Needs you hold that `wait` on you: each row's own and each
 *  one under it, every session once. */
export function waitingIn(
  rows: readonly SessionSummary[],
  kidsOf: (s: SessionSummary) => readonly SessionSummary[] | undefined,
  wait: (s: SessionSummary) => boolean,
): number {
  const counted = new Set<SessionKey>();
  for (const s of rows) for (const x of [s, ...(kidsOf(s) ?? [])]) if (wait(x)) counted.add(x.key);
  return counted.size;
}

// ----- a session's page: the sessions it asked -----

/** How many asked sessions a page lists before "Show all n". */
export const ASKED_SHOWN = 5;

/** The sessions `parent` asked or started, as its page lists them: the ones its
 *  delegations name (`to`, on any machine), and the ones that name it as the session they
 *  were started for (`delegatedBy`, on its machine: askedBy) or launched by
 *  (`launchedBy`). A subagent's own session
 *  (`parentId`) is its subagent, listed with the turn that ran it, not here; a session
 *  the store does not hold has its row in the turn that asked (AskRow). One level: the
 *  sessions a child asked are on the child's page. Those that need you first, then the
 *  newest started; each once. */
export function askedSessions(
  parent: Pick<SessionSummary, "key" | "machine" | "delegations">,
  all: Iterable<SessionSummary>,
): SessionSummary[] {
  const asked = new Set((parent.delegations ?? []).map((d) => d.to).filter((k): k is SessionKey => !!k));
  const out: SessionSummary[] = [];
  for (const s of all)
    if (s.key !== parent.key && (asked.has(s.key) || askedBy(s, parent) || s.launchedBy === parent.key)) out.push(s);
  return out.sort(
    (a, b) =>
      Number(b.state === "needs_you") - Number(a.state === "needs_you") ||
      b.startedAt.localeCompare(a.startedAt) ||
      a.key.localeCompare(b.key),
  );
}

/** The rows a list shows: the first `max`, or every one that needs you when more do, or
 *  all of them once "Show all" was pressed; `more` is how many are left out. */
export function askedShown<T extends Pick<SessionSummary, "state">>(
  list: readonly T[],
  all: boolean,
  max = ASKED_SHOWN,
): { shown: T[]; more: number } {
  const n = all ? list.length : Math.max(max, list.filter((s) => s.state === "needs_you").length);
  const shown = list.slice(0, n);
  return { shown, more: list.length - shown.length };
}

/** The session `s` works for, when `get` holds it: the one that asked it (`delegatedBy`,
 *  on its machine: askedBy), whose subagent it is (`parentId`), or that launched it
 *  (`launchedBy`), in that order.
 *  Undefined for a session of its own, or one whose parent is not known here. */
export function parentOf(
  s: Pick<SessionSummary, "key" | "harness" | "machine" | "delegatedBy" | "parentId" | "launchedBy">,
  get: (key: SessionKey) => SessionSummary | undefined,
): SessionSummary | undefined {
  const keys = [s.delegatedBy, s.parentId && (`${s.harness}:${s.parentId}` as SessionKey), s.launchedBy];
  for (const [i, k] of keys.entries()) {
    const p = k && k !== s.key ? get(k) : undefined;
    if (p && (i > 0 || askedBy(s, p))) return p;
  }
  return undefined;
}

/** The computer a child session runs on, always named (a later stage runs one on another
 *  computer, and its row must say where), also when it is its parent's own: the page's
 *  list of asked sessions, and a child's row under its parent on the board. */
export const askedComputer = (s: Pick<SessionSummary, "machine">): string => s.machine?.trim() || "Unknown computer";
