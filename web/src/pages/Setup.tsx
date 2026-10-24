// SPDX-License-Identifier: Apache-2.0
// /setup's route entry: the checklist lives in SetupPage.tsx, fetched when the app is idle,
// or straight away on a device that has not seen setup (a first run is about to land here).
import { setupSeen } from "../setup/api";
import { PageStandIn, routeChunk } from "./routeChunk";

const chunk = routeChunk(() => import("./SetupPage"), !setupSeen());

export function Setup() {
  const m = chunk.use();
  return m ? <m.Setup /> : <PageStandIn className="page--grouped setup" title="Set up sessionpipe gui" />;
}
