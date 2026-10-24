// SPDX-License-Identifier: Apache-2.0
// The phone's More sheet (Shell.tsx MoreTab draws it on a phone only, so its code loads
// there alone, warmed at idle): the entries the tab bar has no room for, as grouped lists
// (the pages, the installed views, then Display and Settings). It follows a finger down
// from its grabber, and plays its exit before it unmounts.
import { type ReactNode, useRef } from "react";
import { useFocusTrap } from "../lib/focus";
import { useSheetDrag } from "../lib/motion";
import { Link } from "../lib/router";
import { GearIcon } from "./QuickSettings";
import { SlidersIcon } from "./Shell";

export interface MoreSheetProps {
  /** Asked open; false from the tap that closes it, while its exit still plays. */
  open: boolean;
  closing: boolean;
  onClose: () => void;
  /** Display's sheet, in place of this one. */
  onDisplay: () => void;
  /** The pages' rows, then the views' rows. */
  lists: [ReactNode[], ReactNode[]];
}

export function MoreSheet({ open, closing, onClose, onDisplay, lists: [pages, views] }: MoreSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Focus goes back the moment it is asked closed, before whatever opens next (Display)
  // takes it.
  useFocusTrap(ref, open, { onClose });
  useSheetDrag(ref, onClose, { handle: ".more-grab", enabled: open });
  return (
    <>
      <button
        type="button"
        className="more-scrim"
        aria-label="Close"
        onClick={onClose}
        data-dismiss
        data-closing={closing ? "" : undefined}
      />
      <div
        className="more-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="More"
        ref={ref}
        data-closing={closing ? "" : undefined}
        aria-hidden={closing || undefined}
      >
        <span className="more-grab" aria-hidden="true" />
        {pages.length > 0 && <ul className="more-list">{pages}</ul>}
        {views.length > 0 && (
          <div className="more-sect">
            <div className="more-group">Views</div>
            <ul className="more-list">{views}</ul>
          </div>
        )}
        <ul className="more-list">
          <li>
            <button type="button" className="more-row" onClick={onDisplay} aria-haspopup="dialog" data-nav="display">
              <span className="nav-glyph" aria-hidden="true">
                <GearIcon size={20} />
              </span>
              <span className="more-row-name">Display</span>
            </button>
          </li>
          <li>
            <Link to="/settings" className="more-row" data-nav="settings">
              <span className="nav-glyph" aria-hidden="true">
                <SlidersIcon size={20} />
              </span>
              <span className="more-row-name">Settings</span>
            </Link>
          </li>
        </ul>
      </div>
    </>
  );
}
