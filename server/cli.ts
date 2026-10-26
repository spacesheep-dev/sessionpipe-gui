// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. `npx sessionpipe-gui`: start the receiver, print where to
// open it (with a QR code for a phone) and the one line that connects another
// machine. Ctrl-C stops it cleanly.
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { DEFAULT_PORT, type ExtraEntry, ROUTES, UI_KEY_PARAM } from "../shared/api.js";
import { type App, createApp } from "./app.js";
import { defaultStateDir, packageVersion, readGuiConfig, setDisabled, setEnabled, setTlsPreference } from "./config.js";
import { findExtra, formatCatalog, installableExtras } from "./extensions/catalog.js";
import { extraInstalled, installExtra } from "./extensions/extras.js";
import { InstallError } from "./extensions/install.js";
import { bundledDirs } from "./extensions/kind.js";
import { lanAddresses } from "./http/net.js";
import { addPlugin, formatPluginList, linkPlugin, listPlugins, removePlugin } from "./plugins/index.js";
import { sameMachine } from "./setup/index.js";
import { addSkin, formatSkinList, linkSkin, listSkins, removeSkin } from "./skins/index.js";
import { addTheme, formatList, linkTheme, listThemes, removeTheme } from "./themes/index.js";
import { ensureCerts, localHostname, readCerts, resetCerts, TlsError } from "./tls/certs.js";

// Before anything else: an old Node fails somewhere deep with a stack trace; say it plainly.
// (Imports are hoisted above this line, but the two external ones load on any Node.)
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 20) {
  process.stderr.write(`sessionpipe-gui needs Node 20 or newer (you have v${process.versions.node})\n`);
  process.exit(1);
}

