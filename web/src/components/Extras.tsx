// SPDX-License-Identifier: Apache-2.0
// The curated extras on the Views page: official views, plugins, and skins not yet bundled.
// Styled with the same 36x36 .ext-icon row grammar as Views and Plugins, with loopback-only
// Install buttons and one copyable CLI line below.
import type { ExtraEntry, ExtrasResponse } from "@shared/api";
import { ROUTES } from "@shared/api";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/net";
import { fetchSkins } from "../lib/skins";
import { fetchPlugins } from "../plugins/registry";
import { fetchThemes } from "../themes/host/registry";
import { ActionButton, CommandWell } from "./bits";

export const EXTRAS_ALL_LINE = "sessionpipe-gui extras add all";

type Row = ExtrasResponse["extras"][number];

/** Re-read whatever list the kind shows up in. */
function refresh(kind: ExtraEntry["kind"]): Promise<void> {
  return kind === "view" ? fetchThemes() : kind === "skin" ? fetchSkins() : fetchPlugins();
}

function ExtraIconTile({ kind }: { kind: ExtraEntry["kind"] }) {
  return (
    <span className="ext-icon" aria-hidden="true">
      {kind === "plugin" ? (
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
      ) : kind === "skin" ? (
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
          <circle cx="10" cy="10" r="6.75" />
          <circle cx="7.5" cy="8.5" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="10.5" cy="6.75" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="13" cy="9" r="0.9" fill="currentColor" stroke="none" />
          <path d="M12.25 13.5a1.5 1.5 0 0 1-1.5-1.5" />
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
          <rect x="2.75" y="3.5" width="14.5" height="13" rx="2" />
          <path d="M2.75 7.25h14.5" />
          <path d="M8.5 7.25v9.25" />
        </svg>
      )}
    </span>
  );
}

export function Extras({ loopback }: { loopback: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(ROUTES.ui.extras, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setRows(((await res.json()) as ExtrasResponse).extras);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const install = async (row: Row) => {
    setBusy(row.id);
    setLog((l) => ({ ...l, [row.id]: "" }));
    try {
      const res = await apiFetch(`${ROUTES.ui.extras}/${encodeURIComponent(row.id)}/install`, { method: "POST" });
      const text = res.ok ? await res.text() : `${res.status} ${res.statusText}`;
      setLog((l) => ({ ...l, [row.id]: text.trim() }));
      if (res.ok && text.trimEnd().endsWith("\nok")) await refresh(row.kind);
      await load();
    } catch (e) {
      setLog((l) => ({ ...l, [row.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };
  const installAll = async () => {
    for (const row of rows ?? []) if (!row.bundled && !row.installed) await install(row);
  };

  // The bundled extras are the views and plugins listed above already: only what is not
  // here yet gets a row of its own.
  const available = (rows ?? []).filter((r) => !r.bundled);
  const todo = available.filter((r) => !r.installed);
  if (!error && available.length === 0) return null;
  return (
    <section className="form-group" data-extras aria-labelledby="views-extras">
      <div className="form-head">
        <h2 className="section-label" id="views-extras">
          Extras
        </h2>
        {available.length > 1 && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void installAll()}
            disabled={!loopback || busy !== null || todo.length === 0}
            title={loopback ? "Install every extra that is not there yet" : "Only on the machine running the receiver"}
            data-extras-install-all
          >
            {todo.length === 0 ? "All installed" : `Install all (${todo.length})`}
          </button>
        )}
      </div>
      {error && <p className="page-note is-err">{error}</p>}
      <ul className="form-list extras-list">
        {available.map((r) => (
          <li key={r.id} className="form-row themes-row ext-row extras-row" data-extra={r.id}>
            <ExtraIconTile kind={r.kind} />
            <span className="form-row-text ext-body">
              <span className="themes-row-head">
                <span className="themes-row-name">{r.name}</span>
                <span className="themes-row-ver">
                  {r.kind} · {r.size}
                </span>
                {r.installed && <span className="themes-flag ext-pill">installed</span>}
              </span>
              <span className="form-caption themes-row-meta">{r.line}</span>
              {log[r.id] && (
                <pre className={`extras-log${log[r.id]?.endsWith("\nok") ? "" : " is-err"}`} data-extra-log={r.id}>
                  {log[r.id]}
                </pre>
              )}
            </span>
            <span className="form-value themes-row-actions">
              <ActionButton
                className="btn btn--sm"
                pending={busy === r.id}
                pendingLabel="Installing…"
                onClick={() => void install(r)}
                disabled={!loopback || busy !== null}
                title={loopback ? `npm install ${r.npm}` : "Only on the machine running the receiver"}
                data-extra-install={r.id}
              >
                {r.installed ? "Reinstall" : "Install"}
              </ActionButton>
            </span>
          </li>
        ))}
      </ul>
      <div className="extras-cmd">
        <CommandWell command={EXTRAS_ALL_LINE} label="Copy command" />
      </div>
    </section>
  );
}
