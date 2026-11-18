// SPDX-License-Identifier: Apache-2.0
// The app's own update, for page code that must not load the shell's modules: whether
// this is an app that updates itself (the shell lists "updater": the desktop app, never
// the phone app or a browser), and the update that is downloaded and waits to be
// installed, which the sidebar's Settings button marks. The update is native/appState.ts's
// store: the shell's `update` event keeps it current, and it is asked for once as the page
// starts (appState.ts wire), so a window opened after the download knows of it. The store
// is fetched once and only inside such an app.
import { useSyncExternalStore } from "react";
import { updateLine } from "../native/logic";

/** The app checks for its own updates, downloads them and installs them. */
export const selfUpdating = (): boolean => {
  const f = (globalThis as { sessionpipeShell?: { features?: unknown } }).sessionpipeShell?.features;
  return Array.isArray(f) && f.includes("updater");
};

let ready: string | null = null;
let following = false;
const listeners = new Set<() => void>();

function follow(): void {
  if (following || !selfUpdating()) return;
  following = true;
  void import("../native/appState")
    .then(({ update }) => {
      const read = () => {
        const u = update.get();
        const next = u.state === "ready" ? updateLine("", u) : null;
        if (next === ready) return;
        ready = next;
        for (const l of listeners) l();
      };
      update.subscribe(read);
      read();
    })
    .catch(() => {
      following = false;
    });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  follow();
  return () => void listeners.delete(l);
};

/** The downloaded update that waits to be installed, as the update row says it ("0.8.5 is
 *  ready"); null while there is none, and anywhere but an app that updates itself. */
export const useReadyUpdate = (): string | null =>
  useSyncExternalStore(
    subscribe,
    () => ready,
    () => null,
  );
