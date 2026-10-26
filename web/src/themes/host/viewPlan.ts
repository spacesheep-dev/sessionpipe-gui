// SPDX-License-Identifier: Apache-2.0
// Where a view's code comes from (NATIVE-SPEC §2.3). In a browser: the receiver serves the
// page and every view, at /themes/<id>/. In the native app only code shipped in the signed
// app runs in its origin: the views that ship with the GUI (Canvas, Office) are bundled
// into it at the same /themes/<id>/ path, and any other view opens in a window of its own
// on the receiver's origin, with no IPC. Never an import from rx:.
import type { InstalledTheme } from "@shared/theme-api";

/** The views the app carries itself (apps/desktop/scripts/assemble-frontend.sh). */
export const APP_VIEWS: ReadonlySet<string> = new Set(["canvas", "office"]);

export type ViewPlan = { kind: "page"; base: string } | { kind: "window"; path: string };

export function viewPlan(
  theme: Pick<InstalledTheme, "id" | "url" | "bundled">,
  inShell: boolean,
  origin: string,
): ViewPlan {
  if (inShell && !(theme.bundled && APP_VIEWS.has(theme.id))) return { kind: "window", path: theme.url };
  return { kind: "page", base: `${origin}${theme.url}` };
}
