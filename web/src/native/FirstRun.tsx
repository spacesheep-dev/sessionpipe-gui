// SPDX-License-Identifier: Apache-2.0
// The first-run sheet (NATIVE-SPEC §3.9): once, over the board, asking for nothing up
// front. Three switches, all off; each takes effect when turned on (notification
// permission is asked only then), and Done closes it for good.
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toggle } from "../components/bits";
import { type AppSettings, loadSettings, patchSettings, requestNotify, setHotkey, settings, useCell } from "./appState";
import { invoke } from "./bridge";
import { DEFAULT_HOTKEY, FIRST_RUN_KEY, firstRunDue, hotkeyLabel, notifyToggle } from "./logic";
import { features } from "./shell";
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
  root.render(
    <StrictMode>
      <FirstRun onDone={done} />
    </StrictMode>,
  );
}

export function FirstRun({ onDone }: { onDone: () => void }) {
  const s = useCell(settings);
  const f = features();
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-done]")?.focus({ preventScroll: true });
  }, []);
  const set = (p: Partial<AppSettings>) => void patchSettings(p).catch(() => {});
  const notifications = s?.notifications;
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
            <li className="first-run-row">
              <span className="first-run-label">Notify me when a session needs me</span>
              <Toggle
                label="Notify me when a session needs me"
                on={!!notifications?.enabled}
                disabled={!s}
                onChange={async (on) => {
                  const r = await notifyToggle(on, requestNotify);
                  setNote(r.note);
                  if (notifications) set({ notifications: { ...notifications, enabled: r.enabled } });
                }}
              />
            </li>
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
