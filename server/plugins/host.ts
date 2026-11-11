// SPDX-License-Identifier: Apache-2.0
// Owned by: platform. The plugin host: imports every installed plugin's entry module into
// this process, hands it a PluginApi (shared/plugin-api.ts) and keeps what comes back.
// A plugin that fails to import or activate is listed with its error and never takes
// the host down; a listener that throws is logged and the stream goes on. A disabled
// plugin (turned off, or bundled and not yet enabled) is never imported. Suggestions
// (a plugin's advice on an open permission) are kept here, streamed to every page and
// dropped when the attention closes. Nothing here can answer a permission: the
// receiver holds no key.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Info,
  type SessionKey,
  type Snapshot,
  type StreamMessage,
  type Suggestion,
  splitKey,
  UI_KEY_PARAM,
} from "../../shared/api.js";
import {
  type InstalledPlugin,
  type LogLevel,
  maskSettings,
  PLUGIN_API_VERSION,
  type Plugin,
  type PluginApi,
  type PluginHandle,
  type PluginManifest,
} from "../../shared/plugin-api.js";
import type { Control } from "../control/index.js";
import type { Store } from "../store/store.js";
import { snapshotWithControl } from "../ui/index.js";
import type { PluginEntry, PluginRegistry } from "./registry.js";
import type { PluginSettings } from "./settings.js";

export const STORAGE_MAX_BYTES = 256 * 1024;
export const ACTIVATE_TIMEOUT_MS = 15_000;

export interface PluginHostDeps {
  registry: PluginRegistry;
  settings: PluginSettings;
  /** <stateDir>/plugins-storage */
  storageDir: string;
  store: Store;
  control: Control;
  info: () => Info;
  /** One line to the host's log; stderr by default. */
  log?: (line: string) => void;
  activateTimeoutMs?: number;
  /** Remember a plugin as on or off in config.json; the registry is rescanned after. */
  setEnabled?: (id: string, on: boolean) => void;
}

interface Running {
  manifest: PluginManifest;
  handle: PluginHandle;
  /** Everything to undo when it goes: subscriptions the plugin made through the api. */
  offs: Set<() => void>;
  onSettings: Set<(settings: Record<string, unknown>) => void>;
}

export class PluginHost {
  private running = new Map<string, Running>();
  private errors = new Map<string, string>();
  private suggestions = new Map<string, Suggestion>();
  private listeners = new Set<(m: StreamMessage) => void>();
  private offStore: (() => void) | null = null;
  private generation = 0;
  private started = false;

  constructor(private readonly deps: PluginHostDeps) {}

  /** Activate every loadable plugin that is not disabled. Called once the server listens
   *  (the api names its URLs). */
  async start(): Promise<void> {
    this.started = true;
    this.offStore ??= this.deps.store.subscribe((m) => this.prune(m));
    for (const entry of this.deps.registry.list()) await this.activate(entry);
  }

  /** Deactivate everything, re-read the folder, import afresh and activate again. */
  async reload(): Promise<void> {
    await this.deactivateAll();
    this.deps.registry.scan();
    await this.start();
  }

  /** Deactivate everything; at shutdown. */
  async stop(): Promise<void> {
    await this.deactivateAll();
    this.offStore?.();
    this.offStore = null;
    this.suggestions.clear();
    this.started = false;
  }

  /** The listing: manifests with status, error and masked settings; `dir` to this machine only. */
  list(loopback: boolean): InstalledPlugin[] {
    return this.deps.registry.list().map((e) => {
      const manifest: PluginManifest = e.manifest ?? {
        id: e.id,
        name: e.id,
        version: "",
        kind: "plugin",
        entry: "index.js",
        api: 0,
      };
      const error = e.error ?? this.errors.get(e.id);
      const out: InstalledPlugin = {
        ...manifest,
        status: this.running.has(e.id) ? "active" : error ? "error" : "inactive",
      };
      if (error) out.error = error;
      if (e.linked) out.linked = true;
      if (e.bundled) out.bundled = true;
      if (e.disabled) out.disabled = true;
      if (loopback) out.dir = e.dir;
      if (e.manifest) out.values = maskSettings(e.manifest, this.deps.settings.get(e.manifest));
      return out;
    });
  }

  /** Save settings for a plugin: the running one is told; one that failed is tried again
   *  (a missing token was probably why). Returns the new values, masked. */
  async saveSettings(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const entry = this.deps.registry.get(id);
    if (!entry?.manifest) throw new Error(`no plugin "${id}"`);
    const values = this.deps.settings.save(entry.manifest, patch);
    const run = this.running.get(id);
    if (run) {
      for (const l of run.onSettings) {
        try {
          l({ ...values });
        } catch (e) {
          this.log(id, "error", `settings listener threw: ${(e as Error).message}`);
        }
      }
    } else if (this.started && !entry.disabled) {
      await this.activate(entry);
    }
    return maskSettings(entry.manifest, values);
  }

