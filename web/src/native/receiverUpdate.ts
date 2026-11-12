// SPDX-License-Identifier: Apache-2.0
// The page's side of "Update sessionpipe" (Settings › Data, lib/serverAge.ts): what the
// app's launch check found about this computer's receiver (rx_local_update), and the
// click that brings it to the app's version (rx_update_local: what "Start sessionpipe"
// runs, with its progress lines). Loaded only inside the app (a dynamic import), never in
// a browser.
import { channel, invoke } from "./bridge";

/** lifecycle/supervisor.rs LocalUpdate. */
export interface LocalUpdate {
  /** The receiver checked: this computer's (its run.json names it). */
  origin: string;
  running: string;
  app: string;
  state: "current" | "updated" | "click" | "failed";
  why?: string;
}

/** What the launch check found; null when it found nothing to say, or can't be asked. */
export const localUpdate = (): Promise<LocalUpdate | null> =>
  invoke<LocalUpdate | null>("rx_local_update").catch(() => null);

/** Runs the update; each progress line goes to `onProgress`. Rejects with its last line. */
export async function updateLocal(onProgress: (message: string) => void): Promise<LocalUpdate | null> {
  const ch = channel<{ step?: string; message?: string }>((p) => {
    if (p.message) onProgress(p.message);
  });
  try {
    return await invoke<LocalUpdate | null>("rx_update_local", { onProgress: ch });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
}
