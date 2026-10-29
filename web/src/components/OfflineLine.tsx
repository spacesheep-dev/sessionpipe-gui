// SPDX-License-Identifier: Apache-2.0
// The board's one quiet line when a paired machine you rely on is offline (lib/offline.ts
// says which): a sentence in the group headers' tier, Machines, and × to hide it until it
// changes. No colour, no icon: the rows below keep their own states. On a phone the
// sentence itself opens Machines and the × is a 44 pt target.
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../data/hooks";
import {
  acknowledge,
  heldLine,
  offlineMachines,
  offlineWords,
  pruneAcks,
  readAcks,
  unacknowledged,
  writeAcks,
} from "../lib/offline";
import { navigate } from "../lib/router";
import { useContextMenu } from "./ContextMenu";

const openMachines = () => navigate("/machines");

export function OfflineLine({ machine, hold }: { machine: string; hold: boolean }) {
  const { machines, sessions, snapshotAt } = useAppState();
  const [seen, setSeen] = useState(readAcks);
  const live = useMemo(
    () => unacknowledged(offlineMachines(machines.values(), sessions.values(), machine), seen),
    [machines, sessions, machine, seen],
  );
  // Held still with the rows under the hand: it neither appears nor clears until the board
  // lets go, or a resting pointer would find a different row (or this line) under it.
  const shown = useRef(live);
  const list = heldLine(shown.current, live, seen, hold);
  shown.current = list;
  // A machine that came back (or dropped again) forgets its hiding; not before the first
  // snapshot, whose empty list would forget everything.
  useEffect(() => {
    if (!snapshotAt) return;
    const kept = pruneAcks(seen, machines.values());
    if (kept.length === seen.length) return;
    setSeen(kept);
    writeAcks(kept);
  }, [machines, seen, snapshotAt]);
  const hide = () => {
    const next = acknowledge(seen, list);
    setSeen(next);
    writeAcks(next);
  };
  const menu = useContextMenu(() => [
    { label: "Open Machines", run: openMachines },
    { label: "Hide until it changes", run: hide },
  ]);
  if (list.length === 0) return null;
  return (
    <div className="offline-line" role="status" {...menu}>
      <button type="button" className="offline-line-text" tabIndex={-1} onClick={openMachines}>
        {offlineWords(list)}
      </button>
      <button type="button" className="btn btn--ghost btn--sm offline-line-open" onClick={openMachines}>
        Machines
      </button>
      <button
        type="button"
        className="icon-btn offline-line-x"
        aria-label="Dismiss"
        data-tip="Hide until it changes"
        onClick={hide}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
