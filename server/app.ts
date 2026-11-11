// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core (composition root). Every module plugs in here and nowhere
// else. Module boundaries and who owns what: ARCHITECTURE.md.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT, type Info, type RemoteInfo, ROUTES } from "../shared/api.js";
import {
  defaultStateDir,
  type GuiConfig,
  packageVersion,
  readGuiConfig,
  rotateSinkToken,
  type SpacesheepLink,
  setDisabled,
  setEnabled,
  setPublicUrl,
  setSearchHistory,
  setSpacesheep,
  setTlsPreference,
} from "./config.js";
import { type Control, createControl } from "./control/index.js";
import { type Runner, startDemo, startReplay } from "./demo/index.js";
import { registerExtras } from "./extensions/extras.js";
import { bundledDirs } from "./extensions/kind.js";
import { isLoopback, lanAddresses } from "./http/net.js";
import { Router } from "./http/router.js";
import { createOrchestrate, type Orchestrate } from "./orchestrate/index.js";
import { registerOrchestrate } from "./orchestrate/routes.js";
import { registerPhone } from "./phone/index.js";
import { PluginHost, PluginRegistry, PluginSettings, registerPlugins } from "./plugins/index.js";
import { registerReceiver, wellKnown } from "./receiver/index.js";
import { registerSearch } from "./search/routes.js";
import { createSearch, thisHostname } from "./search/service.js";
import type { SearchService } from "./search/types.js";
import { registerSetup } from "./setup/index.js";
import { execDefault, isThisMachine } from "./setup/local.js";
import { createTailscaleProbe } from "./setup/tailscale.js";
import { registerSkins, SkinRegistry } from "./skins/index.js";
import { type OutboxSource, startOutboxSource } from "./sources/outbox.js";
import { type SpacesheepSource, startSpacesheepSource } from "./sources/spacesheep.js";
import { staticFiles, webDir } from "./static.js";
import { Store } from "./store/store.js";
import { registerThemes, ThemeRegistry } from "./themes/index.js";
import { ensureCerts, type TlsMaterial } from "./tls/certs.js";
import { createDualListener, type DualListener, listen } from "./tls/listen.js";
import { registerTrust } from "./tls/trust.js";
import { AttachmentStore } from "./ui/attachments.js";
import { uiAuthFor } from "./ui/auth.js";
import { registerUi, uiGuard } from "./ui/index.js";
import { LabelStore } from "./ui/labels.js";
import { LimitsStore } from "./ui/limits.js";
import { MarkStore } from "./ui/marks.js";
import { registerSpacesheepUi } from "./ui/spacesheep.js";
import { Broadcast } from "./ui/stream.js";
import { ViewerRegistry } from "./ui/viewers.js";

