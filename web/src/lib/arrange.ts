// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The person arranging the session tree: what a move means (planMove,
// pure: the change to the arrangement, the change that undoes it, and its words), doing it
// (arrange: shown at once, kept on the receiver, a toast with Undo, said aloud), custom
// folder CRUD (create, rename, recolor, reorder, delete, all with Undo), and the items
// every session's menu carries (arrangeItems: Pin or Unpin, Move to folder, Move under…,
// Move to top level, Move up and down among the pinned). A drag (components/SessionTree.tsx),
// a key and a menu all come here, so they can do the same things and say them the same way.
//
// None of it is sent to a machine: it moves rows on this person's screens, and nothing a
// session's events say (lib/tree.ts).
import {
  ARRANGEMENT_FOLDER_NAME_MAX,
  ARRANGEMENT_FOLDERS_MAX,
  type Arrangement,
  type ArrangementFolder,
  type ArrangementPatch,
  isEmptySession,
  type LabelColor,
  type SessionKey,
  type SessionSummary,
} from "@shared/api";
import { sanitizeFolderName } from "@shared/arrangement";
import type { MenuList } from "../components/ContextMenu";
import type { AppState, Store } from "../data/store";
import { phoneLayout, sizeClass } from "./device";
import { sessionTitle } from "./format";
import { hiddenNow } from "./hidden";
import { calmNextCommit } from "./motion";
import { pushToast, pushUndo } from "./toasts";
import { arrangeTree, descendants, eventParent, type Tree } from "./tree";

/** Where a session is moved. */
export type Move =
  /** Under another session. */
  | { kind: "under"; parent: SessionKey }
  /** To the top level of Sessions (out of Pinned and out of any custom folder too). */
  | { kind: "top" }
  /** Into Pinned, or to another place in it: before the pin now at `at` (the end without). */
  | { kind: "pin"; at?: number }
  | { kind: "unpin" }
  /** Into a custom folder (promotes a child to root inside that folder; unpins if pinned). */
  | { kind: "folder"; folderId: string }
  /** Out of its custom folder back to Sessions. */
  | { kind: "unfolder" };

export interface Plan {
  patch: ArrangementPatch;
  /** The change that puts it back as it was. */
  undo: ArrangementPatch;
  /** The toast's words: "Moved under “Fix the login form”". */
  said: string;
  /** What a screen reader hears: "Write the tests moved under Fix the login form." */
  spoken: string;
  /** What a screen reader hears when this move is undone. */
  undone: string;
}

const has = (o: object, k: string) => Object.hasOwn(o, k);

/** What moving `key` means, or null when it means nothing (where it already is) or may
 *  not be done (under itself or one of its own sessions). `tree` is the tree drawn now. */
