// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. What the session view (components/SessionBody.tsx) shows for a
// session the receiver does not hold: the history transcript from the search index, its
// module fetched on demand, or the view's own "No such session here" when the index does
// not know it either.
import type { ReactNode, RefObject } from "react";
import { lazyModule } from "../lib/lazy";

const history = lazyModule(() => import("./History"));

export function HistoryOrMissing(props: {
  harness: string;
  id: string;
  mode: "page" | "panel";
  rootRef?: RefObject<HTMLDivElement>;
  fallback: ReactNode;
}) {
  const m = history.use();
  return m ? <m.HistorySession {...props} /> : null;
}