export interface AppOptions {
  port?: number;
  host?: string;
  stateDir?: string;
  /** Tail the local sessionpipe outbox (zero-config on the machine that runs agents). Default true. */
  outbox?: boolean;
  /** The sessionpipe state dir (or its outbox folder) to tail; default: sessionpipe's own. */
  outboxPath?: string;
  /** Generate synthetic sessions so the board is never empty. */
  demo?: boolean;
  /** Replay a sessionpipe JSONL file through the store. */
  replay?: string;
  /** Replay / demo speed. */
  speed?: number;
  /** The rp id control passkeys are made for (CONTROL.md §2); "localhost" by default,
   *  the `.local` hostname when `tls` is on. */
  rpId?: string;
  /** The https origin a trusted reverse proxy on this machine serves from anywhere
   *  (`--public-url`): remembered in config.json; `null` forgets it; undefined keeps the
   *  remembered one. Sets the rp id and makes the router trust X-Forwarded-* from loopback. */
  publicUrl?: string | null;
  /** TLS mode: the same port also answers https with a certificate from the GUI's own
   *  local CA (server/tls), so passkeys work from a phone. Needs `openssl`. */
  tls?: boolean;
  /** The `.local` name the certificate and the rp id are made for (tests); default from os.hostname(). */
  tlsHostname?: string;
  /** Loopback-only test door for the conformance runner. */
  testDoor?: boolean;
  /** Where the built web app is; default: dist/web beside the bundle. */
  webDir?: string;
  /** Stop the console banner (tests). */
  quiet?: boolean;
  /** Store timer period (tests). */
  tickMs?: number;
  /** Events older than this many days keep a shorter preview in memory (store.ts; default 14, 0 = whole). */
  keepDays?: number;
  /** Where installed themes live; default <stateDir>/themes. */
  themesDir?: string;
  /** Where installed plugins live; default <stateDir>/plugins. */
  pluginsDir?: string;
  /** Where installed skins live; default <stateDir>/skins. */
  skinsDir?: string;
  /** Where the views that ship with the GUI are; default dist/bundled/views beside the bundle.
   *  The bundled skins and plugins are its siblings (`../skins`, `../plugins`). */
  bundledDir?: string;
  /** Session search reads agent history under this home (`--search-home`, else the CLI's
   *  os.homedir()). Absent here: an empty home, so tests and embedders never read a real one. */
  searchHome?: string;
  /** dist/cli.js, forked as the search indexer (`index --ipc`); absent: it runs in-process. */
  searchCliPath?: string;
}

export interface App {
  /** The plain-http server, one of the two behind `listener`. */
  server: http.Server;
  /** The https server when TLS mode is on (at boot, or turned on while running). */
  readonly httpsServer: https.Server | null;
  /** What is bound to the port: the dual-protocol listener (http always; https once TLS mode is on). */
  listener: net.Server;
  /** The certificates in use, or null. */
  readonly tls: TlsMaterial | null;
  /** The WebAuthn rp id right now ("localhost", or `<name>.local` with TLS mode). */
  readonly rpId: string;
  /** `--public-url`, normalised (no trailing slash), when set. */
  readonly publicUrl: string | undefined;
  /** Set or forget it at runtime; remembered in config.json. Throws on a bad url. */
  setPublicUrl(url: string | undefined): void;
  /** Turn TLS mode on without a restart: certificates made if needed, the https side
   *  attached to the running listener, the rp id switched, `tls: true` remembered.
   *  Throws TlsError (no openssl). A no-op when already on. */
  enableTls(): TlsMaterial;
  router: Router;
  store: Store;
  control: Control;
  port: number;
  /** http://127.0.0.1:<port>, or the address --host bound when it is not a wildcard. */
  url: string;
  /** http://<lan ip>:<port> for every LAN address the listener answers on, most likely
   *  first: all of them on a wildcard bind, the one bound address otherwise, none on loopback. */
  lanUrls: string[];
  stateDir: string;
  config: () => GuiConfig;
  info: () => Info;
  outbox: OutboxSource | null;
  themes: ThemeRegistry;
  plugins: PluginHost;
  skins: SkinRegistry;
  search: SearchService;
  /** Workflows and their runs (server/orchestrate). */
  orchestrate: Orchestrate;
  close(): Promise<void>;
}

/** `--public-url`: an https origin, nothing after the host and port. The host is what
 *  passkeys are bound to, so a path or query would only mislead. */
export function normalizePublicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`--public-url: not a url: ${raw}`);
  }
  if (u.protocol !== "https:") throw new Error(`--public-url must be https (passkeys need a secure origin): ${raw}`);
  if (u.username || u.password) throw new Error("--public-url: no credentials in the url");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash)
    throw new Error(`--public-url is an origin, https://host[:port], nothing after it: ${raw}`);
  return u.origin;
}

/** Info.remote: how a machine elsewhere pushes events and pairs through the proxy. */
function remoteInfo(url: string, sinkToken: string): RemoteInfo {
  return {
    url,
    host: new URL(url).hostname,
    sinkCommand: `sessionpipe sink add ${url} --tier 3 --token ${sinkToken}`,
    connectCommand: `sessionpipe connect ${url}`,
  };
}

