// SPDX-License-Identifier: Apache-2.0
// Settings › App (NATIVE-SPEC §3.9): the section only the native app has, in the
// Settings window's own grammar (inset groups, a label and one caption per row, the
// control on the trailing edge). Backed by the shell's app_settings_*, the receivers, the
// notification permission and identity's signing panel. The app's own notifications
// (SystemNotifications) are the phone's group here; on a Mac they lead Settings ›
// Notifications instead (components/NotificationsSettings.tsx), above the sounds. The
// app's own update (UpdatesGroup) is Settings › About's, under the version it replaces.
import { type ComponentType, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionButton, CommandWell, Toggle } from "../components/bits";
import { Select } from "../components/Select";
import { Group, Row } from "../components/SettingsWindow";
import { accountMode } from "../lib/net";
import {
  loadNotify,
  loadReceivers,
  loadSettings,
  loadUpdate,
  notify,
  patchSettings,
  receivers,
  requestNotify,
  type AppSettings as Settings,
  setHotkey,
  settings,
  update,
  useCell,
} from "./appState";
import { invoke } from "./bridge";
import {
  hotkeyFrom,
  hotkeyLabel,
  isCancel,
  notifyToggle,
  parseAddress,
  settingsApp,
  updateButton,
  updateHint,
  updateLine,
  updateNotes,
} from "./logic";
import type { ServiceRow } from "./receiverUpdate";
import { features, platform, shellInfo } from "./shell";
import "./native.css";

/** identity's panel (web/src/control/DeviceKeySettings.tsx), once it exists. */
const signingModule = Object.values(
  import.meta.glob<{ default: ComponentType<{ receiverId: string }> }>("../control/DeviceKeySettings.tsx"),
)[0];
const Signing = signingModule ? lazy(signingModule) : null;
/** The account this window shows, when it shows one (account/AccountSettings.tsx). */
const AccountGroup = accountMode() ? lazy(() => import("../account/AccountSettings")) : null;

const KINDS: { kind: string; label: string }[] = [
  { kind: "permission", label: "Permission requests" },
  { kind: "question", label: "Questions" },
  { kind: "error", label: "Errors" },
  { kind: "idle", label: "Finished, waiting for you" },
];

const HOUR = 3_600_000;
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
};

export default function AppSettings() {
  const s = useCell(settings);
  const f = features();
  const info = shellInfo();
  // The phone has no Dock and no window to close: those rows are the desktop's.
  const desktop = !(platform() === "ios" || platform() === "android");
  useEffect(() => {
    void loadSettings();
    void loadReceivers();
  }, []);
  const set = (p: Partial<Settings>) => void patchSettings(p).catch(() => {});
  return (
    <>
      <Group label="General">
        {f.has("autostart") && (
          <Row label="Open at login">
            <Toggle
              label="Open at login"
              on={!!s?.launchAtLogin}
              disabled={!s}
              onChange={(on) => set({ launchAtLogin: on })}
            />
          </Row>
        )}
        {f.has("tray") && (
          <Row label="Show in menu bar" hint="How many sessions need you, with the window closed too.">
            <Toggle
              label="Show in menu bar"
              on={!!s?.menuBar}
              disabled={!s}
              // Menu bar only goes off with it: no item and no Dock icon is an app that shows nowhere.
              onChange={(on) => set(on ? { menuBar: true } : { menuBar: false, menuBarOnly: false })}
            />
          </Row>
        )}
        {f.has("tray") && platform() === "macos" && s?.menuBar && (
          <Row label="Menu bar only" hint="Hides the Dock icon.">
            <Toggle label="Menu bar only" on={s.menuBarOnly} onChange={(on) => set({ menuBarOnly: on })} />
          </Row>
        )}
        {desktop && !s?.menuBarOnly && (
          <Row label="Show count on the Dock icon">
            <Toggle
              label="Show count on the Dock icon"
              on={!!s?.dockBadge}
              disabled={!s}
              onChange={(on) => set({ dockBadge: on })}
            />
          </Row>
        )}
        {desktop && (
          <Row label="Keep running when the window is closed">
            <Toggle
              label="Keep running when the window is closed"
              on={!!s?.keepRunning}
              disabled={!s}
              onChange={(on) => set({ keepRunning: on })}
            />
          </Row>
        )}
      </Group>

      {f.has("hotkey") && (
        <Group label="Shortcut" note="Brings sessionpipe forward with New session open, from any app.">
          <Row label="New session from anywhere">
            <HotkeyRecorder value={s?.hotkey ?? null} disabled={!s} />
          </Row>
        </Group>
      )}

      {f.has("notifications") && !desktop && <SystemNotifications full={false} />}

      {AccountGroup && (
        <Suspense fallback={null}>
          <AccountGroup />
        </Suspense>
      )}

      <ReceiversGroup current={info?.receiver?.id ?? null} />

      {/* On an account this phone's key is the account group's row ("Approve this iPhone"). */}
      {Signing && info?.receiver && f.has("signer") && !accountMode() && (
        <Suspense fallback={null}>
          <Signing receiverId={info.receiver.id} />
        </Suspense>
      )}
    </>
  );
}

