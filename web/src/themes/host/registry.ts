// SPDX-License-Identifier: Apache-2.0
// The installed themes as the page knows them: fetched from GET /api/ui/themes at boot
// and again whenever the stream comes back (a reconnect may follow a server restart
// with new themes). A small external store so the shell, the theme page and the
// Themes page all read the same list.
import type { InstalledTheme } from "@shared/theme-api";
import { THEME_ROUTES } from "@shared/theme-api";
import { useSyncExternalStore } from "react";
import { apiUrl } from "../../lib/net";

export interface ThemesState {
  themes: readonly InstalledTheme[];
  /** The first fetch finished (with a list or an error). */
  loaded: boolean;
  error: string | null;
}

let state: ThemesState = { themes: [], loaded: false, error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function set(patch: Partial<ThemesState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

async function request(url: string, method: "GET" | "POST"): Promise<InstalledTheme[]> {
  const res = await fetch(apiUrl(url), { method, headers: { accept: "application/json" } });
  if (!res.ok) {
    let reason = `${res.status} ${res.statusText}`;
    try {
      reason = ((await res.json()) as { reason?: string }).reason ?? reason;
    } catch {
      // no body
    }
    throw new Error(reason);
  }
  const body = (await res.json()) as { themes?: InstalledTheme[] };
  return Array.isArray(body.themes) ? body.themes : [];
}

/** Fetch the list; concurrent calls share one request. */
export function fetchThemes(): Promise<void> {
  if (inflight) return inflight;
  inflight = request(THEME_ROUTES.list, "GET")
    .then((themes) => set({ themes, loaded: true, error: null }))
    .catch((e: unknown) => set({ loaded: true, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Ask the server to re-read the themes dir (loopback only), then take its answer. */
export async function reloadThemes(): Promise<void> {
  try {
    const themes = await request(THEME_ROUTES.reload, "POST");
    set({ themes, loaded: true, error: null });
  } catch (e) {
    set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** Hide a view (a bundled one cannot be removed) or show it again; loopback only. */
export async function setThemeDisabled(id: string, off: boolean): Promise<void> {
  const themes = await request(
    `${THEME_ROUTES.toggle}/${encodeURIComponent(id)}/${off ? "disable" : "enable"}`,
    "POST",
  );
  set({ themes, loaded: true, error: null });
}

export function useThemes(): ThemesState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
