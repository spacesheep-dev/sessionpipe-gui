// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The person arranging the session tree: what a move means (planMove,
// pure: the change to the arrangement, the change that undoes it, and its words), doing it
// (arrange: shown at once, kept on the receiver, a toast with Undo, said aloud), and the
// items every session's menu carries (arrangeItems: Pin or Unpin, Move under…, Move to
// top level, Move up and down among the pinned). A drag (components/SessionTree.tsx), a
// key and a menu all come here, so they can do the same things and say them the same way.
//
// None of it is sent to a machine: it moves rows on this person's screens, and nothing a
// session's events say (lib/tree.ts).
import {
  type Arrangement,
  type ArrangementPatch,
  isEmptySession,
  type SessionKey,
  type SessionSummary,
} from "@shared/api";
import type { MenuList } from "../components/ContextMenu";
import type { AppState, Store } from "../data/store";
import { sessionTitle } from "./format";
import { hiddenNow } from "./hidden";
import { pushToast, pushUndo } from "./toasts";
import { arrangeTree, descendants, eventParent, type Tree } from "./tree";

/** Where a session is moved. */
export type Move =
  /** Under another session. */
  | { kind: "under"; parent: SessionKey }
  /** To the top level of Sessions (out of Pinned too). */
  | { kind: "top" }
  /** Into Pinned, or to another place in it: before the pin now at `at` (the end without). */
  | { kind: "pin"; at?: number }
  | { kind: "unpin" };

export interface Plan {
  patch: ArrangementPatch;
  /** The change that puts it back as it was. */
  undo: ArrangementPatch;
  /** The toast's words: "Moved under Fix the login form". */
  said: string;
  /** What a screen reader hears: "Write the tests moved under Fix the login form." */
  spoken: string;
}

const has = (o: object, k: string) => Object.hasOwn(o, k);

/** What moving `key` means, or null when it means nothing (where it already is) or may
 *  not be done (under itself or one of its own sessions). `tree` is the tree drawn now. */
export function planMove(
  arr: Pick<Arrangement, "placed" | "pinned">,
  tree: Pick<Tree, "nodes">,
  all: readonly SessionSummary[],
  key: SessionKey,
  move: Move,
  title: (key: SessionKey) => string,
): Plan | null {
  const s = all.find((x) => x.key === key);
  const node = tree.nodes.get(key);
  if (!s || !node) return null;
  const pinned = arr.pinned.includes(key);
  const unpinned = arr.pinned.filter((k) => k !== key);
  const events = eventParent(s, all);
  const name = title(key);
  // The placement's half of a change, and of its undo.
  const place = (to: SessionKey | null | "follow"): Pick<Plan, "patch" | "undo"> => {
    const was = has(arr.placed, key) ? arr.placed[key]! : ("follow" as const);
    if (was === to) return { patch: {}, undo: {} };
    return {
      patch: to === "follow" ? { follow: [key] } : { placed: { [key]: to } },
      undo: was === "follow" ? { follow: [key] } : { placed: { [key]: was } },
    };
  };
  const pins = (next: SessionKey[]): Pick<Plan, "patch" | "undo"> =>
    next.length === arr.pinned.length && next.every((k, i) => k === arr.pinned[i])
      ? { patch: {}, undo: {} }
      : { patch: { pinned: next }, undo: { pinned: [...arr.pinned] } };
  const join = (...parts: Pick<Plan, "patch" | "undo">[]) => ({
    patch: Object.assign({}, ...parts.map((p) => p.patch)) as ArrangementPatch,
    undo: Object.assign({}, ...parts.map((p) => p.undo)) as ArrangementPatch,
  });
  const none = (): Pick<Plan, "patch" | "undo"> => ({ patch: {}, undo: {} });
  const empty = (p: ArrangementPatch) => Object.keys(p).length === 0;
  let change: Pick<Plan, "patch" | "undo">;
  let said: string;
  let spoken: string;
  switch (move.kind) {
    case "under": {
      const to = move.parent;
      if (to === key || descendants(tree, key).has(to) || !tree.nodes.has(to)) return null;
      if (node.parent === to && !pinned) return null;
      // Back under the session its events name: it follows them again.
      change = join(place(events === to ? "follow" : to), pinned ? pins(unpinned) : none());
      said = `Moved under ${title(to)}`;
      spoken = `${name} moved under ${title(to)}.`;
      break;
    }
    case "top": {
      if (!pinned && !node.parent) return null;
      // Whether it would hang under a session out of Pinned: then it is placed at the top.
      const hangs = has(arr.placed, key) ? arr.placed[key] !== null : !!events;
      const onlyPin = pinned && !hangs;
      change = join(hangs ? place(events ? null : "follow") : none(), pinned ? pins(unpinned) : none());
      said = onlyPin ? "Unpinned" : "Moved to the top level";
      spoken = onlyPin ? `${name} unpinned.` : `${name} moved to the top level.`;
      break;
    }
    case "pin": {
      // `at` counts the pins as drawn, this one among them: past its own place, one less.
      const from = arr.pinned.indexOf(key);
      const raw = move.at ?? arr.pinned.length;
      const i = Math.max(0, Math.min(from >= 0 && raw > from ? raw - 1 : raw, unpinned.length));
      change = pins([...unpinned.slice(0, i), key, ...unpinned.slice(i)]);
      said = pinned ? "Moved in Pinned" : "Pinned";
      spoken = pinned ? `${name} moved in Pinned.` : `${name} pinned.`;
      break;
    }
    case "unpin": {
      if (!pinned) return null;
      change = pins(unpinned);
      said = "Unpinned";
      spoken = `${name} unpinned.`;
      break;
    }
  }
  if (empty(change.patch)) return null;
  return { ...change, said, spoken };
}

