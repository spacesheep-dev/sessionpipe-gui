// SPDX-License-Identifier: Apache-2.0
// The curated extras on the Views page: the official views and plugins. The bundled ones
// are already the rows of the lists above, so only an entry that is not bundled gets a row
// here, with an Install button that works from the receiver machine (POST
// /api/ui/extras/:id/install, loopback only) and the one line that does the same from a
// terminal anywhere. With everything bundled the section is not drawn.
import type { ExtraEntry, ExtrasResponse } from "@shared/api";
import { ROUTES } from "@shared/api";
import { useCallback, useEffect, useState } from "react";
import { fetchSkins } from "../lib/skins";
import { fetchPlugins } from "../plugins/registry";
import { fetchThemes } from "../themes/host/registry";
import { CopyIconButton } from "./bits";

export const EXTRAS_ALL_LINE = "sessionpipe-gui extras add all";

type Row = ExtrasResponse["extras"][number];

/** Re-read whatever list the kind shows up in. */
function refresh(kind: ExtraEntry["kind"]): Promise<void> {
  return kind === "view" ? fetchThemes() : kind === "skin" ? fetchSkins() : fetchPlugins();
}

export function Extras({ loopback }: { loopback: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch(ROUTES.ui.extras, { headers: { accept: "application/json" } });
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
      const res = await fetch(`${ROUTES.ui.extras}/${encodeURIComponent(row.id)}/install`, { method: "POST" });
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
          <li key={r.id} className="form-row extras-row" data-extra={r.id}>
            <span className="form-row-text">
              <span className="themes-row-head">
                <span className="themes-row-name">{r.name}</span>
                <span className="themes-row-ver">
                  {r.kind} · {r.size}
                </span>
                {r.installed && <span className="themes-flag">installed</span>}
              </span>
              <span className="form-caption">{r.line}</span>
              {log[r.id] && (
                <pre className={`extras-log${log[r.id]?.endsWith("\nok") ? "" : " is-err"}`} data-extra-log={r.id}>
                  {log[r.id]}
                </pre>
              )}
            </span>
            <span className="form-value">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void install(r)}
                disabled={!loopback || busy !== null}
                title={loopback ? `npm install ${r.npm}` : "Only on the machine running the receiver"}
                data-extra-install={r.id}
              >
                {busy === r.id ? "Installing…" : r.installed ? "Reinstall" : "Install"}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="well-row cmd">
        <code className="extras-line">{EXTRAS_ALL_LINE}</code>
        <CopyIconButton text={EXTRAS_ALL_LINE} label="Copy command" />
      </div>
    </section>
  );
}
