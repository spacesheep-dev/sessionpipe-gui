// SPDX-License-Identifier: Apache-2.0
// Quick settings ("Display"): one click from the sidebar's foot (a 260 px popover beside
// it) or More › Display on a phone (a bottom sheet) to the three things a person changes
// by eye: the appearance (System / Light / Dark), the skin (Spacesheep, Paper and any
// installed from outside; never the internal Plain) and the text size, then one row to
// the Settings window. Each choice is per device (web/src/lib/theme.ts). Esc closes it
// through the global keys (data-dismiss). The keyboard and the install line live in
// Settings.

import { skinTokensFor } from "@shared/skin-api";
import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../lib/focus";
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
      {open && sheet && (
        <button
          type="button"
          className="qs-scrim"
          aria-label="Close display settings"
          tabIndex={-1}
          data-dismiss
          onClick={() => setOpen(false)}
        />
      )}
      {open && (
        <div
          className="qs-pop"
          role="dialog"
          aria-modal="true"
          aria-label="Quick settings"
          ref={pop}
          onContextMenu={noContextMenu}
        >
          {sheet && <span className="qs-grab" aria-hidden="true" />}
          {sheet && <h2 className="qs-sheet-title">Display</h2>}
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
          <div className="qs-sect qs-sect--inline">
            <span className="qs-label">Text size</span>
            <Segmented<TextSize>
              value={settings.textSize}
              onChange={setTextSize}
              label="Text size"
              options={TEXT_SIZES.map((s) => ({
                value: s,
                label: SIZE_LABEL[s],
                title: `${Math.round(s * 100)} %`,
              }))}
            />
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

/** The skin's own ground and ink as one small circle, split on the diagonal, so a row
 *  shows the skin before it is picked. A token the skin does not set falls back to the
 *  page's own. */
export function SkinSwatch({ skin, scheme }: { skin: InstalledSkin; scheme: "dark" | "light" }) {
  const t = skinTokensFor(skin, scheme);
  const bg = t["--bg-3"] ?? t["--bg"] ?? "var(--bg-3)";
  const fg = t["--fg"] ?? "var(--fg)";
  return (
    <span
      className="qs-swatch"
      aria-hidden="true"
      style={{ background: `linear-gradient(135deg, ${bg} 50%, ${fg} 50%)` }}
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
