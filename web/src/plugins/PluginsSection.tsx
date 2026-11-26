// SPDX-License-Identifier: Apache-2.0
// The Plugins section of the Views page: server plugins in an inset grouped card with 36x36
// monochrome icon tiles, status pills matching pool.css, native switches, and a full-width
// nested settings drawer beneath each configurable plugin row.
import type { InstalledPlugin, SettingField } from "@shared/plugin-api";
import { isMasked } from "@shared/plugin-api";
import { useEffect, useId, useRef, useState } from "react";
import { ActionButton } from "../components/bits";
import { Select } from "../components/Select";
import { fetchPlugins, savePluginSettings, setPluginEnabled, usePlugins } from "./registry";
import "./plugins.css";

export const PLUGIN_ADD_LINE = "sessionpipe-gui plugin add <source>";
const ONLY_HERE = "Only on the machine running the receiver";

export const isLoopbackPage = (): boolean =>
  typeof location !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

const isEmptySettingValue = (v: unknown): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Whether a plugin's settings appear empty or unconfigured (used to auto-expand on enable). */
export function hasUnconfiguredSettings(plugin: InstalledPlugin): boolean {
  const fields = plugin.settings ?? [];
  if (fields.length === 0) return false;
  const values = plugin.values ?? {};
  if (Object.keys(values).length === 0) return true;
  if (fields.some((f) => f.type === "secret" && !isMasked(values[f.key]) && isEmptySettingValue(values[f.key]))) {
    return true;
  }
  return fields.every(
    (f) =>
      f.type === "boolean" ||
      isEmptySettingValue(values[f.key]) ||
      JSON.stringify(values[f.key]) === JSON.stringify(f.default),
  );
}

/** Status pill label and tone matching pool.css status pills. */
export function pluginStatusPill(plugin: Pick<InstalledPlugin, "status" | "disabled">): {
  label: string;
  tone: "active" | "off" | "err";
} {
  if (plugin.status === "error") return { label: "Error", tone: "err" };
  if (plugin.disabled) return { label: "Off", tone: "off" };
  if (plugin.status === "active") return { label: "Active", tone: "active" };
  return { label: "Inactive", tone: "off" };
}

export function PluginsSection({
  reloading = false,
  onAddClick,
}: {
  reloading?: boolean;
  onAddClick?: () => void;
} = {}) {
  const { plugins, loaded, error, demo } = usePlugins();
  const [note, setNote] = useState<string | null>(null);
  const loopback = isLoopbackPage();

  useEffect(() => {
    void fetchPlugins();
  }, []);

  return (
    <section className="form-group plugins" data-plugins aria-labelledby="views-plugins">
      <div className="form-head">
        <h2 className="section-label" id="views-plugins">
          Plugins
        </h2>
      </div>
      {error && <p className="page-note is-err">{error}</p>}
      {demo && (
        <p className="page-note">Demo mode: plugins stay inactive, so nobody is messaged about pretend sessions.</p>
      )}
      {loaded && plugins.length === 0 && !error && (
        <div className="form-list themes-empty-card">
          <p className="state-text themes-empty">
            No plugins installed.
            {onAddClick && (
              <>
                {" "}
                <button type="button" className="themes-inline-link" onClick={onAddClick}>
                  Install via CLI…
                </button>
              </>
            )}
          </p>
        </div>
      )}
      {plugins.length > 0 && (
        <ul className="form-list themes-list plug-list">
          {plugins.map((p) => (
            <PluginRow key={p.id} plugin={p} loopback={loopback} busy={reloading} onNote={setNote} />
          ))}
        </ul>
      )}
      <div className="themes-tools" aria-live="polite">
        {note && <span className="sect-note">{note}</span>}
        {!loopback && plugins.length > 0 && (
          <span className="sect-note">Plugin settings and toggles work on the receiver machine only.</span>
        )}
      </div>
    </section>
  );
}

export function PluginIconTile({ plugin }: { plugin: Pick<InstalledPlugin, "id" | "disabled" | "status"> }) {
  const cls = `ext-icon${plugin.disabled ? " ext-icon--dim" : ""}${plugin.status === "error" ? " ext-icon--err" : ""}`;
  return (
    <span className={cls} aria-hidden="true">
      {plugin.id === "ping-a-human" ? (
        <svg
          viewBox="0 0 20 20"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M17.25 3.25 9.25 11.25" />
          <path d="M17.25 3.25 12 17.25l-2.75-6-6-2.75 14-5.25Z" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 20 20"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M7.5 2.75v3.5M12.5 2.75v3.5" />
          <path d="M5.5 6.25h9v3a4.5 4.5 0 0 1-9 0v-3Z" />
          <path d="M10 13.75v3.5" />
        </svg>
      )}
    </span>
  );
}