/** The app's own notifications: the one switch, and on a computer (`full`) Pause and what
 *  to notify about, which the phone's notifier does not read. A pause is one sentence with
 *  Resume; a refusal by macOS is the whole panel, one row with the way to System Settings
 *  and no switch that could only be refused. */
export function SystemNotifications({ full }: { full: boolean }) {
  const s = useCell(settings);
  const status = useCell(notify);
  const [note, setNote] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    // In Settings › App (the phone) the section has asked for the settings itself.
    if (full) void loadSettings();
    void loadNotify();
  }, [full]);
  const n = s?.notifications;
  const until = n?.pausedUntil ? Date.parse(n.pausedUntil) : Number.NaN;
  const paused = until > Date.now();
  // The pause ends by itself: the row is the select again when it does.
  useEffect(() => {
    if (!paused) return;
    const t = window.setTimeout(() => tick((x) => x + 1), until - Date.now());
    return () => window.clearTimeout(t);
  }, [paused, until]);
  const denied = status === "denied";
  const where = settingsApp(platform());
  const set = (to: Partial<Settings["notifications"]>) => {
    if (n) void patchSettings({ notifications: { ...n, ...to } }).catch(() => {});
  };
  const openSettings = (
    <button
      type="button"
      className="btn btn--sm"
      onClick={() => void invoke("app_notify_open_settings").catch(() => {})}
    >
      Open {where}
    </button>
  );
  if (full && denied)
    return (
      <Group>
        <Row label="Notifications are off for sessionpipe">{openSettings}</Row>
      </Group>
    );
  const on = !!n?.enabled && !denied;
  return (
    <>
      <Group label={full ? undefined : "Notifications"} note={denied ? undefined : note}>
        {denied && (
          <Row label="Notifications are off for sessionpipe" hint={`Turn them on in ${where} › Notifications.`}>
            {openSettings}
          </Row>
        )}
        <Row label="Notify me when a session needs me">
          <Toggle
            label="Notify me when a session needs me"
            on={on}
            disabled={!n || denied}
            onChange={async (v) => {
              const r = await notifyToggle(v, requestNotify, where);
              setNote(r.note);
              set({ enabled: r.enabled });
            }}
          />
        </Row>
        {full && on && paused && (
          <Row
            label={`Paused until ${new Date(until).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`}
          >
            <button type="button" className="btn btn--sm" onClick={() => set({ pausedUntil: null })}>
              Resume
            </button>
          </Row>
        )}
        {full && on && !paused && (
          <Row label="Pause">
            <Select<string>
              className="settings-select"
              size="sm"
              align="end"
              aria-label="Pause notifications"
              value="off"
              options={[
                { value: "off", label: "Not paused" },
                { value: "hour", label: "For 1 hour" },
                { value: "tomorrow", label: "Until tomorrow" },
              ]}
              onChange={(v) => {
                if (v !== "off")
                  set({ pausedUntil: new Date(v === "hour" ? Date.now() + HOUR : tomorrow()).toISOString() });
              }}
            />
          </Row>
        )}
      </Group>
      {full && on && n && (
        <Group label="Notify me about">
          {KINDS.map((k) => (
            <Row key={k.kind} label={k.label}>
              <Toggle
                label={k.label}
                on={n.kinds?.[k.kind] ?? k.kind !== "idle"}
                onChange={(v) => set({ kinds: { ...n.kinds, [k.kind]: v } })}
              />
            </Row>
          ))}
        </Group>
      )}
    </>
  );
}

