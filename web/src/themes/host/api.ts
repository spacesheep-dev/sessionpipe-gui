// SPDX-License-Identifier: Apache-2.0
// The ThemeApi a mounted theme is handed (shared/theme-api.ts), built from what the
// page already has: the store, the transport, the router, the format helpers, the
// design tokens, the labels, the menus and the host's React. One instance per mount;
// `dispose()` drops the store subscription when the theme unmounts.
import {
  LABEL_COLORS,
  type LabelColor,
  type Labels,
  type SessionKey,
  type SessionSummary,
  type Stats,
  splitKey,
} from "@shared/api";
import {
  type ConnectionState,
  type InstalledTheme,
  THEME_API_VERSION,
  THEME_ROUTES,
  type ThemeApi,
  type ThemeSnapshot,
  type ViewMenuItem,
} from "@shared/theme-api";
import * as React from "react";
import * as ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import { confirmAction, type MenuItem, openMenu } from "../../components/ContextMenu";
import { createControlApi } from "../../control/themeControl";
import type { AppState, Store } from "../../data/store";
import { harnessMark, repoBranch, sessionTitle } from "../../lib/format";
import { harnessIconSvg } from "../../lib/harnessIcons";
import { labelName, requestLabelRename } from "../../lib/labels";
import { sessionItems, sessionMenuSubtitle, sessionMenuTitle } from "../../lib/menus";
import { apiUrl } from "../../lib/net";
import { agentPath, navigate, sessionPath } from "../../lib/router";
import { type AppSettings, effectiveLens, getSettings, subscribeSettings } from "../../lib/settings";
import { activeMap, registerViewActions } from "../../lib/shortcuts";
import { agentTabKey, openSplit } from "../../lib/split";
import { ago, dur } from "../../lib/time";
import tokensCss from "../../styles/tokens.css?raw";

/** Every custom property tokens.css defines, once, in order of first appearance. */
export const TOKENS: readonly string[] = (() => {
  const seen = new Set<string>();
  for (const m of tokensCss.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)) seen.add(m[1]!);
  return Object.freeze([...seen]);
})();

const EMPTY_STATS: Stats = { events: 0, sessions: 0, machines: 0, eventsLastMinute: 0, storageBytes: 0, uptimeS: 0 };

const CONNECTION: Record<AppState["connection"], ConnectionState> = {
  connecting: "connecting",
  reconnecting: "connecting",
  live: "live",
  offline: "offline",
};

