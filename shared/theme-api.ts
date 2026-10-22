// SPDX-License-Identifier: Apache-2.0
// The theme plugin contract. A theme is an ES module, installed under
// <stateDir>/themes/<id>/ beside a theme.json manifest, served by the GUI at
// /themes/<id>/ and imported at runtime. It renders into a container the host gives
// it and talks to the host only through the ThemeApi it is handed. Nothing here
// depends on React: a theme may use the host's React (api.react), its own bundled
// framework, plain DOM or a <canvas>.
//
// Versioning: `ThemeApi.version` is bumped on a breaking change; a manifest's
// `api` says which version the theme was written for; the host refuses a theme
// whose major is newer than its own.

import type {
  Attachment,
  ControlActivity,
  LabelColor,
  MachineSummary,
  SessionDetail,
  SessionKey,
  SessionSummary,
  Stats,
  StoredEvent,
  Viewer,
} from "./api.js";

export const THEME_API_VERSION = 1 as const;

/** theme.json, next to the entry module. */
export interface ThemeManifest {
  /** `[a-z][a-z0-9-]{1,40}`; also the route segment: /t/<id>. */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Relative path of the ES module; defaults to "index.js". */
  entry?: string;
  /** Optional stylesheet the host links before mounting (scoped by the theme itself). */
  style?: string;
  /** Inline SVG for the nav entry (24×24 viewBox, currentColor). */
  icon?: string;
  /** Shown under an "experimental" divider in the nav. */
  experimental?: boolean;
  /** The ThemeApi version this theme targets. */
  api: number;
  /** Where it came from (filled by the host on install, not by the author). */
  source?: string;
}

export type ConnectionState = "connecting" | "live" | "offline";

/** What the host knows right now. Immutable: every change produces a new object. */
export interface ThemeSnapshot {
  connection: ConnectionState;
  sessions: ReadonlyMap<SessionKey, SessionSummary>;
  machines: ReadonlyMap<string, MachineSummary>;
  stats: Stats;
  /** Newest first, at most a few hundred. */
  control: readonly ControlActivity[];
  /** Newest first, at most a few hundred: the live tail of the event stream. */
  recent: readonly StoredEvent[];
  /** "dark" | "light", the resolved scheme the page renders in. */
  scheme: "dark" | "light";
  /** Browsers connected to this GUI right now (phones, laptops); `current` marks this one. */
  viewers: readonly Viewer[];
  /** The app-wide tier lens (Settings › Tier lens): what a receiver at this tier would
   *  have got; null = everything. A view may ignore it. Absent on older hosts. */
  tierLens?: 0 | 1 | 2 | 3 | null;
  /** Simple hides what most people never touch (collapse HUD extras into one menu, drop
   *  the style switch); advanced is everything. Absent on older hosts. */
  mode?: "simple" | "advanced";
  /** The person's colour labels, the same everywhere in the app and on every device: a
   *  session's colour, and what each colour is called (the person's name, else the
   *  colour's own: "Red"). Draw a label as one small dot in `var(--label-<colour>)`
   *  beside the state glyph, never as a fill or a stripe. Absent on older hosts. */
  labels?: {
    sessions: ReadonlyMap<SessionKey, LabelColor>;
    names: Readonly<Record<LabelColor, string>>;
  };
}

/** What a control call can do from this page. `ok: false` carries the reason the host
 *  would show (not a secure context, machine not paired, daemon offline). */
export interface ControlAvailability {
  ok: boolean;
  reason?: string;
}

export interface ThemeApi {
  version: typeof THEME_API_VERSION;
  /** Host name and version, e.g. { name: "sessionpipe-gui", version: "0.1.0" }. */
  host: { name: string; version: string };
  /** This theme's manifest, as installed. */
  manifest: ThemeManifest;
  /** The absolute URL prefix of the theme's own files (assets, workers). */
  baseUrl: string;

  /** Current state, and a subscription that fires with the new snapshot on every change. */
  state: {
    get(): ThemeSnapshot;
    subscribe(listener: (snapshot: ThemeSnapshot) => void): () => void;
  };
  /** Every live event as it arrives, with the session summary after applying it. */
  onEvent(listener: (event: StoredEvent, session: SessionSummary) => void): () => void;

  /** Typed reads of the UI API. */
  fetch: {
    session(key: SessionKey, opts?: { after?: number; limit?: number }): Promise<SessionDetail>;
    forget(key: SessionKey): Promise<void>;
  };

  /** Host navigation. */
  navigate(path: string): void;
  /** Open a session: as the page (default), or `split` beside the current view in a
   *  side panel the host slides in; `from` is the rectangle (viewport px) the panel
   *  should animate out of, e.g. the card that was clicked. */
  openSession(key: SessionKey, opts?: OpenSessionOptions): void;

