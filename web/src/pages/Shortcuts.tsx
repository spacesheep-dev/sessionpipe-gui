// SPDX-License-Identifier: Apache-2.0
// /shortcuts' route entry: the page lives in ShortcutsPage.tsx, fetched when the app is idle.
import { PageStandIn, routeChunk } from "./routeChunk";

const chunk = routeChunk(() => import("./ShortcutsPage"));

export function Shortcuts() {
  const m = chunk.use();
  return m ? <m.Shortcuts /> : <PageStandIn className="sc-page" title="Keyboard shortcuts" />;
}
