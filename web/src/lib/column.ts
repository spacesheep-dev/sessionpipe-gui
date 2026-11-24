// SPDX-License-Identifier: Apache-2.0
// How wide a transcript's own column is: a session's, or one read from Search. On a touch
// screen a reply's prose keeps to about 70 characters in a column of NARROW_COLUMN_PX and
// more; in a narrower one it runs to the column's edge, as the messages and the message
// field do (session.css, chat.css). The column is measured, never the window: beside the
// sidebar and inside the bands at the sides, the window says nothing of it.
//
// It is said as data-column="narrow" or "wide" on the column itself, and not asked by a
// container query: with a size container round the transcript, Chromium drew a phone's
// page a point apart in places nothing else changed (after "Show less" a folded message's
// "Show all" a point from the finger at 320 pt; "Ask another agent…" a pixel lower).
import { type RefCallback, type RefObject, useCallback } from "react";

/** Under this width (px) a transcript's column is narrow and a reply takes all of it. */
export const NARROW_COLUMN_PX = 640;

/** What a column of `width` px is. */
export function columnKind(width: number): "narrow" | "wide" {
  return width < NARROW_COLUMN_PX ? "narrow" : "wide";
}

/** Keeps `el`'s data-column what its own width is, from now until the returned stop.
 *  A ResizeObserver's answer comes before the frame is painted, so no frame shows the
 *  other one. */
export function markColumn(el: HTMLElement): () => void {
  if (typeof ResizeObserver !== "function") return () => {};
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const width = e.contentBoxSize?.[0]?.inlineSize ?? e.contentRect.width;
      const kind = columnKind(width);
      if (el.dataset.column !== kind) el.dataset.column = kind;
    }
  });
  ro.observe(el);
  return () => ro.disconnect();
}

/** A ref for a transcript's column: sets `ref` as the element mounts, and marks it. */
export function useColumnRef<T extends HTMLElement>(ref: RefObject<T | null>): RefCallback<T> {
  return useCallback(
    (el: T | null) => {
      ref.current = el;
      if (!el) return;
      const stop = markColumn(el);
      return () => {
        stop();
        ref.current = null;
      };
    },
    [ref],
  );
}