function ReceiversGroup({ current }: { current: string | null }) {
  const list = useCell(receivers);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const url = parseAddress(address);
    if (!url) return setError("That isn't an address. Try studio-mac.local:7373.");
    setError(null);
    try {
      const rx = await invoke<{ id: string } | null>("rx_add", { url });
      if (rx) {
        setAdding(false);
        setAddress("");
        await loadReceivers();
      }
    } catch (e) {
      if (!isCancel(e)) setError(e instanceof Error ? e.message : String(e));
    }
  };
  // The account this window shows has its own group above: it is not listed twice.
  const shown = (list ?? []).filter((r) => !(r.kind === "spacesheep" && r.id === current));
  return (
    <Group label="Receivers" note={error ?? "The window shows one receiver at a time; switching reloads it."}>
      {shown.map((r) => (
        <Row
          key={r.id}
          // A spacesheep account in the list is named by whose it is.
          label={r.name || r.email || r.origin}
          hint={`${r.origin}${r.connected === false ? " · not connected" : ""}${r.id === current ? " · this window" : ""}`}
        >
          {r.id !== current && (
            <>
              <ActionButton className="btn btn--sm" onClick={() => invoke("rx_select", { id: r.id })}>
                Switch
              </ActionButton>
              {/* An account is not removed from here: it is disconnected, in its own window's
                  group above, where what that removes is said. */}
              {r.kind !== "spacesheep" && (
                <ActionButton
                  className="btn btn--sm btn--ghost"
                  onClick={async () => {
                    await invoke("rx_remove", { id: r.id });
                    await loadReceivers();
                  }}
                >
                  Remove
                </ActionButton>
              )}
            </>
          )}
        </Row>
      ))}
      {list && shown.length === 0 && <Row label="No receivers yet" />}
      {adding ? (
        <Row label="Address">
          <form
            className="welcome-connect-form"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input
              className="field"
              // biome-ignore lint/a11y/noAutofocus: the field Add… just opened
              autoFocus
              type="text"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="off"
              placeholder="studio-mac.local:7373"
              aria-label="Receiver address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setAdding(false);
                }
              }}
            />
            <button type="submit" className="btn btn--sm btn--primary" disabled={!address.trim()}>
              Add
            </button>
          </form>
        </Row>
      ) : (
        <Row label="Another computer">
          <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
            Add…
          </button>
        </Row>
      )}
    </Group>
  );
}

/** The app's own update, one sentence a state (logic.ts updateLine) with the one thing to
 *  press, if any: Check now, Install and relaunch once it is downloaded, Try again after a
 *  failure. It asks the shell where the update is as it mounts, so it is right wherever it
 *  shows first. */
export function UpdateRow({ appVersion }: { appVersion: string }) {
  const u = useCell(update);
  useEffect(() => {
    void loadUpdate();
  }, []);
  const hint = updateHint(u);
  const notes = updateNotes(u);
  const button = updateButton(u);
  // The button goes while the app is at work and is back when that ends. A keyboard's place
  // stays in the row meanwhile, so Tab goes on from here, and returns to the button; not to
  // Install and relaunch, which nobody was about to press.
  const ctl = useRef<HTMLSpanElement>(null);
  const held = !!ctl.current?.contains(document.activeElement);
  useLayoutEffect(() => {
    const el = ctl.current;
    if (!held || !el || el.querySelector(":focus")) return;
    const next = u.state === "ready" ? null : el.querySelector("button");
    (next ?? el).focus();
  }, [held, u.state]);
  return (
    <Row
      label={updateLine(appVersion, u)}
      hint={
        notes ? (
          <a href={notes} target="_blank" rel="noreferrer noopener">
            {hint} ↗
          </a>
        ) : (
          hint || undefined
        )
      }
    >
      <span className="app-update-ctl" ref={ctl} tabIndex={-1}>
        {u.state === "ready" ? (
          <ActionButton className="btn btn--sm btn--primary" onClick={() => invoke("app_update_restart")}>
            {button}
          </ActionButton>
        ) : button ? (
          <ActionButton className="btn btn--sm" onClick={async () => update.set(await invoke("app_update_check"))}>
            {button}
          </ActionButton>
        ) : null}
      </span>
    </Row>
  );
}

