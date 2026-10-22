// SPDX-License-Identifier: Apache-2.0
// The tier lens, app-wide: a toolbar chip at the top right of the page ("All tiers",
// "Tier 1"), worded like the machine and harness filters beside it. A click cycles all → 0 → 1 → 2 → 3 → all, `l` does the same from anywhere;
// a click held for a moment (or a right click) opens the picker, the same segmented
// control the Session page has, with every tier's name. Hidden in Simple mode, where the
// lens is always "all". Each page says what the lens took away ("tier 1 lens · 4 hidden")
// through <LensNote>, with a reset.
import type { Tier } from "@shared/api";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { cycleLens, LENSES, type Lens, lensLabel, setTierLens, useAppSettings } from "../lib/settings";
import { TIER_HINT, TIER_LABEL } from "../lib/tier";
import { Segmented } from "./bits";

const HOLD_MS = 450;

export const LENS_OPTIONS = LENSES.map((l) => ({
  value: l === null ? "all" : String(l),
  label: l === null ? "All" : String(l),
  title: l === null ? "Everything that arrived" : `${TIER_LABEL[l]}: ${TIER_HINT[l]}`,
}));
export const lensFromOption = (v: string): Lens => (v === "all" ? null : (Number(v) as Tier));
export const lensToOption = (l: Lens): string => (l === null ? "all" : String(l));

/** The picker alone (Settings › Tier lens uses it too). */
export function LensPicker({ label = "Tier lens" }: { label?: string }) {
  const { tierLens } = useAppSettings();
  return (
    <Segmented<string>
      value={lensToOption(tierLens)}
      onChange={(v) => setTierLens(lensFromOption(v))}
      label={label}
      options={LENS_OPTIONS}
    />
  );
}

export function LensChip() {
  const { tierLens, mode } = useAppSettings();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const hold = useRef<number | null>(null);
  const held = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  if (mode === "simple") return null;

  const clearHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    held.current = false;
    clearHold();
    hold.current = window.setTimeout(() => {
      held.current = true;
      setOpen(true);
    }, HOLD_MS);
  };
  const onClick = () => {
    clearHold();
    if (held.current) {
      held.current = false;
      return;
    }
    if (open) setOpen(false);
    else cycleLens();
  };

  return (
    <div className={`lens-chip ${tierLens !== null ? "lens-chip--on" : ""}`} ref={wrap} data-lens={lensLabel(tierLens)}>
      <button
        type="button"
        className="lens-chip-btn num"
        onPointerDown={onPointerDown}
        onPointerUp={clearHold}
        onPointerLeave={clearHold}
        onPointerCancel={clearHold}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          clearHold();
          setOpen(true);
        }}
        aria-label={`Tier lens: ${lensLabel(tierLens)}. Click to cycle, hold to pick`}
        title={`Tier lens · ${tierLens === null ? "everything" : TIER_LABEL[tierLens]} · click cycles, hold picks, l`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {tierLens === null ? "All tiers" : `Tier ${tierLens}`}
      </button>
      {open && (
        <div className="lens-pop" role="dialog" aria-label="Tier lens">
          <div className="qs-row">
            <span className="qs-label">Tier lens</span>
            <LensPicker />
            <p className="qs-note">
              {tierLens === null ? "Everything that arrived." : `${TIER_LABEL[tierLens]} · ${TIER_HINT[tierLens]}`}
            </p>
          </div>
          <button type="button" className="btn btn--sm btn--ghost qs-close" onClick={() => setOpen(false)} data-dismiss>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

/** "tier 1 lens · 4 hidden · show all": one quiet line a page shows while its lens hides
 *  something. Nothing when the lens is off or nothing was hidden. */
export function LensNote({ lens, hidden }: { lens: Lens; hidden: number }) {
  if (lens === null || hidden <= 0) return null;
  return (
    <p className="lens-note" data-lens-note>
      <span>
        tier {lens} lens · {hidden} hidden
      </span>
      <button type="button" className="lens-note-reset" onClick={() => setTierLens(null)}>
        show all
      </button>
    </p>
  );
}
