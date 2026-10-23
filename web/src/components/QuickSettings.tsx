// SPDX-License-Identifier: Apache-2.0
// Quick settings ("Display"): one click from the sidebar's foot (a 260 px popover beside
// it) or More › Display on a phone (a bottom sheet) to the three things a person changes
// by eye: the appearance (System / Light / Dark), the skin (Spacesheep, Paper and any
// installed from outside; never the internal Plain) and the text size, then one row to
// the Settings window. Each choice is per device (web/src/lib/theme.ts). Esc closes it
// through the global keys (data-dismiss); it leaves as it came (pop-out beside the rail,
// sheet-down on a phone, where it also follows a drag down). The keyboard and the
// install line live in Settings.

import { skinTokensFor } from "@shared/skin-api";
import { type CSSProperties, type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../lib/focus";
import { usePresence, useSheetDrag } from "../lib/motion";
import { Link, navigate } from "../lib/router";
import { fetchSkins, type InstalledSkin, isPlain, schemeLabel, useSkins } from "../lib/skins";
import {
  resolvedScheme,
  setSkin,
  setTextSize,
  setTheme,
  TEXT_SIZES,
  type TextSize,
  type Theme,
  useSettings,
} from "../lib/theme";
import { Segmented } from "./bits";

export const APPEARANCE: { value: Theme; label: string }[] = [
  { value: "auto", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
export const SIZE_LABEL: Record<TextSize, string> = { 0.9: "A−", 1: "A", 1.1: "A+", 1.25: "A++" };
/** The stops in words, for the slider's spoken value and the palette. */
export const SIZE_NAME: Record<TextSize, string> = { 0.9: "Small", 1: "Default", 1.1: "Large", 1.25: "Larger" };

/** Text size as macOS draws it: a small "A", four stops on one track, a large "A". The
 *  stops are ticks under the track; the value is spoken as its name ("Large, 110 %"). */
export function TextSizeSlider({ value, onChange }: { value: TextSize; onChange: (t: TextSize) => void }) {
  const i = Math.max(0, TEXT_SIZES.indexOf(value));
  const last = TEXT_SIZES.length - 1;
  return (
    <div className="ts-slider">
      <span className="ts-a ts-a--sm" aria-hidden="true">
        A
      </span>
      <span className="ts-track">
        <input
          type="range"
          className="slider ts-input"
          min={0}
          max={last}
          step={1}
          value={i}
          aria-label="Text size"
          aria-valuetext={`${SIZE_NAME[value]}, ${Math.round(value * 100)} %`}
          data-size={value}
          onChange={(e) => onChange(TEXT_SIZES[Number(e.target.value)] ?? 1)}
          style={{ "--slider-pct": `${(i / last) * 100}%` } as CSSProperties}
        />
        <span className="ts-ticks" aria-hidden="true">
          {TEXT_SIZES.map((t) => (
            <span key={t} className={`ts-tick ${t === value ? "ts-tick--on" : ""}`} />
          ))}
        </span>
      </span>
      <span className="ts-a ts-a--lg" aria-hidden="true">
        A
      </span>
    </div>
  );
}
export const SKIN_ADD_LINE = "sessionpipe-gui skin add <folder | skin.tgz | skin.zip | npm-package | git-url>";

// Settings.tsx (the Notifications section of the dialog) looks for the section under these
// names; it lives in NotificationsSettings.tsx. The popover itself is appearance only.
export { NotificationsSettings, NotificationsSettings as NotificationsSection } from "./NotificationsSettings";

/** A surface that is a menu already shows no context menu of its own (text fields keep
 *  the browser's, for paste). */
export function noContextMenu(e: ReactMouseEvent) {
  if (!(e.target as HTMLElement).closest("input, textarea, [contenteditable]")) e.preventDefault();
}

/** The skins a person can pick: the shipped two, then the ones installed from outside
 *  (a disabled one stays out). Plain is the internal base and is never listed. */
export function useListedSkins(): {
  builtins: InstalledSkin[];
  installed: InstalledSkin[];
  error: string | null;
} {
  const { skins, error } = useSkins();
  return {
    builtins: skins.filter((s) => s.source === "builtin" && !isPlain(s)),
    installed: skins.filter((s) => s.source !== "builtin" && !s.disabled && !isPlain(s)),
    error,
  };
}

export function GearIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6" />
    </svg>
  );
}

export function QuickSettings({
  placement,
  trigger = true,
  open: openProp,
  onOpenChange,
}: {
  placement: "rail" | "tabbar";
  /** false: no button of its own; the caller opens it through `open`. */
  trigger?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean | ((o: boolean) => boolean)) => {
    const v = typeof next === "function" ? next(open) : next;
    setOpenState(v);
    onOpenChange?.(v);
  };
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // Focus stays inside while open, Esc closes, and it goes back to the trigger after.
  useFocusTrap(pop, open, { onClose: () => setOpen(false) });
  // Mounted through its exit; on a phone the sheet follows a drag down from its grabber.
  const { mounted, closing } = usePresence(open);
  useSheetDrag(pop, () => setOpen(false), { enabled: placement === "tabbar" && open });
  const settings = useSettings();
  const { builtins, installed, error: skinsError } = useListedSkins();

  useEffect(() => {
    if (!open) return;
    void fetchSkins();
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

  const current = settings.skin.id;
  const forced = settings.skin.scheme !== "both";
  const scheme = resolvedScheme(settings);
  const row = (s: InstalledSkin) => (
    <SkinRow key={s.id} skin={s} scheme={scheme} on={current === s.id} onPick={() => setSkin(s)} />
  );
  const sheet = placement === "tabbar";

  return (
    <div className={`qs qs--${placement}`} ref={wrap}>
      {trigger && (
        <button
          type="button"
          className={`theme-btn qs-trigger ${open ? "nav-link--on" : ""}`}
          onClick={() => setOpen((o) => !o)}
          aria-label="Quick settings"
          data-tip="Display"
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <GearIcon />
        </button>
      )}
      {mounted && sheet && (
        <button
          type="button"
          className="qs-scrim"
          aria-label="Close display settings"
          tabIndex={-1}
          data-dismiss
          data-closing={closing ? "" : undefined}
          onClick={() => setOpen(false)}
        />
      )}
      {mounted && (
        <div
          className="qs-pop"
          role="dialog"
          aria-modal="true"
          aria-label="Quick settings"
          aria-hidden={closing || undefined}
          ref={pop}
          onContextMenu={noContextMenu}
          data-closing={closing ? "" : undefined}
        >
          {sheet && <span className="qs-grab" aria-hidden="true" data-sheet-handle />}
          {sheet && (
            <h2 className="qs-sheet-title" data-sheet-handle>
              Display
            </h2>
          )}
          <div className="qs-sect">
            <span className="qs-label">Appearance</span>
            <Segmented<Theme>
              value={forced ? (settings.skin.scheme as Theme) : settings.appearance}
              onChange={setTheme}
              label="Appearance"
              options={APPEARANCE.map((o) => ({
                ...o,
                title: forced ? `Set by the ${settings.skin.name} skin` : undefined,
              }))}
              disabled={forced}
            />
            {forced && <p className="qs-note">{settings.skin.name} is light only.</p>}
          </div>
          <div className="qs-sect">
            <span className="qs-label" id="qs-skin-label">
              Skin
            </span>
            <ul className="qs-themes" aria-labelledby="qs-skin-label">
              {builtins.map(row)}
              {installed.length > 0 && (
                <li className="qs-divider" aria-hidden="true">
                  Installed
                </li>
              )}
              {installed.map(row)}
            </ul>
            {skinsError && <p className="qs-note">Installed skins could not be read ({skinsError}).</p>}
          </div>
          <div className="qs-sect">
            <span className="qs-label">Text size</span>
            <TextSizeSlider value={settings.textSize} onChange={setTextSize} />
          </div>
          <div className="qs-foot">
            <Link
              to="/settings"
              className="qs-all"
              data-nav="all-settings"
              plainClick={() => {
                setOpen(false);
                navigate("/settings");
              }}
            >
              <span>Settings…</span>
              <span className="qs-all-chev" aria-hidden="true" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

/** The skin's two grounds as one tiny chip: its sidebar ground on the left, its page on
 *  the right, a hairline round it, so a row shows the skin before it is picked and never
 *  reads as a dark-mode glyph. A skin with one scheme shows that one; a token the skin
 *  does not set falls back to the page's own. */
export function SkinSwatch({ skin, scheme }: { skin: InstalledSkin; scheme: "dark" | "light" }) {
  const t = skinTokensFor(skin, skin.scheme === "both" ? scheme : (skin.scheme as "dark" | "light"));
  const side = t["--bg-3"] ?? "var(--bg-3)";
  const page = t["--bg"] ?? "var(--bg)";
  return (
    <span
      className="qs-swatch"
      aria-hidden="true"
      style={{ background: `linear-gradient(to right, ${side} 0 42%, ${page} 42%)` }}
    />
  );
}

function SkinRow({
  skin,
  scheme,
  on,
  onPick,
}: {
  skin: InstalledSkin;
  scheme: "dark" | "light";
  on: boolean;
  onPick: () => void;
}) {
  const hint = skin.error
    ? "broken"
    : skin.scheme === "both"
      ? skin.warning
        ? "low contrast"
        : ""
      : `${schemeLabel(skin.scheme)}${skin.warning ? " · low contrast" : ""}`;
  const extras = [
    skin.warning ?? "",
    skin.fonts?.length ? "fonts" : "",
    skin.css ? "css" : "",
    skin.linked ? "linked" : "",
    skin.bundled ? "bundled" : "",
  ].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        className={`qs-theme ${on ? "qs-theme--on" : ""}`}
        onClick={onPick}
        aria-pressed={on}
        disabled={!!skin.error}
        title={skin.error ?? (extras.length ? extras.join(" · ") : skin.description)}
        data-skin={skin.id}
        data-skin-source={skin.source}
      >
        <span className="qs-check" aria-hidden="true" />
        <SkinSwatch skin={skin} scheme={scheme} />
        <span className="qs-theme-name">{skin.name}</span>
        {hint && <span className="qs-theme-hint">{hint}</span>}
      </button>
    </li>
  );
}
