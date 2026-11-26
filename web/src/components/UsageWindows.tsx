// SPDX-License-Identifier: Apache-2.0
// One window of an account's limits as the Usage page draws it, shared by a free-standing
// account section and a pooled account's rows (PoolAccounts.tsx): its name, a bar of what
// is left, the figure, when it resets. A window past its reset has no bar (an empty one
// would read as none left) and says when it reset. Numbers come from lib/limits.ts only.
import type { LimitWindow } from "@shared/api";
import { isOut, readWindow, resetClock, windowLabel } from "../lib/limits";

const LOW_PERCENT = 20;

export function WindowRow({ w, now }: { w: LimitWindow; now: number }) {
  const r = readWindow(w, now);
  const out = isOut(r);
  const low = r.kind === "left" && Math.floor(r.room) <= LOW_PERCENT;
  const clock = resetClock(w.resetsAt) || undefined;
  const barClass = [
    "usage-bar",
    out ? "usage-bar--out" : low ? "usage-bar--low" : "",
    r.fill !== null && r.fill > 0 ? "usage-bar--nonzero" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li className={`usage-win ${r.kind === "reset" ? "usage-win--reset" : ""}`} data-window={w.id}>
      <span className="usage-label">{windowLabel(w)}</span>
      {r.fill !== null && (
        <span className={barClass} aria-hidden="true">
          <span style={{ width: `${r.fill * 100}%` }} />
        </span>
      )}
      {r.kind === "reset" ? (
        <span className="usage-when num" title={clock}>
          {r.when}
        </span>
      ) : (
        <>
          <span className={`usage-value num ${out ? "usage-out" : low ? "usage-low" : ""}`}>{r.value}</span>
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
