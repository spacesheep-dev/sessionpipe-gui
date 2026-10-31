// SPDX-License-Identifier: Apache-2.0
// The first-run sheet (NATIVE-SPEC §3.9): once, over the board, asking for nothing up
// front. On the Mac, three switches, all off; each takes effect when turned on
// (notification permission is asked only then), and Done closes it for good. On the
// phone it is the last screen of the onboarding: "You're in", the one step left
// (the computer approves this iPhone once, so it can answer prompts), where that is in
// the computer's own labels, Ask <computer> to approve and Later. Notifications are
// offered where they belong (Settings › App, the inbox's banner), not here.
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toggle } from "../components/bits";
import { navigate } from "../lib/router";
import { type AppSettings, loadSettings, patchSettings, requestNotify, setHotkey, settings, useCell } from "./appState";
import { invoke } from "./bridge";
import { DEFAULT_HOTKEY, FIRST_RUN_KEY, firstRunDue, hotkeyLabel, notifyToggle, settingsApp } from "./logic";
import { type Phone, WORDS } from "./onboarding";
import { features, platform, shellInfo } from "./shell";
import "./native.css";

const seenHere = (): boolean => {
  try {
    return !!localStorage.getItem(FIRST_RUN_KEY);
  } catch {
    return false;
  }
};

export async function maybeShowFirstRun(): Promise<void> {
  const s = await loadSettings();
  if (!firstRunDue(s, seenHere())) return;
  const host = document.createElement("div");
  host.className = "first-run-host";
  document.body.append(host);
  const root = createRoot(host);
  const done = () => {
    try {
      localStorage.setItem(FIRST_RUN_KEY, "1");
    } catch {}
    void invoke("app_first_run_done").catch(() => {});
    root.unmount();
    host.remove();
  };
  const p = platform();
  const phone: Phone | null = p === "ios" || p === "android" ? p : null;
  root.render(
    <StrictMode>{phone ? <Connected phone={phone} onDone={done} /> : <FirstRun onDone={done} />}</StrictMode>,
  );
}

/** The notifications switch: permission is asked when it is turned on, never before. */
function NotifyRow({ label, where, onNote }: { label: string; where: string; onNote: (n: string | null) => void }) {
  const s = useCell(settings);
  const notifications = s?.notifications;
  return (
    <li className="first-run-row">
      <span className="first-run-label">{label}</span>
      <Toggle
        label={label}
        on={!!notifications?.enabled}
        disabled={!s}
        onChange={async (on) => {
          const r = await notifyToggle(on, requestNotify, where);
          onNote(r.note);
          if (notifications)
            void patchSettings({ notifications: { ...notifications, enabled: r.enabled } }).catch(() => {});
        }}
      />
    </li>
  );
}

/** The phone's: the board is up behind it, and one step is left before it can send. */
export function Connected({ phone, onDone }: { phone: Phone; onDone: () => void }) {
  const f = features();
  const computer = shellInfo()?.receiver?.name || "your computer";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  // /add-device?ask=1 files the device request itself: "Ask studio-mac to approve" is one tap.
  const ask = () => {
    onDone();
    navigate("/add-device?ask=1");
  };
  const signer = f.has("signer");
  return (
    <>
      <div className="menu-scrim menu-scrim--dialog first-run-scrim" aria-hidden="true" />
      <div
        className="confirm first-run first-run--phone"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-title"
        aria-describedby="first-run-body"
        ref={ref}
        tabIndex={-1}
        data-first-run="phone"
      >
        <span className="menu-grab" aria-hidden="true" />
        <h2 className="confirm-title" id="first-run-title">
          {WORDS.connected.title}
        </h2>
        <p className="confirm-body" id="first-run-body">
          {signer ? WORDS.connected.body(phone, computer) : WORDS.connected.bodyNoSigner}
        </p>
        {signer && <p className="first-run-where">{WORDS.connected.where(computer)}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn btn--ghost onb-quiet" data-later onClick={onDone}>
            {signer ? WORDS.connected.later : WORDS.connected.done}
          </button>
          {signer && (
            <button type="button" className="btn btn--primary onb-primary" data-ask onClick={ask}>
              {WORDS.connected.ask(computer)}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** The Mac's. */
export function FirstRun({ onDone }: { onDone: () => void }) {
  const s = useCell(settings);
  const f = features();
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-done]")?.focus({ preventScroll: true });
  }, []);
  const set = (p: Partial<AppSettings>) => void patchSettings(p).catch(() => {});
  return (
    <>
      <div className="menu-scrim menu-scrim--dialog first-run-scrim" aria-hidden="true" />
      <div
        className="confirm first-run"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-title"
        aria-describedby="first-run-body"
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
        }}
      >
        <h2 className="confirm-title" id="first-run-title">
          {f.has("tray") ? "sessionpipe is in your menu bar" : "sessionpipe is ready"}
        </h2>
        <p className="confirm-body" id="first-run-body">
          {f.has("tray")
            ? "It shows how many sessions need you, even with this window closed."
            : "Everything here can be changed later in Settings."}
        </p>
        <ul className="first-run-list">
          {f.has("notifications") && (
            <NotifyRow label="Notify me when a session needs me" where={settingsApp(platform())} onNote={setNote} />
          )}
          {f.has("autostart") && (
            <li className="first-run-row">
              <span className="first-run-label">Open at login</span>
              <Toggle
                label="Open at login"
                on={!!s?.launchAtLogin}
                disabled={!s}
                onChange={(on) => set({ launchAtLogin: on })}
              />
            </li>
          )}
          {f.has("hotkey") && (
            <li className="first-run-row">
              <span className="first-run-label">
                New session shortcut <kbd className="first-run-key">{hotkeyLabel(s?.hotkey ?? DEFAULT_HOTKEY)}</kbd>
              </span>
              <Toggle
                label="New session shortcut"
                on={!!s?.hotkey}
                disabled={!s}
                onChange={(on) =>
                  void setHotkey(on ? DEFAULT_HOTKEY : null).catch(() =>
                    setNote("That shortcut is taken. Set another in Settings › App."),
                  )
                }
              />
            </li>
          )}
        </ul>
        {note && <p className="first-run-note">{note}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn btn--primary" data-done onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}