  /** Design tokens as CSS custom property names the theme may use in its own CSS
   *  (e.g. "--bg", "--fg", "--fg-2", "--line", "--needs", "--err"); the host keeps them
   *  defined on :root for both schemes. */
  tokens: readonly string[];

  /** Per-theme JSON kept by the server (shared across devices), ≤ 256 KB. */
  storage: {
    get<T = unknown>(): Promise<T | null>;
    /** Replaces the document, whatever another device wrote meanwhile. */
    set(value: unknown): Promise<void>;
    /** Read, change, write, without losing another device's write: `change` gets the
     *  stored document (null when none) and returns the new one; when another device
     *  wrote in between, the host reads again and calls `change` again (a few times at
     *  most, then rejects). Resolves with what was written. Keep `change` pure: it may
     *  run more than once. Absent on older hosts. */
    update?<T = unknown>(change: (current: T | null) => T): Promise<T>;
    /** Another device (or another tab) wrote the document: the listener gets the new
     *  value. This page's own writes are not echoed. Absent on older hosts. */
    subscribe?(listener: (value: unknown) => void): () => void;
  };
  /** Per-device convenience storage (localStorage, namespaced); may be unavailable. */
  local: {
    get<T = unknown>(key: string): T | null;
    set(key: string, value: unknown): void;
  };

  /** The control channel, signed by the host with the person's passkey and day key
   *  (CONTROL.md). Present when the host supports it; each call rejects with an Error
   *  whose message is what the host would show. */
  control?: {
    /** Whether a command to this session's machine (or this machine id) can be signed and sent now. */
    availability(target: { session?: SessionKey; machineId?: string }): ControlAvailability;
    /** A prompt for the session's next turn. */
    send(session: SessionKey, text: string): Promise<ControlActivity>;
    /** Allow or deny an open permission attention. */
    answer(
      session: SessionKey,
      attentionId: string,
      decision: "allow" | "deny",
      note?: string,
    ): Promise<ControlActivity>;
    cancel(session: SessionKey): Promise<ControlActivity>;
    /** A new session on a paired machine; the returned activity names the session key the host chose. */
    start(
      machineId: string,
      opts: { harness: string; cwd: string; text: string },
    ): Promise<ControlActivity & { session: SessionKey }>;
    /** Upload an image (PNG, JPEG, GIF or WebP, ≤ 8 MB) to send beside a prompt. The
     *  protocol carries text only: name the result in `text` the way
     *  shared/attachments.ts `composePrompt` does (its `path` when the session runs on
     *  the GUI's machine, its `url` otherwise), and the host draws it as a thumbnail.
     *  Absent on older hosts. */
    attach?(file: Blob): Promise<Attachment>;
  };

  /** The host's keymap (web/src/lib/shortcuts.ts). `register` adds the view's own keys
   *  while it is mounted: they are listed in the `?` help and on /shortcuts under the
   *  view's name, a person can rebind them there, and the host dispatches them (ignoring
   *  text fields) so the view needs no keydown listener of its own. On the view's page
   *  its keys shadow the host's for the same chord. `keys` are chord strings, "a",
   *  "shift+enter", "mod+k", or two in a row, "g b"; `mod` is ⌘ on a Mac, ctrl elsewhere.
   *  Returns the function that removes them (the host also removes them on unmount).
   *  `active()` is every action's bindings in force, by id: the view's own under their
   *  short ids, the host's under theirs ("palette.toggle", "list.down", …), so a view can
   *  show the right hints. Present on hosts that have the keymap. */
  shortcuts?: {
    register(actions: ViewShortcut[]): () => void;
    active(): Record<string, string[]>;
  };

  /** The person's colour labels (`ThemeSnapshot.labels` reads them): set or clear one
   *  session's or several at once; the change lands in `state` on every device. Absent
   *  on older hosts. */
  labels?: {
    set(keys: SessionKey | readonly SessionKey[], color: LabelColor | null): Promise<void>;
    /** Name a colour ("Urgent"); null or "" gives it back its own name. ≤ 32 characters. */
    rename(color: LabelColor, name: string | null): Promise<void>;
    /** Opens the host's "Edit labels" dialog (the names of all seven). */
    edit(color?: LabelColor): void;
  };

  /** The host's own right-click menu, so a view's menus look and behave like every other
   *  menu in the app (keyboard, type-ahead, submenus; an action sheet from the bottom on
   *  touch). The host leaves right-clicks inside a view alone: the view calls
   *  `preventDefault()` on its own `contextmenu` (and its own long-press) and opens one of
   *  these. Absent on older hosts. */
  menu?: {
    /** Opens `items` at a point in viewport px. `source: "touch"` (or a phone) shows the
     *  action sheet, `title` / `subtitle` heading it; `"keyboard"` highlights the first item. */
    open(items: readonly ViewMenuItem[], at: { x: number; y: number }, opts?: ViewMenuOptions): void;
    /** The menu a session has everywhere else (Open as page, Open beside, Label ▸, Open
     *  parent, Subagents ▸, Copy ▸, Forget…), with the view's own items after the open
     *  group (`answer`, e.g. Allow / Deny) and before Copy (`extra`). */
    session(
      key: SessionKey,
      at: { x: number; y: number },
      opts?: ViewMenuOptions & { answer?: readonly ViewMenuItem[]; extra?: readonly ViewMenuItem[] },
    ): void;
    /** The host's confirm: an alert on a desktop, an action sheet on a phone. True for
     *  the action. Ask before anything destructive. */
    confirm(o: { title: string; body?: string; action: string; danger?: boolean }): Promise<boolean>;
  };

