// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Shared icons, rolled-up status lamps, and folder context menu items used
// by both the sidebar tree (SessionTree.tsx) and the Board's Organized view (Board.tsx).
import { type ArrangementFolder, LABEL_COLORS, LABEL_DEFAULT_NAMES, type SessionKey } from "@shared/api";
import type { Store } from "../data/store";
import { deleteFolder, recolorFolder, reorderFolder } from "../lib/arrange";
import type { Loud } from "../lib/tree";
import { StateDot } from "./bits";
import type { MenuList } from "./ContextMenu";
import {
  FolderIcon as BaseFolderIcon,
  PinIcon as BasePinIcon,
  ProjectIcon as BaseProjectIcon,
  PlusIcon,
} from "./Icons";

/** Monochrome 16 px folder icon for custom folders. */
export function FolderIcon({
  open,
  size = 16,
  className = "stree-folder-glyph",
}: {
  open?: boolean;
  size?: number;
  className?: string;
}) {
  return <BaseFolderIcon open={open} size={size} className={className} />;
}

/** Monochrome 16 px project / repository icon for project groups. */
export function ProjectIcon({ size = 16, className = "stree-project-glyph" }: { size?: number; className?: string }) {
  return <BaseProjectIcon size={size} className={className} />;
}

/** Monochrome 16 px pin icon for the Pinned section header. */
export function PinIcon({ size = 16, className = "group-org-glyph" }: { size?: number; className?: string }) {
  return <BasePinIcon size={size} className={className} />;
}

/** Small `+` glyph for "New session in <project>" and "New folder". */
export function PlusSmallIcon({ size = 12, className }: { size?: number; className?: string }) {
  return <PlusIcon size={size} className={className} />;
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