/** The addresses `server.address()` gives for a wildcard bind: every address of its family,
 *  or every IPv4 address for the IPv4-mapped ::ffff:0.0.0.0. */
const WILDCARDS = new Set(["0.0.0.0", "::", "::ffff:0.0.0.0"]);

export async function createApp(opts: AppOptions = {}): Promise<App> {
  const startedAt = new Date().toISOString();
  const stateDir = opts.stateDir ?? defaultStateDir();
  let config = readGuiConfig(stateDir);
  // `plugin|skin|view enable|disable` (server/cli.ts) write config.json while this runs.
  // The two lists they change are taken from the file each time they are read and before
  // every write here, so Reload plugins sees the CLI's change and no write of ours drops it.
  // The rest, the secrets above all, stays this process's own. A file that is gone, does
  // not parse, or holds other secrets than ours changes nothing here: the CLI rebuilds a
  // file it cannot parse with new secrets and only its own key, and those cut-down lists
  // are not an edit of ours (the re-read never writes; the next write of ours replaces
  // it). The CLI takes no lock, so two writes at the same instant are still last-writer-wins.
  const live = (): GuiConfig => {
    let disk: unknown;
    try {
      disk = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return config;
    }
    if (!disk || typeof disk !== "object" || Array.isArray(disk)) return config;
    const list = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : undefined;
    const { disabled, enabled, sinkToken, uiKey } = disk as Record<string, unknown>;
    if (sinkToken !== config.sinkToken || uiKey !== config.uiKey) return config;
    const next: GuiConfig = { ...config };
    const off = list(disabled);
    const on = list(enabled);
    if (off) next.disabled = off;
    else delete next.disabled;
    if (on) next.enabled = on;
    else delete next.enabled;
    config = next;
    return config;
  };
  const store = new Store(stateDir, { tickMs: opts.tickMs, keepDays: opts.keepDays });
  // Each account's usage limits follow the store from its first event (the outbox's
  // first read, the demo's) on.
  const limits = new LimitsStore(stateDir);
  limits.follow(store);
  const router = new Router();
  let port = opts.port ?? DEFAULT_PORT;
  let tls: TlsMaterial | null = opts.tls
    ? ensureCerts(path.join(stateDir, "tls"), { hostname: opts.tlsHostname, addresses: lanAddresses() })
    : null;
  // --public-url: given → remembered; null → forgotten; undefined → the remembered one.
  if (opts.publicUrl !== undefined)
    config = setPublicUrl(stateDir, live(), opts.publicUrl === null ? undefined : normalizePublicUrl(opts.publicUrl));
  let publicUrl: string | undefined = config.publicUrl ? normalizePublicUrl(config.publicUrl) : undefined;
  const publicHost = (): string | undefined => (publicUrl ? new URL(publicUrl).hostname : undefined);
  const chooseRpId = (): string => opts.rpId ?? publicHost() ?? tls?.hostname ?? "localhost";
  let rpId = chooseRpId();
  /** The browser origins passkeys for the rp id work on (Info.control.origins). */
  const origins = (): string[] => {
    const out: string[] = [];
    if (publicUrl && publicHost() === rpId) out.push(publicUrl);
    if (tls && tls.hostname === rpId) out.push(`https://${rpId}:${port}`);
    if (rpId === "localhost") out.push(`http://localhost:${port}`);
    if (!out.length) out.push(`https://${rpId}:${port}`);
    return out;
  };
  router.trustProxy = () => publicUrl !== undefined;
  const uiKey = (): string => config.uiKey;
  const uiAuth = uiAuthFor(uiKey);

  const control = createControl({
    stateDir,
    sinkToken: () => config.sinkToken,
    rpId: () => rpId,
    testDoor: opts.testDoor ?? false,
    uiAuth,
    sessionExists: (key) => store.sessionExists(key),
    origins,
    uiKey,
    // A send for a machine paired on spacesheep: the signed body to its jobs route, as
    // this account (the gui key), which verifies it against the machine's keys.
    remoteSend: async (m, body) => {
      const link = config.spacesheep;
      if (!link || m.remote?.origin !== link.origin)
        return { status: 503, json: { code: "no_relay", error: "Not connected to spacesheep any more." } };
      const res = await fetch(`${link.origin}/api/machines/${encodeURIComponent(m.id)}/jobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${link.key}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, json };
    },
  });

  registerReceiver(router, { store, sinkToken: () => config.sinkToken, control });
  control.register(router);
  // A pooled account's windows ride on the hello too (DESIGN §2.3): the limits follow the
  // machine frames for them, newest wins against the events'.
  limits.followControl(control);

  // A spacesheep account as the backend (docs/rfcs/08): the relay feeds the store like
  // the outbox does; on by the link in config, started again when a connect lands.
  let spacesheep: SpacesheepSource | null = null;
  const startSpacesheep = (link: SpacesheepLink): void => {
    spacesheep?.stop();
    try {
      spacesheep = startSpacesheepSource(store, {
        ...link,
        // The machines paired there become rows here (control.remote), their sends settled
        // by the relay's word on spacesheep's jobs.
        onMachines: (list, origin, rpId) => control.remote.upsert(list as never, { via: "spacesheep", origin, rpId }),
        pendingJobsFrom: () => control.remote.pendingFrom(),
        onJobs: (jobs) => control.remote.applyJobs(jobs),
      });
    } catch (e) {
      if (!opts.quiet) process.stderr.write(`[sessionpipe-gui] spacesheep: ${(e as Error).message}\n`);
    }
  };
  if (config.spacesheep) startSpacesheep(config.spacesheep);

  let outbox: OutboxSource | null = null;
  if (opts.outbox !== false) {
    try {
      outbox = startOutboxSource(store, { path: opts.outboxPath });
    } catch (e) {
      if (!opts.quiet) process.stderr.write(`[sessionpipe-gui] outbox: ${(e as Error).message}\n`);
    }
  }

  let demo: Runner | null = null;
  /** Synthetic sessions never outlive demo mode: turning it off (or starting without
   *  --demo) forgets every session the generator wrote, and its usage limits. */
  const dropDemoSessions = (): number => {
    let n = 0;
    for (const s of store.snapshot().sessions) if (s.source === "demo" && store.forget(s.key)) n++;
    limits.dropDemo();
    return n;
  };
  const setDemo = (on: boolean): void => {
    if (on && !demo) demo = startDemo(store, { speed: opts.speed, control });
    else if (!on && demo) {
      demo.stop();
      demo = null;
      dropDemoSessions();
    }
  };
  // Demo machines (server/demo/machine.ts) never outlive demo mode either.
  control.demo.remove();
  if (opts.demo) setDemo(true);
  else {
    const dropped = dropDemoSessions();
    if (dropped && !opts.quiet)
      process.stderr.write(`[sessionpipe-gui] forgot ${dropped} demo session(s) left from an earlier run\n`);
  }
  let replay: Runner | null = null;
  if (opts.replay) replay = startReplay(store, opts.replay, { speed: opts.speed ?? 0, rebase: true, maxGapMs: 10_000 });

  // What --host bound. A wildcard (the default 0.0.0.0, ::, or ::ffff:0.0.0.0) answers on every LAN
  // address; one address answers there alone, so a loopback bind offers no LAN URL and
  // the sink command names the loopback address that was bound (::1 refuses 127.0.0.1).
  // Null until the listener is bound, and for a wildcard.
  // An address with a zone id (fe80::1%en0) has no URL form browsers or fetch accept, so
  // it is never put in a URL; the fallback stays 127.0.0.1, as before.
  let bound: string | null = null;
  const urlHost = (ip: string): string => (ip.includes(":") ? `[${ip}]` : ip);
  const usable = (): string | null => (bound !== null && !bound.includes("%") ? bound : null);
  const selfUrl = (): string => `http://${urlHost(usable() ?? "127.0.0.1")}:${port}`;
  const lanUrls = (): string[] => {
    if (bound === null) return lanAddresses().map((ip) => `http://${ip}:${port}`);
    const ip = usable();
    return ip === null || isLoopback(ip) ? [] : [`http://${urlHost(ip)}:${port}`];
  };
  const httpsUrl = (): string | undefined => (tls ? `https://${tls.hostname}:${port}` : undefined);
  const attachments = AttachmentStore.for(stateDir);
  const info = (): Info => {
    const lan = lanUrls();
    const base = lan[0] ?? selfUrl();
    const stats = store.stats();
    const ob = outbox?.status();
    return {
      name: "sessionpipe-gui",
      version: packageVersion(),
      startedAt,
      port,
      urls: {
        local: `http://localhost:${port}`,
        lan,
        ...(tls ? { https: httpsUrl()! } : {}),
        ...(publicUrl ? { public: publicUrl } : {}),
      },
      sinkCommand: `sessionpipe sink add ${base} --tier 3 --token ${config.sinkToken}`,
      sinkToken: config.sinkToken,
      uiKey: config.uiKey,
      sources: {
        http: true,
        outbox: ob ? { path: ob.path, sessions: ob.sessions, enabled: true, events: ob.events } : null,
        demo: demo !== null,
        spacesheep: spacesheep?.status() ?? null,
      },
      storage: { dir: stateDir, bytes: stats.storageBytes + attachments.bytes(), attachments: attachments.bytes() },
      wellKnown: wellKnown(control),
      control: {
        enabled: true,
        rpId,
        machines: control.machines().size,
        origins: origins(),
        keyTypes: control.keyTypes,
      },
      hostname: os.hostname().replace(/\.(local|lan|home)$/i, ""),
      ...(publicUrl ? { remote: remoteInfo(publicUrl, config.sinkToken) } : {}),
      ...(tls
        ? {
            tls: {
              on: true,
              hostname: tls.hostname,
              httpsUrl: httpsUrl()!,
              caUrl: `${base}${ROUTES.caCert}`,
              caFingerprint: tls.caFingerprint,
              expiresAt: tls.serverExpiresAt,
            },
          }
        : {}),
    };
  };

  const viewers = new ViewerRegistry();
  const bundled = bundledDirs(opts.bundledDir);
  const disabled = (): readonly string[] => live().disabled ?? [];
  const plugins = new PluginHost({
    registry: new PluginRegistry(opts.pluginsDir ?? path.join(stateDir, "plugins"), {
      bundledDir: bundled.plugin,
      lists: live,
    }),
    settings: new PluginSettings(path.join(stateDir, "plugins-settings")),
    storageDir: path.join(stateDir, "plugins-storage"),
    store,
    control,
    info,
    setEnabled: (id, on) => {
      config = setEnabled(stateDir, live(), `plugin:${id}`, on);
    },
  });
  // The person's labels follow the store: a forgotten session loses its label.
  const labels = new LabelStore(stateDir, (key) => store.sessionExists(key));
  labels.follow(store);
  const marks = new MarkStore(stateDir, (key) => store.sessionExists(key));
  marks.follow(store);
  // Stream messages that come from neither the store nor control: a view's state written.
  const broadcast = new Broadcast();
  registerUi(router, {
    labels,
    marks,
    limits,
    broadcast,
    colorThemesDir: path.join(stateDir, "color-themes"),
    store,
    control,
    uiKey,
    info,
    viewers,
    plugins,
    rotateSinkToken: () => {
      config = rotateSinkToken(stateDir, live());
      return config.sinkToken;
    },
    demo: { on: () => demo !== null, set: setDemo },
  });
  // Session search (server/search): after the store and labels, behind the same UI guard;
  // its POSTs only from this machine (loopback or one of its own addresses, never through
  // the proxy; with the test door, x-spgui-test-remote stands in for the address).
  const search = await createSearch({
    stateDir,
    store,
    labels,
    hostname: thisHostname(),
    home: opts.searchHome ?? path.join(stateDir, "search", "no-home"),
    history: () => config.searchHistory !== false,
    setHistory: (on) => {
      config = setSearchHistory(stateDir, live(), on);
    },
    broadcast: (m) => broadcast.emit(m),
    port: () => port,
    cliPath: opts.searchCliPath,
    quiet: opts.quiet,
  });
  registerSearch(router, search, uiGuard(uiKey), (ctx) => {
    if (ctx.remote.forwarded) return false;
    const over = opts.testDoor ? ctx.req.headers["x-spgui-test-remote"] : undefined;
    return isThisMachine(typeof over === "string" && over ? over : ctx.remote.ip);
  });
  // Workflows (server/orchestrate): runs across agents and machines, moved by control's
  // acks and a one-second clock, signed only by a browser; their frames ride the broadcast.
  const orchestrate = createOrchestrate({ stateDir, control, broadcast: (m) => broadcast.emit(m) });
  registerOrchestrate(router, orchestrate, uiGuard(uiKey), { testDoor: opts.testDoor ?? false });
  registerSpacesheepUi(
    router,
    {
      link: () => config.spacesheep,
      status: () => spacesheep?.status() ?? null,
      connect: (link) => {
        config = setSpacesheep(stateDir, live(), link);
        startSpacesheep(link);
        broadcast.emit({ kind: "info" } as never);
      },
      disconnect: () => {
        spacesheep?.stop();
        spacesheep = null;
        config = setSpacesheep(stateDir, live(), undefined);
        control.remote.drop("spacesheep");
      },
      deviceName: () => `${os.hostname().replace(/\.(local|lan|home)$/i, "")}`,
      version: () => packageVersion(),
    },
    uiGuard(uiKey),
  );
  const themes = new ThemeRegistry(opts.themesDir ?? path.join(stateDir, "themes"), {
    bundledDir: bundled.view,
    disabled,
  });
  registerThemes(router, {
    registry: themes,
    uiAuth,
    stateDir: path.join(stateDir, "themes-state"),
    onState: (id, etag) => broadcast.emit({ kind: "viewState", id, etag }),
    setDisabled: (id, off) => {
      config = setDisabled(stateDir, live(), `view:${id}`, off);
    },
  });
  registerPlugins(router, { host: plugins, uiAuth, demo: opts.demo === true });
  const skins = new SkinRegistry(opts.skinsDir ?? path.join(stateDir, "skins"), path.join(stateDir, "color-themes"), {
    bundledDir: bundled.skin,
    disabled,
  });
  registerSkins(router, { registry: skins, uiAuth });
  registerExtras(router, {
    uiAuth,
    dirs: {
      themes: opts.themesDir ?? path.join(stateDir, "themes"),
      skins: opts.skinsDir ?? path.join(stateDir, "skins"),
      plugins: opts.pluginsDir ?? path.join(stateDir, "plugins"),
      bundled: bundled.view,
    },
    after: async (kind) => {
      if (kind === "view") themes.scan();
      else if (kind === "skin") skins.scan();
      else await plugins.reload();
    },
  });
  registerTrust(router, { uiAuth, uiKey, tls: () => tls, info });

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => void router.handle(req, res);
  const server = http.createServer(handler);
  server.keepAliveTimeout = 65_000;
  const makeHttps = (m: TlsMaterial): https.Server => {
    const s = https.createServer({ key: m.key, cert: m.cert, minVersion: "TLSv1.2" }, handler);
    s.keepAliveTimeout = 65_000;
    return s;
  };
  let httpsServer: https.Server | null = tls ? makeHttps(tls) : null;
  // One listener for both protocols, always: the https side can then be attached while
  // running (the setup page's "Turn on"), without rebinding the port.
  const listener: DualListener = createDualListener({ http: server, https: httpsServer });
  const enableTls = (): TlsMaterial => {
    if (tls) return tls;
    const m = ensureCerts(path.join(stateDir, "tls"), { hostname: opts.tlsHostname, addresses: lanAddresses() });
    httpsServer = makeHttps(m);
    listener.setHttps(httpsServer);
    tls = m;
    rpId = chooseRpId();
    config = setTlsPreference(stateDir, live(), true);
    return m;
  };
  /** The setup page's "Use https://…" and "Stop using it": at runtime, remembered. */
  const applyPublicUrl = (url: string | undefined): void => {
    const next = url ? normalizePublicUrl(url) : undefined;
    publicUrl = next;
    rpId = chooseRpId();
    config = setPublicUrl(stateDir, live(), next);
  };

  const tailscale = createTailscaleProbe(execDefault, {
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    port: () => port,
  });
  const setup = registerSetup(router, {
    store,
    control,
    info,
    viewers,
    tls: () => tls,
    enableTls,
    sinkToken: () => config.sinkToken,
    port: () => port,
    outbox,
    outboxPath: opts.outboxPath,
    testDoor: opts.testDoor ?? false,
    publicUrl: () => publicUrl,
    setPublicUrl: applyPublicUrl,
    tailscale,
  });
  registerPhone(router, {
    control,
    info,
    uiAuth,
    port: () => port,
    setPublicUrl: applyPublicUrl,
    tailscale,
    testDoor: opts.testDoor ?? false,
  });
  router.fallback = staticFiles(opts.webDir ?? webDir(), { uiAuth, uiKey });

  const host = opts.host ?? "0.0.0.0";
  port = await listen(listener, opts.port ?? DEFAULT_PORT, host);
  const addr = listener.address();
  // Node reports 0 as 0.0.0.0 and ::0 as ::. The IPv4-mapped wildcard (::ffff:0.0.0.0, or
  // ::ffff:0:0) comes back as :: on macOS but as ::ffff:0.0.0.0 on Linux, and answers on
  // every IPv4 address there too.
  // An IPv4-mapped address (::ffff:127.0.0.1) answers on its IPv4 address too, so URLs name
  // that form: the one main always gave, and the one the desktop's loopback check knows.
  if (typeof addr === "object" && addr && !WILDCARDS.has(addr.address))
    bound = addr.address.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, "$1");
  // Plugins start once the port is known: their api names the URLs a message can carry.
  // Plugins can reach out of the machine (a Telegram bot, say). Demo mode exists to look
  // at the UI with synthetic sessions, so it never activates them: a throwaway server
  // must not ping a real phone about pretend prompts.
  if (opts.demo) {
    if (!opts.quiet) process.stderr.write("[sessionpipe-gui] plugins are off in demo mode\n");
  } else await plugins.start();

  return {
    server,
    get httpsServer() {
      return httpsServer;
    },
    listener,
    get tls() {
      return tls;
    },
    get rpId() {
      return rpId;
    },
    enableTls,
    get publicUrl() {
      return publicUrl;
    },
    setPublicUrl: applyPublicUrl,
    router,
    store,
    control,
    port,
    url: selfUrl(),
    get lanUrls() {
      return lanUrls();
    },
    stateDir,
    config: () => live(),
    info,
    outbox,
    themes,
    plugins,
    skins,
    search,
    orchestrate,
    close: async () => {
      await plugins.stop();
      setup.pairer.close();
      outbox?.stop();
      spacesheep?.stop();
      setDemo(false);
      replay?.stop();
      orchestrate.close();
      control.close();
      await search.close();
      await store.close();
      server.closeAllConnections?.();
      httpsServer?.closeAllConnections?.();
      listener.destroyConnections();
      await new Promise<void>((r) => listener.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      if (httpsServer) await new Promise<void>((r) => httpsServer!.close(() => r()));
    },
  };
}

export { ROUTES };
