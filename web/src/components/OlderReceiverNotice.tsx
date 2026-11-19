// SPDX-License-Identifier: Apache-2.0
// The line an option shows when the receiver is older than it (lib/serverAge.ts): one
// sentence; on this computer, in the app, Update (the app's release through npx,
// native/receiverUpdate.ts), its progress line while it works, and what to do when it
// didn't work; and the command to copy, folded away in "Run it yourself". An update
// already running when the window opens (from another Settings window, or one the app
// stopped waiting for) shows as working until it ends.
import type { OlderReceiver } from "../lib/serverAge";
import { failureWords, type LocalUpdate, useUpdateRun } from "../native/receiverUpdate";
import { CommandWell } from "./bits";

const inShell = "sessionpipeShell" in window;

export function OlderReceiverNotice({
  older,
  local,
  onUpdated,
}: {
  older: OlderReceiver;
  local: LocalUpdate | null;
  onUpdated: () => void;
}) {
  const { busy, progress, failed, run } = useUpdateRun(local, onUpdated);
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
        {words ? (
          <span className="settings-hint" role="alert">
            {words.sentence}
          </span>
        ) : null}
      </div>
      {older.here && inShell ? (
        <div>
          <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => void run()}>
            {busy ? "Updating…" : "Update"}
          </button>
        </div>
      ) : null}
      {older.command ? (
        <details className="settings-details">
          <summary>Run it yourself</summary>
          {words?.detail ? <p className="settings-details-line">{words.detail}</p> : null}
          <CommandWell command={older.command} label="Copy the update command" />
        </details>
      ) : null}
    </div>
  );
}