export function planMove(
  arr: Pick<Arrangement, "placed" | "pinned" | "folders" | "inFolder">,
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
  const curFolder = arr.inFolder?.[key];
  const folderName = (id: string) => arr.folders?.find((f) => f.id === id)?.name ?? "folder";
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
  const folder = (to: string | null): Pick<Plan, "patch" | "undo"> => {
    const was = curFolder ?? null;
    if (was === to) return { patch: {}, undo: {} };
    return {
      patch: { inFolder: { [key]: to } },
      undo: { inFolder: { [key]: was } },
    };
  };
  const join = (...parts: Pick<Plan, "patch" | "undo">[]) => ({
    patch: Object.assign({}, ...parts.map((p) => p.patch)) as ArrangementPatch,
    undo: Object.assign({}, ...parts.map((p) => p.undo)) as ArrangementPatch,
  });
  const none = (): Pick<Plan, "patch" | "undo"> => ({ patch: {}, undo: {} });
  const empty = (p: ArrangementPatch) => Object.keys(p).length === 0;
  let change: Pick<Plan, "patch" | "undo">;
  let said: string;
  let spoken: string;
  const undone = pinned
    ? `${name} is back in Pinned.`
    : curFolder
      ? `${name} is back in ${folderName(curFolder)}.`
      : node.parent
        ? `${name} is back under ${title(node.parent)}.`
        : `${name} is back at the top level.`;
  switch (move.kind) {
    case "under": {
      const to = move.parent;
      if (to === key || descendants(tree, key).has(to) || !tree.nodes.has(to)) return null;
      if (node.parent === to && !pinned && !curFolder) return null;
      // Back under the session its events name: it follows them again.
      // Nesting clears any custom folder on the child so it inherits its parent's folder cleanly.
      change = join(
        place(events === to ? "follow" : to),
        pinned ? pins(unpinned) : none(),
        curFolder ? folder(null) : none(),
      );
      said = `Moved under “${title(to)}”`;
      spoken = `${name} moved under ${title(to)}.`;
      break;
    }
    case "top": {
      if (!pinned && !node.parent && !curFolder) return null;
      // Whether it would hang under a session out of Pinned: then it is placed at the top.
      const hangs = has(arr.placed, key) ? arr.placed[key] !== null : !!events;
      const onlyPin = pinned && !hangs && !curFolder;
      const onlyFolder = !pinned && !node.parent && !!curFolder;
      change = join(
        hangs ? place(events ? null : "follow") : none(),
        pinned ? pins(unpinned) : none(),
        curFolder ? folder(null) : none(),
      );
      said = onlyPin ? "Unpinned" : onlyFolder ? `Removed from “${folderName(curFolder)}”` : "Moved to top level";
      spoken = onlyPin
        ? `${name} unpinned.`
        : onlyFolder
          ? `${name} removed from ${folderName(curFolder)}.`
          : `${name} moved to top level.`;
      break;
    }
    case "pin": {
      // `at` counts the pins as drawn, this one among them: past its own place, one less.
      const from = arr.pinned.indexOf(key);
      const raw = move.at ?? arr.pinned.length;
      const i = Math.max(0, Math.min(from >= 0 && raw > from ? raw - 1 : raw, unpinned.length));
      const next = [...unpinned.slice(0, i), key, ...unpinned.slice(i)];
      // Pinning clears inFolder so the session never duplicates across Pinned and Folders.
      change = join(pins(next), curFolder ? folder(null) : none());
      const wasChild = !pinned && !!node.parent;
      said = pinned ? "Moved within Pinned" : wasChild ? "Pinned and moved to top level" : "Pinned";
      spoken = pinned
        ? `${name} moved to ${i + 1} of ${next.length} in Pinned.`
        : wasChild
          ? `${name} pinned and moved to top level.`
          : `${name} pinned.`;
      break;
    }
    case "unpin": {
      if (!pinned) return null;
      change = pins(unpinned);
      said = "Unpinned";
      spoken = `${name} unpinned.`;
      break;
    }
    case "folder": {
      const target = arr.folders?.find((f) => f.id === move.folderId);
      if (!target) return null;
      if (curFolder === move.folderId && !pinned && !node.parent) return null;
      // Moving a child into a folder promotes it to root inside that folder.
      const hangs = has(arr.placed, key) ? arr.placed[key] !== null : !!events;
      change = join(
        hangs ? place(events ? null : "follow") : none(),
        pinned ? pins(unpinned) : none(),
        folder(move.folderId),
      );
      said = `Moved to “${target.name}”`;
      spoken = `${name} moved to ${target.name}.`;
      break;
    }
    case "unfolder": {
      if (!curFolder) return null;
      change = folder(null);
      said = `Removed from “${folderName(curFolder)}”`;
      spoken = `${name} removed from ${folderName(curFolder)}.`;
      break;
    }
  }
  if (empty(change.patch)) return null;
  return { ...change, said, spoken, undone };
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

export type ArrangeSource = "pointer" | "key" | "menu" | "picker";

/** What a move was, for the tree to show its result (unfold the parent or folder it went into). */
export interface Arranged {
  key: SessionKey;
  move: Move;
  source?: ArrangeSource;
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
export const arrangeError = (reason: string, move: Move): string =>
  reason === "too_many"
    ? move.kind === "pin"
      ? "Couldn't pin. Pinned holds up to 100."
      : move.kind === "folder"
        ? "Couldn't move to folder. Limit reached."
        : "Couldn't move. Only 500 moves are kept."
    : reason === "bad_folder"
      ? "That folder no longer exists."
      : "Couldn't save the move. Try again.";

/** Moves `key` as asked: shown at once, kept on the receiver, a toast with Undo, and said.
 *  False when the move means nothing or may not be done. */
export function arrange(store: Store, key: SessionKey, move: Move, o?: { source?: ArrangeSource }): boolean {
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
      title: arrangeError(e.message, move),
      label: "error",
      at: Date.now(),
    });
  });
  // One way back at a time: a newer move takes the older one's toast (its undo is the one
  // that matches what is drawn now). Quiet: the tree's live region is the one voice.
  pushUndo({
    id: "arrange",
    title: plan.said,
    body: title(key),
    quiet: true,
    session: key,
    undo: () => {
      calmNextCommit();
      void store.patchArrangement(plan.undo).catch(() => {});
      for (const l of spokenListeners) l(plan.undone);
    },
  });
  for (const l of spokenListeners) l(plan.spoken, { key, move, source: o?.source });
  return true;
}

