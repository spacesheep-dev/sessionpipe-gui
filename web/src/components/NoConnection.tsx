// SPDX-License-Identifier: Apache-2.0
// The Board's and the Inbox's first load when the first snapshot doesn't come (data/hooks.ts
// useFirstLoad): one sentence that names the place (lib/device.ts reachName) and the next
// step. A wait is said with no button ("Connecting to studio-mac…": the stream is open and
// reopens by itself); a failure gets Retry, the menu bar's word for it, and, for this
// computer's own receiver in the desktop app, Start sessionpipe beside it, the welcome's
// start (native/StartHere.tsx, loaded only then, so a browser never loads native code).
// Centred where the rows would be; read out as it changes.
import { lazy, Suspense } from "react";
import { useAppState, useStore } from "../data/hooks";
import { localReceiver, reachName } from "../lib/device";
import { NEW_WORDS, REUSED } from "../native/accountWords";
import { EmptyState } from "./bits";

const loadStart = () => import("../native/StartHere");
const Start = lazy(() => loadStart().then((m) => ({ default: m.NoConnectionStart })));

export function NoConnection({ slow }: { slow: boolean }) {
  const { connection } = useAppState();
  const store = useStore();
  const where = reachName();
  const local = localReceiver();
  // Fetched while it still waits, so a failure that follows has its Start at once.
  if (local) void loadStart();
  if (slow) return <EmptyState center role="status" className="no-conn" title={REUSED.connecting(where)} />;
  const retry = (
    <button type="button" className="btn btn--sm" onClick={() => store.reconnect()}>
      Retry
    </button>
  );
  // This computer's own receiver is reached without the network: "offline" says nothing of it.
  if (local)
    return (
      <Suspense fallback={<EmptyState center role="status" className="no-conn" title={NEW_WORDS.reachFailed(where)} />}>
        <Start where={where} retry={retry} onStarted={() => store.reconnect()} />
      </Suspense>
    );
  return (
    <EmptyState
      center
      role="status"
      className="no-conn"
      title={connection === "offline" ? NEW_WORDS.reachOffline : NEW_WORDS.reachFailed(where)}
      actions={retry}
    />
  );
}
