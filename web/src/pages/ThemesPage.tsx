// SPDX-License-Identifier: Apache-2.0
// /themes (the Views & Plugins page): styled as a calm macOS System Settings Extensions pane.
// Installed views and server plugins sit in inset grouped cards with 36x36 monochrome icon
// tiles, native switches, and a collapsible Install via CLI disclosure toggled from the bar.
import type { InstalledTheme } from "@shared/theme-api";
import { useEffect, useState } from "react";
import { CommandWell } from "../components/bits";
import { MoreButton, useContextMenu } from "../components/ContextMenu";
import { Extras } from "../components/Extras";
import { PageBar } from "../components/PageBar";
import { copyText } from "../lib/menus";
import { Link, navigate } from "../lib/router";
import { isLoopbackPage, PLUGIN_ADD_LINE, PluginsSection } from "../plugins/PluginsSection";
import { fetchPlugins, reloadPlugins, usePlugins } from "../plugins/registry";
import { fetchThemes, reloadThemes, setThemeDisabled, useThemes } from "../themes/host/registry";
import "../themes/host/host.css";

export const ADD_LINE = "sessionpipe-gui view add <source>";
const ONLY_HERE = "Only on the machine running the receiver";

/** Sanitize a manifest's inline SVG icon before rendering inside the 36x36 icon well. */
export function safeViewSvg(svg: string | undefined): string | null {
  if (!svg) return null;
  const s = svg.trim();
  if (!/^<svg[\s>]/i.test(s) || /<script|on[a-z]+\s*=|javascript:|<foreignObject|<iframe/i.test(s)) return null;
  return s;
}

