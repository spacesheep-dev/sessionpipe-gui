// SPDX-License-Identifier: Apache-2.0
// Settings › App (NATIVE-SPEC §3.9): the section only the native app has, in the
// Settings window's own grammar (inset groups, a label and one caption per row, the
// control on the trailing edge). Backed by the shell's app_settings_*, the receivers, the
// notification permission, the updater and identity's signing panel.
import { type ComponentType, lazy, Suspense, useEffect, useState } from "react";
import { ActionButton, Toggle } from "../components/bits";
import { Select } from "../components/Select";
import { Group, Row } from "../components/SettingsWindow";
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
  updateHint,
  updateLine,
} from "./logic";
import { features, platform, shellInfo } from "./shell";
import "./native.css";

/** identity's panel (web/src/control/DeviceKeySettings.tsx), once it exists. */
const signingModule = Object.values(
  import.meta.glob<{ default: ComponentType<{ receiverId: string }> }>("../control/DeviceKeySettings.tsx"),
)[0];
const Signing = signingModule ? lazy(signingModule) : null;

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
    void loadUpdate();
    void loadNotify();
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
            <Toggle label="Show in menu bar" on={!!s?.menuBar} disabled={!s} onChange={(on) => set({ menuBar: on })} />
          </Row>
        )}
        {desktop && (
          <Row label="Show count on the Dock icon">
            <Toggle
              label="Show count on the Dock icon"
              on={!!s?.dockBadge}
              disabled={!s || !!s.menuBarOnly}
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
        {f.has("tray") && (
          <Row label="Menu bar only" hint="Hides the Dock icon.">
            <Toggle
              label="Menu bar only"
              on={!!s?.menuBarOnly}
              disabled={!s}
              onChange={(on) => set({ menuBarOnly: on })}
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

      {f.has("notifications") && <NotificationsGroup s={s} set={set} />}

      <ReceiversGroup current={info?.receiver?.id ?? null} />

      {Signing && info?.receiver && f.has("signer") && (
        <Suspense fallback={null}>
          <Signing receiverId={info.receiver.id} />
        </Suspense>
      )}

      {f.has("updater") && <UpdatesGroup appVersion={info?.appVersion ?? ""} s={s} set={set} />}
    </>
  );
}

function NotificationsGroup({ s, set }: { s: Settings | null; set: (p: Partial<Settings>) => void }) {
  const status = useCell(notify);
  const [note, setNote] = useState<string | null>(null);
  const n = s?.notifications;
  const until = n?.pausedUntil ? Date.parse(n.pausedUntil) : Number.NaN;
  const paused = until > Date.now();
  const denied = status === "denied";
  const where = settingsApp(platform());
  return (
    <Group label="Notifications" note={denied ? undefined : note}>
      {denied && (
        <Row label="Notifications are off for sessionpipe" hint={`Turn them on in ${where} › Notifications.`}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void invoke("app_notify_open_settings").catch(() => {})}
          >
            Open {where}
          </button>
        </Row>
      )}
      <Row label="Notify me when a session needs me">
        <Toggle
          label="Notify me when a session needs me"
          on={!!n?.enabled && !denied}
          disabled={!n || denied}
          onChange={async (on) => {
            const r = await notifyToggle(on, requestNotify, where);
            setNote(r.note);
            if (n) set({ notifications: { ...n, enabled: r.enabled } });
          }}
        />
      </Row>
      {n?.enabled &&
        !denied &&
        KINDS.map((k) => (
          <Row key={k.kind} label={k.label}>
            <Toggle
              label={k.label}
              on={n.kinds?.[k.kind] ?? k.kind !== "idle"}
              onChange={(on) => set({ notifications: { ...n, kinds: { ...n.kinds, [k.kind]: on } } })}
            />
          </Row>
        ))}
      {n?.enabled && !denied && (
        <Row
          label="Pause"
          hint={
            paused
              ? `Until ${new Date(until).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`
              : undefined
          }
        >
          <Select<string>
            className="settings-select"
            size="sm"
            align="end"
            aria-label="Pause notifications"
            value={paused ? "paused" : "off"}
            options={[
              { value: "off", label: paused ? "Resume" : "Off" },
              { value: "hour", label: "For 1 hour" },
              { value: "tomorrow", label: "Until tomorrow" },
              ...(paused ? [{ value: "paused", label: "Paused" }] : []),
            ]}
            onChange={(v) => {
              if (v === "paused") return;
              const at = v === "hour" ? Date.now() + HOUR : v === "tomorrow" ? tomorrow() : null;
              set({ notifications: { ...n, pausedUntil: at === null ? null : new Date(at).toISOString() } });
            }}
          />
        </Row>
      )}
    </Group>
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
  return (
    <Group label="Receivers" note={error ?? "The window shows one receiver at a time; switching reloads it."}>
      {(list ?? []).map((r) => (
        <Row
          key={r.id}
          label={r.name}
          hint={`${r.origin}${r.connected === false ? " · not connected" : ""}${r.id === current ? " · this window" : ""}`}
        >
          {r.id !== current && (
            <>
              <ActionButton className="btn btn--sm" onClick={() => invoke("rx_select", { id: r.id })}>
                Switch
              </ActionButton>
              <ActionButton
                className="btn btn--sm btn--ghost"
                onClick={async () => {
                  await invoke("rx_remove", { id: r.id });
                  await loadReceivers();
                }}
              >
                Remove
              </ActionButton>
            </>
          )}
        </Row>
      ))}
      {list && list.length === 0 && <Row label="No receivers yet" />}
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

function UpdatesGroup({
  appVersion,
  s,
  set,
}: {
  appVersion: string;
  s: Settings | null;
  set: (p: Partial<Settings>) => void;
}) {
  const u = useCell(update);
  return (
    <Group label="Updates">
      <Row label="Check for updates automatically" hint="On launch and every 6 hours.">
        <Toggle
          label="Check for updates automatically"
          on={s?.autoUpdate ?? true}
          disabled={!s}
          onChange={(on) => set({ autoUpdate: on })}
        />
      </Row>
      <Row label={updateLine(appVersion, u)} hint={updateHint(appVersion, u) || undefined}>
        {u.state === "ready" ? (
          <ActionButton className="btn btn--sm btn--primary" onClick={() => invoke("app_update_restart")}>
            Install and relaunch
          </ActionButton>
        ) : (
          <ActionButton
            className="btn btn--sm"
            disabled={u.state === "checking" || u.state === "downloading"}
            onClick={async () => update.set(await invoke("app_update_check"))}
          >
            Check now
          </ActionButton>
        )}
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
        aria-label={value ? `New session shortcut: ${hotkeyLabel(value)}. Click to record another` : "Record shortcut"}
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
        {recording ? "Type a shortcut…" : value ? hotkeyLabel(value) : "Record Shortcut"}
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