// ----- custom folder CRUD (all synced via arrangement.json with Undo) -----

/** Generates a unique folder id matching FOLDER_ID_RE (`f_<time>_<rand>`). */
export function generateFolderId(existing: readonly ArrangementFolder[]): string {
  const taken = new Set(existing.map((f) => f.id));
  for (let i = 0; i < 16; i++) {
    const id = `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    if (!taken.has(id)) return id;
  }
  return `f_${Date.now().toString(36)}_${existing.length + 1}`;
}

function folderFailToast(id: string, title: string): void {
  pushToast({
    id: `folder-failed|${id}`,
    kind: "error",
    sticky: false,
    title,
    label: "error",
    at: Date.now(),
  });
}

/** Creates a custom folder, optionally moving `moveSession` into it in the same atomic
 *  patch. Returns the created folder, or null if invalid or at the cap. */
export function createFolder(
  store: Store,
  rawName: string,
  o?: { color?: LabelColor; moveSession?: SessionKey; source?: ArrangeSource },
): ArrangementFolder | null {
  const name = sanitizeFolderName(rawName);
  if (name.length < 1 || name.length > ARRANGEMENT_FOLDER_NAME_MAX) return null;
  const state = store.get();
  const prevFolders = state.arrangement.folders ?? [];
  if (prevFolders.length >= ARRANGEMENT_FOLDERS_MAX) {
    folderFailToast("cap", `Couldn't create folder. Up to ${ARRANGEMENT_FOLDERS_MAX} folders are kept.`);
    return null;
  }
  const folder: ArrangementFolder = {
    id: generateFolderId(prevFolders),
    name,
    ...(o?.color ? { color: o.color } : {}),
  };
  const nextFolders = [...prevFolders, folder];
  let patch: ArrangementPatch = { folders: nextFolders };
  let undo: ArrangementPatch = { folders: prevFolders };
  let said = `Created folder “${name}”`;
  let body: string | undefined;
  let spoken = `Created folder ${name}.`;
  let undone = `Removed folder ${name}.`;
  let arranged: Arranged | undefined;

  if (o?.moveSession) {
    const { all, tree } = personTree(state);
    const title = (k: SessionKey) => {
      const s = state.sessions.get(k);
      return s ? sessionTitle(s) : "a session";
    };
    const withNew = { ...state.arrangement, folders: nextFolders };
    const plan = planMove(withNew, tree, all, o.moveSession, { kind: "folder", folderId: folder.id }, title);
    if (plan) {
      patch = { ...plan.patch, folders: nextFolders };
      // Restoring prevFolders automatically prunes the new folder's inFolder entry; keep any
      // prior placement/pin/folder undo from plan.undo.
      const prevFolder = state.arrangement.inFolder?.[o.moveSession];
      const undoInFolder = prevFolder ? { [o.moveSession]: prevFolder } : undefined;
      undo = {
        ...plan.undo,
        folders: prevFolders,
        ...(undoInFolder ? { inFolder: undoInFolder } : { inFolder: undefined }),
      };
      if (!undoInFolder) delete undo.inFolder;
      said = `Moved to “${name}”`;
      body = title(o.moveSession);
      spoken = `${title(o.moveSession)} moved to new folder ${name}.`;
      undone = plan.undone;
      arranged = { key: o.moveSession, move: { kind: "folder", folderId: folder.id }, source: o.source };
    }
  }

  store.patchArrangement(patch).catch((e: Error) => {
    folderFailToast(
      folder.id,
      e.message === "too_many"
        ? `Couldn't create folder. Up to ${ARRANGEMENT_FOLDERS_MAX} folders are kept.`
        : "Couldn't create folder. Try again.",
    );
  });
  pushUndo({
    id: "arrange",
    title: said,
    body,
    quiet: true,
    session: o?.moveSession,
    undo: () => {
      calmNextCommit();
      void store.patchArrangement(undo).catch(() => {});
      for (const l of spokenListeners) l(undone);
    },
  });
  for (const l of spokenListeners) l(spoken, arranged);
  return folder;
}

