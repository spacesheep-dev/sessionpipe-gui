// SPDX-License-Identifier: Apache-2.0
// /feed's route entry: the page lives in FeedPage.tsx, fetched when the app is idle.
import { PageStandIn, routeChunk } from "./routeChunk";

const chunk = routeChunk(() => import("./FeedPage"));

export function Feed() {
  const m = chunk.use();
  return m ? <m.Feed /> : <PageStandIn className="feed" title="Feed" />;
}
