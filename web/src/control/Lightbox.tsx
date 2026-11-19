// SPDX-License-Identifier: Apache-2.0
// A sent message's picture, whole, over the page: in a browser and in every app shell alike
// (an app's web view opens no new tab for the receiver's own address). Esc, a tap outside
// the picture or × closes it; with several, the arrow keys and the two chevrons move through
// the message's pictures. A route change closes it, as the other dialogs do. Focus is held
// inside while it is open and goes back to the thumbnail after.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../lib/focus";

export interface LightboxPicture {
  src: string;
  /** Said under it, and the dialog's name. */
  name: string;
}

export function Lightbox({
  pictures,
  at,
  onMove,
  onClose,
}: {
  pictures: readonly LightboxPicture[];
  at: number;
  onMove: (at: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, { initial: "[data-lightbox-close]" });
  const n = pictures.length;
  const move = (by: number) => onMove((at + by + n) % n);
  const keys = useRef({ move, onClose });
  keys.current = { move, onClose };
  useEffect(() => {
    // Its own keys wherever the focus is, and none of the page's while it is up; Tab is the
    // focus trap's.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") return;
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        keys.current.onClose();
      } else if (n > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        keys.current.move(e.key === "ArrowLeft" ? -1 : 1);
      }
    };
    const onRoute = () => keys.current.onClose();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("popstate", onRoute);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("popstate", onRoute);
    };
  }, [n]);
  const p = pictures[at];
  if (!p) return null;
  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it from the keyboard (the focus trap)
    <div
      className="lb"
      role="dialog"
      aria-modal="true"
      aria-label={p.name}
      ref={ref}
      tabIndex={-1}
      data-lightbox={at}
      onClick={(e) => {
        // Not the page's: the thumbnail's row or bubble below takes no click from here.
        e.stopPropagation();
        // A tap outside the picture and its controls.
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("lb-stage")) onClose();
      }}
    >
      <div className="lb-stage">
        <img key={p.src} className="lb-img" src={p.src} alt="" />
      </div>
      <p className="lb-cap">
        <span className="lb-name">{p.name}</span>
        {n > 1 && (
          <span className="lb-count num">
            {at + 1} of {n}
          </span>
        )}
      </p>
      <button type="button" className="icon-btn lb-btn lb-x" onClick={onClose} aria-label="Close" data-lightbox-close>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M4 4l8 8M12 4 4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {n > 1 && (
        <>
          <button
            type="button"
            className="icon-btn lb-btn lb-prev"
            onClick={() => move(-1)}
            aria-label="Previous picture"
          >
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="none">
              <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <button type="button" className="icon-btn lb-btn lb-next" onClick={() => move(1)} aria-label="Next picture">
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="none">
              <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
