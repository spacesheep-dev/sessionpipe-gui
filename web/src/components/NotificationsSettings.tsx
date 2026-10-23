// SPDX-License-Identifier: Apache-2.0
// The Notifications section of the Settings window (components/Settings.tsx mounts it):
// switch rows for system notifications (lib/notify.ts) and sounds (lib/sounds.ts), the
// volume, one row per kind of moment with its sound and a ▶ to test it, and the file you can
// upload for any of them. The window's grouped form: each control on the same trailing
// edge as every other section's, one caption line under a label.
import { useId, useRef, useState } from "react";
import { setNotifyPref, useNotifyPref } from "../lib/notify";
import {
  BUILTIN_SOUNDS,
  playSound,
  removeCustomSound,
  SOUND_KINDS,
  type SoundChoice,
  type SoundKind,
  setCustomSound,
  setSoundChoice,
  setSoundsOn,
  setSoundVolume,
  useSounds,
} from "../lib/sounds";
import { Slider, Switch } from "./bits";
import { Select } from "./Select";

export function NotificationsSettings() {
  const notify = useNotifyPref();
  const s = useSounds();
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const blocked = notify.permission === "denied" || notify.permission === "unsupported";
  const notifyHint =
    notify.permission === "unsupported"
      ? "Not available in this browser."
      : notify.permission === "denied"
        ? "Blocked for this site in the browser's settings."
        : "When a prompt needs you and this tab is in the background.";
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setProblem(await setCustomSound(f));
  };
  return (
    <div className="ntf" data-sounds={s.on ? "on" : "off"}>
      <section className="settings-group" aria-label="Alerts">
        <div className="settings-cells">
          <div className="settings-row ntf-row" data-row="notify">
            <div className="settings-row-text">
              <span className="settings-label ntf-label" id={`${id}-notify`}>
                Notify me
              </span>
              <span className="settings-hint ntf-hint">{notifyHint}</span>
            </div>
            <div className="settings-row-ctl">
              <Switch on={notify.on} onChange={(v) => void setNotifyPref(v)} label="Notify me" disabled={blocked} />
            </div>
          </div>
          <div className="settings-row ntf-row" data-row="sounds">
            <div className="settings-row-text">
              <span className="settings-label ntf-label">Sounds</span>
              {!s.supported && <span className="settings-hint ntf-hint">Not available in this browser.</span>}
            </div>
            <div className="settings-row-ctl">
              <Switch on={s.on} onChange={setSoundsOn} label="Sounds" disabled={!s.supported} />
            </div>
          </div>
          <div className="settings-row ntf-row" data-row="volume">
            <div className="settings-row-text">
              <label className="settings-label ntf-label" htmlFor={`${id}-volume`}>
                Volume
              </label>
            </div>
            <div className="settings-row-ctl">
              <Slider
                id={`${id}-volume`}
                className="ntf-slider"
                label="Volume"
                value={s.volume}
                disabled={!s.on || !s.supported}
                onChange={setSoundVolume}
              />
              <span className="ntf-pct num">{Math.round(s.volume * 100)} %</span>
            </div>
          </div>
        </div>
      </section>
      <section className="settings-group" aria-label="Sounds for">
        <h3 className="settings-group-label">Sounds for</h3>
        <div className="settings-cells">
          {SOUND_KINDS.map((k) => (
            <div className="settings-row ntf-row" data-kind={k.kind} key={k.kind}>
              <div className="settings-row-text">
                <label className="settings-label ntf-label" htmlFor={`${id}-${k.kind}`}>
                  {k.label}
                </label>
                <span className="settings-hint ntf-hint">{k.hint.charAt(0).toUpperCase() + k.hint.slice(1)}.</span>
              </div>
              <div className="settings-row-ctl">
                <Select<SoundChoice>
                  id={`${id}-${k.kind}`}
                  className="ntf-select"
                  size="sm"
                  align="end"
                  value={s.kinds[k.kind]}
                  disabled={!s.supported}
                  onChange={(v) => setSoundChoice(k.kind as SoundKind, v)}
                  options={[
                    ...BUILTIN_SOUNDS.map((b) => ({ value: b.id as SoundChoice, label: b.label })),
                    ...(s.custom ? [{ value: "custom" as SoundChoice, label: `Your sound · ${s.custom.name}` }] : []),
                  ]}
                />
                <button
                  type="button"
                  className="icon-btn ntf-play"
                  disabled={!s.supported}
                  onClick={() => void playSound(k.kind, { test: true })}
                  aria-label={`Test the ${k.label.toLowerCase()} sound`}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path
                      d="M5 3.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L5.9 3.1a.6.6 0 0 0-.9.5Z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              </div>
            </div>
          ))}
          <div className="settings-row ntf-row" data-row="upload">
            <div className="settings-row-text">
              <span className="settings-label ntf-label">Your own sound</span>
              {s.custom ? (
                <span className="settings-hint ntf-file ellipsis" title={s.custom.name}>
                  {s.custom.name} · {Math.max(1, Math.round(s.custom.bytes / 1024))} KB
                </span>
              ) : (
                <span className="settings-hint">Any kind can play it; files up to 500 KB.</span>
              )}
              {problem && (
                <span className="settings-hint ntf-err" role="alert">
                  {problem}
                </span>
              )}
            </div>
            <div className="settings-row-ctl">
              {s.custom ? (
                <button type="button" className="btn btn--sm" onClick={() => void removeCustomSound()}>
                  Remove
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--sm ntf-choose"
                  disabled={!s.supported}
                  onClick={() => file.current?.click()}
                >
                  Choose a file…
                </button>
              )}
            </div>
            <input
              ref={file}
              type="file"
              accept="audio/*"
              className="sr-only"
              tabIndex={-1}
              aria-label="Upload a sound"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                setProblem(null);
                void onFile(f);
              }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

export default NotificationsSettings;
