// SPDX-License-Identifier: Apache-2.0
// /workflows' route entry: the page lives in WorkflowsPage.tsx, fetched when the app is
// idle (pages/routeChunk.tsx), with the list, the editor and the run view in one chunk.
import { PageStandIn, routeChunk } from "../../pages/routeChunk";

const chunk = routeChunk(() => import("./WorkflowsPage"));

export type WorkflowsRouteProps = { view: "list" } | { view: "workflow"; id: string } | { view: "run"; id: string };

export function Workflows(p: WorkflowsRouteProps) {
  const m = chunk.use();
  return m ? <m.WorkflowsRoute {...p} /> : <PageStandIn className="page--grouped workflows" title="Workflows" />;
}