const HELP = `sessionpipe-gui ${packageVersion()} — a sessionpipe receiver with a live board

usage: sessionpipe-gui [options]

  --port N          listen on port N (default ${DEFAULT_PORT})
  --host H          bind address (default 0.0.0.0: this machine and the LAN)
  --state DIR       where events and config live (default ~/.local/state/sessionpipe-gui)
  --no-outbox       do not tail this machine's sessionpipe outbox
  --outbox DIR      tail a sessionpipe state dir other than the default one
  --keep-days N     events older than N days keep a shorter preview in memory (default 14; 0 = whole)
  --demo            generate synthetic sessions so the board is never empty
  --replay FILE     replay a sessionpipe JSONL file (--speed N: 0 = at once, 1 = real time; idle gaps capped at 10 s)
  --speed N         demo / replay speed
  --tls             TLS mode: the same port also answers https with a certificate from
                    the GUI's own local CA, so passkeys work from a phone (needs openssl);
                    remembered in config.json until --no-tls
  --no-tls          turn TLS mode off again (remembered)
  --rp-id HOST      WebAuthn rp id control passkeys are made for (default localhost;
                    with --tls, this machine's <name>.local; with --public-url, its host)
  --public-url URL  reached from anywhere: the https origin a reverse proxy on this
                    machine serves (Tailscale: "tailscale serve --bg 7373", then
                    https://<name>.<tailnet>.ts.net); remembered until --no-public-url.
                    Passkeys are made for its host; the proxy's X-Forwarded-* are trusted
  --no-public-url   forget the public url (remembered)
  --test-door       loopback-only test door for the conformance runner
  --themes-dir DIR  where views (themes) are installed (default <state>/themes)
  --plugins-dir DIR where plugins are installed (default <state>/plugins)
  --skins-dir DIR   where skins are installed (default <state>/skins)
  --bundled-dir DIR where the views that ship with the GUI are (default dist/bundled/views);
                    the bundled skins and plugins are in skins/ and plugins/ beside it
  --search-home DIR session search reads agent history (~/.claude*, ~/.codex, ~/.gemini)
                    under DIR instead of your home; also SPGUI_SEARCH_HOME. With --demo and
                    neither, no history is read (demos and screenshots stay synthetic)
  --open            open the board in the browser
  --quiet           no banner
  --version         print the version
  --help            this

views (themes: pages kept outside the GUI, loaded by the board at runtime):

  sessionpipe-gui view list                  installed views
  sessionpipe-gui view add <source>          install: a folder, a .tgz/.zip (path or URL),
                                             an npm package name or a git URL
  sessionpipe-gui view link <folder>         symlink a folder, for development
  sessionpipe-gui view remove <id>           uninstall
  sessionpipe-gui view disable|enable <id>   hide a view (Canvas and Office ship bundled and
                                             cannot be removed) or show it again
  "theme" is an alias of "view". --state DIR / --themes-dir DIR apply to these too.

plugins (server-side code that reacts to events: notifications, suggested answers):

  sessionpipe-gui plugin list|add|link|remove  the same verbs; folders under <state>/plugins,
                                             settings on the Views page; --plugins-dir DIR
  sessionpipe-gui plugin enable|disable <id> turn one on or off. ping-a-human ships bundled
                                             and is off until you enable it (then set its
                                             Telegram token on the Views page)

skins (tokens, fonts, radius, density and an optional stylesheet; no code):

  sessionpipe-gui skin list|add|link|remove    the same verbs; folders under <state>/skins,
                                             picked in the page's quick settings; --skins-dir DIR
  sessionpipe-gui skin disable|enable <id>   hide an installed skin from the popover or
                                             show it again
  Plain color-theme JSON files in <state>/color-themes/*.json still work and are listed
  with the skins; see docs/skin-authoring.md and docs/color-theme.example.json.

extras (the official views, skins and plugins; every one ships inside the GUI):

  sessionpipe-gui extras list                catalogue: id, kind, one line, size, state
  sessionpipe-gui extras add <id|all>        nothing to do today: all of them are bundled
  The same list is on the Views page. \`npm run bundle:sync\` in a checkout refreshes the
  bundled copies from the themes repo beside it.

A view is code running in the board page with access to everything it shows. A plugin
is code running in the receiver process with everything this machine has. Only install
what you trust, from people you trust. A skin runs no code.

search (every session's prompts, replies and tool calls; works offline, no browser):

  sessionpipe-gui search "<query>" [--agent a] [--machine m] [--repo r] [--since 7d]
                         [--until d] [--in f] [--source s] [--newest] [--limit n] [--json]
                                             "a phrase", -without, pre*, and the same filters
                                             as the page (agent: machine: repo: since: …);
                                             exit 0 with results, 1 with none
  sessionpipe-gui index [--rebuild] [--status] [--verify]
                                             bring the search index up to date (asks the
                                             running GUI when there is one)

tls (passkeys from a phone; README "Passkeys from a phone"):

  sessionpipe-gui tls status                 hostname, names in the certificate, expiry,
                                             the CA fingerprint and the file paths
  sessionpipe-gui tls trust                  macOS: add the CA to your login keychain
                                             (security add-trusted-cert; asks for your password)
  sessionpipe-gui tls reset                  delete the CA and the certificate; the next
                                             --tls start makes new ones (phones trust again)
  With --tls the rp id is <name>.local and passkeys work only on https://<name>.local:PORT,
  on the phone and on this machine; http://localhost still serves everything else. The
  name is mDNS: macOS advertises it itself, Linux needs avahi-daemon, Windows 10+ resolves it.
`;

interface Args {
  port?: number;
  host?: string;
  state?: string;
  outbox: boolean;
  outboxPath?: string;
  keepDays?: number;
  demo: boolean;
  replay?: string;
  speed?: number;
  rpId?: string;
  /** `--public-url URL` a string; `--no-public-url` null; neither undefined (the remembered one). */
  publicUrl?: string | null;
  testDoor: boolean;
  open: boolean;
  quiet: boolean;
  themesDir?: string;
  pluginsDir?: string;
  skinsDir?: string;
  bundledDir?: string;
  /** --search-home DIR: where session search reads agent history. */
  searchHome?: string;
  /** `view|theme|plugin|skin <verb> [arg]`: a subcommand instead of the server. */
  ext?: { kind: "view" | "plugin" | "skin"; verb: string; arg?: string };
  /** `extras list|add <id|all>`: a subcommand instead of the server. */
  extras?: { verb: string; arg?: string };
  /** `--tls` true, `--no-tls` false, neither: whatever config.json remembers. */
  tls?: boolean;
  /** `tls <verb>`: a subcommand instead of the server. */
  tlsCommand?: string;
}

