// SPDX-License-Identifier: Apache-2.0
// Notifications on the inbox: one bell in the page bar, as Mail and Slack keep it, that
// opens a small popover with "Notify me" (the one switch for system notifications,
// lib/notify.ts; turning it on asks the browser once, a refusal there keeps it off) and
// the way to the sounds. The bell is struck through while nothing will notify. The
// switch on its own (NotifyToggle) stays for anywhere else that wants it. In the phone
// app and the Mac app the notifications are the app's, not the page's (native/appState.ts):
// the same bell and banner read the system's permission and the app's switch, and a
// refusal there is "Open Settings" ("Open System Settings" on a Mac), never the browser's
// words. On the phone "Turn on" asks the system as Settings › App does; the Mac says
// nothing under the bar while its switch is off: the struck bell says that.
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { nativeNotify, phoneShell, shellPlatform } from "../lib/device";
import { usePresence } from "../lib/motion";
import { type NotifyPermission, setNotifyPref, useNotifyPref } from "../lib/notify";
import { Link, openSettings, settingsHref, usePath } from "../lib/router";
import { settingsApp } from "../native/logic";
import { Notice, Toggle } from "./bits";
import { BellIcon } from "./Icons";

type AppState = typeof import("../native/appState");
let appState: Promise<AppState> | null = null;
/** The app's stores, fetched once and only inside an app that notifies itself. */
const loadAppState = (): Promise<AppState> => (appState ??= import("../native/appState"));

/** The app's notifications: the system's permission and the app's own switch. */
export interface AppNotify {
  /** null until the shell has answered. */
  status: "granted" | "denied" | "undetermined" | null;
  /** The app's switch ("Notify me when a session needs me", in Settings). */
  enabled: boolean;
  /** The phone app: it asks from the Inbox ("Turn on"); a computer's app does not. */
  phone: boolean;
  /** The system's own Settings as it is named here, where a refusal is undone. */
  where: string;
  /** Asks the system once (as the switch in Settings does), then turns the switch on. */
  turnOn(): Promise<void>;
  turnOff(): Promise<void>;
  /** The app's page in the system's Settings, where a refusal is undone. */
  openSettings(): void;
}

/** The app's notification state inside an app that notifies itself (the phone app, the
 *  Mac app); null in a browser, and on Windows and Linux, whose app has no notifier. */
export function useAppNotify(): AppNotify | null {
  const phone = phoneShell();
  const inApp = phone || nativeNotify();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const mod = useRef<AppState | null>(null);
  useEffect(() => {
    if (!inApp) return;
    let on = true;
    const offs: (() => void)[] = [];
    void loadAppState().then((m) => {
      if (!on) return;
      mod.current = m;
      offs.push(m.notify.subscribe(bump), m.settings.subscribe(bump));
      void m.loadNotify();
      if (!m.settings.get()) void m.loadSettings();
      bump();
    });
    return () => {
      on = false;
      for (const off of offs) off();
    };
  }, [inApp]);
  const m = mod.current;
  if (!inApp) return null;
  const set = async (enabled: boolean) => {
    const s = m?.settings.get();
    if (!m || !s) return;
    await m.patchSettings({ notifications: { ...s.notifications, enabled } }).catch(() => {});
  };
  return {
    status: m?.notify.get() ?? null,
    enabled: !!m?.settings.get()?.notifications.enabled,
    phone,
    where: settingsApp(shellPlatform()),
    turnOn: async () => {
      if (!m) return;
      const status = (await m.requestNotify()) ?? m.notify.get();
      if (status === "granted") await set(true);
    },
    turnOff: () => set(false),
    // iOS: the shell opens the app's page in Settings; Android: MainActivity's spNotify
    // opens the app's notification settings (an intent, which Rust can't send there).
    openSettings: () => {
      if (shellPlatform() === "android") {
        (globalThis as { spNotify?: { openSettings(): void } }).spNotify?.openSettings();
        return;
      }
      void import("../native/bridge").then((b) => b.invoke("app_notify_open_settings")).catch(() => {});
    },
  };
}

/** Whether the page says, under the bar, that nothing will notify: the browser refused
 *  (or can't), the phone app hasn't been allowed yet, or the Mac app's switch is on and
 *  macOS refuses (with the switch off, the struck bell says it). */
