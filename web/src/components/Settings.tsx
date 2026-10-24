// SPDX-License-Identifier: Apache-2.0
// The Settings window's route entry: the window lives in SettingsWindow.tsx, fetched when
// the app is idle. Until it is in (a first open within the first second), nothing is drawn
// over the board; the window rises the moment it arrives.
import { routeChunk } from "../pages/routeChunk";

const chunk = routeChunk(() => import("./SettingsWindow"));

export function Settings() {
  const m = chunk.use();
  return m ? <m.Settings /> : null;
}
