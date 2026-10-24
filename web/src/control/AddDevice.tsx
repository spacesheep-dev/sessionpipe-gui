// SPDX-License-Identifier: Apache-2.0
// /add-device's route entry: the page lives in AddDeviceBody.tsx, fetched when the app is idle.
import { PageStandIn, routeChunk } from "../pages/routeChunk";

const chunk = routeChunk(() => import("./AddDeviceBody"));

export function AddDevicePage() {
  const m = chunk.use();
  return m ? <m.AddDevicePage /> : <PageStandIn className="page--grouped pair add-device" title="Add this device" />;
}
