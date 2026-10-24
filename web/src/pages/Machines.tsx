// SPDX-License-Identifier: Apache-2.0
// /machines' route entry: the page lives in MachinesPage.tsx, fetched when the app is idle.
import { PageStandIn, routeChunk } from "./routeChunk";

const chunk = routeChunk(() => import("./MachinesPage"));

export function Machines() {
  const m = chunk.use();
  return m ? <m.Machines /> : <PageStandIn className="page--grouped machines" title="Machines" />;
}
