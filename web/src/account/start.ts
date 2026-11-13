// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The way in to the account's backend, loaded only when the shell says the
// receiver this window shows is a spacesheep account (main.tsx): it starts the backend on
// the app's own IPC and puts it where every request of the page's goes (lib/net.ts).
import { setApiBackend } from "../lib/net";
import { pushToast } from "../lib/toasts";
import { type AccountBackend, type AccountNotice, startAccountBackend } from "./backend";
import { cacheName } from "./cache";
import { accountShell, tauriCalls } from "./shell";

/** What the backend had to say once (set before the app renders). */
export const notices: AccountNotice[] = [];

/** Says each of them, once, as a quiet toast: nothing is wrong with the board, it is only
 *  not kept. */
export function showNotices(): void {
  for (const n of notices.splice(0))
    pushToast({
      id: `account|${n.kind}`,
      kind: "delivered",
      sticky: false,
      label: "notice",
      title:
        n.kind === "cache_memory" ? "Sessions are not kept on this phone" : "Labels and read marks are not being saved",
      body:
        n.kind === "cache_memory"
          ? "Its storage could not be opened, so they load again each time the app opens."
          : "This phone could not write them down just now.",
      at: Date.now(),
      ms: 12_000,
    });
}

export async function startAccount(): Promise<AccountBackend | null> {
  const shell = accountShell();
  if (!shell) return null;
  const notice = (n: AccountNotice): void => void notices.push(n);
  let backend: AccountBackend;
  try {
    backend = await startAccountBackend({ shell, calls: tauriCalls, notice });
  } catch (e) {
    // What was kept could not be read into a board (a cache from a version that wrote it
    // another way, a write cut short): never a blank page. It is deleted and the board is
    // read from the relay again, kept in memory this once.
    console.error("[account] the kept board could not be read:", e);
    notices.length = 0;
    try {
      indexedDB.deleteDatabase(cacheName(shell.id));
    } catch {
      // no IndexedDB to delete from
    }
    backend = await startAccountBackend({ shell, calls: tauriCalls, idb: null, notice });
  }
  setApiBackend(backend.answer);
  (window as unknown as { __sessionpipeAccount?: AccountBackend }).__sessionpipeAccount = backend;
  return backend;
}
