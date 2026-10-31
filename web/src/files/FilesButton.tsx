// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The one button that opens the Files drawer, on the session page's bar
// and on the side panel's head: a folder, pressed while the drawer is open.
import type { SessionKey } from "@shared/api";
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
      <svg
        viewBox="0 0 20 20"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H8l2 2h5.5A1.5 1.5 0 0 1 17 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z" />
      </svg>
    </button>
  );
}