/** The scheme the page renders in right now: the explicit choice, else the OS. */
export function resolvedScheme(): "dark" | "light" {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark" || t === "light") return t;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Fires when the resolved scheme changes (the theme switch, or the OS). */
function watchScheme(onChange: () => void): () => void {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener?.("change", onChange);
  return () => {
    mo.disconnect();
    mq?.removeEventListener?.("change", onChange);
  };
}

/** The labels as a view reads them: a map, and every colour's name resolved. One object
 *  per label document, so a snapshot made for another reason keeps the same one. */
const viewLabels = new WeakMap<Labels, NonNullable<ThemeSnapshot["labels"]>>();
function labelsFor(l: Labels): NonNullable<ThemeSnapshot["labels"]> {
  let v = viewLabels.get(l);
  if (!v) {
    v = Object.freeze({
      sessions: new Map(Object.entries(l.sessions)) as ReadonlyMap<SessionKey, LabelColor>,
      names: Object.freeze(Object.fromEntries(LABEL_COLORS.map((c) => [c, labelName(l, c)]))) as Readonly<
        Record<LabelColor, string>
      >,
    });
    viewLabels.set(l, v);
  }
  return v;
}

/** A view's menu rows as the host's: a view's own shortcut id names its live binding. */
function hostItems(items: readonly ViewMenuItem[], viewId: string): MenuItem[] {
  const own = activeMap();
  return items.map((i): MenuItem => {
    if ("sep" in i || "heading" in i) return i;
    if ("items" in i) return { label: i.label, disabled: i.disabled, items: hostItems(i.items, viewId) };
    const scoped = i.action && `${viewId}:${i.action}` in own ? `${viewId}:${i.action}` : i.action;
    return { ...i, action: scoped };
  });
}

export function toSnapshot(
  s: AppState,
  scheme: "dark" | "light",
  settings: AppSettings = getSettings(),
): ThemeSnapshot {
  return Object.freeze({
    connection: CONNECTION[s.connection],
    sessions: s.sessions,
    machines: s.machines,
    stats: s.stats ?? EMPTY_STATS,
    control: s.control,
    recent: s.recent,
    scheme,
    viewers: s.viewers,
    tierLens: effectiveLens(settings),
    mode: settings.mode,
    labels: labelsFor(s.labels),
  });
}

export interface ThemeApiOptions {
  store: Store;
  manifest: InstalledTheme;
  /** Where the view's files are (ThemePage's plan); the receiver's /themes/<id>/ by default. */
  base?: string;
  host: { name: string; version: string };
}

export function createThemeApi(opts: ThemeApiOptions): { api: ThemeApi; dispose: () => void } {
  const { store, manifest } = opts;
  const id = manifest.id;
  const baseUrl = opts.base ?? `${location.origin}${manifest.url}`;

  // One immutable snapshot per change of the store, the scheme or the settings, built on demand.
  let scheme = resolvedScheme();
  let cached: { base: AppState; scheme: "dark" | "light"; settings: AppSettings; snap: ThemeSnapshot } | null = null;
  const get = (): ThemeSnapshot => {
    const base = store.get();
    const settings = getSettings();
    if (!cached || cached.base !== base || cached.scheme !== scheme || cached.settings !== settings) {
      cached = { base, scheme, settings, snap: toSnapshot(base, scheme, settings) };
    }
    return cached.snap;
  };
  const subscribers = new Set<(s: ThemeSnapshot) => void>();
  const notify = () => {
    if (subscribers.size === 0) return;
    const snap = get();
    for (const l of subscribers) {
      try {
        l(snap);
      } catch (e) {
        console.error(`[theme ${id}] subscriber threw`, e);
      }
    }
  };
  const unsubStore = store.subscribe(notify);
  const unsubSettings = subscribeSettings(notify);
  const unwatch = watchScheme(() => {
    const next = resolvedScheme();
    if (next === scheme) return;
    scheme = next;
    notify();
  });

  const statePath = `${THEME_ROUTES.state}/${encodeURIComponent(id)}/state`;
  // The version of the stored document this page last read or wrote: a `viewState` frame
  // with another one is another device's write.
  let etag: string | null = null;
  const readState = async (): Promise<{ value: unknown; etag: string | null }> => {
    const res = await fetch(apiUrl(statePath), { headers: { accept: "application/json" } });
    if (res.status === 204) return { value: null, etag: res.headers.get("etag") };
    if (!res.ok) throw new Error(`theme storage: ${res.status} ${res.statusText}`);
    return { value: await res.json(), etag: res.headers.get("etag") };
  };
  // Writes in flight: the frame announcing our own write can land before the PUT's
  // answer names its ETag, so the check waits for them.
  let writing = 0;
  const writeState = async (value: unknown, ifMatch?: string | null): Promise<boolean> => {
    writing++;
    try {
      const res = await fetch(apiUrl(statePath), {
        method: "PUT",
        headers: { "content-type": "application/json", ...(ifMatch ? { "if-match": ifMatch } : {}) },
        body: JSON.stringify(value === undefined ? null : value),
      });
      if (res.status === 412) return false;
      if (!res.ok) {
        throw new Error(res.status === 413 ? "theme storage: value is over 256 KB" : `theme storage: ${res.status}`);
      }
      etag = res.headers.get("etag") ?? etag;
      return true;
    } finally {
      writing--;
      if (!writing) checkState();
    }
  };
  const stateListeners = new Set<(value: unknown) => void>();
  let seenState = store.get().viewStates.get(id);
  const checkState = (): void => {
    const next = store.get().viewStates.get(id);
    if (writing || next === seenState) return;
    seenState = next;
    if (!next || next === etag || stateListeners.size === 0) return;
    void readState()
      .then((r) => {
        etag = r.etag;
        for (const l of stateListeners) {
          try {
            l(r.value);
          } catch (e) {
            console.error(`[theme ${id}] storage listener threw`, e);
          }
        }
      })
      .catch((e) => console.warn(`[theme ${id}] storage re-read failed`, e));
  };
  const unsubState = store.subscribe(checkState);
  /** The view's registered keys, removed on dispose. */
  const unregisters = new Set<() => void>();
  const localKey = (k: string) => `sessionpipe-gui.theme.${id}.${k}`;

  const api: ThemeApi = {
    version: THEME_API_VERSION,
    host: opts.host,
    manifest,
    baseUrl,
    state: {
      get,
      subscribe(listener) {
        subscribers.add(listener);
        return () => {
          subscribers.delete(listener);
        };
      },
    },
    onEvent: (listener) => store.onEvent(listener),
    fetch: {
      session(key, o = {}) {
        const { harness, id: sid } = splitKey(key);
        return store.transport.session(harness, sid, o);
      },
      forget(key) {
        const { harness, id: sid } = splitKey(key);
        return store.transport.forget(harness, sid);
      },
    },
    navigate: (path) => navigate(path),
    openSession(key: SessionKey, opts) {
      // An agent beside is the panel's agent tab, right after its session's tab.
      if (opts?.split) {
        openSplit(opts.agent ? agentTabKey(key, opts.agent) : key, { from: opts.from, background: opts.background });
        return;
      }
      const { harness, id: sid } = splitKey(key);
      navigate(opts?.agent ? agentPath(harness, sid, opts.agent) : sessionPath(harness, sid));
    },
    tokens: TOKENS,
    storage: {
      async get<T = unknown>(): Promise<T | null> {
        const r = await readState();
        etag = r.etag;
        return r.value as T | null;
      },
      async set(value: unknown): Promise<void> {
        await writeState(value);
      },
      async update<T = unknown>(change: (current: T | null) => T): Promise<T> {
        for (let attempt = 0; attempt < 5; attempt++) {
          const r = await readState();
          const next = change(r.value as T | null);
          if (await writeState(next, r.etag ?? '"0"')) return next;
        }
        throw new Error("theme storage: another device kept writing; try again");
      },
      subscribe(listener) {
        stateListeners.add(listener);
        return () => {
          stateListeners.delete(listener);
        };
      },
    },
    local: {
      get<T = unknown>(key: string): T | null {
        try {
          const raw = localStorage.getItem(localKey(key));
          return raw === null ? null : (JSON.parse(raw) as T);
        } catch {
          return null;
        }
      },
      set(key: string, value: unknown): void {
        try {
          if (value === undefined || value === null) localStorage.removeItem(localKey(key));
          else localStorage.setItem(localKey(key), JSON.stringify(value));
        } catch {
          // private mode or full: per-device storage is a convenience only
        }
      },
    },
    control: createControlApi({ machines: () => store.get().machines, sessions: () => store.get().sessions }),
    shortcuts: {
      register(actions) {
        const off = registerViewActions(id, manifest.name || id, Array.isArray(actions) ? actions : []);
        unregisters.add(off);
        return () => {
          unregisters.delete(off);
          off();
        };
      },
      active() {
        const all = activeMap();
        const out: Record<string, string[]> = {};
        const prefix = `${id}:`;
        for (const [k, v] of Object.entries(all)) out[k.startsWith(prefix) ? k.slice(prefix.length) : k] = v;
        return out;
      },
    },
    labels: {
      async set(keys, color) {
        const list = typeof keys === "string" ? [keys] : [...keys];
        if (list.length) await store.patchLabels({ sessions: Object.fromEntries(list.map((k) => [k, color])) });
      },
      async rename(color, name) {
        await store.patchLabels({ names: { [color]: name } });
      },
      edit: (color) => requestLabelRename(color),
    },
    menu: {
      open(items, at, o = {}) {
        openMenu(hostItems(items, id), at, o);
      },
      session(key, at, o = {}) {
        const s = store.get().sessions.get(key);
        if (!s) return;
        const items = sessionItems(s, {
          store,
          surface: "page",
          answer: o.answer ? hostItems(o.answer, id) : undefined,
          extra: o.extra ? hostItems(o.extra, id) : undefined,
        });
        openMenu(items, at, {
          title: o.title ?? sessionMenuTitle(s),
          subtitle: o.subtitle ?? sessionMenuSubtitle(s),
          source: o.source,
        });
      },
      confirm: (o) => confirmAction(o),
    },
    react: { React, ReactDOM, createRoot },
    format: {
      ago: (iso, now = Date.now()) => ago(iso, now),
      duration: (ms) => dur(ms),
      title: (s: SessionSummary) => sessionTitle(s),
      repoBranch: (s: SessionSummary) => repoBranch(s),
      monogram: (harness) => harnessMark(harness).glyph,
      harnessIcon: (harness) => harnessIconSvg(harness),
    },
  };

  return {
    api,
    dispose: () => {
      unsubStore();
      unsubState();
      stateListeners.clear();
      unsubSettings();
      unwatch();
      subscribers.clear();
      for (const off of unregisters) off();
      unregisters.clear();
    },
  };
}
