// SPDX-License-Identifier: Apache-2.0
// The Plugins section of the Views page: what server plugins are installed, their
// status or error, an Enable / Disable switch (a bundled plugin is off until enabled), a
// settings form made from each manifest, folded while the plugin is off (secrets as
// password fields showing the mask; saving works from the receiver machine only), Reload,
// and the line that installs more.
// A plugin is code running in the receiver process: the section says so.
import type { InstalledPlugin, SettingField } from "@shared/plugin-api";
import { isMasked } from "@shared/plugin-api";
import { useEffect, useState } from "react";
import { CopyIconButton } from "../components/bits";
import { Select } from "../components/Select";
import { fetchPlugins, reloadPlugins, savePluginSettings, setPluginEnabled, usePlugins } from "./registry";
import "./plugins.css";

export const PLUGIN_ADD_LINE = "sessionpipe-gui plugin add <folder | plugin.tgz | npm-package | git-url>";

export const isLoopbackPage = (): boolean =>
  typeof location !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

export function PluginsSection() {
  const { plugins, loaded, error, demo } = usePlugins();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const loopback = isLoopbackPage();

  useEffect(() => {
    void fetchPlugins();
  }, []);

  const reload = async () => {
    setBusy(true);
    setNote(null);
    try {
      await reloadPlugins();
      setNote("Reloaded: every plugin was stopped, re-read and started again.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="form-group plugins" data-plugins aria-labelledby="views-plugins">
      <div className="form-head">
        <h2 className="section-label" id="views-plugins">
          Plugins
        </h2>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => void reload()}
          disabled={!loopback || busy}
          title={loopback ? "Stop, re-read and start every plugin" : "Only on the machine running the receiver"}
          data-plugins-reload
        >
          {busy ? "Reloading…" : "Reload plugins"}
        </button>
      </div>
      {error && <p className="page-note is-err">{error}</p>}
      {demo && (
        <p className="page-note">Demo mode: plugins stay inactive, so nobody is messaged about pretend sessions.</p>
      )}
      {loaded && plugins.length === 0 && !error && (
        <p className="state-text themes-empty">No plugins installed. Add one with the command below.</p>
      )}
      {plugins.length > 0 && (
        <ul className="form-list themes-list">
          {plugins.map((p) => (
            <PluginRow key={p.id} plugin={p} loopback={loopback} busy={busy} onNote={setNote} />
          ))}
        </ul>
      )}
      <div className="themes-tools">
        {note && <span className="sect-note">{note}</span>}
        {!loopback && <span className="sect-note">Reload and settings work on the receiver machine only.</span>}
      </div>
      <div className="well-row cmd">
        <code className="cmd-text">{PLUGIN_ADD_LINE}</code>
        <CopyIconButton text="sessionpipe-gui plugin add " label="Copy command" />
      </div>
      <p className="caption">
        Server code that reacts to events, like a message to your phone when a session needs you. A plugin runs inside
        the receiver process; nothing it does can answer a permission, only your passkey signs that. Only install
        plugins you trust.
      </p>
    </section>
  );
}

function PluginRow({
  plugin: p,
  loopback,
  busy,
  onNote,
}: {
  plugin: InstalledPlugin;
  loopback: boolean;
  busy: boolean;
  onNote: (note: string | null) => void;
}) {
  const [toggling, setToggling] = useState(false);
  const toggle = async (on: boolean) => {
    setToggling(true);
    onNote(null);
    try {
      await setPluginEnabled(p.id, on);
      onNote(on ? `${p.id} is on.` : `${p.id} is off: it will not run.`);
    } catch (e) {
      onNote(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  };
  const flags = [p.disabled ? "disabled" : p.status, p.linked && "linked", p.bundled && "bundled"].filter(
    (f): f is string => !!f,
  );
  return (
    <li className="form-row themes-row plug-row" data-plugin-row={p.id} data-plugin-status={p.status}>
      <span className="form-row-text">
        <span className="themes-row-head">
          <span className="themes-row-name">{p.name || p.id}</span>
          {p.version && <span className="themes-row-ver num">{p.version}</span>}
          {flags.map((f) => (
            <span key={f} className={`themes-flag ${f === p.status ? `plug-status plug-status--${p.status}` : ""}`}>
              {f}
            </span>
          ))}
        </span>
        {p.description && <span className="form-caption themes-row-meta">{p.description}</span>}
        {p.error && <span className="themes-row-err">{p.error}</span>}
        {p.settings && p.settings.length > 0 && (
          // Folded while the plugin is off: a long form for something that does not run is noise.
          <details className="plug-more" open={!p.disabled}>
            <summary>Settings</summary>
            <SettingsForm plugin={p} loopback={loopback} />
          </details>
        )}
      </span>
      {!p.error && (
        <span className="form-value themes-row-open">
          <button
            type="button"
            className={`btn btn--sm ${p.disabled && loopback ? "" : "btn--ghost"}`}
            onClick={() => void toggle(!!p.disabled)}
            disabled={!loopback || busy || toggling}
            title={
              loopback
                ? p.bundled
                  ? "Bundled with the app: it cannot be removed, only turned off"
                  : "Turn it off without removing its files"
                : "Only from the machine running the receiver"
            }
            data-plugin-toggle={p.id}
          >
            {toggling ? "…" : p.disabled ? "Enable" : "Disable"}
          </button>
        </span>
      )}
    </li>
  );
}

function SettingsForm({ plugin: p, loopback }: { plugin: InstalledPlugin; loopback: boolean }) {
  const fields = p.settings ?? [];
  const current = p.values ?? {};
  const [draft, setDraft] = useState<Record<string, unknown>>(current);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const currentJson = JSON.stringify(current);
  // New values from the server (a save, a reload) replace what is shown.
  useEffect(() => {
    setDraft(current);
  }, [currentJson]);
  const dirty = JSON.stringify(draft) !== currentJson;

  const save = async () => {
    setSaving(true);
    setNote(null);
    try {
      // Only what changed goes; a secret still showing its mask is left alone by the server.
      const patch: Record<string, unknown> = {};
      for (const f of fields) {
        if (JSON.stringify(draft[f.key]) !== JSON.stringify(current[f.key])) patch[f.key] = draft[f.key] ?? null;
      }
      await savePluginSettings(p.id, patch);
      setNote({ text: "Saved." });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), err: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="plug-form"
      data-plugin-settings={p.id}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {fields.map((f) => (
        <Field
          key={f.key}
          field={f}
          value={draft[f.key]}
          disabled={!loopback}
          onChange={(v) =>
            setDraft((d) => ({
              // A secret field typed empty again means "leave it": the stored one stays.
              ...d,
              [f.key]: f.type === "secret" && v === "" && isMasked(current[f.key]) ? current[f.key] : v,
            }))
          }
        />
      ))}
      <div className="plug-form-foot">
        <button
          type="submit"
          className={`btn btn--sm ${dirty && loopback ? "btn--primary" : ""}`}
          disabled={!loopback || !dirty || saving}
          title={loopback ? undefined : "Settings are saved from the receiver machine only"}
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        {dirty && loopback && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDraft(current)}>
            Reset
          </button>
        )}
        {note && <span className={`sect-note ${note.err ? "is-err" : ""}`}>{note.text}</span>}
      </div>
    </form>
  );
}

function Field({
  field: f,
  value,
  disabled,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = `plug-${f.key}`;
  const help = f.help ? <span className="plug-help">{f.help}</span> : null;
  switch (f.type) {
    case "boolean":
      return (
        <label className="plug-field plug-field--check" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="plug-label">{f.label}</span>
          {help}
        </label>
      );
    case "multiselect": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="plug-field plug-field--multi" disabled={disabled}>
          <legend className="plug-label">{f.label}</legend>
          <div className="plug-options">
            {(f.options ?? []).map((o) => (
              <label key={o} className="plug-option">
                <input
                  type="checkbox"
                  checked={chosen.includes(o)}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...chosen.filter((c) => c !== o), o] : chosen.filter((c) => c !== o))
                  }
                />
                <code>{o}</code>
              </label>
            ))}
          </div>
          {help}
        </fieldset>
      );
    }
    case "select":
      return (
        <label className="plug-field" htmlFor={id}>
          <span className="plug-label">{f.label}</span>
          <Select<string>
            id={id}
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={onChange}
            options={(f.options ?? []).map((o) => ({ value: o, label: o }))}
          />
          {help}
        </label>
      );
    case "number":
      return (
        <label className="plug-field" htmlFor={id}>
          <span className="plug-label">{f.label}</span>
          <input
            id={id}
            type="number"
            value={typeof value === "number" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          />
          {help}
        </label>
      );
    case "secret": {
      // The stored secret is never sent to the page: the mask ("••••" + last 4) stands in as
      // the placeholder, and the field itself is empty until a new value is typed. Sending
      // the mask back (or nothing) leaves the stored secret as it is; "" removes it.
      const stored = isMasked(value);
      return (
        <label className="plug-field" htmlFor={id}>
          <span className="plug-label">{f.label}</span>
          <span className="plug-secret">
            <input
              id={id}
              type="password"
              autoComplete="off"
              value={stored ? "" : typeof value === "string" ? value : ""}
              placeholder={stored ? String(value) : "not set"}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
              data-secret
            />
            {stored && !disabled && (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => onChange(null)}
                title="Remove the stored value"
              >
                Remove
              </button>
            )}
          </span>
          {help}
          {stored && <span className="plug-help">Stored; shown masked. Type to replace it.</span>}
        </label>
      );
    }
    default:
      return (
        <label className="plug-field" htmlFor={id}>
          <span className="plug-label">{f.label}</span>
          <input
            id={id}
            type="text"
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
          {help}
        </label>
      );
  }
}
