// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. New session in the app itself: the compose glyph, ⌘N in an
// installed window, `?new=1`, and the host that shows the sheet (NewSessionSheet.tsx, with
// its rows, files and start). The sheet is fetched once the page is idle, so it costs the
// first load nothing and opens at once; asked for before that, an invisible field holds
// the keys typed meanwhile so none of them reaches the page. Mounted once, in the shell.
import { useEffect } from "react";
import { lazyModule, whenIdle } from "../lib/lazy";
import { usePresence } from "../lib/motion";
import { setSearchParams } from "../lib/router";
import { hintFor } from "../lib/shortcuts";
import "./newSession.css";
import { closeNewSession, type NewSessionTarget, openNewSession, useNewSession } from "./newSessionState";

const sheetModule = lazyModule(() => import("./NewSessionSheet"));
whenIdle(() => void sheetModule.preload().catch(() => {}));

export function NewSessionHost() {
  const { open, target, seq } = useNewSession();
  const mod = sheetModule.use();
  // Kept for its exit (sheet-lift on a desktop, sheet-down on a phone), then let go.
  const { mounted, closing } = usePresence(open);
  if (!mounted) return null;
  if (!mod) return closing ? null : <KeyCatch />;
  return <mod.Sheet key={seq} target={target} closing={closing} />;
}

/** The stand-in while the sheet may still be loading: a field no one sees, holding focus,
 *  so a key typed after `c` is not the page's ("g" "b" must not navigate away). */
function KeyCatch() {
  return (
    <input
      className="sr-only"
      aria-label="New session"
      // biome-ignore lint/a11y/noAutofocus: it stands in for the sheet, which takes focus as it opens
      autoFocus
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") closeNewSession();
      }}
    />
  );
}

/** The compose glyph (a square and a pencil): the sidebar header, the phone's Board and
 *  Inbox bars. Opens the sheet with the board's context. */
export function ComposeButton({ className = "" }: { className?: string }) {
  const keys = hintFor("newSession.open");
  const label = "New session";
  return (
    <button
      type="button"
      className={`icon-btn compose-btn ${className}`}
      aria-label={label}
      data-tip={label}
      data-tip-keys={keys || undefined}
      data-tip-side="bottom"
      onClick={() => openNewSession()}
      data-compose
    >
      <svg
        viewBox="0 0 20 20"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5V11" />
        <path d="M14.2 3.3a1.3 1.3 0 0 1 1.9 0l.6.6a1.3 1.3 0 0 1 0 1.9L10.5 12 8 12.5l.5-2.5z" />
      </svg>
    </button>
  );
}

/** `?new=1` on any route (with `machine=`, `harness=`, `cwd=`; the PWA's manifest shortcut
 *  uses `/?new=1`) opens the sheet over the page, and the parameters leave the address. */
export function useNewFromUrl(path: string): void {
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("new") !== "1") return;
    const target: NewSessionTarget = {};
    const machine = q.get("machine");
    const harness = q.get("harness");
    const cwd = q.get("cwd");
    if (machine) target.machine = machine;
    if (harness) target.harness = harness;
    if (cwd) target.cwd = cwd;
    setSearchParams({ new: null, machine: null, harness: null, cwd: null }, { replace: true });
    openNewSession(target);
  }, [path]);
}

/** ⌘N (Ctrl+N elsewhere) reaches a page only in an installed app's own window; a tab's is
 *  the browser's, which is why `mod+n` stays unbindable. In that window it opens the sheet,
 *  and the first time it arrives the shortcut table learns it works here. */
export const STANDALONE_KEY = "sp.newSession.modN";
export function useStandaloneNewKey(): void {
  useEffect(() => {
    if (typeof matchMedia !== "function" || !matchMedia("(display-mode: standalone)").matches) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "n" || e.defaultPrevented) return;
      e.preventDefault();
      try {
        localStorage.setItem(STANDALONE_KEY, "1");
      } catch {}
      openNewSession();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
