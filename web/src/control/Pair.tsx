// SPDX-License-Identifier: Apache-2.0
// /pair/<code>'s route entry. The page's frame is drawn here at once; the approval itself
// (PairBody.tsx, also the setup page's step) is fetched when the app is idle.
import { BackButton, PageBar } from "../components/PageBar";
import { back } from "../lib/router";
import { routeChunk } from "../pages/routeChunk";

const chunk = routeChunk(() => import("./PairBody"));

export function PairPage({ code }: { code: string }) {
  const m = chunk.use();
  return (
    <div className="page page--doc page--grouped pair">
      <PageBar title="Pair a machine" back={<BackButton onClick={() => back("/machines")} label="Machines" />} />
      {m ? <m.PairBody code={code} /> : null}
    </div>
  );
}
