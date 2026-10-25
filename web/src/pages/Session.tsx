// SPDX-License-Identifier: Apache-2.0
// /s/:harness/:id — one session as a page: the SessionView scrolling the window, with
// its own title row. The same view opens beside any page in the side panel
// (components/SessionPanel.tsx). The pending-devices bar is rare, so its module arrives
// with the page rather than in the first load.
import { SessionView } from "../components/SessionView";
import { lazyModule } from "../lib/lazy";

const pending = lazyModule(() => import("../control/PendingDevices"));

export function SessionPage({ harness, id }: { harness: string; id: string }) {
  const m = pending.use();
  return (
    <>
      {m && <m.PendingDevices bar />}
      <SessionView harness={harness} id={id} mode="page" />
    </>
  );
}