/** Renames a custom folder. Returns true if changed. */
export function renameFolder(store: Store, folderId: string, rawName: string): boolean {
  const name = sanitizeFolderName(rawName);
  if (name.length < 1 || name.length > ARRANGEMENT_FOLDER_NAME_MAX) return false;
  const prevFolders = store.get().arrangement.folders ?? [];
  const cur = prevFolders.find((f) => f.id === folderId);
  if (!cur || cur.name === name) return false;
  const nextFolders = prevFolders.map((f) => (f.id === folderId ? { ...f, name } : f));
  const prevName = cur.name;
  store.patchArrangement({ folders: nextFolders }).catch(() => {
    folderFailToast(folderId, "Couldn't rename folder. Try again.");
  });
  pushUndo({
    id: "arrange",
    title: `Renamed folder to “${name}”`,
    quiet: true,
    undo: () => {
      calmNextCommit();
      void store.patchArrangement({ folders: prevFolders }).catch(() => {});
      for (const l of spokenListeners) l(`Folder renamed back to ${prevName}.`);
    },
  });
  for (const l of spokenListeners) l(`Folder renamed to ${name}.`);
  return true;
}

/** Sets or clears a custom folder's subtle Finder dot color. Returns true if changed. */
export function recolorFolder(store: Store, folderId: string, color: LabelColor | null): boolean {
  const prevFolders = store.get().arrangement.folders ?? [];
  const cur = prevFolders.find((f) => f.id === folderId);
  if (!cur || (cur.color ?? null) === color) return false;
  const nextFolders = prevFolders.map((f) => {
    if (f.id !== folderId) return f;
    const { color: _old, ...rest } = f;
    return color ? { ...rest, color } : rest;
  });
  store.patchArrangement({ folders: nextFolders }).catch(() => {
    folderFailToast(folderId, "Couldn't update folder color. Try again.");
  });
  const said = color ? `Folder color set` : `Folder color cleared`;
  pushUndo({
    id: "arrange",
    title: said,
    body: cur.name,
    quiet: true,
    undo: () => {
      calmNextCommit();
      void store.patchArrangement({ folders: prevFolders }).catch(() => {});
      for (const l of spokenListeners) l(`Restored color for ${cur.name}.`);
    },
  });
  for (const l of spokenListeners) l(`${said} for ${cur.name}.`);
  return true;
}

