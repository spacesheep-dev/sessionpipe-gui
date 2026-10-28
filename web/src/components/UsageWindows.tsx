// SPDX-License-Identifier: Apache-2.0
// One window of an account's limits as the Usage page draws it, shared by a free-standing
// account section and a pooled account's rows (PoolAccounts.tsx): its name, a bar of what
// is left, the figure, when it resets. A window past its reset has no bar (an empty one
// would read as none left) and says when it reset. Numbers come from lib/limits.ts only.
import type { LimitWindow } from "@shared/api";
import { isOut, readWindow, resetClock, windowLabel } from "../lib/limits";

export function WindowRow({ w, now }: { w: LimitWindow; now: number }) {
  const r = readWindow(w, now);
  const clock = resetClock(w.resetsAt) || undefined;
  return (
    <li className={`usage-win ${r.kind === "reset" ? "usage-win--reset" : ""}`} data-window={w.id}>
      <span className="usage-label">{windowLabel(w)}</span>
      {r.fill !== null && (
        <span className="usage-bar" aria-hidden="true">
          <span style={{ width: `${r.fill * 100}%` }} />
        </span>
      )}
      {r.kind === "reset" ? (
        <span className="usage-when num" title={clock}>
          {r.when}
        </span>
      ) : (
        <>
          <span className={`usage-value num ${isOut(r) ? "usage-out" : ""}`}>{r.value}</span>
          {r.when && (
            <span className="usage-when num" title={clock}>
              {r.when}
            </span>
          )}
        </>
      )}
    </li>
  );
}
