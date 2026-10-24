// SPDX-License-Identifier: Apache-2.0
// /themes' route entry (Views and plugins): the page lives in ThemesPage.tsx, fetched when
// the app is idle.
import { PageStandIn, routeChunk } from "./routeChunk";

const chunk = routeChunk(() => import("./ThemesPage"));

export function Themes() {
  const m = chunk.use();
  return m ? <m.Themes /> : <PageStandIn className="page--grouped themes" title="Views" />;
}