/** Moves a custom folder up (-1) or down (+1) in order. Returns true if changed. */
export function reorderFolder(store: Store, folderId: string, dir: -1 | 1): boolean {
  const prevFolders = store.get().arrangement.folders ?? [];
  const i = prevFolders.findIndex((f) => f.id === folderId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= prevFolders.length) return false;
  const nextFolders = [...prevFolders];
  const [moved] = nextFolders.splice(i, 1);
  nextFolders.splice(j, 0, moved!);
  store.patchArrangement({ folders: nextFolders }).catch(() => {
    folderFailToast(folderId, "Couldn't reorder folder. Try again.");
  });
  const way = dir < 0 ? "up" : "down";
  pushUndo({
    id: "arrange",
    title: `Moved “${moved!.name}” ${way}`,
    quiet: true,
    undo: () => {
      calmNextCommit();
      void store.patchArrangement({ folders: prevFolders }).catch(() => {});
      for (const l of spokenListeners) l(`${moved!.name} moved back.`);
    },
  });
  for (const l of spokenListeners) l(`Folder ${moved!.name} moved ${way}.`);
  return true;
}

/** Deletes a custom folder (never deletes sessions: returns them to Sessions). Undo
 *  restores both the folder and its exact session memberships atomically. */
export function deleteFolder(store: Store, folderId: string): boolean {
  const state = store.get();
  const prevFolders = state.arrangement.folders ?? [];
  const origIndex = prevFolders.findIndex((f) => f.id === folderId);
  const cur = origIndex >= 0 ? prevFolders[origIndex] : undefined;
  if (!cur) return false;
  const members = Object.entries(state.arrangement.inFolder ?? {})
    .filter(([, fid]) => fid === folderId)
    .map(([k]) => k);
  const nextFolders = prevFolders.filter((f) => f.id !== folderId);
  store.patchArrangement({ folders: nextFolders }).catch(() => {
    folderFailToast(folderId, "Couldn't delete folder. Try again.");
  });
  const body =
    members.length > 0
      ? `${members.length} ${members.length === 1 ? "session" : "sessions"} returned to Sessions`
      : undefined;
  pushUndo({
    id: "arrange",
    title: `Deleted folder “${cur.name}”`,
    body,
    quiet: true,
    undo: () => {
      calmNextCommit();
      const live = store.get();
      const currentFolders = live.arrangement.folders ?? [];
      const without = currentFolders.filter((f) => f.id !== folderId);
      const at = Math.min(origIndex, without.length);
      const mergedFolders = [...without.slice(0, at), cur, ...without.slice(at)];
      const restored: Record<SessionKey, string> = {};
      for (const k of members) if (live.sessions.has(k)) restored[k] = folderId;
      const patch: ArrangementPatch = {
        folders: mergedFolders,
        ...(Object.keys(restored).length > 0 ? { inFolder: restored } : {}),
      };
      void store.patchArrangement(patch).catch(() => {});
      for (const l of spokenListeners) l(`Restored folder ${cur.name}.`);
    },
  });
  for (const l of spokenListeners) l(`Deleted folder ${cur.name}.`);
  return true;
}

// ----- Move under… & Move to folder… pickers + touch folder prompt -----

export interface MoveUnderRequest {
  key: SessionKey;
  fromTree?: boolean;
}
const pickListeners = new Set<(req: MoveUnderRequest) => void>();
/** Opens the "Move under…" picker for `key` (components/MoveUnder.tsx, mounted once). */
export function requestMoveUnder(key: SessionKey, o?: { fromTree?: boolean }): void {
  const req: MoveUnderRequest = { key, ...(o?.fromTree ? { fromTree: true } : {}) };
  for (const l of pickListeners) l(req);
}
export function onMoveUnder(l: (req: MoveUnderRequest) => void): () => void {
  pickListeners.add(l);
  return () => {
    pickListeners.delete(l);
  };
}