  /** The host's React and ReactDOM, for themes that want them without bundling their
   *  own. A theme built with JSX can map `react` and `react-dom` to these. */
  react?: { React: unknown; ReactDOM: unknown; createRoot: unknown };

  /** Shared helpers the host already has: relative time, durations, titles. */
  format: {
    ago(iso: string, now?: number): string;
    duration(ms: number): string;
    title(session: SessionSummary): string;
    repoBranch(session: SessionSummary): string;
    /** "Cl" for claude-code, "Cx" for codex, … */
    monogram(harness: string): string;
    /** The harness's monochrome mark as inline SVG (currentColor) with its human name,
     *  "Claude Code"; null for a harness without one (draw the monogram then). */
    harnessIcon?(harness: string): { svg: string; name: string } | null;
  };
}

/** One row of a view's menu (ThemeApi.menu): an action, a submenu, a separator or a
 *  heading. `keys` is a hint shown at the right ("⌫"); `action` names one of the view's
 *  own registered shortcuts (its short id) or a host action ("label.red"), whose live
 *  binding is shown instead. `disabled` as a string is the reason. `swatch` draws a
 *  colour label's dot before the text. */
export type ViewMenuItem =
  | {
      label: string;
      run: () => void | Promise<void>;
      keys?: string;
      action?: string;
      danger?: boolean;
      disabled?: string | boolean;
      checked?: boolean;
      radio?: boolean;
      swatch?: LabelColor;
    }
  | { label: string; items: readonly ViewMenuItem[]; disabled?: string | boolean }
  | { sep: true }
  | { heading: string };

export interface ViewMenuOptions {
  title?: string;
  subtitle?: string;
  source?: "mouse" | "keyboard" | "touch";
}

/** One key a view registers (ThemeApi.shortcuts). */
export interface ViewShortcut {
  /** `[a-z][a-z0-9._-]*`, unique within the view. */
  id: string;
  label: string;
  /** Default bindings; a person may change them on /shortcuts. */
  keys: string[];
  run(): void;
  /** One line of help. */
  hint?: string;
}

export interface OpenSessionOptions {
  split?: boolean;
  from?: { x: number; y: number; width: number; height: number };
  /** With `split`: add the session as a tab without switching to it. */
  background?: boolean;
  /** One of the session's subagents (an `AgentRun` id): the session opens on that
   *  agent (its own tools, state and result), beside or as the page. A host without
   *  agent views opens the session itself. */
  agent?: string;
}

/** The module's default export. `mount` returns the function that unmounts. */
export interface Theme {
  mount(container: HTMLElement, api: ThemeApi): (() => void) | Promise<() => void>;
}

/** Server-side listing: GET /api/ui/themes. */
export interface InstalledTheme extends ThemeManifest {
  /** URL prefix where its files are served: /themes/<id>/ */
  url: string;
  /** Where on disk; loopback only. */
  dir?: string;
  /** Linked from a folder for development (changes show on reload). */
  linked?: boolean;
  /** Shipped with the GUI (dist/bundled/views/<id>), not installed by the person: listed
   *  after their own installs (an install of the same id overrides it), `source: "bundled"`,
   *  cannot be removed, only disabled. */
  bundled?: boolean;
  /** Turned off (config.json `disabled`): kept in the list for the Views page, but off the
   *  rail, and /t/<id> says so instead of mounting it. */
  disabled?: boolean;
  /** Why this entry cannot be loaded (bad manifest, api too new, …); such a theme is
   *  listed so the problem is visible, but gets no nav entry. */
  error?: string;
}

export const THEME_ROUTES = {
  /** GET → { themes: InstalledTheme[] } */
  list: "/api/ui/themes",
  /** GET/PUT /api/ui/themes/:id/state → JSON */
  state: "/api/ui/themes",
  /** Static: /themes/:id/<file> */
  files: "/themes",
  /** POST /api/ui/themes/reload (loopback): re-read manifests */
  reload: "/api/ui/themes/reload",
  /** POST /api/ui/themes/:id/disable | /enable (loopback): hide a view (a bundled one
   *  cannot be removed) or show it again → { themes } */
  toggle: "/api/ui/themes",
} as const;

export const THEME_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