export const notifyBlocked = (app: AppNotify | null, permission: NotifyPermission): boolean =>
  app
    ? app.phone
      ? app.status === "denied" || app.status === "undetermined"
      : app.enabled && app.status === "denied"
    : permission === "denied" || permission === "unsupported";

const hintFor = (on: boolean, permission: string, app: AppNotify | null) =>
  app
    ? app.status === "denied"
      ? `Off for sessionpipe in ${app.where}.`
      : on
        ? "When a prompt needs you and the app is in the background."
        : "A system notification when a prompt needs you."
    : permission === "unsupported"
      ? "Not available in this browser."
      : permission === "denied"
        ? "Off for this site in the browser's settings."
        : on
          ? "When a prompt needs you and this tab is in the background."
          : "A system notification when a prompt needs you.";

export function NotifyToggle({ compact = false }: { compact?: boolean }) {
  const browser = useNotifyPref();
  const app = useAppNotify();
  const on = app ? app.enabled && app.status === "granted" : browser.on;
  const blocked = app
    ? app.status === "denied"
    : browser.permission === "denied" || browser.permission === "unsupported";
  const hint = hintFor(on, browser.permission, app);
  const change = (v: boolean) => void (app ? (v ? app.turnOn() : app.turnOff()) : setNotifyPref(v));
  return (
    <div className="notify" data-notify={on ? "on" : "off"} title={compact ? hint : undefined}>
      <Toggle on={on} onChange={change} label="Notify me" disabled={blocked} />
      <span className="notify-text">Notify me</span>
      {!compact && <span className="notify-hint">{hint}</span>}
    </div>
  );
}

/** The bell and its popover. */
export function NotifyMenu() {
  const browser = useNotifyPref();
  const app = useAppNotify();
  const on = app ? app.enabled && app.status === "granted" : browser.on;
  const [open, setOpen] = useState(false);
  const { mounted, closing } = usePresence(open);
  const path = usePath();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const close = () => {
    setOpen(false);
    btn.current?.focus({ preventScroll: true });
  };
  return (
    <div className="notify-menu" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="icon-btn notify-bell"
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={mounted ? id : undefined}
        data-notify={on ? "on" : "off"}
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon size={16} muted={!on} />
      </button>
      {mounted && (
        <div
          id={id}
          className="pop notify-pop"
          role="dialog"
          aria-label="Notifications"
          data-closing={closing ? "" : undefined}
        >
          <NotifyToggle />
          <div className="notify-pop-foot">
            <Link
              to={settingsHref("notifications", path)}
              plainClick={() => {
                close();
                openSettings("notifications");
              }}
              className="btn btn--sm btn--ghost"
            >
              Sounds
            </Link>
            <button type="button" className="sr-only" onClick={close} data-dismiss={open ? "" : undefined}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Notifications are off for this site · How to allow": the condition once, under the
 *  bar, with the steps behind the one button. In the phone app: "Notifications are off",
 *  with Turn on (the system's one question) or, once refused there, Open Settings. In the
 *  Mac app: "Notifications are off for sessionpipe", with Open System Settings. */
export function NotifyBlocked({ permission, app = null }: { permission: NotifyPermission; app?: AppNotify | null }) {
  const [how, setHow] = useState(false);
  if (!notifyBlocked(app, permission)) return null;
  if (app) {
    const denied = app.status === "denied";
    return (
      <div className="notify-hint">
        <Notice
          action={
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => (denied ? app.openSettings() : void app.turnOn())}
            >
              {denied ? `Open ${app.where}` : "Turn on"}
            </button>
          }
        >
          {app.phone ? "Notifications are off" : "Notifications are off for sessionpipe"}
        </Notice>
      </div>
    );
  }
  if (permission === "unsupported")
    return <p className="page-note notify-hint">Notifications are not available in this browser.</p>;
  return (
    <div className="notify-hint">
      <Notice
        action={
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-expanded={how}
            onClick={() => setHow((v) => !v)}
          >
            How to allow
          </button>
        }
      >
        Notifications are off for this site
      </Notice>
      {how && (
        <p className="notify-how">
          Open the site's settings from the icon left of the address, set Notifications to Allow, then reload this page.
        </p>
      )}
    </div>
  );
}
