// SPDX-License-Identifier: Apache-2.0
// The skins every install has. Two are listed: Spacesheep, the default, in both schemes
// (cool neutrals of one hue, flame for needs you, red for errors, nothing else coloured),
// and Paper (warm paper, light only). Plain is the scheme's own tokens from tokens.css and
// sets nothing: the internal base, never listed in the appearance UI. Working, stale,
// idle and done are neutral tiers in every skin (tokens.css), so none sets them.
// Credits: docs/brand.md, "Third-party marks".
import type { InstalledSkin } from "./skin-api.js";

/** The skin a device with no stored choice gets. */
export const DEFAULT_SKIN_ID = "spacesheep";
/** The skin that sets no tokens: the scheme's own. Not listed in the appearance UI. */
export const PLAIN_SKIN_ID = "plain";

const builtin = (s: Omit<InstalledSkin, "source" | "version">): InstalledSkin => ({
  ...s,
  version: "",
  source: "builtin",
});

export const BUILTIN_SKINS: readonly InstalledSkin[] = [
  builtin({
    id: DEFAULT_SKIN_ID,
    name: "Spacesheep",
    description: "Cool neutrals and the spacesheep.dev flame for needs you.",
    scheme: "both",
    tokens: {
      dark: {
        "--bg": "oklch(0.185 0.01 285)",
        "--bg-2": "oklch(0.225 0.011 285)",
        "--bg-3": "oklch(0.25 0.011 285)",
        "--bg-4": "oklch(0.3 0.012 285)",
        "--line": "oklch(0.29 0.01 285)",
        "--line-2": "oklch(0.36 0.012 285)",
        "--fg": "oklch(0.95 0.005 285)",
        "--fg-2": "oklch(0.8 0.01 285)",
        "--fg-3": "oklch(0.68 0.012 285)",
        "--fg-4": "oklch(0.56 0.012 285)",
        "--needs": "oklch(0.77 0.145 55)",
        "--needs-fg": "oklch(0.83 0.11 60)",
        "--needs-bg": "oklch(0.235 0.03 50)",
        "--needs-line": "oklch(0.42 0.08 52)",
        "--ok": "oklch(0.74 0.12 155)",
        "--err": "oklch(0.72 0.15 25)",
        "--err-soft": "oklch(0.68 0.09 25)",
        "--err-bg": "oklch(0.26 0.04 25)",
        "--focus": "oklch(0.72 0.09 285)",
        "--mark": "oklch(0.42 0.08 95)",
        "--mark-fg": "oklch(0.95 0.07 98)",
        "--shadow": "none",
      },
      light: {
        "--bg": "oklch(0.993 0.002 285)",
        "--bg-2": "oklch(1 0 0)",
        "--bg-3": "oklch(0.962 0.003 285)",
        "--bg-4": "oklch(0.928 0.004 285)",
        "--line": "oklch(0.912 0.004 285)",
        "--line-2": "oklch(0.85 0.006 285)",
        "--fg": "oklch(0.22 0.012 285)",
        "--fg-2": "oklch(0.4 0.012 285)",
        "--fg-3": "oklch(0.51 0.012 285)",
        "--fg-4": "oklch(0.62 0.01 285)",
        "--needs": "oklch(0.68 0.17 50)",
        "--needs-fg": "oklch(0.52 0.15 45)",
        "--needs-bg": "oklch(0.975 0.014 60)",
        "--needs-line": "oklch(0.87 0.06 55)",
        "--ok": "oklch(0.6 0.12 155)",
        "--err": "oklch(0.55 0.19 27)",
        "--err-soft": "oklch(0.58 0.12 27)",
        "--err-bg": "oklch(0.97 0.015 25)",
        "--focus": "oklch(0.55 0.1 285)",
        "--mark": "oklch(0.93 0.1 95)",
        "--mark-fg": "oklch(0.38 0.08 70)",
        "--shadow": "none",
      },
    },
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
        "--bg": "oklch(0.972 0.01 80)",
        "--bg-2": "oklch(0.994 0.005 80)",
        "--bg-3": "oklch(0.943 0.013 80)",
        "--bg-4": "oklch(0.908 0.016 80)",
        "--line": "oklch(0.895 0.014 80)",
        "--line-2": "oklch(0.83 0.018 78)",
        "--fg": "oklch(0.24 0.02 60)",
        "--fg-2": "oklch(0.43 0.02 60)",
        "--fg-3": "oklch(0.52 0.018 60)",
        "--fg-4": "oklch(0.62 0.014 60)",
        "--needs": "oklch(0.7 0.15 62)",
        "--needs-fg": "oklch(0.48 0.12 58)",
        "--needs-bg": "oklch(0.965 0.02 78)",
        "--needs-line": "oklch(0.86 0.07 72)",
        "--ok": "oklch(0.58 0.1 150)",
        "--err": "oklch(0.54 0.16 25)",
        "--err-soft": "oklch(0.6 0.09 25)",
        "--err-bg": "oklch(0.955 0.025 25)",
        "--focus": "oklch(0.5 0.05 60)",
        "--mark": "oklch(0.92 0.08 90)",
        "--mark-fg": "oklch(0.4 0.09 70)",
        // The label dots, a shade warmer and quieter on paper.
        "--label-red": "oklch(0.6 0.12 26)",
        "--label-orange": "oklch(0.64 0.1 46)",
        "--label-yellow": "oklch(0.76 0.1 88)",
        "--label-green": "oklch(0.62 0.08 145)",
        "--label-blue": "oklch(0.58 0.08 245)",
        "--label-purple": "oklch(0.56 0.08 310)",
        "--label-grey": "oklch(0.64 0.01 70)",
      },
    },
  }),
];