export function PluginRow({
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
  const hasSettings = !!(p.settings && p.settings.length > 0);
  const [open, setOpen] = useState(!p.disabled);
  const [toggling, setToggling] = useState(false);
  const prevDisabled = useRef(p.disabled);
  const drawerId = useId();
  const displayName = p.name || p.id;

  // Collapse when disabled; auto-expand if enabled while settings are unconfigured.
  useEffect(() => {
    if (prevDisabled.current === p.disabled) return;
    const wasDisabled = !!prevDisabled.current;
    prevDisabled.current = p.disabled;
    if (p.disabled) {
      setOpen(false);
    } else if (wasDisabled && hasSettings && hasUnconfiguredSettings(p)) {
      setOpen(true);
    }
  }, [p, hasSettings]);

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

  const pill = pluginStatusPill(p);
  const switchTitle = loopback
    ? p.bundled
      ? "Bundled with the app: cannot be removed, only turned off"
      : p.disabled
        ? "Enable plugin"
        : "Turn off without removing its files"
    : ONLY_HERE;

  return (
    <li
      className="plug-item"
      data-plugin-row={p.id}
      data-plugin-status={p.status}
      data-disabled={p.disabled ? "" : undefined}
      data-bundled={p.bundled ? "" : undefined}
    >
      <div className="form-row themes-row ext-row plug-row">
        <PluginIconTile plugin={p} />
        <span className="form-row-text ext-body">
          <span className="themes-row-head">
            <span className="themes-row-name">{displayName}</span>
            {p.version && <span className="themes-row-ver num">{p.version}</span>}
            <span className={`plug-pill plug-pill--${pill.tone}`} data-plugin-pill={pill.tone}>
              {pill.label}
            </span>
            {p.linked && <span className="themes-flag ext-pill">linked</span>}
          </span>
          {p.description && <span className="form-caption themes-row-meta">{p.description}</span>}
          {p.error && <span className="themes-row-err">{p.error}</span>}
        </span>
        <span className="form-value themes-row-actions plug-row-actions">
          {hasSettings && (
            <button
              type="button"
              className="btn btn--sm btn--ghost plug-cfg-btn"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={drawerId}
              data-plugin-settings-toggle={p.id}
            >
              <span>Settings</span>
              <svg
                className="plug-cfg-chev"
                viewBox="0 0 12 12"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 4.5 6 7.5l3-3" />
              </svg>
            </button>
          )}
          {!p.error && (
            <button
              type="button"
              role="switch"
              aria-checked={!p.disabled}
              aria-label={`${p.disabled ? "Enable" : "Disable"} ${displayName}`}
              className={`toggle ext-switch ${!p.disabled ? "toggle-on" : ""}`}
              onClick={() => void toggle(!!p.disabled)}
              disabled={!loopback || busy || toggling}
              title={switchTitle}
              data-plugin-toggle={p.id}
            >
              <span className="toggle-knob" />
            </button>
          )}
        </span>
      </div>
      {hasSettings && open && (
        <div className="plug-drawer" id={drawerId} data-plugin-drawer={p.id}>
          <SettingsForm plugin={p} loopback={loopback} />
        </div>
      )}
    </li>
  );
}

/** Computes the minimal per-field patch between `draft` and `current`, treating `null` and
 *  `undefined` as equal for non-secret fields (e.g. cleared optional numbers). */
export function pluginSettingsPatch(
  fields: readonly SettingField[],
  draft: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    const d = draft[f.key];
    const c = current[f.key];
    const same =
      f.type === "secret"
        ? JSON.stringify(d) === JSON.stringify(c)
        : JSON.stringify(d ?? null) === JSON.stringify(c ?? null);
    if (!same) patch[f.key] = d ?? null;
  }
  return patch;
}

export function SettingsForm({ plugin: p, loopback }: { plugin: InstalledPlugin; loopback: boolean }) {
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
  const patch = pluginSettingsPatch(fields, draft, current);
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    setSaving(true);
    setNote(null);
    try {
      // Only what changed goes; a secret still showing its mask is left alone by the server.
      const saved = await savePluginSettings(p.id, patch);
      setDraft(saved);
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
        if (!loopback || !dirty || saving) return;
        void save();
      }}
    >
      <div className="plug-fields">
        {fields.map((f) => (
          <Field
            key={f.key}
            pluginId={p.id}
            field={f}
            value={draft[f.key]}
            disabled={!loopback}
            onChange={(v) => {
              setNote(null);
              setDraft((d) => ({
                // A secret field typed empty again means "leave it": the stored one stays.
                ...d,
                [f.key]: f.type === "secret" && v === "" && isMasked(current[f.key]) ? current[f.key] : v,
              }));
            }}
          />
        ))}
      </div>
      <div className="plug-drawer-foot">
        <div className="plug-drawer-status" aria-live="polite">
          {note ? (
            <span className={`sect-note ${note.err ? "is-err" : ""}`}>{note.text}</span>
          ) : !loopback ? (
            <span className="sect-note">Settings save on the receiver machine only.</span>
          ) : null}
        </div>
        <div className="plug-drawer-actions">
          {dirty && loopback && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                setDraft(current);
                setNote(null);
              }}
            >
              Reset
            </button>
          )}
          <ActionButton
            type="submit"
            className={`btn btn--sm ${dirty && loopback ? "btn--primary" : ""}`}
            pending={saving}
            pendingLabel="Saving…"
            disabled={!loopback || !dirty || saving}
            title={loopback ? undefined : "Settings are saved from the receiver machine only"}
          >
            Save
          </ActionButton>
        </div>
      </div>
    </form>
  );
}

