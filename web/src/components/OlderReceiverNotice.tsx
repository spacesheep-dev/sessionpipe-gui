// SPDX-License-Identifier: Apache-2.0
// The line an option shows when the receiver is older than it (lib/serverAge.ts): one
// sentence; on this computer, in the app, "Update sessionpipe" (what "Start sessionpipe"
// runs: the app's release through npx, else the sessionpipe-gui on PATH), its progress line
// while it works and its last line when it fails; and the command to copy.
import { useState } from "react";
import type { OlderReceiver } from "../lib/serverAge";
import { CommandWell } from "./bits";

const inShell = "sessionpipeShell" in window;

export function OlderReceiverNotice({ older, onUpdated }: { older: OlderReceiver; onUpdated: () => void }) {
  const [working, setWorking] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const update = async () => {
    setWorking(true);
    setFailed(null);
    setLine(null);
    try {
      const { updateLocal } = await import("../native/receiverUpdate");
      await updateLocal(setLine);
      onUpdated();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      setLine(null);
    }
  };
  return (
    <div className="settings-row settings-row--stack">
      <div className="settings-row-text">
        <span className="settings-hint">{older.sentence}</span>
        {working && line ? (
          <span className="settings-hint" role="status">
            {line}
          </span>
        ) : null}
        {failed ? (
          <span className="settings-hint" role="alert">
            Couldn't update it: {failed}
          </span>
        ) : null}
      </div>
      {older.here && inShell ? (
        <div>
          <button type="button" className="btn btn--sm btn--primary" disabled={working} onClick={() => void update()}>
            {working ? "Updating…" : "Update sessionpipe"}
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
