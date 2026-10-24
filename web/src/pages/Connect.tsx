// SPDX-License-Identifier: Apache-2.0
// /connect's route entry: the page lives in ConnectPage.tsx, fetched when the app is idle.
import { PageStandIn, routeChunk } from "./routeChunk";

const chunk = routeChunk(() => import("./ConnectPage"));

export function Connect() {
  const m = chunk.use();
  return m ? <m.Connect /> : <PageStandIn className="page--grouped connect" title="Connect" />;
}
