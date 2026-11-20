// SPDX-License-Identifier: Apache-2.0
// The Settings window's entry, drawn over the page while the address carries
// `?settings=` (Shell.tsx SettingsHost): the window lives in SettingsWindow.tsx, fetched
// when the app is idle. Until it is in (a first open within the first second), nothing is
// drawn over the page; the window rises the moment it arrives.
import { routeChunk } from "../pages/routeChunk";

const chunk = routeChunk(() => import("./SettingsWindow"));

export function Settings() {
  const m = chunk.use();
  return m ? <m.Settings /> : null;
}