export interface MoveFolderRequest {
  key: SessionKey;
  fromTree?: boolean;
}
const folderPickListeners = new Set<(req: MoveFolderRequest) => void>();
/** Opens the "Move to folder…" picker for `key` (components/MoveFolder.tsx). */
export function requestMoveFolder(key: SessionKey, o?: { fromTree?: boolean }): void {
  const req: MoveFolderRequest = { key, ...(o?.fromTree ? { fromTree: true } : {}) };
  for (const l of folderPickListeners) l(req);
}
export function onMoveFolder(l: (req: MoveFolderRequest) => void): () => void {
  folderPickListeners.add(l);
  return () => {
    folderPickListeners.delete(l);
  };
}

export interface FolderPromptRequest {
  mode: "create" | "rename";
  folderId?: string;
  initialName?: string;
  moveSession?: SessionKey;
  fromTree?: boolean;
}
const folderPromptListeners = new Set<(req: FolderPromptRequest) => void>();
/** Opens a lightweight dialog/sheet to create or rename a folder (touch, or New folder… in menu). */
export function requestFolderPrompt(req: FolderPromptRequest): void {
  for (const l of folderPromptListeners) l(req);
}
export function onFolderPrompt(l: (req: FolderPromptRequest) => void): () => void {
  folderPromptListeners.add(l);
  return () => {
    folderPromptListeners.delete(l);
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

/** Pin or Unpin; Move to folder ▸; Move under…; Move to top level where it is under a
 *  session; Move up and Move down among the pinned. For every session's menu, on every
 *  surface (lib/menus.ts). */
export function arrangeItems(s: SessionSummary, store: Store, o?: { inTree?: boolean }): MenuList {
  const state = store.get();
  if (isEmptySession(s)) return [];
  const { tree } = personTree(state);
  const node = tree.nodes.get(s.key);
  const pins = state.arrangement.pinned;
  const at = pins.indexOf(s.key);
  const pinned = at >= 0;
  const folders = state.arrangement.folders ?? [];
  const curFolder = state.arrangement.inFolder?.[s.key];
  // On a phone (compact layout, no sidebar), omit Pin, Unpin and Pinned moves.
  const showPin = !phoneLayout() || sizeClass() === "regular";
  const run = (move: Move) => () => void arrange(store, s.key, move, o?.inTree ? { source: "menu" } : undefined);
  const folderItems: MenuList = [
    ...folders.map((f) => ({
      label: f.name,
      swatch: f.color,
      checked: curFolder === f.id,
      run: run({ kind: "folder", folderId: f.id }),
    })),
    !!curFolder && { label: "Remove from folder", run: run({ kind: "unfolder" }) },
    (folders.length > 0 || !!curFolder) && { sep: true as const },
    {
      label: "New folder…",
      run: () => requestFolderPrompt({ mode: "create", moveSession: s.key, fromTree: o?.inTree }),
    },
  ];
  return [
    showPin &&
      (pinned
        ? { label: "Unpin", action: "tree.pin", run: run({ kind: "unpin" }) }
        : { label: "Pin", action: "tree.pin", run: run({ kind: "pin" }) }),
    showPin && pinned && at > 0 && { label: "Move up in Pinned", run: run({ kind: "pin", at: at - 1 }) },
    showPin &&
      pinned &&
      at < pins.length - 1 && { label: "Move down in Pinned", run: run({ kind: "pin", at: at + 2 }) },
    { label: "Move to folder", items: folderItems },
    !!node &&
      moveTargets(tree, s.key).length > 0 && {
        label: "Move under…",
        action: "tree.moveUnder",
        run: () => requestMoveUnder(s.key, { fromTree: o?.inTree }),
      },
    !!node?.parent && { label: "Move to top level", action: "tree.moveOut", run: run({ kind: "top" }) },
  ];
}
