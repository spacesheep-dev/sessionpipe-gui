// SPDX-License-Identifier: Apache-2.0
// /t/<id>: the page a theme renders into. Links the manifest's stylesheet, imports the
// entry module from /themes/<id>/, calls mount(container, api) and unmounts when the
// route changes. A theme that fails to import or mount gets a readable panel with the
// message and the file, never a blank page.
import type { Theme } from "@shared/theme-api";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../data/hooks";
import { Link } from "../../lib/router";
import { createThemeApi } from "./api";
import { useThemes } from "./registry";
import "./host.css";

interface Failure {
  stage: "import" | "mount";
  message: string;
  url: string;
}

const describe = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function ThemePage({ id }: { id: string }) {
  const store = useStore();
  const { themes, loaded, error: listError } = useThemes();
  const theme = themes.find((t) => t.id === id);
  const ref = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [status, setStatus] = useState<"loading" | "mounted">("loading");

  // Primitive deps: the list is refetched on every reconnect and would otherwise remount.
  const manifestKey =
    theme && !theme.error && !theme.disabled ? JSON.stringify([theme.url, theme.entry, theme.style, theme.linked]) : "";

  useEffect(() => {
    const el = ref.current;
    if (!theme || theme.error || theme.disabled || !el) return;
    let cancelled = false;
    let unmount: (() => void) | null = null;
    let link: HTMLLinkElement | null = null;
    let dispose: (() => void) | null = null;
    setFailure(null);
    setStatus("loading");

    // A linked theme is being edited: a fresh module instance on every visit.
    const bust = theme.linked ? `?v=${Date.now()}` : "";
    const base = `${location.origin}${theme.url}`;
    const entryUrl = `${base}${theme.entry ?? "index.js"}${bust}`;

    const run = async () => {
      if (theme.style) {
        link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = `${base}${theme.style}${bust}`;
        link.dataset.theme = theme.id;
        document.head.appendChild(link);
      }
      let mod: { default?: Partial<Theme> } & Partial<Theme>;
      try {
        mod = (await import(/* @vite-ignore */ entryUrl)) as typeof mod;
      } catch (e) {
        throw { stage: "import", message: describe(e), url: entryUrl } satisfies Failure;
      }
      const t = mod.default?.mount ? mod.default : mod;
      if (typeof t.mount !== "function") {
        throw {
          stage: "import",
          message: "the module's default export has no mount(container, api) function",
          url: entryUrl,
        } satisfies Failure;
      }
      let version = "0.0.0";
      try {
        version = (await store.transport.info()).version;
      } catch {
        // the mock, or offline: the theme still mounts
      }
      if (cancelled) return;
      const built = createThemeApi({ store, manifest: theme, host: { name: "sessionpipe-gui", version } });
      dispose = built.dispose;
      let un: (() => void) | undefined;
      try {
        un = (await t.mount(el, built.api)) ?? undefined;
      } catch (e) {
        throw { stage: "mount", message: describe(e), url: entryUrl } satisfies Failure;
      }
      if (cancelled) {
        un?.();
        return;
      }
      unmount = typeof un === "function" ? un : null;
      setStatus("mounted");
    };
    run().catch((f: unknown) => {
      if (cancelled) return;
      const failure: Failure =
        f && typeof f === "object" && "stage" in f
          ? (f as Failure)
          : { stage: "mount", message: describe(f), url: entryUrl };
      console.error(`[theme ${theme.id}] ${failure.stage} failed:`, failure.message);
      setFailure(failure);
    });

    return () => {
      cancelled = true;
      try {
        unmount?.();
      } catch (e) {
        console.error(`[theme ${theme.id}] unmount threw`, e);
      }
      dispose?.();
      link?.remove();
      el.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestKey, store]);

  const notFound = loaded && !theme;
  return (
    <div className="theme-page" data-theme-page={id} data-status={failure ? "error" : status}>
      <div
        className="theme-host"
        ref={ref}
        data-theme-id={id}
        hidden={!!failure || !theme || !!theme.error || !!theme.disabled}
      />
      {theme?.error && <ErrorPanel title={`${theme.name || id} cannot load`} message={theme.error} url={theme.url} />}
      {theme && !theme.error && theme.disabled && (
        <ErrorPanel
          title={`${theme.name || id} is disabled`}
          message={
            theme.bundled
              ? "This view ships with the GUI and was turned off. Enable it on the Views page, or with `sessionpipe-gui view enable` on the receiver machine."
              : "This view was turned off. Enable it on the Views page, or with `sessionpipe-gui view enable` on the receiver machine."
          }
        />
      )}
      {failure && (
        <ErrorPanel
          title={`${theme?.name ?? id} failed to ${failure.stage === "import" ? "load" : "mount"}`}
          message={failure.message}
          url={failure.url}
        />
      )}
      {notFound && (
        <ErrorPanel
          title={`No theme "${id}" is installed`}
          message={listError ? `The theme list could not be read: ${listError}` : "It may have been removed."}
        />
      )}
      {!loaded && !theme && (
        <p className="theme-wait" aria-live="polite">
          Loading themes…
        </p>
      )}
    </div>
  );
}

function ErrorPanel({ title, message, url }: { title: string; message: string; url?: string }) {
  return (
    <section className="theme-error state" role="alert">
      <svg className="state-glyph theme-error-glyph" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 7.5v5.5M12 16.2v.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <h2 className="state-title">{title}</h2>
      <pre className="theme-error-msg">{message}</pre>
      {url && (
        <p className="theme-error-file">
          <span>File</span> <code>{url}</code>
        </p>
      )}
      <p className="state-text theme-error-help">
        Fix it and reload the page, or manage views on the <Link to="/themes">Views page</Link>. A linked view reloads
        from its folder on every visit.
      </p>
    </section>
  );
}
