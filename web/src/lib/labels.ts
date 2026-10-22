// SPDX-License-Identifier: Apache-2.0
// The person's colour labels in the page (shared/api.ts Labels; ORGANIZE-SPEC.md §3): a
// label's name, the "Label" submenu every session menu carries, the label search token,
// and the request to rename labels (a dialog listens for it). The document itself lives
// in the store (AppState.labels) and changes through `store.patchLabels`.
import { LABEL_COLORS, LABEL_DEFAULT_NAMES, type LabelColor, type Labels, type SessionKey } from "@shared/api";
import type { MenuItem } from "../components/ContextMenu";
import type { Store } from "../data/store";

/** What a label is called: the person's name for it, else the colour's own. */
export const labelName = (labels: Labels, color: LabelColor): string =>
  labels.names[color] ?? LABEL_DEFAULT_NAMES[color];

/** A session's label, if it has one. */
export const labelOf = (labels: Labels, key: SessionKey): LabelColor | undefined => labels.sessions[key];

/** Set (or with `null` clear) the label of one or more sessions. The dot changes at once;
 *  a refusal puts it back (store.patchLabels) and resolves false. */
export async function setLabel(
  store: Store,
  keys: SessionKey | readonly SessionKey[],
  color: LabelColor | null,
): Promise<boolean> {
  const list = typeof keys === "string" ? [keys] : keys;
  if (!list.length) return true;
  try {
    await store.patchLabels({ sessions: Object.fromEntries(list.map((k) => [k, color])) });
    return true;
  } catch (e) {
    console.warn("label not set:", (e as Error).message);
    return false;
  }
}

/** Rename a label (an empty name goes back to the colour's own). Rejects with the
 *  server's reason (`bad_name`) for the dialog to show. */
export function renameLabel(store: Store, color: LabelColor, name: string | null): Promise<Labels> {
  return store.patchLabels({ names: { [color]: name } });
}

/** The colour a `label:` search value names: a colour id ("red") or a label's name
 *  ("urgent"), case-insensitive; undefined when it names neither. */
export function labelFromQuery(labels: Labels, value: string): LabelColor | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  for (const c of LABEL_COLORS) if (c === v || labelName(labels, c).toLowerCase() === v) return c;
  return undefined;
}

// ----- the rename request (the dialog that answers it is the page's own) -----

const renameListeners = new Set<(color?: LabelColor) => void>();

/** Ask for the label names dialog, at one colour or at the list. */
export function requestLabelRename(color?: LabelColor): void {
  for (const l of renameListeners) l(color);
}

/** The dialog subscribes here; returns the unsubscribe. */
export function onLabelRename(l: (color?: LabelColor) => void): () => void {
  renameListeners.add(l);
  return () => {
    renameListeners.delete(l);
  };
}

/** The "Label" submenu, Finder's: one row per colour with its dot and name, a check on
 *  the current one (when every key shares it), "None", then "Edit labels…". Each row
 *  shows its keymap chord (⌥⌘1 … ⌥⌘7, ⌥⌘0). */
export function labelMenu(store: Store, keys: readonly SessionKey[]): MenuItem {
  const labels = store.get().labels;
  const current = new Set(keys.map((k) => labels.sessions[k] ?? null));
  const only = current.size === 1 ? [...current][0] : undefined;
  return {
    label: "Label",
    items: [
      ...LABEL_COLORS.map(
        (c): MenuItem => ({
          label: labelName(labels, c),
          swatch: c,
          checked: only === c,
          radio: true,
          action: `label.${c}`,
          run: () => void setLabel(store, keys, c),
        }),
      ),
      { sep: true },
      {
        label: "None",
        checked: only === null,
        radio: true,
        action: "label.none",
        disabled: current.size === 1 && only === null ? true : undefined,
        run: () => void setLabel(store, keys, null),
      },
      { sep: true },
      { label: "Edit labels…", run: () => requestLabelRename(only ?? undefined) },
    ],
  };
}

// ----- filtering: the toolbar chip and the `label:` search token -----

/** The toolbar chip's value: every label (""), one colour, or the unlabelled ("none"). */
export type LabelFilter = "" | LabelColor | "none";

/** Whether a session passes the chip. */
export const labelPasses = (labels: Labels, key: SessionKey, f: LabelFilter): boolean =>
  !f || (f === "none" ? !labels.sessions[key] : labels.sessions[key] === f);

/** A search query with its `label:` tokens read off: `label:<colour or name>` keeps that
 *  label, `label:none` the unlabelled, `-label:<x>` leaves it out. `rest` is the free
 *  text left for the page's own matching; `test` is true when no token was given. A token
 *  that names no label keeps nothing (it never silently matches everything). A bare
 *  `label:` (still being typed) is ignored. */
export function labelQuery(labels: Labels, q: string): { rest: string; test: (key: SessionKey) => boolean } {
  const keep: (LabelColor | "none" | null)[] = [];
  const drop: (LabelColor | "none" | null)[] = [];
  const rest = q
    .split(/\s+/)
    .filter((w) => {
      const m = /^(-?)label:(.*)$/i.exec(w);
      if (!m) return true;
      const v = m[2]!;
      if (!v) return false;
      const c =
        v.toLowerCase() === "none"
          ? "none"
          : (labelFromQuery(labels, v) ?? labelFromQuery(labels, v.replace(/_/g, " ")) ?? null);
      (m[1] ? drop : keep).push(c);
      return false;
    })
    .join(" ")
    .trim();
  if (keep.length === 0 && drop.length === 0) return { rest, test: () => true };
  const is = (key: SessionKey, c: LabelColor | "none" | null) =>
    c === null ? false : c === "none" ? !labels.sessions[key] : labels.sessions[key] === c;
  return {
    rest,
    test: (key) => keep.every((c) => is(key, c)) && !drop.some((c) => is(key, c)),
  };
}

/** Whether any session has a label (the chip shows once one does). */
export const anyLabel = (labels: Labels): boolean => Object.keys(labels.sessions).length > 0;