  /** Turn a plugin on or off: remembered in config.json, the folder rescanned, then the
   *  plugin started (if the host is running) or stopped. Throws on an unknown id. */
  async setEnabled(id: string, on: boolean): Promise<void> {
    if (!this.deps.registry.has(id)) throw new Error(`no plugin "${id}"`);
    this.deps.setEnabled?.(id, on);
    const was = new Map(this.deps.registry.list().map((e) => [e.id, e.disabled === true]));
    this.deps.registry.scan();
    // The rescan also reads what `sessionpipe-gui plugin enable|disable` changed since the
    // last one: every other plugin turned on or off follows it, so none is listed off
    // while it still runs (or on while it does not).
    for (const other of this.deps.registry.list()) {
      if (other.id === id || !was.has(other.id) || was.get(other.id) === (other.disabled === true)) continue;
      if (other.disabled) {
        await this.deactivate(other.id);
        this.errors.delete(other.id);
      } else if (this.started) await this.activate(other);
    }
    const entry = this.deps.registry.get(id);
    if (!on || !entry || entry.disabled) {
      await this.deactivate(id);
      this.errors.delete(id);
      return;
    }
    if (this.started) await this.activate(entry);
  }

  /** Open suggestions, for the snapshot. */
  currentSuggestions(): Suggestion[] {
    return [...this.suggestions.values()];
  }

