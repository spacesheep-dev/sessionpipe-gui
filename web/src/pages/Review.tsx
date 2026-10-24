// SPDX-License-Identifier: Apache-2.0
// /review's route entry: the page lives in ReviewPage.tsx, fetched when the app is idle.
import { PageStandIn, routeChunk } from "./routeChunk";

const chunk = routeChunk(() => import("./ReviewPage"));

export function Review() {
  const m = chunk.use();
  return m ? <m.Review /> : <PageStandIn className="review" title="Review" />;
}
