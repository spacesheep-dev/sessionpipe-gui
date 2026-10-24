// SPDX-License-Identifier: Apache-2.0
// /phone's route entry: the three steps live in PhoneSteps.tsx, fetched when the app is idle.
import { PageStandIn, routeChunk } from "../pages/routeChunk";

const chunk = routeChunk(() => import("./PhoneSteps"));

export function PhonePage() {
  const m = chunk.use();
  return m ? <m.PhonePage /> : <PageStandIn className="page--grouped phone-page" title="Your phone" />;
}
