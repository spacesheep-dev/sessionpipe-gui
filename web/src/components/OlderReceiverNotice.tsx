// SPDX-License-Identifier: Apache-2.0
// The line an option shows when the receiver is older than it (lib/serverAge.ts): one
// sentence; on this computer, in the app, "Update sessionpipe" (the app's release through
// npx), its progress line while it works, and what to do when it didn't work; and the
// command to copy. An update already running when the window opens (from another Settings
// window, or one the app stopped waiting for) shows as working until it ends.
import { useEffect, useState } from "react";
import type { OlderReceiver } from "../lib/serverAge";
import type { LocalUpdate, UpdateFailure } from "../native/receiverUpdate";
import { CommandWell } from "./bits";

export type LocalUpdateState = LocalUpdate;

const inShell = "sessionpipeShell" in window;

/** The failure, in the words the notice shows: the sentence, and a small line under it. */
export function failureWords(f: UpdateFailure): { sentence: string; detail?: string } {
  if (f.kind === "notRunning")
    return {
      sentence: "The update didn't finish, and sessionpipe isn't running right now. Press Update again.",
      detail: f.log,
    };
  return { sentence: "Couldn't update it. Press Update again, or run the command below.", detail: f.line };
}

export function OlderReceiverNotice({
  older,
  local,
  onUpdated,
}: {
  older: OlderReceiver;
  local: LocalUpdate | null;
  onUpdated: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [failed, setFailed] = useState<UpdateFailure | null>(null);
  // Another run's: read again until it ends, then the version.
  const elsewhere = !working && !!local?.busy;
  useEffect(() => {
    if (!elsewhere) return;
    const t = setInterval(onUpdated, 1500);
    return () => clearInterval(t);
  }, [elsewhere, onUpdated]);
  const update = async () => {
    setWorking(true);
    setFailed(null);
    setLine(null);
    try {
      const { updateLocal } = await import("../native/receiverUpdate");
      await updateLocal(setLine);
    } catch (e) {
      const f = e as UpdateFailure;
      // Still at work in the background, or another run: shown as working, not as failed.
      if (f.kind !== "stillRunning" && f.kind !== "busy") setFailed(f);
    } finally {
      setWorking(false);
      setLine(null);
      onUpdated();
    }
  };
  const busy = working || elsewhere;
  const progress = working ? line : elsewhere ? (local?.progress ?? null) : null;
  const words = failed ? failureWords(failed) : null;
  return (
    <div className="settings-row settings-row--stack">
      <div className="settings-row-text">
        <span className="settings-hint">{older.sentence}</span>
        {busy && progress ? (
          <span className="settings-hint" role="status">
            {progress}
          </span>
        ) : null}
        {words && !busy ? (
          <span role="alert" className="older-failure">
            <span className="settings-hint">{words.sentence}</span>
            {words.detail ? <span className="settings-hint older-detail">{words.detail}</span> : null}
          </span>
        ) : null}
      </div>
      {older.here && inShell ? (
        <div>
          <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => void update()}>
            {busy ? "Updating…" : "Update sessionpipe"}
          </button>
        </div>
      ) : null}
      {older.command ? (
        <>
          <span className="settings-hint">Or run this in a terminal:</span>
          <div className="settings-well">
            <CommandWell command={older.command} label="Copy the update command" />
          </div>
        </>
      ) : null}
    </div>
  );
}