function parseArgs(argv: string[]): Args | "help" | "version" {
  const a: Args = { outbox: true, demo: false, testDoor: false, open: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) fail(`${f} needs a value`);
      return v;
    };
    switch (f) {
      case "--help":
      case "-h":
        return "help";
      case "--version":
      case "-v":
        return "version";
      case "--port":
        a.port = Number(next());
        if (!Number.isInteger(a.port) || a.port < 0 || a.port > 65535) fail("--port needs a number 0–65535");
        break;
      case "--host":
        a.host = next();
        break;
      case "--state":
        a.state = next();
        break;
      case "--no-outbox":
        a.outbox = false;
        break;
      case "--outbox":
        a.outboxPath = next();
        break;
      case "--keep-days":
        a.keepDays = Number(next());
        if (!Number.isInteger(a.keepDays) || a.keepDays < 0) fail("--keep-days needs a whole number of days");
        break;
      case "--demo":
        a.demo = true;
        break;
      case "--replay":
        a.replay = next();
        break;
      case "--speed":
        a.speed = Number(next());
        if (!Number.isFinite(a.speed) || a.speed < 0) fail("--speed needs a number ≥ 0");
        break;
      case "--public-url":
        a.publicUrl = next();
        break;
      case "--no-public-url":
        a.publicUrl = null;
        break;
      case "--rp-id":
        a.rpId = next();
        break;
      case "--tls":
        a.tls = true;
        break;
      case "--no-tls":
        a.tls = false;
        break;
      case "tls":
        if (a.tlsCommand !== undefined) fail("one tls command at a time");
        a.tlsCommand = argv[++i] ?? "";
        break;
      case "--test-door":
        a.testDoor = true;
        break;
      case "--themes-dir":
        a.themesDir = next();
        break;
      case "--plugins-dir":
        a.pluginsDir = next();
        break;
      case "--skins-dir":
        a.skinsDir = next();
        break;
      case "--bundled-dir":
        a.bundledDir = next();
        break;
      case "--search-home":
        a.searchHome = path.resolve(next());
        break;
      case "theme":
      case "view":
      case "plugin":
      case "skin":
        if (a.ext) fail("one view / plugin / skin command at a time");
        a.ext = { kind: f === "plugin" || f === "skin" ? f : "view", verb: argv[++i] ?? "" };
        if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) a.ext.arg = argv[++i];
        break;
      case "extras":
        if (a.extras) fail("one extras command at a time");
        a.extras = { verb: argv[++i] ?? "list" };
        if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) a.extras.arg = argv[++i];
        break;
      case "--open":
        a.open = true;
        break;
      case "--quiet":
      case "-q":
        a.quiet = true;
        break;
      default:
        fail(`unknown option ${f} (try --help)`);
    }
  }
  return a;
}

function fail(msg: string): never {
  process.stderr.write(`sessionpipe-gui: ${msg}\n`);
  process.exit(2);
}

