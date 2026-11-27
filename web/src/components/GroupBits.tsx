// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Shared icons, rolled-up status lamps, and folder context menu items used
// by both the sidebar tree (SessionTree.tsx) and the Board's Organized view (Board.tsx).
import { type ArrangementFolder, LABEL_COLORS, LABEL_DEFAULT_NAMES, type SessionKey } from "@shared/api";
import type { Store } from "../data/store";
import { deleteFolder, recolorFolder, reorderFolder } from "../lib/arrange";
import type { Loud } from "../lib/tree";
import { StateDot } from "./bits";
import type { MenuList } from "./ContextMenu";

/** Monochrome 16 px folder icon for custom folders. */
export function FolderIcon({ open, className = "stree-folder-glyph" }: { open?: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? (
        <>
          <path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h2.6l1.3 1.4h4.6a1.5 1.5 0 0 1 1.4 1.1" />
          <path d="M2 6.5h11.3a1 1 0 0 1 .97 1.24l-.9 3.6A1.5 1.5 0 0 1 11.9 12.5H3.5A1.5 1.5 0 0 1 2 11z" />
        </>
      ) : (
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
      )}
    </svg>
  );
}

/** Monochrome 16 px project / repository icon for project groups. */
export function ProjectIcon({ className = "stree-project-glyph" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 6h5M5.5 9h3.5" />
    </svg>
  );
}

/** Monochrome 16 px pin icon for the Pinned section header. */
export function PinIcon({ className = "group-org-glyph" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 2.5h4l-.6 3.6L11.5 8v1.2H4.5V8l2.1-1.9zM8 9.2v4.3" />
    </svg>
  );
}

/** Small `+` glyph for "New session in <project>" and "New folder". */
export function PlusSmallIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M7 3.2v7.6M3.2 7h7.6" />
    </svg>
  );
}

/** Rolled-up status lamp for a collapsed custom folder or project group. */
export function GroupLamp({ loud, className }: { loud: Loud; className?: string }) {
  if (loud === "none") return null;
  if (loud === "unread") {
    return (
      <span className={className ?? "group-rolled-lamp"} data-rolled="unread">
        <StateDot state="idle" unread />
      </span>
    );
  }
  return (
    <span className={className ?? "group-rolled-lamp"} data-rolled={loud}>
      <StateDot state={loud} />
    </span>
  );
}

/** Context / action-sheet items for a custom folder: Rename, Color, Move up/down, optional
 *  Unfold/Fold all, and Delete folder (which pushes an Undo entry). */
export function folderMenuItems(
  store: Store,
  folder: ArrangementFolder,
  index: number,
  total: number,
  opts: {
    onRename: () => void;
    kidKeys?: SessionKey[];
    folded?: ReadonlySet<string>;
    setFoldedMany?: (keys: readonly string[], fold: boolean) => void;
  },
): MenuList {
  const kidKeys = opts.kidKeys ?? [];
  const anyKidFolded = kidKeys.some((k) => opts.folded?.has(k));
  const anyKidOpen = kidKeys.some((k) => !opts.folded?.has(k));
  return [
    { label: "Rename…", run: opts.onRename },
    {
      label: "Color",
      items: [
        {
          label: "None",
          radio: true,
          checked: !folder.color,
          run: () => void recolorFolder(store, folder.id, null),
        },
        { sep: true },
        ...LABEL_COLORS.map((c) => ({
          label: LABEL_DEFAULT_NAMES[c],
          swatch: c,
          radio: true,
          checked: folder.color === c,
          run: () => void recolorFolder(store, folder.id, c),
        })),
      ],
    },
    index > 0 && { label: "Move up", run: () => void reorderFolder(store, folder.id, -1) },
    index < total - 1 && { label: "Move down", run: () => void reorderFolder(store, folder.id, 1) },
    kidKeys.length > 0 && opts.setFoldedMany && { sep: true },
    kidKeys.length > 0 &&
      opts.setFoldedMany && {
        label: "Unfold all",
        disabled: !anyKidFolded,
        run: () => opts.setFoldedMany!(kidKeys, false),
      },
    kidKeys.length > 0 &&
      opts.setFoldedMany && {
        label: "Fold all",
        disabled: !anyKidOpen,
        run: () => opts.setFoldedMany!(kidKeys, true),
      },
    { sep: true },
    { label: "Delete folder", danger: true, run: () => void deleteFolder(store, folder.id) },
  ];
}
