// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. /search's route entry: the page lives in SearchPage.tsx (and
// web/src/search/*), fetched when the app is idle, so the first load carries none of it.
import { PageStandIn, routeChunk } from "./routeChunk";

const chunk = routeChunk(() => import("./SearchPage"));

export function Search() {
  const m = chunk.use();
  return m ? <m.Search /> : <PageStandIn className="sx" title="Search" />;
}