async function banner(app: App): Promise<string> {
  const info = app.info();
  const lines: string[] = [];
  lines.push(`sessionpipe-gui ${info.version} · ${app.stateDir}`);
  lines.push("");
  // Not set up yet (no event, no TLS mode, or this machine's daemon not paired): the
  // setup page first, since that is where a first run should go.
  const pairedHere = [...app.control.machines().keys()].some((n) => sameMachine(n, os.hostname()));
  if (app.store.stats().events === 0 || !info.tls || !pairedHere) {
    lines.push(`  setup   ${info.urls.local}/setup   (first run: your sessions, https, pairing, your phone)`);
  }
  lines.push(`  local   ${info.urls.local}`);
  for (const u of info.urls.lan) lines.push(`  network ${u}/?${UI_KEY_PARAM}=${info.uiKey}`);
  if (info.tls) {
    lines.push(
      `  https   ${info.tls.httpsUrl}/?${UI_KEY_PARAM}=${info.uiKey}   (passkeys; rp id ${info.control.rpId})`,
    );
    lines.push(`  trust   ${info.urls.lan[0] ?? info.urls.local}${ROUTES.trust}   CA ${info.tls.caFingerprint}`);
  }
  if (info.remote) {
    lines.push(
      `  anywhere ${info.remote.url}/?${UI_KEY_PARAM}=${info.uiKey}   (through your proxy; passkeys; rp id ${info.control.rpId})`,
    );
  }
  // With TLS on the QR opens the trust page (plain http), which installs the CA and then
  // forwards to the https origin: a fresh phone never meets a certificate warning first.
  const phoneUrl = info.urls.lan[0]
    ? `${info.urls.lan[0]}${info.tls ? ROUTES.trust : "/"}?${UI_KEY_PARAM}=${info.uiKey}`
    : null;
  if (phoneUrl) {
    lines.push("");
    lines.push(
      info.tls
        ? "  on a phone, scan this (same Wi-Fi; it starts with the trust steps):"
        : "  on a phone, scan this (same Wi-Fi):",
    );
    const qr = await QRCode.toString(phoneUrl, { type: "terminal", small: true });
    for (const l of qr.split("\n")) lines.push(`  ${l}`);
  }
  lines.push("  from another machine:");
  lines.push(`    ${info.sinkCommand}`);
  if (info.remote) {
    lines.push("  from a machine anywhere (through the proxy):");
    lines.push(`    ${info.remote.sinkCommand}`);
    lines.push(`    ${info.remote.connectCommand}`);
  }
  lines.push("");
  if (info.sources.outbox) {
    lines.push(`  outbox  tailing ${info.sources.outbox.path} (${info.sources.outbox.sessions} sessions)`);
  } else lines.push("  outbox  not tailed (--no-outbox)");
  if (info.sources.demo) lines.push("  demo    on");
  if (!info.tls) lines.push("  tls     off (passkeys from a phone need it: --tls)");
  lines.push("");
  lines.push("  Ctrl-C to stop");
  return `${lines.join("\n")}\n`;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {}
}

