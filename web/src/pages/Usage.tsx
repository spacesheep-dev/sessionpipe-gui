// SPDX-License-Identifier: Apache-2.0
// /usage's route entry: the page lives in UsagePage.tsx, fetched when the app is idle.
import { PageStandIn, routeChunk } from "./routeChunk";

const chunk = routeChunk(() => import("./UsagePage"));

export function Usage() {
  const m = chunk.use();
  return m ? <m.Usage /> : <PageStandIn className="page--grouped usage" title="Usage" />;
}