function Field({
  pluginId,
  field: f,
  value,
  disabled,
  onChange,
}: {
  pluginId: string;
  field: SettingField;
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = `plug-${pluginId}-${f.key}`;
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const help = f.help ? (
    <span className="plug-help" id={helpId}>
      {f.help}
    </span>
  ) : null;

  switch (f.type) {
    case "boolean": {
      const checked = value === true;
      return (
        <div className="plug-drawer-row plug-field--bool">
          <div className="plug-bool-text">
            <label className="plug-label" htmlFor={id}>
              {f.label}
            </label>
            {help}
          </div>
          <button
            id={id}
            type="button"
            role="switch"
            aria-checked={checked}
            aria-describedby={f.help ? helpId : undefined}
            className={`toggle ext-switch ${checked ? "toggle-on" : ""}`}
            disabled={disabled}
            onClick={() => onChange(!checked)}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      );
    }
    case "multiselect": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="plug-drawer-row">
          <fieldset className="plug-field plug-field--multi" disabled={disabled}>
            <legend className="plug-label">{f.label}</legend>
            <div className="plug-chips">
              {(f.options ?? []).map((o) => {
                const on = chosen.includes(o);
                return (
                  <label key={o} className={`plug-chip ${on ? "is-on" : ""}`}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      disabled={disabled}
                      onChange={(e) =>
                        onChange(
                          e.target.checked ? [...chosen.filter((c) => c !== o), o] : chosen.filter((c) => c !== o),
                        )
                      }
                    />
                    {on && (
                      <svg
                        className="plug-chip-check"
                        viewBox="0 0 12 12"
                        width="11"
                        height="11"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M2.5 6.25 5 8.75 9.5 3.5" />
                      </svg>
                    )}
                    <code>{o}</code>
                  </label>
                );
              })}
            </div>
            {help}
          </fieldset>
        </div>
      );
    }
    case "select":
      return (
        <div className="plug-drawer-row plug-field-grid">
          <span className="plug-label" id={labelId}>
            {f.label}
          </span>
          <div className="plug-control">
            <Select<string>
              id={id}
              labelledBy={labelId}
              value={typeof value === "string" ? value : ""}
              disabled={disabled}
              onChange={onChange}
              options={(f.options ?? []).map((o) => ({ value: o, label: o }))}
            />
            {help}
          </div>
        </div>
      );
    case "number":
      return (
        <div className="plug-drawer-row plug-field-grid">
          <label className="plug-label" htmlFor={id}>
            {f.label}
          </label>
          <div className="plug-control">
            <input
              id={id}
              type="number"
              className="field plug-input"
              value={typeof value === "number" ? value : ""}
              disabled={disabled}
              aria-describedby={f.help ? helpId : undefined}
              onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
            />
            {help}
          </div>
        </div>
      );
    case "secret": {
      // The stored secret is never sent to the page: the mask ("••••" + last 4) stands in as
      // the placeholder, and the field itself is empty until a new value is typed. Sending
      // the mask back (or nothing) leaves the stored secret as it is; null removes it.
      const stored = isMasked(value);
      return (
        <div className="plug-drawer-row plug-field-grid">
          <label className="plug-label" htmlFor={id}>
            {f.label}
          </label>
          <div className="plug-control">
            <div className="plug-secret">
              <input
                id={id}
                type="password"
                autoComplete="off"
                className="field plug-input"
                value={stored ? "" : typeof value === "string" ? value : ""}
                placeholder={stored ? String(value) : "not set"}
                disabled={disabled}
                aria-describedby={f.help ? helpId : undefined}
                onChange={(e) => onChange(e.target.value)}
                data-secret
              />
              {stored && !disabled && (
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => onChange(null)}
                  title="Clear the stored secret"
                >
                  Clear
                </button>
              )}
            </div>
            {help}
            {stored && <span className="plug-help">Stored (masked). Type to replace.</span>}
          </div>
        </div>
      );
    }
    default:
      return (
        <div className="plug-drawer-row plug-field-grid">
          <label className="plug-label" htmlFor={id}>
            {f.label}
          </label>
          <div className="plug-control">
            <input
              id={id}
              type="text"
              className="field plug-input"
              value={typeof value === "string" ? value : ""}
              disabled={disabled}
              aria-describedby={f.help ? helpId : undefined}
              onChange={(e) => onChange(e.target.value)}
            />
            {help}
          </div>
        </div>
      );
  }
}
