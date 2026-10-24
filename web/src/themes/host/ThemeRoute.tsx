// SPDX-License-Identifier: Apache-2.0
// /t/:id's route entry: the host (ThemePage.tsx, the view API and the token list it hands a
// view) is fetched when the app is idle, so it costs the first load nothing. Its frame's
// CSS stays here, in the first load, so a cold open straight into a view lays out at its
// final size from the first frame; the view itself takes longer to import than the host.
import { routeChunk } from "../../pages/routeChunk";
import "./host.css";

const chunk = routeChunk(() => import("./ThemePage"));

export function ThemeRoute({ id }: { id: string }) {
  const m = chunk.use();
  return m ? (
    <m.ThemePage id={id} />
  ) : (
    <div className="theme-page" data-theme-page={id} data-status="loading" aria-busy="true" />
  );
}
