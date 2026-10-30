// SPDX-License-Identifier: Apache-2.0
// The skins every install has. Two are listed: sessionpipe, the default, in both schemes
// (the brand's ink, graphite and paper neutrals, its orange for needs you, a crimson for
// errors, nothing else coloured; the same values as tokens.css), and Paper (warm paper and
// ink, light only). Plain is the scheme's own tokens from tokens.css and sets nothing: the
// internal base, never listed in the appearance UI. Working, stale, idle and done are
// neutral tiers in every skin (tokens.css), so none sets them. A device on a built-in no
// longer listed (Spacesheep, the default before the brand) gets the default, silently
// (lib/theme.ts). docs/brand.md has the palette and why each value is what it is.
import type { InstalledSkin, SkinTokens } from "./skin-api.js";

/** The skin a device with no stored choice gets. */
export const DEFAULT_SKIN_ID = "sessionpipe";
/** The skin that sets no tokens: the scheme's own. Not listed in the appearance UI. */
export const PLAIN_SKIN_ID = "plain";

const builtin = (s: Omit<InstalledSkin, "source" | "version">): InstalledSkin => ({
  ...s,
  version: "",
  source: "builtin",
});

/** sessionpipe, light: white ground, paper wells, ink text. tokens.css's light set. */
const LIGHT: SkinTokens = {
  "--bg": "#ffffff",
  "--bg-2": "#ffffff",
  "--bg-3": "#f5f5f3",
  "--bg-4": "#ebebe7",
  "--line": "#e4e4e1",
  "--line-2": "#dcdcd8",
  "--fg": "#141414",
  "--fg-2": "#454545",
  "--fg-3": "#5c5c5a",
  "--fg-4": "#858581",
  "--needs": "#ff5a1f",
  "--needs-fg": "#c13b01",
  "--needs-bg": "#fff5f2",
  "--needs-line": "#ffc5b1",
  "--needs-ink": "#141414",
  "--tint": "#ff5a1f",
  "--tint-fg": "#c13b01",
  "--ok": "oklch(0.6 0.12 155)",
  "--err": "#cb234d",
  "--err-soft": "#e07a93",
  "--err-bg": "#fbf0f3",
  "--focus": "#f24d06",
  "--mark": "#ffe1d7",
  "--mark-fg": "#141414",
  "--shadow": "none",
};

/** sessionpipe, dark: ink ground, warm-grey text. tokens.css's dark set. */
const DARK: SkinTokens = {
  "--bg": "#141414",
  "--bg-2": "#1c1c1b",
  "--bg-3": "#222222",
  "--bg-4": "#2a2a2a",
  "--line": "#2a2a2a",
  "--line-2": "#3a3a39",
  "--fg": "#f5f5f3",
  "--fg-2": "#c4c4c0",
  "--fg-3": "#9a9a96",
  "--fg-4": "#6e6e6a",
  "--needs": "#ff5a1f",
  "--needs-fg": "#ff5a1f",
  "--needs-bg": "#221815",
  "--needs-line": "#662d18",
  "--needs-ink": "#141414",
  "--tint": "#ff5a1f",
  "--tint-fg": "#ff5a1f",
  "--ok": "oklch(0.74 0.12 155)",
  "--err": "#ef4c73",
  "--err-soft": "#a8405a",
  "--err-bg": "#23181b",
  "--focus": "#ff5a1f",
  "--mark": "#512617",
  "--mark-fg": "#f5f5f3",
  "--shadow": "none",
};

export const BUILTIN_SKINS: readonly InstalledSkin[] = [
  builtin({
    id: DEFAULT_SKIN_ID,
    name: "sessionpipe",
    description: "Ink, paper and the sessionpipe orange for needs you.",
    scheme: "both",
    tokens: { dark: DARK, light: LIGHT },
  }),
  builtin({
    id: PLAIN_SKIN_ID,
    name: "Plain",
    description: "The stock tokens; the base every skin starts from.",
    scheme: "both",
    tokens: {},
  }),
  builtin({
    id: "paper",
    name: "Paper",
    description: "Warm paper and ink, light only.",
    scheme: "light",
    tokens: {
      light: {
        "--bg": "#f5f4ef",
        "--bg-2": "#faf9f5",
        "--bg-3": "#ecebe4",
        "--bg-4": "#e4e2da",
        "--line": "#e4e2da",
        "--line-2": "#d9d7ce",
        "--fg": "#1f1e1d",
        "--fg-2": "#474643",
        "--fg-3": "#5c5b57",
        "--fg-4": "#85837d",
        // The orange's 3:1 cut: the brand's own on paper is 2.8:1, too faint for a dot alone.
        "--needs": "#f24d06",
        "--needs-fg": "#c13b01",
        "--needs-bg": "#f6ebe3",
        "--needs-line": "#f9bea6",
        "--needs-ink": "#1f1e1d",
        // The phone's tint takes the same cut, for the same reason.
        "--tint": "#f24d06",
        "--tint-fg": "#c13b01",
        "--ok": "oklch(0.58 0.1 150)",
        "--err": "#cb234d",
        "--err-soft": "#d65776",
        "--err-bg": "#f2e5e4",
        "--focus": "#f24d06",
        "--mark": "#f8ccb9",
        "--mark-fg": "#1f1e1d",
        // The label dots, a shade warmer and quieter on paper.
        "--label-red": "oklch(0.6 0.12 26)",
        "--label-orange": "oklch(0.68 0.09 62)",
        "--label-yellow": "oklch(0.76 0.1 88)",
        "--label-green": "oklch(0.62 0.08 145)",
        "--label-blue": "oklch(0.58 0.08 245)",
        "--label-purple": "oklch(0.56 0.08 310)",
        "--label-grey": "oklch(0.64 0.01 70)",
      },
    },
  }),
];
