// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The one button that opens the Files drawer, on the session page's bar
// and on the side panel's head: a folder, pressed while the drawer is open.
import type { SessionKey } from "@shared/api";
import { FolderIcon } from "../components/Icons";
import { hintFor } from "../lib/shortcuts";
import { type DrawerMode, toggleDrawer, useDrawer } from "./state";

export function FilesButton({
  session,
  mode,
  className = "",
}: {
  session: SessionKey;
  /** Which drawer: the page's or the panel's. */
  mode: DrawerMode;
  className?: string;
}) {
  const { open } = useDrawer(session, mode);
  return (
    <button
      type="button"
      className={`icon-btn files-btn ${className}`}
      onClick={() => toggleDrawer(session, mode)}
      aria-label="Files"
      aria-pressed={open}
      data-tip="Files"
      data-tip-keys={hintFor("session.files") || undefined}
      data-tip-side="bottom"
    >
      <FolderIcon size={16} />
    </button>
  );
}
