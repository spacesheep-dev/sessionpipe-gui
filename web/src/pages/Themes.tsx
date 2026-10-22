// SPDX-License-Identifier: Apache-2.0
// /themes (the Views page): what is installed, as rows (name, version, one line of what it
// is, Open and Disable), Reload in the bar for this machine, the one line that installs
// more, the extras not yet here, the server plugins, and the warning that a view is code
// running in this page. A row's menu opens it, turns it on or off and copies its path.
import type { InstalledTheme } from "@shared/theme-api";
import { useEffect, useState } from "react";
import { CopyIconButton } from "../components/bits";
import { useContextMenu } from "../components/ContextMenu";
import { Extras } from "../components/Extras";
import { PageBar } from "../components/PageBar";
import { copyText } from "../lib/menus";
import { Link, navigate } from "../lib/router";
import { PluginsSection } from "../plugins/PluginsSection";
import { fetchThemes, reloadThemes, setThemeDisabled, useThemes } from "../themes/host/registry";
import "../themes/host/host.css";

export const ADD_LINE = "sessionpipe-gui view add <folder | view.tgz | view.zip | npm-package | git-url>";
const ONLY_HERE = "Only on the machine running the receiver";

export function Themes() {
  const { themes, loaded, error } = useThemes();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

  useEffect(() => {
    void fetchThemes();
  }, []);

  const reload = async () => {
    setBusy(true);
    setNote(null);
    try {
      await reloadThemes();
      setNote("Re-read the themes folder.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (id: string, off: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      await setThemeDisabled(id, off);
      setNote(off ? `${id} is off: hidden from the rail.` : `${id} is on.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page--doc page--grouped themes">
      <PageBar
        title="Views"
        meta={themes.length ? `${themes.length} installed` : undefined}
        actions={
          <button
            type="button"
            className="icon-btn"
            onClick={() => void reload()}
            disabled={!loopback || busy}
            aria-label="Reload"
            title={loopback ? "Reload: re-read the themes folder" : ONLY_HERE}
          >
            <svg
              viewBox="0 0 16 16"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M13 8a5 5 0 1 1-1.5-3.6" />
              <path d="M13 2.5v3h-3" />
            </svg>
          </button>
        }
      />
      <section className="form-group" aria-labelledby="views-installed">
        <div className="form-head">
          <h2 className="section-label" id="views-installed">
            Installed
          </h2>
        </div>
        {error && <p className="page-note is-err">{error}</p>}
        {loaded && themes.length === 0 && !error && (
          <p className="state-text themes-empty">No views installed. Add one with the command below.</p>
        )}
        {themes.length > 0 && (
          <ul className="form-list themes-list">
            {themes.map((t) => (
              <ThemeRow
                key={t.id}
                t={t}
                loopback={loopback}
                busy={busy}
                onToggle={(off) => void toggle(t.id, off)}
                onReload={() => void reload()}
              />
            ))}
          </ul>
        )}
        <div className="themes-tools">
          {note && <span className="sect-note">{note}</span>}
          {!loopback && <span className="sect-note">Reload works on the receiver machine only.</span>}
        </div>
      </section>

      <section className="form-group" aria-labelledby="views-add">
        <div className="form-head">
          <h2 className="section-label" id="views-add">
            Add a view
          </h2>
        </div>
        <div className="well-row cmd">
          <code className="cmd-text">{ADD_LINE}</code>
          <CopyIconButton text="sessionpipe-gui view add " label="Copy command" />
        </div>
        <p className="caption">
          On the receiver machine, then Reload. Also <code>view link</code>, <code>view remove</code>,{" "}
          <code>view list</code>; how to write one is <code>docs/theme-authoring.md</code>.
        </p>
      </section>

      <Extras loopback={loopback} />

      <PluginsSection />

      <section className="form-group" aria-labelledby="views-trust">
        <div className="form-head">
          <h2 className="section-label" id="views-trust">
            Trust
          </h2>
        </div>
        <p className="caption themes-trust">
          A view is code that runs in this page, with everything the page has: every session and event, tool input and
          output, and Forget. It is served from your own state dir and nothing sandboxes it. Only install themes you
          trust, from people you trust.
        </p>
      </section>
    </div>
  );
}

function ThemeRow({
  t,
  loopback,
  busy,
  onToggle,
  onReload,
}: {
  t: InstalledTheme;
  loopback: boolean;
  busy: boolean;
  onToggle: (off: boolean) => void;
  onReload: () => void;
}) {
  const path = t.dir ?? t.source;
  const canOpen = !t.error && !t.disabled;
  const menu = useContextMenu(
    () => [
      canOpen && { label: "Open", run: () => navigate(`/t/${encodeURIComponent(t.id)}`) },
      !t.error && {
        label: t.disabled ? "Enable" : "Disable",
        run: () => onToggle(!t.disabled),
        disabled: loopback ? (busy ? "Busy" : undefined) : ONLY_HERE,
      },
      path && { label: "Copy path", run: () => copyText(path) },
      { sep: true },
      { label: "Reload views", run: onReload, disabled: loopback ? undefined : ONLY_HERE },
    ],
    { title: () => t.name || t.id, subtitle: () => `/t/${t.id}` },
  );
  const flags = [
    t.linked && "linked",
    t.bundled && "bundled",
    t.disabled && "disabled",
    t.experimental && "experimental",
  ].filter((f): f is string => !!f);
  return (
    <li className="form-row themes-row" data-theme-row={t.id} {...menu}>
      <span className="form-row-text">
        <span className="themes-row-head">
          <span className="themes-row-name">{t.name || t.id}</span>
          {t.version && <span className="themes-row-ver num">{t.version}</span>}
          {flags.map((f) => (
            <span key={f} className="themes-flag">
              {f}
            </span>
          ))}
          {t.error && <span className="themes-flag themes-flag--err">broken</span>}
        </span>
        {t.description && <span className="form-caption themes-row-meta">{t.description}</span>}
        {t.error && <span className="themes-row-err">{t.error}</span>}
      </span>
      <span className="form-value themes-row-open">
        {canOpen && (
          <Link to={`/t/${encodeURIComponent(t.id)}`} className="btn btn--sm">
            Open
          </Link>
        )}
        {!t.error && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => onToggle(!t.disabled)}
            disabled={!loopback || busy}
            title={
              loopback
                ? t.bundled
                  ? "Bundled with the app: it cannot be removed, only hidden"
                  : "Hide it from the sidebar without removing its files"
                : ONLY_HERE
            }
            data-toggle={t.id}
          >
            {t.disabled ? "Enable" : "Disable"}
          </button>
        )}
      </span>
    </li>
  );
}
