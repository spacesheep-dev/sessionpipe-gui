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
 *  not kept. Of the documents, the person's own are said (their labels and read marks);
 *  the usage limits are read again from the events, so nothing of theirs is lost. */
export function showNotices(): void {
  for (const n of notices.splice(0)) {
    const words = noticeWords(n);
    if (!words) continue;
    pushToast({
      id: `account|${n.kind}`,
      kind: "delivered",
      sticky: false,
      label: "notice",
      title: words.title,
      body: words.body,
      at: Date.now(),
      ms: 12_000,
    });
  }
}

/** A notice in words, or null when there is nothing a person needs to be told. */
export function noticeWords(n: AccountNotice): { title: string; body: string } | null {
  if (n.kind === "cache_memory")
    return {
      title: "Sessions are not kept on this phone",
      body: "Its storage could not be opened, so they load again each time the app opens.",
    };
  if (n.names?.includes("labels") || n.names?.includes("marks"))
    return {
      title: "Labels and read marks are not being saved",
      body: "This phone could not read the ones it keeps, so changes made now are not kept.",
    };
  return null;
}

/** The account is gone from this phone and the page holds nothing of it any more: the
 *  window is opened again on what the shell shows now (another receiver, or none: the
 *  welcome). */
const leave = (): void => {
  location.replace("/");
};

/** Starts the backend on what the phone kept. When that cannot be read into a board (a
 *  cache from a version that wrote it another way, a write cut short) it is never a blank
 *  page: what was kept is deleted and the backend is started once more with nowhere to
 *  keep the sessions, so the board is read from the relay again. That is for this launch
 *  only (the next one has its storage back), so the notice that sessions are not kept on
 *  this phone is not passed on from it: it would not be true. */
export async function startOnKept(
  start: (o: { idb?: null; notice: (n: AccountNotice) => void }) => Promise<AccountBackend>,
  o: { notice: (n: AccountNotice) => void; forgetKept: () => void; unsay: () => void },
): Promise<AccountBackend> {
  try {
    return await start({ notice: o.notice });
  } catch (e) {
    console.error("[account] the kept board could not be read:", e);
    // Whatever the first try had to say is of a backend that never came up.
    o.unsay();
    o.forgetKept();
    return start({ idb: null, notice: (n) => void (n.kind !== "cache_memory" && o.notice(n)) });
  }
}

/** What of the backend the page leaves where a test, or somebody looking into a problem,
 *  can read it: how the account stands and what was asked. Nothing that acts (no send, no
 *  disconnect, no key): a script in the page has the app's own ways for those already. */
export type AccountHook = Pick<AccountBackend, "view" | "subscribe" | "asked" | "flushed">;
export const hookOf = (b: AccountBackend): AccountHook => ({
  view: () => b.view(),
  subscribe: (l) => b.subscribe(l),
  asked: b.asked,
  flushed: () => b.flushed(),
});

export async function startAccount(): Promise<AccountBackend | null> {
  const shell = accountShell();
  if (!shell) return null;
  const backend = await startOnKept((o) => startAccountBackend({ shell, calls: tauriCalls, onGone: leave, ...o }), {
    notice: (n) => void notices.push(n),
    unsay: () => {
      notices.length = 0;
    },
    forgetKept: () => {
      try {
        indexedDB.deleteDatabase(cacheName(shell.id));
      } catch {
        // no IndexedDB to delete from
      }
    },
  });
  setApiBackend(backend.answer);
  (window as unknown as { __sessionpipeAccount?: AccountHook }).__sessionpipeAccount = hookOf(backend);
  return backend;
}
