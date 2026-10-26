// SPDX-License-Identifier: Apache-2.0
// The installed server plugins as the page knows them: GET /api/ui/plugins, the reload,
// the settings save and the enable / disable switch (all answer only from the receiver
// machine). A small external store, like the one for views, so the Views page and
// anything else read one list.
import type { InstalledPlugin } from "@shared/plugin-api";
import { PLUGIN_ROUTES } from "@shared/plugin-api";
import { useSyncExternalStore } from "react";
import { apiUrl } from "../lib/net";

export interface PluginsState {
  plugins: readonly InstalledPlugin[];
  /** The first fetch finished (with a list or an error). */
  loaded: boolean;
  error: string | null;
  /** The server runs in demo mode: plugins stay inactive. */
  demo: boolean;
}

let state: PluginsState = { plugins: [], loaded: false, error: null, demo: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function set(patch: Partial<PluginsState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

async function request<T>(url: string, method: "GET" | "POST" | "PUT", body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let reason = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { reason?: string; message?: string };
      reason = j.message ?? j.reason ?? reason;
    } catch {
      // no body
    }
    throw new Error(reason);
  }
  return (await res.json()) as T;
}

const listOf = (body: { plugins?: InstalledPlugin[] }): InstalledPlugin[] =>
  Array.isArray(body.plugins) ? body.plugins : [];

/** Fetch the list; concurrent calls share one request. */
export function fetchPlugins(): Promise<void> {
  if (inflight) return inflight;
  inflight = request<{ plugins?: InstalledPlugin[]; demo?: boolean }>(PLUGIN_ROUTES.list, "GET")
    .then((body) => set({ plugins: listOf(body), loaded: true, error: null, demo: body.demo === true }))
    .catch((e: unknown) => set({ loaded: true, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Deactivate, re-read the plugins dir, import afresh and activate (loopback only). */
export async function reloadPlugins(): Promise<void> {
  const body = await request<{ plugins?: InstalledPlugin[] }>(PLUGIN_ROUTES.reload, "POST");
  set({ plugins: listOf(body), loaded: true, error: null });
}

/** Turn a plugin on or off (loopback only); remembered by the server in config.json. */
export async function setPluginEnabled(id: string, on: boolean): Promise<void> {
  const body = await request<{ plugins?: InstalledPlugin[] }>(
    `${PLUGIN_ROUTES.toggle}/${encodeURIComponent(id)}/${on ? "enable" : "disable"}`,
    "POST",
  );
  set({ plugins: listOf(body), loaded: true, error: null });
}

/** Save one plugin's settings (loopback only); the list is updated with the masked values. */
export async function savePluginSettings(id: string, values: Record<string, unknown>): Promise<void> {
  const body = await request<{ settings: Record<string, unknown> }>(
    `${PLUGIN_ROUTES.settings}/${encodeURIComponent(id)}/settings`,
    "PUT",
    values,
  );
  set({ plugins: state.plugins.map((p) => (p.id === id ? { ...p, values: body.settings } : p)) });
  // The plugin may have come alive (or fallen over) on the new values.
  void fetchPlugins();
}

export function usePlugins(): PluginsState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