/** This computer's background service when it is behind the app, under the app's own
 *  update (receiverUpdate.ts serviceRow): its version, what to do, and Update; while it
 *  works, its progress; after a failure, the sentence and the failure line and the command
 *  folded away in Details; once current, its new version alone. */
function ServiceUpdateRow({ row, update, command }: ServiceUpdate) {
  const label = row.running ? `The background service runs ${row.running}` : "The background service";
  if (row.kind === "done")
    return (
      <div className="settings-row service-row">
        <div className="settings-row-text">
          <span className="settings-label">{label}</span>
        </div>
      </div>
    );
  const working = row.kind === "working";
  const hint =
    row.kind === "behind" ? (
      `Update it to ${row.app} to match the app.`
    ) : row.kind === "working" ? (
      <span role="status">{row.progress}</span>
    ) : (
      <span role="alert">{row.sentence}</span>
    );
  return (
    <div className="settings-row service-row">
      <div className="settings-row-text service-row-text">
        <span className="settings-label">{label}</span>
        <span className="settings-hint">{hint}</span>
        {row.kind === "failed" && (
          <details className="settings-details">
            <summary>Details</summary>
            {row.detail && <p className="settings-details-line">{row.detail}</p>}
            <p className="settings-details-say">Or run this in a terminal:</p>
            <CommandWell command={command} label="Copy the update command" />
          </details>
        )}
      </div>
      <div className="settings-row-ctl">
        {/* At work it can't be pressed and is dimmed, and it keeps the focus, which a
            disabled button would drop (as StartHere.tsx's). */}
        <button
          type="button"
          className="btn btn--sm btn--primary"
          aria-disabled={working || undefined}
          aria-busy={working || undefined}
          onClick={() => {
            if (!working) void update();
          }}
        >
          {working ? "Updating…" : "Update"}
        </button>
      </div>
    </div>
  );
}

/** What Settings › About passes for the service's row: the row, the click, the command. */
export interface ServiceUpdate {
  row: ServiceRow;
  update: () => Promise<void>;
  command: string;
}

/** Settings › About's updates, in an app that updates itself (the page fetches this only
 *  there): where the update is, this computer's background service when it is behind the
 *  app, then whether the app looks by itself. It stands on its own, with the app's settings
 *  asked for here. */
export function UpdatesGroup({ appVersion, service }: { appVersion: string; service?: ServiceUpdate }) {
  const s = useCell(settings);
  useEffect(() => {
    void loadSettings();
  }, []);
  return (
    <Group>
      <UpdateRow appVersion={appVersion} />
      {service && <ServiceUpdateRow {...service} />}
      <Row label="Check for updates automatically" hint="On launch and every 6 hours.">
        <Toggle
          label="Check for updates automatically"
          on={s?.autoUpdate ?? true}
          disabled={!s}
          onChange={(on) => void patchSettings({ autoUpdate: on }).catch(() => {})}
        />
      </Row>
    </Group>
  );
}

/** The shortcut recorder: shows the shortcut, or "Record Shortcut"; a click listens for
 *  the next chord with ⌃, ⌥ or ⌘ (Esc cancels, ⌫ clears). */
function HotkeyRecorder({ value, disabled }: { value: string | null; disabled?: boolean }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onChange = (h: string | null) => {
    setError(null);
    setHotkey(h).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <span className="app-settings-hotkey">
      <button
        type="button"
        className="btn btn--sm app-settings-key"
        data-recording={recording || undefined}
        disabled={disabled}
        aria-label={
          value ? `New session shortcut: ${hotkeyLabel(value, platform())}. Click to record another` : "Record shortcut"
        }
        onClick={() => setRecording((r) => !r)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") return setRecording(false);
          if (e.key === "Backspace" || e.key === "Delete") {
            setRecording(false);
            return onChange(null);
          }
          const h = hotkeyFrom(e);
          if (!h) return;
          setRecording(false);
          onChange(h);
        }}
      >
        {recording ? "Type a shortcut…" : value ? hotkeyLabel(value, platform()) : "Record Shortcut"}
      </button>
      {value && !recording && (
        <button type="button" className="btn btn--sm btn--ghost" disabled={disabled} onClick={() => onChange(null)}>
          Clear
        </button>
      )}
      {error && <span className="settings-hint app-settings-err">That shortcut is taken. Try another.</span>}
    </span>
  );
}