/** Concise PageBar meta: "2 views · 1 plugin", "2 views", or undefined while empty. */
export function formatExtensionMeta(viewCount: number, pluginCount: number): string | undefined {
  const parts: string[] = [];
  if (viewCount > 0) parts.push(`${viewCount} ${viewCount === 1 ? "view" : "views"}`);
  if (pluginCount > 0) parts.push(`${pluginCount} ${pluginCount === 1 ? "plugin" : "plugins"}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Only noteworthy badges appear beside a view's title; bundled sits quietly in menu/tooltip. */
export function viewBadges(t: InstalledTheme): { key: string; label: string; err?: boolean }[] {
  const out: { key: string; label: string; err?: boolean }[] = [];
  if (t.linked) out.push({ key: "linked", label: "linked" });
  if (t.experimental) out.push({ key: "experimental", label: "experimental" });
  if (t.error) out.push({ key: "broken", label: "broken", err: true });
  return out;
}

export function Themes() {
  const { themes, loaded, error } = useThemes();
  const { plugins } = usePlugins();
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const loopback = isLoopbackPage();

  useEffect(() => {
    void fetchThemes();
    void fetchPlugins();
  }, []);

  const reloadAll = async () => {
    setBusy(true);
    setReloading(true);
    setNote(null);
    try {
      const results = await Promise.allSettled([reloadThemes(), reloadPlugins()]);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length === 0) {
        setNote("Reloaded views and plugins.");
      } else {
        const msg = failed.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join("; ");
        setNote(msg);
      }
    } finally {
      setBusy(false);
      setReloading(false);
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

  const meta = formatExtensionMeta(themes.length, plugins.length);

  return (
    <div className="page page--doc page--grouped themes">
      <PageBar
        title="Views"
        meta={meta}
        actions={
          <>
            <button
              type="button"
              className={`icon-btn themes-reload ${reloading ? "is-busy" : ""}`}
              onClick={() => void reloadAll()}
              disabled={!loopback || busy}
              aria-label="Reload"
              title={loopback ? "Reload views and plugins" : ONLY_HERE}
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
            <button
              type="button"
              className={`btn btn--sm ${addOpen ? "btn--on" : ""}`}
              onClick={() => setAddOpen((o) => !o)}
              aria-expanded={addOpen}
              aria-controls="themes-install-panel"
              data-add-toggle
            >
              <svg
                viewBox="0 0 12 12"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 2.25v7.5M2.25 6h7.5" />
              </svg>
              Add…
            </button>
          </>
        }
      />

      {addOpen && (
        <section
          className="form-group themes-install"
          id="themes-install-panel"
          data-install-panel
          aria-labelledby="views-add"
        >
          <div className="form-head">
            <h2 className="section-label" id="views-add">
              Install via CLI
            </h2>
            <button
              type="button"
              className="icon-btn themes-install-close"
              onClick={() => setAddOpen(false)}
              aria-label="Close install instructions"
              title="Close"
            >
              <svg
                viewBox="0 0 12 12"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" />
              </svg>
            </button>
          </div>
          <div className="form-list themes-install-card">
            <div className="themes-install-row">
              <span className="themes-install-kind">View</span>
              <CommandWell command={ADD_LINE} label="Copy view install command" />
            </div>
            <div className="themes-install-row">
              <span className="themes-install-kind">Plugin</span>
              <CommandWell command={PLUGIN_ADD_LINE} label="Copy plugin install command" />
            </div>
          </div>
          <p className="caption">
            Run on this computer, then Reload. Also <code>view link</code>, <code>view remove</code>,{" "}
            <code>view list</code>.
          </p>
        </section>
      )}

      <section className="form-group" aria-labelledby="views-installed">
        <div className="form-head">
          <h2 className="section-label" id="views-installed">
            Views
          </h2>
        </div>
        {error && <p className="page-note is-err">{error}</p>}
        {loaded && themes.length === 0 && !error && (
          <div className="form-list themes-empty-card">
            <p className="state-text themes-empty">
              No views installed.{" "}
              <button type="button" className="themes-inline-link" onClick={() => setAddOpen(true)}>
                Install via CLI…
              </button>
            </p>
          </div>
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
                onReload={() => void reloadAll()}
              />
            ))}
          </ul>
        )}
        <div className="themes-tools" aria-live="polite">
          {note && <span className="sect-note">{note}</span>}
          {!loopback && <span className="sect-note">Reload and toggles work on the receiver machine only.</span>}
        </div>
      </section>

      <Extras loopback={loopback} />

      <PluginsSection reloading={reloading} onAddClick={() => setAddOpen(true)} />

      <footer className="themes-trust-foot">
        <svg
          className="themes-trust-icon"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 1.75 2.75 3.75v4.1c0 3.1 2.25 5.45 5.25 6.4 3-.95 5.25-3.3 5.25-6.4v-4.1L8 1.75Z" />
          <path d="M8 7v3" />
          <circle cx="8" cy="4.9" r="0.6" fill="currentColor" stroke="none" />
        </svg>
        <p className="themes-trust">
          Views run inside this page with access to your sessions and events; plugins run inside the receiver process
          and can notify or suggest answers, never sign permissions (only your passkey signs those). Neither is
          sandboxed. Only install themes and plugins you trust.
        </p>
      </footer>
    </div>
  );
}

export function ViewIconTile({ theme }: { theme: Pick<InstalledTheme, "id" | "icon" | "disabled" | "error"> }) {
  const svg = safeViewSvg(theme.icon);
  const cls = `ext-icon${theme.disabled ? " ext-icon--dim" : ""}${theme.error ? " ext-icon--err" : ""}`;
  return (
    <span className={cls} aria-hidden="true">
      {svg ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by safeViewSvg (rejects scripts, event handlers, foreignObject, iframe)
        <span className="ext-icon-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <FallbackViewIcon id={theme.id} />
      )}
    </span>
  );
}

function FallbackViewIcon({ id }: { id: string }) {
  if (id === "canvas") {
    return (
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
        <rect x="2.5" y="3.5" width="9" height="6.5" rx="1.5" />
        <rect x="8.5" y="10" width="9" height="6.5" rx="1.5" />
        <path d="M2.5 6.5h9M8.5 13h9" />
      </svg>
    );
  }
  if (id === "office") {
    return (
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
        <path d="M10 2.75 17 6.5v7L10 17.25 3 13.5v-7L10 2.75Z" />
        <path d="M3 6.5 10 10.25 17 6.5" />
        <path d="M10 10.25v7" />
      </svg>
    );
  }
  return (
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
  );
}

export function ThemeRow({
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
  const displayName = t.name || t.id;
  const buildMenu = () => [
    canOpen && { label: "Open", run: () => navigate(`/t/${encodeURIComponent(t.id)}`) },
    !t.error && {
      label: t.disabled ? "Enable" : "Disable",
      run: () => onToggle(!t.disabled),
      disabled: loopback ? (busy ? "Busy" : undefined) : ONLY_HERE,
    },
    path && { label: "Copy path", run: () => copyText(path) },
    { sep: true as const },
    { label: "Reload views", run: onReload, disabled: loopback ? undefined : ONLY_HERE },
  ];
  const menu = useContextMenu(buildMenu, {
    title: () => displayName,
    subtitle: () => (t.bundled ? `/t/${t.id} · Bundled` : `/t/${t.id}`),
  });
  const badges = viewBadges(t);
  const switchTitle = loopback
    ? t.bundled
      ? "Bundled with the app: cannot be removed, only hidden"
      : t.disabled
        ? "Show in the sidebar"
        : "Hide from the sidebar without removing its files"
    : ONLY_HERE;

  return (
    <li
      className="form-row themes-row ext-row"
      data-theme-row={t.id}
      data-disabled={t.disabled ? "" : undefined}
      data-bundled={t.bundled ? "" : undefined}
      {...menu}
    >
      <ViewIconTile theme={t} />
      <span className="form-row-text ext-body">
        <span className="themes-row-head">
          <span className="themes-row-name">{displayName}</span>
          {t.version && <span className="themes-row-ver num">{t.version}</span>}
          {badges.map((b) => (
            <span key={b.key} className={`themes-flag ext-pill${b.err ? " themes-flag--err ext-pill--err" : ""}`}>
              {b.label}
            </span>
          ))}
        </span>
        {t.description && <span className="form-caption themes-row-meta">{t.description}</span>}
        {t.error && <span className="themes-row-err">{t.error}</span>}
      </span>
      <span className="form-value themes-row-actions">
        {canOpen && (
          <Link to={`/t/${encodeURIComponent(t.id)}`} className="btn btn--sm">
            Open
          </Link>
        )}
        {!t.error && (
          <button
            type="button"
            role="switch"
            aria-checked={!t.disabled}
            aria-label={`${t.disabled ? "Enable" : "Disable"} ${displayName}`}
            className={`toggle ext-switch ${!t.disabled ? "toggle-on" : ""}`}
            onClick={() => onToggle(!t.disabled)}
            disabled={!loopback || busy}
            title={switchTitle}
            data-toggle={t.id}
          >
            <span className="toggle-knob" />
          </button>
        )}
        <MoreButton
          build={buildMenu}
          label={`Actions for ${displayName}`}
          title={() => displayName}
          className="ext-more"
        />
      </span>
    </li>
  );
}