  /** Stream messages the host itself makes (suggestions). */
  subscribe(l: (m: StreamMessage) => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  status(id: string): "active" | "error" | "inactive" {
    return this.running.has(id) ? "active" : this.errors.has(id) ? "error" : "inactive";
  }

  // ---------- lifecycle ----------

  private async activate(entry: PluginEntry): Promise<void> {
    if (!entry.manifest || entry.disabled || this.running.has(entry.id)) return;
    const manifest = entry.manifest;
    this.errors.delete(entry.id);
    const timeoutMs = this.deps.activateTimeoutMs ?? ACTIVATE_TIMEOUT_MS;
    const run: Running = { manifest, handle: { deactivate() {} }, offs: new Set(), onSettings: new Set() };
    try {
      const url = `${pathToFileURL(path.join(entry.dir, manifest.entry)).href}?gen=${++this.generation}`;
      const mod = (await import(url)) as { default?: Partial<Plugin> };
      const plugin = mod.default;
      if (!plugin || typeof plugin.activate !== "function") {
        throw new Error("the module's default export has no activate(api)");
      }
      const api = this.makeApi(entry, run);
      const handle = await withTimeout(
        Promise.resolve(plugin.activate(api)),
        timeoutMs,
        `activate() did not finish in ${Math.round(timeoutMs / 1000)} s`,
      );
      if (!handle || typeof handle.deactivate !== "function") {
        throw new Error("activate(api) did not return { deactivate() }");
      }
      run.handle = handle;
      this.running.set(entry.id, run);
      this.log(entry.id, "info", `active (${manifest.name} ${manifest.version})`);
    } catch (e) {
      for (const off of run.offs) off();
      const message = (e as Error)?.message ?? String(e);
      this.errors.set(entry.id, message);
      this.log(entry.id, "error", `failed to start: ${message}`);
    }
  }

  private async deactivateAll(): Promise<void> {
    const ids = [...this.running.keys()];
    for (const id of ids) await this.deactivate(id);
  }

  private async deactivate(id: string): Promise<void> {
    const run = this.running.get(id);
    if (!run) return;
    this.running.delete(id);
    try {
      await withTimeout(Promise.resolve(run.handle.deactivate()), 5000, "deactivate() did not finish in 5 s");
    } catch (e) {
      this.log(id, "warn", `deactivate: ${(e as Error).message}`);
    }
    for (const off of run.offs) off();
    run.offs.clear();
    run.onSettings.clear();
    for (const [key, s] of this.suggestions) if (s.plugin === id) this.suggestions.delete(key);
  }

  // ---------- the api ----------

  private makeApi(entry: PluginEntry, run: Running): PluginApi {
    const id = entry.id;
    const manifest = run.manifest;
    const { deps } = this;
    const log = (level: LogLevel, msg: string, data?: unknown): void => this.log(id, level, msg, data, manifest);
    const guard =
      <T>(l: (m: T) => void) =>
      (m: T): void => {
        try {
          l(m);
        } catch (e) {
          log("error", `listener threw: ${(e as Error)?.message ?? e}`);
        }
      };
    const track = (off: () => void): (() => void) => {
      run.offs.add(off);
      return () => {
        run.offs.delete(off);
        off();
      };
    };
    const info = deps.info();
    const storageFile = path.join(deps.storageDir, `${id}.json`);
    return {
      version: PLUGIN_API_VERSION,
      host: { name: info.name, version: info.version, urls: info.urls },
      manifest,
      log,
      settings: {
        get: <T>() => ({ ...deps.settings.get(manifest) }) as T,
        onChange: (l) => {
          const wrapped = guard(l);
          run.onSettings.add(wrapped);
          return track(() => run.onSettings.delete(wrapped));
        },
      },
      events: {
        subscribe: (l) => {
          const wrapped = guard(l);
          const offStore = deps.store.subscribe(wrapped);
          const offControl = deps.control.subscribe(wrapped);
          return track(() => {
            offStore();
            offControl();
          });
        },
        snapshot: (): Snapshot => ({
          ...snapshotWithControl(deps.store, deps.control),
          suggestions: this.currentSuggestions(),
        }),
      },
      sessions: {
        get: (key) => deps.store.session(key),
        url: (key) => this.sessionUrl(key),
      },
      suggest: (s) => this.suggest(id, s),
      storage: {
        get: async <T>(): Promise<T | null> => {
          try {
            return JSON.parse(readFileSync(storageFile, "utf8")) as T;
          } catch {
            return null;
          }
        },
        set: async (value: unknown): Promise<void> => {
          const text = JSON.stringify(value);
          if (text === undefined) throw new Error("storage.set: the value is not JSON");
          if (Buffer.byteLength(text) > STORAGE_MAX_BYTES) {
            throw new Error(`storage.set: over ${STORAGE_MAX_BYTES / 1024} KB`);
          }
          mkdirSync(deps.storageDir, { recursive: true, mode: 0o700 });
          const tmp = `${storageFile}.${process.pid}.tmp`;
          writeFileSync(tmp, text, { mode: 0o600 });
          renameSync(tmp, storageFile);
        },
      },
      fetch: globalThis.fetch.bind(globalThis),
    };
  }

  /** The session page a phone can open: the https origin with TLS mode on, else the
   *  first LAN URL; the UI key is appended either way so a cold browser is let in. */
  private sessionUrl(key: SessionKey): string {
    const info = this.deps.info();
    const base = info.urls.https ?? info.urls.lan[0] ?? info.urls.local;
    const { harness, id } = splitKey(key);
    const u = new URL(`/s/${encodeURIComponent(harness)}/${encodeURIComponent(id)}`, base);
    if (info.uiKey) u.searchParams.set(UI_KEY_PARAM, info.uiKey);
    return u.toString();
  }

  private suggest(
    plugin: string,
    s: { session: SessionKey; attentionId: string; decision: "allow" | "deny"; by: string; note?: string },
  ): void {
    if (!s || typeof s.session !== "string" || typeof s.attentionId !== "string") {
      throw new Error("suggest: session and attentionId are required");
    }
    if (s.decision !== "allow" && s.decision !== "deny") throw new Error('suggest: decision must be "allow" or "deny"');
    if (typeof s.by !== "string" || !s.by.trim()) throw new Error("suggest: say who, in `by`");
    const session = this.deps.store.session(s.session);
    if (!session) throw new Error(`suggest: no session ${s.session}`);
    const att = session.openAttentions.find((a) => a.attentionId === s.attentionId);
    if (att?.kind !== "permission") throw new Error(`suggest: ${s.attentionId} is not an open permission`);
    if (!(att.answerable ?? !att.attentionId.startsWith("notif-"))) {
      throw new Error(`suggest: ${s.attentionId} cannot be answered from here (a notification twin)`);
    }
    const suggestion: Suggestion = {
      session: s.session,
      attentionId: s.attentionId,
      decision: s.decision,
      by: s.by.trim().slice(0, 120),
      plugin,
      at: new Date().toISOString(),
    };
    if (typeof s.note === "string" && s.note.trim()) suggestion.note = s.note.trim().slice(0, 500);
    this.suggestions.set(`${s.session}\n${s.attentionId}`, suggestion);
    this.emit({ kind: "suggestion", suggestion });
  }

  /** A suggestion lives only while its attention is open. */
  private prune(m: StreamMessage): void {
    if (m.kind === "forgotten") {
      for (const [key, s] of this.suggestions) if (s.session === m.key) this.suggestions.delete(key);
      return;
    }
    if (m.kind !== "session" && m.kind !== "event") return;
    const session = m.session;
    for (const [key, s] of this.suggestions) {
      if (s.session !== session.key) continue;
      if (!session.openAttentions.some((a) => a.attentionId === s.attentionId)) this.suggestions.delete(key);
    }
  }

  private emit(m: StreamMessage): void {
    for (const l of this.listeners) {
      try {
        l(m);
      } catch {}
    }
  }

  private log(id: string, level: LogLevel, msg: string, data?: unknown, manifest?: PluginManifest): void {
    let line = `[plugin:${id}] ${level}: ${msg}`;
    if (data !== undefined) {
      try {
        line += ` ${JSON.stringify(data)}`;
      } catch {
        line += ` ${String(data)}`;
      }
    }
    // Belt and braces: a value equal to one of the plugin's secret settings never reaches the log.
    const m = manifest ?? this.deps.registry.get(id)?.manifest;
    if (m) {
      const values = this.deps.settings.get(m);
      for (const f of m.settings ?? []) {
        const v = values[f.key];
        if (f.type === "secret" && typeof v === "string" && v.length >= 4) line = line.split(v).join("••••");
      }
    }
    (this.deps.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(line);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