/** `sessionpipe-gui view|theme|plugin|skin list|add|link|remove`. Prints what it did; exits 1 on a problem. */
async function extensionCommand(parsed: Args): Promise<void> {
  const { kind, verb, arg } = parsed.ext!;
  const stateDir = parsed.state ?? defaultStateDir();
  const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const bundled = bundledDirs(parsed.bundledDir);
  const disabled = () => readGuiConfig(stateDir).disabled ?? [];
  const pluginOpts = () => ({
    bundledDir: bundled.plugin,
    disabled,
    enabled: () => readGuiConfig(stateDir).enabled ?? [],
  });
  const skinOpts = () => ({ bundledDir: bundled.skin, disabled });
  const viewOpts = () => ({ bundledDir: bundled.view, disabled });
  const ops =
    kind === "plugin"
      ? {
          noun: "plugin",
          dir: parsed.pluginsDir ?? path.join(stateDir, "plugins"),
          list: (dir: string) => formatPluginList(dir, listPlugins(dir, pluginOpts())),
          ids: (dir: string) => listPlugins(dir, pluginOpts()).map((p) => p.id),
          add: addPlugin,
          link: linkPlugin,
          remove: (dir: string, id: string) => removePlugin(dir, id, pluginOpts()),
          off: (id: string) => `${id} is off: it will not run; \`plugin enable ${id}\` turns it on`,
          on: (id: string) => `${id} is on: it starts with the receiver (a running one picks it up on Reload plugins)`,
        }
      : kind === "skin"
        ? {
            noun: "skin",
            dir: parsed.skinsDir ?? path.join(stateDir, "skins"),
            list: (dir: string) => formatSkinList(dir, listSkins(dir, skinOpts())),
            ids: (dir: string) => listSkins(dir, skinOpts()).map((s) => s.id),
            add: addSkin,
            link: linkSkin,
            remove: (dir: string, id: string) => removeSkin(dir, id, skinOpts()),
            off: (id: string) =>
              `${id} is off: hidden from the appearance popover; \`skin enable ${id}\` brings it back`,
            on: (id: string) => `${id} is on`,
          }
        : {
            noun: "view",
            dir: parsed.themesDir ?? path.join(stateDir, "themes"),
            list: (dir: string) => formatList(dir, listThemes(dir, viewOpts())),
            ids: (dir: string) => listThemes(dir, viewOpts()).map((t) => t.id),
            add: addTheme,
            link: linkTheme,
            remove: (dir: string, id: string) => removeTheme(dir, id, viewOpts()),
            off: (id: string) => `${id} is off: hidden from the rail; \`view enable ${id}\` brings it back`,
            on: (id: string) => `${id} is on`,
          };
  try {
    switch (verb) {
      case "disable":
      case "enable": {
        if (!arg) fail(`${ops.noun} ${verb} needs an id (see \`${ops.noun} list\`)`);
        if (!ops.ids(ops.dir).includes(arg)) fail(`no ${ops.noun} "${arg}" (see \`${ops.noun} list\`)`);
        const cfg = readGuiConfig(stateDir);
        const key = `${ops.noun}:${arg}`;
        // A view keeps its `disabled` entry alone; a plugin or skin goes through both lists,
        // since a bundled plugin is off until `enabled` names it.
        if (kind === "view") setDisabled(stateDir, cfg, key, verb === "disable");
        else setEnabled(stateDir, cfg, key, verb === "enable");
        out(verb === "disable" ? ops.off(arg) : ops.on(arg));
        return;
      }
      case "list":
      case "ls":
        out(ops.list(ops.dir));
        return;
      case "add":
      case "install":
        if (!arg) fail(`${ops.noun} add needs a source: a folder, a .tgz/.zip, an npm package or a git URL`);
        out((await ops.add(ops.dir, arg)).message);
        return;
      case "link":
        if (!arg) fail(`${ops.noun} link needs a folder`);
        out(ops.link(ops.dir, arg).message);
        return;
      case "remove":
      case "rm":
        if (!arg) fail(`${ops.noun} remove needs an id (see \`${ops.noun} list\`)`);
        out(ops.remove(ops.dir, arg).message);
        return;
      default:
        fail(`unknown ${ops.noun} command "${verb}" (list, add, link, remove, disable, enable)`);
    }
  } catch (e) {
    if (e instanceof InstallError) {
      process.stderr.write(`sessionpipe-gui: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

/** `sessionpipe-gui extras list|add <id|all>`: the catalogue; `add` installs an entry that
 *  is not bundled, of which there are none today. */
async function extrasCommand(parsed: Args): Promise<void> {
  const { verb, arg } = parsed.extras!;
  const stateDir = parsed.state ?? defaultStateDir();
  const dirs = {
    themes: parsed.themesDir ?? path.join(stateDir, "themes"),
    skins: parsed.skinsDir ?? path.join(stateDir, "skins"),
    plugins: parsed.pluginsDir ?? path.join(stateDir, "plugins"),
    bundled: parsed.bundledDir,
  };
  const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  switch (verb) {
    case "list":
    case "ls":
      out(formatCatalog((e) => extraInstalled(dirs, e)));
      out(
        installableExtras().length
          ? "`extras add <id>` installs one from npm; `extras add all` every one that is not bundled."
          : "Every one ships inside the GUI: nothing to install. ping-a-human is off until `plugin enable ping-a-human`.",
      );
      return;
    case "add":
    case "install": {
      if (!arg) fail("extras add needs an id from `extras list`, or `all`");
      if (arg === "all" && installableExtras().length === 0) {
        out("Every extra ships inside the GUI already: nothing to install.");
        out("Skins are in the appearance popover; `plugin enable ping-a-human` turns the Telegram plugin on.");
        return;
      }
      const wanted = arg === "all" ? installableExtras() : [findExtra(arg)];
      if (wanted[0] === undefined) fail(`no extra "${arg}" (see \`extras list\`)`);
      let failed = 0;
      for (const entry of wanted as ExtraEntry[]) {
        if (entry.bundled) {
          out(
            entry.kind === "plugin"
              ? `${entry.id}: bundled with the GUI, nothing to install; \`plugin enable ${entry.id}\` turns it on`
              : `${entry.id}: bundled with the GUI, nothing to install`,
          );
          continue;
        }
        out(`${entry.id}: installing ${entry.npm}…`);
        try {
          out((await installExtra(dirs, entry)).message);
        } catch (e) {
          if (!(e instanceof InstallError)) throw e;
          failed++;
          process.stderr.write(`sessionpipe-gui: ${entry.id}: ${e.message}\n`);
        }
      }
      if (failed) process.exit(1);
      out("A skin shows in the appearance popover after Reload; a plugin on the Views page after Reload plugins.");
      return;
    }
    default:
      fail(`unknown extras command "${verb}" (list, add)`);
  }
}

/** `sessionpipe-gui tls status|trust|reset`. */
function tlsCommand(parsed: Args): void {
  const verb = parsed.tlsCommand!;
  const stateDir = parsed.state ?? defaultStateDir();
  const dir = path.join(stateDir, "tls");
  const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const hostname = localHostname();
  switch (verb) {
    case "status": {
      const m = readCerts(dir);
      const cfg = readGuiConfig(stateDir);
      out(`tls mode   ${cfg.tls ? "on (remembered; --no-tls turns it off)" : "off (start with --tls)"}`);
      out(`hostname   ${hostname}`);
      if (!m) {
        out(`certs      none yet under ${dir} (made on the first --tls start)`);
        return;
      }
      out(`names      ${m.sans.join(", ")}`);
      if (!m.sans.includes(`DNS:${hostname}`)) {
        out(`           (the certificate was made for ${m.hostname}; it is re-issued at the next start)`);
      }
      out(`expires    server ${m.serverExpiresAt.slice(0, 10)} · CA ${m.caExpiresAt.slice(0, 10)}`);
      out(`CA sha256  ${m.caFingerprint}`);
      out(`files      ${m.caCertPath}`);
      out(`           ${m.caKeyPath}`);
      out(`           ${m.serverCertPath}`);
      out(`           ${m.serverKeyPath}`);
      return;
    }
    case "trust": {
      let m = readCerts(dir);
      if (!m) {
        try {
          m = ensureCerts(dir, { addresses: lanAddresses() });
        } catch (e) {
          if (e instanceof TlsError) fail(e.message);
          throw e;
        }
      }
      if (process.platform !== "darwin") {
        out(`On this platform add the CA by hand: ${m.caCertPath}`);
        out(
          "  Debian/Ubuntu: sudo cp ca.crt /usr/local/share/ca-certificates/sessionpipe-gui.crt && sudo update-ca-certificates",
        );
        out("  Fedora/RHEL:   sudo trust anchor ca.crt");
        out("  Firefox and Chrome keep their own store: Settings → Certificates → Authorities → Import.");
        return;
      }
      const keychain = path.join(process.env.HOME ?? "~", "Library", "Keychains", "login.keychain-db");
      out(`Adding "sessionpipe-gui local CA · ${m.hostname}" to ${keychain} (macOS asks for your password)…`);
      try {
        // The user trust domain (no -d): -d is the admin domain, which needs sudo and
        // otherwise imports the certificate without any trust setting.
        execFileSync(
          "security",
          ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-p", "basic", "-k", keychain, m.caCertPath],
          { stdio: "inherit" },
        );
        const dump = execFileSync("security", ["dump-trust-settings"], { encoding: "utf8" });
        if (!dump.includes("sessionpipe-gui local CA"))
          fail(
            `The certificate was imported but has no trust setting. By hand: open ${m.caCertPath} in Keychain Access and set "Always Trust" for SSL.`,
          );
      } catch {
        fail(
          `security add-trusted-cert did not finish. By hand: open ${m.caCertPath} in Keychain Access and set "Always Trust" for SSL.`,
        );
      }
      out(`Trusted. Open https://${m.hostname}:${parsed.port ?? DEFAULT_PORT}/ in this Mac's browser.`);
      return;
    }
    case "reset": {
      out(
        resetCerts(dir)
          ? `Deleted ${dir}; the next --tls start makes a new CA (phones must trust it again).`
          : `Nothing under ${dir}.`,
      );
      return;
    }
    default:
      fail(`unknown tls command "${verb}" (status, trust, reset)`);
  }
}

/** `search …` / `index …`: session search from a terminal (server/search/cli.ts). */
async function searchCommand(sub: "search" | "index", rest: string[]): Promise<void> {
  const { runIndexCli, runSearchCli } = await import("./search/cli.js");
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const home = flag("--search-home") ?? process.env.SPGUI_SEARCH_HOME;
  const io = {
    stdout: process.stdout,
    stderr: process.stderr,
    stateDir: path.resolve(flag("--state") ?? defaultStateDir()),
    home: home ? path.resolve(home) : undefined,
  };
  const code = await (sub === "search" ? runSearchCli : runIndexCli)(rest, io);
  process.exitCode = code;
  // Nothing should hold the loop open now; if something does, do not hang the terminal.
  setTimeout(() => process.exit(code), 2000).unref();
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "search" || sub === "index") return searchCommand(sub, process.argv.slice(3));
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (parsed === "version") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  if (parsed.ext) return extensionCommand(parsed);
  if (parsed.extras) return extrasCommand(parsed);
  if (parsed.tlsCommand !== undefined) return tlsCommand(parsed);
  const t0 = Date.now();
  // --tls / --no-tls are remembered in config.json; a bare start uses the remembered choice.
  const stateDir = parsed.state ?? defaultStateDir();
  const tls =
    parsed.tls === undefined
      ? readGuiConfig(stateDir).tls === true
      : setTlsPreference(stateDir, readGuiConfig(stateDir), parsed.tls).tls === true;
  let app: App;
  try {
    app = await createApp({
      port: parsed.port,
      host: parsed.host,
      stateDir: parsed.state,
      outbox: parsed.outbox,
      outboxPath: parsed.outboxPath,
      keepDays: parsed.keepDays,
      demo: parsed.demo,
      replay: parsed.replay,
      speed: parsed.speed,
      rpId: parsed.rpId,
      publicUrl: parsed.publicUrl,
      testDoor: parsed.testDoor,
      quiet: parsed.quiet,
      themesDir: parsed.themesDir,
      pluginsDir: parsed.pluginsDir,
      skinsDir: parsed.skinsDir,
      bundledDir: parsed.bundledDir,
      tls,
      // History search reads the real home only when asked to run for real: a demo without
      // --search-home reads none (SEARCH-SPEC D14), and only the bundle forks the indexer.
      searchHome:
        parsed.searchHome ??
        (process.env.SPGUI_SEARCH_HOME ? path.resolve(process.env.SPGUI_SEARCH_HOME) : undefined) ??
        (parsed.demo ? undefined : os.homedir()),
      searchCliPath: import.meta.url.endsWith(".js") ? fileURLToPath(import.meta.url) : undefined,
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") fail(`port ${parsed.port ?? DEFAULT_PORT} is in use (try --port)`);
    if (err instanceof TlsError) fail(`${err.message}\n(--no-tls starts without TLS mode)`);
    fail(err.message);
  }
  if (!parsed.quiet) {
    process.stdout.write(await banner(app));
    const s = app.store.stats();
    process.stdout.write(`  ready in ${Date.now() - t0} ms · ${s.sessions} sessions · ${s.events} events\n\n`);
  }
  if (parsed.open) openBrowser(app.info().urls.local);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    if (!parsed.quiet) process.stdout.write(`\n${signal}: stopping\n`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
