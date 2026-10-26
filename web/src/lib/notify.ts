// SPDX-License-Identifier: Apache-2.0
// Owned by: web. A system notification when a new answerable attention arrives on the
// stream while this tab is in the background, and the app badge (installed PWA) with the
// number open. Opt-in per device ("Notify me", in the inbox header and the quick
// settings): the browser's permission is asked once, when the toggle is turned on, and
// the choice lives in localStorage. The first snapshot never notifies: those prompts
// were already waiting when the page opened.
import { useEffect, useSyncExternalStore } from "react";
import { type OpenAttention, openAttentions, useAnswerableCount, useStore } from "../data/hooks";
import { ATTENTION_LABEL, oneLine, sessionTitle, toolLabel } from "./format";
import { navigate } from "./router";

const KEY = "sessionpipe-gui.notify";

export type NotifyPermission = NotificationPermission | "unsupported";

export interface NotifyState {
  /** The person asked for notifications here (and the browser allowed them). */
  on: boolean;
  permission: NotifyPermission;
}

const permission = (): NotifyPermission =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;

const read = (): NotifyState => {
  let want = false;
  try {
    want = localStorage.getItem(KEY) === "1";
  } catch {
    // private mode or blocked storage: off
  }
  const p = permission();
  return { on: want && p === "granted", permission: p };
};

let state: NotifyState = read();
const listeners = new Set<() => void>();
const commit = (next: NotifyState) => {
  state = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useNotifyPref(): NotifyState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Turns notifications on (asking the browser once, if it has not been asked) or off.
 *  Resolves to the resulting state: `on` stays false when the browser refused. */
export async function setNotifyPref(on: boolean): Promise<NotifyState> {
  let p = permission();
  if (on && p === "default") {
    try {
      p = await Notification.requestPermission();
    } catch {
      p = permission();
    }
  }
  const want = on && p === "granted";
  try {
    if (want) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // the choice lasts for this page only
  }
  commit({ on: want, permission: p });
  return state;
}

/** Whether a notification would reach anyone: the page is not the one being looked at. */
const inBackground = (): boolean => document.visibilityState !== "visible" || !document.hasFocus();

/** The notification for one attention. From the page when the browser allows it there
 *  (desktops), else through the service worker's registration (Android requires it). */
function show(r: OpenAttention): void {
  const s = r.session;
  const a = r.attention;
  const title = `${sessionTitle(s)} needs you · ${a.tool ? toolLabel(a.tool) : (ATTENTION_LABEL[a.kind] ?? a.kind)}`;
  const options: NotificationOptions = {
    body: a.message ? oneLine(a.message, 160) : undefined,
    tag: `${s.key}|${a.attentionId}`,
    icon: "/brand/apple-touch-icon.png",
    data: { url: "/inbox" },
  };
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      navigate("/inbox");
      n.close();
    };
  } catch {
    navigator.serviceWorker
      ?.getRegistration()
      .then((reg) => reg?.showNotification(title, options))
      .catch(() => {});
  }
}

/** The per-tab watcher: notifies on each answerable attention the stream adds after the
 *  first snapshot (when this tab is in the background and notifications are on), and keeps
 *  the app badge at the number open. Mounted once, in App. */
export function useAttentionEffects(): void {
  const store = useStore();
  useEffect(() => {
    /** Ids known so far; null until the first snapshot, which only seeds it. */
    let known: Set<string> | null = null;
    const check = () => {
      const st = store.get();
      if (!st.snapshotAt) return;
      const rows = openAttentions(st.sessions).filter((r) => r.answerable);
      const ids = new Set(rows.map((r) => `${r.session.key}|${r.attention.attentionId}`));
      if (known === null) {
        known = ids;
        return;
      }
      const fresh = rows.filter((r) => !known?.has(`${r.session.key}|${r.attention.attentionId}`));
      known = ids;
      if (fresh.length === 0 || !state.on || !inBackground()) return;
      // Oldest first, so the newest ends up on top of the stack.
      // An unattended run (`attended: false`) is in the Inbox, never a notification.
      for (const r of fresh.reverse()) if (r.session.attended !== false) show(r);
    };
    check();
    return store.subscribe(check);
  }, [store]);

  const n = useAnswerableCount();
  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (n > 0) nav.setAppBadge?.(n).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
  }, [n]);
}

/** "(n) " when answerable attentions are open, else nothing: the tab title's prefix. */
export const titlePrefix = (n: number): string => (n > 0 ? `(${n}) ` : "");
