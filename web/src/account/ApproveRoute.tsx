// SPDX-License-Identifier: Apache-2.0
// /add-device's entry on a spacesheep account: the page lives in ApprovePhone.tsx, loaded
// when the route is first shown (only a window on an account ever asks for it).
import { PageStandIn, routeChunk } from "../pages/routeChunk";

const chunk = routeChunk(() => import("./ApprovePhone"));

export function ApprovePhonePage() {
  const m = chunk.use();
  return m ? <m.default /> : <PageStandIn className="page--grouped pair approve" title="" />;
}
