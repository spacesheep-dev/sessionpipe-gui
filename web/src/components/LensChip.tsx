// SPDX-License-Identifier: Apache-2.0
// The tier lens, app-wide: a toolbar pop-up at the top right of the page ("All tiers",
// "Tier 1") that opens a menu like the machine and harness filters beside it, each tier
// with what it keeps; `l` steps through them from anywhere. It holds one width whatever
// it says, so the search beside it never moves. Hidden in Simple mode, where the lens is
// always "all". Each page says what the lens took away in plain words ("Showing presence
// only · 16 hidden · Show all") through <LensNote>.
import type { Tier } from "@shared/api";
import { useEffect, useRef, useState } from "react";
import { LENSES, type Lens, lensLabel, setTierLens, useAppSettings } from "../lib/settings";
import { TIER_HINT, TIER_LABEL } from "../lib/tier";
import { Segmented } from "./bits";
import { type MenuList, openMenu, useMenuOpen } from "./ContextMenu";

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

const chipText = (l: Lens) => (l === null ? "All tiers" : `Tier ${l}`);
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** The lens menu: every tier with the name of what it keeps, the current one checked. */
export function lensItems(current: Lens): MenuList {
  return [
    { heading: "Tier lens" },
    ...LENSES.map((l) => ({
      label: l === null ? "All tiers" : `Tier ${l} · ${cap(TIER_LABEL[l])}`,
      radio: true,
      checked: l === current,
      run: () => setTierLens(l),
    })),
  ];
}

export function LensChip() {
  const { tierLens, mode } = useAppSettings();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const menuUp = useMenuOpen();
  useEffect(() => {
    if (!menuUp) setOpen(false);
  }, [menuUp]);
  if (mode === "simple") return null;
  const show = (keyboard: boolean) => {
    const el = btn.current;
    if (!el) return;
    openMenu(lensItems(tierLens), el, { source: keyboard ? "keyboard" : "mouse", invoker: el, title: "Tier lens" });
    setOpen(true);
  };
  return (
    <div className={`lens-chip ${tierLens !== null ? "lens-chip--on" : ""}`} data-lens={lensLabel(tierLens)}>
      <button
        ref={btn}
        type="button"
        className="lens-chip-btn num"
        onClick={(e) => show(e.detail === 0)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          show(true);
        }}
        aria-label={`Tier lens: ${chipText(tierLens)}`}
        title={tierLens === null ? "Everything that arrived" : `${cap(TIER_LABEL[tierLens])}: ${TIER_HINT[tierLens]}`}
        data-tip="Tier lens"
        data-tip-keys="L"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {/* Every label stacked in one cell: the widest sets the width, so "All tiers" →
            "Tier 0" never moves its neighbours. */}
        <span className="lens-chip-text">
          {LENSES.map((l) => (
            <span key={lensLabel(l)} aria-hidden={l !== tierLens || undefined} data-on={l === tierLens || undefined}>
              {chipText(l)}
            </span>
          ))}
        </span>
        <svg className="lens-chip-caret" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path
            d="M3 4.5 6 7.5l3-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

/** What the lens keeps, said plainly ("presence only", "presence and actions"). */
export const lensWords = (l: Tier): string =>
  l === 0 ? "presence only" : l === 1 ? "presence and actions" : l === 2 ? "everything but tool output" : "everything";

/** "Showing presence only · 16 hidden · Show all": one quiet line a page shows while its
 *  lens hides something. Nothing when the lens is off or nothing was hidden. */
export function LensNote({ lens, hidden }: { lens: Lens; hidden: number }) {
  if (lens === null || hidden <= 0) return null;
  return (
    <p className="lens-note" data-lens-note>
      <span>
        Showing {lensWords(lens)} · <span className="num">{hidden}</span> hidden
      </span>
      <button type="button" className="btn btn--sm btn--ghost lens-note-reset" onClick={() => setTierLens(null)}>
        Show all
      </button>
    </p>
  );
}