/** The sessions the tree is made of: those the list holds (an empty one is not), less
 *  none; and the tree as the sidebar draws it (a parent hidden on this device holds no
 *  session it was asked by or placed under). */
export function personTree(state: Pick<AppState, "sessions" | "arrangement">): {
  all: SessionSummary[];
  tree: Tree;
} {
  const all = [...state.sessions.values()].filter((s) => !isEmptySession(s));
  const tree = arrangeTree({
    all,
    arrangement: state.arrangement,
    drawn: (p) => !hiddenNow(p),
    needs: (c) => c.state === "needs_you" && !hiddenNow(c),
  });
  return { all, tree };
}

// ----- what is said, for the tree's live region -----

/** What a move was, for the tree to show its result (unfold the parent it went under). */
export interface Arranged {
  key: SessionKey;
  move: Move;
}
const spokenListeners = new Set<(words: string, what?: Arranged) => void>();
/** The sidebar's tree says what a move did through its live region (SessionTree.tsx), and
 *  opens what the move put the row under. */
export function onArranged(l: (words: string, what?: Arranged) => void): () => void {
  spokenListeners.add(l);
  return () => {
    spokenListeners.delete(l);
  };
}

/** Why a change was not kept, in words. */
const refusal = (reason: string): string =>
  reason === "too_many" ? "Not saved: that is more than the receiver keeps" : "Not saved. Try again.";

/** Moves `key` as asked: shown at once, kept on the receiver, a toast with Undo, and said.
 *  False when the move means nothing or may not be done. */
export function arrange(store: Store, key: SessionKey, move: Move): boolean {
  const state = store.get();
  const { all, tree } = personTree(state);
  const title = (k: SessionKey) => {
    const s = state.sessions.get(k);
    return s ? sessionTitle(s) : "a session";
  };
  const plan = planMove(state.arrangement, tree, all, key, move, title);
  if (!plan) return false;
  store.patchArrangement(plan.patch).catch((e: Error) => {
    pushToast({
      id: `arrange-failed|${key}`,
      kind: "error",
      sticky: false,
      session: key,
      title: refusal(e.message),
      label: "error",
      at: Date.now(),
    });
  });
  // One way back at a time: a newer move takes the older one's toast (its undo is the one
  // that matches what is drawn now).
  pushUndo({
    id: "arrange",
    title: plan.said,
    session: key,
    undo: () => {
      void store.patchArrangement(plan.undo).catch(() => {});
      for (const l of spokenListeners) l(`Undone. ${title(key)} is back where it was.`);
    },
  });
  for (const l of spokenListeners) l(plan.spoken, { key, move });
  return true;
}

// ----- Move under…: the picker -----

const pickListeners = new Set<(key: SessionKey) => void>();
/** Opens the "Move under…" picker for `key` (components/MoveUnder.tsx, mounted once). */
export function requestMoveUnder(key: SessionKey): void {
  for (const l of pickListeners) l(key);
}
export function onMoveUnder(l: (key: SessionKey) => void): () => void {
  pickListeners.add(l);
  return () => {
    pickListeners.delete(l);
  };
}

/** The sessions `key` may be moved under: every one the tree holds but itself, the
 *  sessions under it and the one it is under now, in the tree's order (top to bottom, as
 *  the sidebar draws it). */
export function moveTargets(tree: Tree, key: SessionKey): SessionSummary[] {
  const not = descendants(tree, key);
  const now = tree.nodes.get(key)?.parent;
  const out: SessionSummary[] = [];
  const walk = (n: Tree["roots"][number]) => {
    if (n.s.key !== key && n.s.key !== now && !not.has(n.s.key)) out.push(n.s);
    for (const k of n.kids) walk(k);
  };
  for (const r of tree.roots) walk(r);
  return out;
}

// ----- the menu items -----

/** Pin or Unpin; Move under…; Move to top level where it is under a session; Move up and
 *  Move down among the pinned. For every session's menu, on every surface (lib/menus.ts). */
export function arrangeItems(s: SessionSummary, store: Store): MenuList {
  const state = store.get();
  if (isEmptySession(s)) return [];
  const { tree } = personTree(state);
  const node = tree.nodes.get(s.key);
  const pins = state.arrangement.pinned;
  const at = pins.indexOf(s.key);
  const pinned = at >= 0;
  return [
    pinned
      ? { label: "Unpin", run: () => void arrange(store, s.key, { kind: "unpin" }) }
      : { label: "Pin", run: () => void arrange(store, s.key, { kind: "pin" }) },
    pinned && at > 0 && { label: "Move up", run: () => void arrange(store, s.key, { kind: "pin", at: at - 1 }) },
    pinned &&
      at < pins.length - 1 && {
        label: "Move down",
        run: () => void arrange(store, s.key, { kind: "pin", at: at + 2 }),
      },
    !!node && moveTargets(tree, s.key).length > 0 && { label: "Move under…", run: () => requestMoveUnder(s.key) },
    !!node?.parent && { label: "Move to top level", run: () => void arrange(store, s.key, { kind: "top" }) },
  ];
}
