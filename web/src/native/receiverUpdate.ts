// SPDX-License-Identifier: Apache-2.0
// The page's side of "Update sessionpipe" (Settings › Data, lib/serverAge.ts): what the
// app's launch check found about this computer's receiver (rx_local_update), and the
// click that brings it to the app's version (rx_update_local: the app's release through
// npx, with its progress lines). Loaded only inside the app (a dynamic import), never in
// a browser.
import { channel, invoke } from "./bridge";

/** lifecycle/supervisor.rs LocalUpdate. */
export interface LocalUpdate {
  /** The receiver checked: this computer's (its run.json names it). */
  origin: string;
  running: string;
  app: string;
  state: "current" | "updated" | "click" | "failed" | "unchanged";
  why?: string;
  /** An install or update is running from the app now, and its last progress line. */
  busy: boolean;
  progress?: string;
}

/** lifecycle/supervisor.rs UpdateFailure: why "Update sessionpipe" didn't work. */
export interface UpdateFailure {
  kind: "notRunning" | "download" | "stillRunning" | "busy" | "failed";
  line: string;
  log?: string;
}

/** What the launch check found; null when it found nothing to say, or can't be asked. */
export const localUpdate = (): Promise<LocalUpdate | null> =>
  invoke<LocalUpdate | null>("rx_local_update").catch(() => null);

const asFailure = (e: unknown): UpdateFailure =>
  e && typeof e === "object" && "kind" in e && "line" in e
    ? (e as UpdateFailure)
    : { kind: "failed", line: e instanceof Error ? e.message : String(e) };

/** Runs the update; each progress line goes to `onProgress`. Rejects with an UpdateFailure. */
export async function updateLocal(onProgress: (message: string) => void): Promise<LocalUpdate | null> {
  const ch = channel<{ step?: string; message?: string }>((p) => {
    if (p.message) onProgress(p.message);
  });
  try {
    return await invoke<LocalUpdate | null>("rx_update_local", { onProgress: ch });
  } catch (e) {
    throw asFailure(e);
  }
}
