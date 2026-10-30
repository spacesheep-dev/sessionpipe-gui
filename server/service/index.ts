// SPDX-License-Identifier: Apache-2.0
// Owned by: packaging. `sessionpipe-gui service install|uninstall|status`: the receiver as a
// per-user background service, so it runs at login and outlives any window (the desktop
// app's "Start sessionpipe" runs `service install`). macOS: a LaunchAgent bootstrapped into
// gui/<uid>. Linux: a systemd --user unit. Windows: not yet.
//
// `install` finds a service of ours already there (every app upgrade does: the plist
// names the cli of the version that installed it) and upgrades it in place: the same port,
// state dir and options unless flags say otherwise, the new node and cli, a restart, and a
// wait until the receiver answers with the new version. A plist under our label that runs
// something else is left alone.
//
// Everything outside the process (the platform, HOME, the uid, launchctl / systemctl, the
// port probe) comes in through `ServiceEnv`, so tests run against a temp HOME and a fake
// launchctl (`SP_LAUNCHCTL`, `SP_SYSTEMCTL`) and never touch the real session.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT } from "../../shared/api.js";
import { packageVersion } from "../config.js";
import { readRunFile, readRunFileRaw, runFilePath } from "../runfile.js";
import { launchAgentPath, launchAgentPlist, parseLaunchctlPrint, plistArgv } from "./launchd.js";
import { parseSystemctlShow, systemdUnit, unitArgv, unitName, unitPath } from "./systemd.js";

export const SERVICE_LABEL = "dev.spacesheep.sessionpipe-gui";
export const SERVICE_LOG = "service.log";
export const WINDOWS_NOTE =
  "a background service on Windows is not here yet: run `sessionpipe-gui` in a terminal, or add it to Startup apps yourself";

export type Verb = "install" | "uninstall" | "status";
export interface ServiceOptions {
  verb: Verb;
  port?: number;
  host?: string;
  state?: string;
  /** Receiver options after `--`, passed on to the service as they are. */
  extra?: string[];
  dryRun?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Probe = "gui" | "other" | null;

export interface ServiceEnv {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  label: string;
  launchctl: string;
  systemctl: string;
  /** The node binary and the CLI the service runs, both absolute. */
  node: string;
  cli: string;
  /** The default state dir, when `--state` is absent. */
  defaultState: string;
  exec(cmd: string, args: string[]): ExecResult;
  /** This sessionpipe-gui's version: what an installed service is upgraded to. */
  version: string;
  /** Who answers on 127.0.0.1:<port>: this GUI, something else, or nothing. */
  probe(port: number): Promise<Probe>;
  /** The version a sessionpipe-gui on 127.0.0.1:<port> reports; undefined when none answers. */
  running(port: number): Promise<string | undefined>;
  /** How long `install` waits for the receiver to answer (0: don't wait). A big state dir
   *  rebuilds its index at boot, which can take most of a minute. */
  waitMs: number;
  /** How long launchd gets to let go of a job after `bootout`. */
  settleMs: number;
  out(line: string): void;
  err(line: string): void;
}

/** The real environment, with the test overrides read from `process.env`. */
export function processEnv(defaultState: string): ServiceEnv {
  const env = process.env;
  let cli = process.argv[1] ?? "";
  try {
    cli = realpathSync(cli);
  } catch {}
  return {
    platform: process.platform,
    home: env.HOME ?? os.homedir(),
    uid: process.getuid?.() ?? 0,
    label: env.SP_SERVICE_LABEL || SERVICE_LABEL,
    launchctl: env.SP_LAUNCHCTL || "launchctl",
    systemctl: env.SP_SYSTEMCTL || "systemctl",
    node: process.execPath,
    cli,
    defaultState,
    version: packageVersion(),
    exec: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
      return {
        code: r.status ?? (r.error ? 127 : 1),
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? r.error?.message ?? "",
      };
    },
    probe: probePort,
    running: async (port) => (await fetchInfo(port))?.version,
    waitMs: env.SP_SERVICE_WAIT_MS !== undefined ? Number(env.SP_SERVICE_WAIT_MS) : 90_000,
    settleMs: 10_000,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`sessionpipe-gui: ${s}\n`),
  };
}

/** `GET /api/ui/info` on loopback:<port>, when something listens there. */
async function fetchInfo(port: number, timeoutMs = 1000): Promise<{ name?: string; version?: string } | null> {
  const open = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
  if (!open) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ui/info`, { signal: AbortSignal.timeout(timeoutMs) });
    return (await res.json()) as { name?: string; version?: string };
  } catch {
    return {};
  }
}

/** Is anything listening on loopback:<port>, and is it a sessionpipe-gui? */
export async function probePort(port: number, timeoutMs = 1000): Promise<Probe> {
  const info = await fetchInfo(port, timeoutMs);
  if (!info) return null;
  return info.name === "sessionpipe-gui" ? "gui" : "other";
}

const tilde = (p: string, home: string) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The PATH the service runs with: launchd and systemd start programs with a bare one, and
 *  the receiver runs `sessionpipe` (pairing) and `npm` (view add) found on it. */
export function servicePath(node: string): string {
  const dirs = [path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

/** What the service runs: node, the CLI, the port and state dir, then whatever came after `--`. */
export function serviceArgv(env: ServiceEnv, o: { port: number; state: string; host?: string; extra?: string[] }) {
  const argv = [env.node, env.cli, "--port", String(o.port), "--state", o.state, "--quiet"];
  if (o.host) argv.push("--host", o.host);
  return [...argv, ...(o.extra ?? [])];
}

interface Installed {
  file: string;
  argv: string[];
}

function serviceFile(env: ServiceEnv): string | null {
  if (env.platform === "darwin") return launchAgentPath(env.home, env.label);
  if (env.platform === "linux") return unitPath(env.home, env.label);
  return null;
}

function readInstalled(env: ServiceEnv): Installed | null {
  const file = serviceFile(env);
  if (!file || !existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  return { file, argv: env.platform === "darwin" ? plistArgv(text) : unitArgv(text) };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Does an installed service's argv run a sessionpipe-gui: `node …/sessionpipe-gui/dist/cli.js`
 *  (an install, a global npm, an npx cache), the `sessionpipe-gui` bin itself, or the very
 *  cli this installer runs from (a checkout)? Anything else under our label is someone's
 *  own, and `install` leaves it alone. */
export function isOurs(argv: string[], cli?: string): boolean {
  const [program, script] = argv;
  if (!program) return false;
  if (path.basename(program) === "sessionpipe-gui") return true;
  if (!script) return false;
  if (cli && script === cli) return true;
  return /(^|\/)sessionpipe-gui\/dist\/cli\.js$/.test(script) || path.basename(script) === "sessionpipe-gui";
}

/** The receiver options an installed service was given: port, state, host, and the rest. */
export function installedOptions(argv: string[]): { port?: number; state?: string; host?: string; extra: string[] } {
  const rest = argv.slice(path.basename(argv[0] ?? "") === "sessionpipe-gui" ? 1 : 2);
  const o: { port?: number; state?: string; host?: string; extra: string[] } = { extra: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--port") o.port = Number(rest[++i]);
    else if (a === "--state") o.state = rest[++i];
    else if (a === "--host") o.host = rest[++i];
    else if (a !== "--quiet") o.extra.push(a);
  }
  return o;
}

/** What the manager says: loaded at all, running, pid. */
function managerState(env: ServiceEnv): { loaded: boolean; running: boolean; pid?: number } {
  if (env.platform === "darwin") {
    const r = env.exec(env.launchctl, ["print", `gui/${env.uid}/${env.label}`]);
    if (r.code !== 0) return { loaded: false, running: false };
    return { loaded: true, ...parseLaunchctlPrint(r.stdout) };
  }
  const r = env.exec(env.systemctl, [
    "--user",
    "show",
    unitName(env.label),
    "--property=LoadState,ActiveState,MainPID",
  ]);
  if (r.code !== 0 || /^LoadState=not-found/m.test(r.stdout)) return { loaded: false, running: false };
  return { loaded: true, ...parseSystemctlShow(r.stdout) };
}

/** `launchctl bootout` returns before the job is gone; a bootstrap (or a "still loaded"
 *  verdict) right after it is too early. Polls the manager until the label is unloaded. */
async function waitUnloaded(env: ServiceEnv): Promise<boolean> {
  const until = Date.now() + env.settleMs;
  for (;;) {
    if (!managerState(env).loaded) return true;
    if (Date.now() >= until) return false;
    await sleep(100);
  }
}

/** Run one `service` verb; resolves to the process exit code. */
export async function runService(o: ServiceOptions, env: ServiceEnv): Promise<number> {
  if (env.platform !== "darwin" && env.platform !== "linux") {
    env.err(WINDOWS_NOTE);
    return 1;
  }
  if (o.verb === "install") return install(o, env);
  if (o.verb === "uninstall") return uninstall(o, env);
  return status(env);
}

const failedCommand = (c: string[], r: ExecResult) =>
  `${c.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`;

/** The file the service runs from. */
function serviceText(env: ServiceEnv, argv: string[], state: string): string {
  const logPath = path.join(state, SERVICE_LOG);
  const envVars = { PATH: servicePath(env.node) };
  return env.platform === "darwin"
    ? launchAgentPlist({ label: env.label, argv, env: envVars, logPath, workingDirectory: state })
    : systemdUnit({
        description: "sessionpipe-gui (the board: a sessionpipe receiver)",
        argv,
        env: envVars,
        logPath,
        workingDirectory: state,
      });
}

/** How many sessions a state dir holds (one events file each): the wait's words. */
function sessionCount(state: string): number {
  let n = 0;
  try {
    for (const h of readdirSync(path.join(state, "events"), { withFileTypes: true })) {
      if (h.isDirectory())
        n += readdirSync(path.join(state, "events", h.name)).filter((f) => f.endsWith(".jsonl")).length;
    }
  } catch {}
  return n;
}

/** Waits (env.waitMs) for a sessionpipe-gui to answer on the port, the given version when
 *  one is wanted. Every 10 s a progress line, as the desktop app's welcome shows them. */
async function waitForReceiver(
  env: ServiceEnv,
  o: { port: number; state: string; version?: string },
): Promise<"answered" | "running" | "silent"> {
  const t0 = Date.now();
  const until = t0 + env.waitMs;
  let said = 0;
  while (Date.now() < until) {
    const v = await env.running(o.port);
    if (v !== undefined && (!o.version || v === o.version)) return "answered";
    const secs = Math.floor((Date.now() - t0) / 1000);
    if (secs >= said) {
      const n = sessionCount(o.state);
      env.out(
        said === 0
          ? `starting on :${o.port}…${n ? ` ${n} sessions to load;` : ""} a big board takes a minute`
          : `still starting after ${secs} s…`,
      );
      said = secs + 10;
    }
    await sleep(200);
  }
  return managerState(env).running ? "running" : "silent";
}

function afterWait(env: ServiceEnv, verdict: "running" | "silent", port: number, state: string): number {
  const secs = Math.round(env.waitMs / 1000);
  const log = tilde(path.join(state, SERVICE_LOG), env.home);
  if (verdict === "running") {
    env.out(`still starting on :${port} after ${secs} s; it keeps going (${log})`);
  } else {
    env.out(`not answering on :${port} after ${secs} s; it keeps trying: see ${log}`);
  }
  return 0;
}

async function install(o: ServiceOptions, env: ServiceEnv): Promise<number> {
  const file = serviceFile(env)!;
  const prefix = o.dryRun ? "would refuse: " : "";

  // A service under our label already: ours is upgraded in place; anything else is refused.
  const inst = readInstalled(env);
  if (inst || managerState(env).loaded) {
    if (inst && isOurs(inst.argv, env.cli)) return upgrade(o, env, inst);
    env.err(
      inst
        ? `${prefix}a service is already installed under ${env.label} (${tilde(file, env.home)}), and it isn't sessionpipe-gui's: it runs ${inst.argv[0] ?? "nothing"}; \`service uninstall\` removes it`
        : `${prefix}a service is already installed (${tilde(file, env.home)}); \`sessionpipe-gui service status\` shows it, \`service uninstall\` removes it`,
    );
    return 1;
  }

  // One receiver per port.
  const port = o.port ?? DEFAULT_PORT;
  const state = path.resolve(o.state ?? env.defaultState);
  const who = await env.probe(port);
  if (who === "gui") {
    env.err(`${prefix}a sessionpipe-gui already answers on :${port}; stop it first, or install on another --port`);
    return 1;
  }
  if (who === "other") {
    env.err(`${prefix}port ${port} is in use by another program (try --port)`);
    return 1;
  }

  const argv = serviceArgv(env, { port, state, host: o.host, extra: o.extra });
  const text = serviceText(env, argv, state);
  const commands: string[][] =
    env.platform === "darwin"
      ? [[env.launchctl, "bootstrap", `gui/${env.uid}`, file]]
      : [
          [env.systemctl, "--user", "daemon-reload"],
          [env.systemctl, "--user", "enable", "--now", unitName(env.label)],
        ];

  if (o.dryRun) {
    env.out(`# ${file}`);
    env.out(text.trimEnd());
    env.out("");
    for (const c of commands) env.out(`$ ${c.join(" ")}`);
    env.out("");
    env.out(
      `dry run: nothing written or started; it would serve http://127.0.0.1:${port} from ${tilde(state, env.home)}`,
    );
    return 0;
  }

  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(file, text, { mode: 0o644 });
  for (const c of commands) {
    const r = env.exec(c[0]!, c.slice(1));
    if (r.code !== 0) {
      rmSync(file, { force: true });
      if (env.platform === "linux") env.exec(env.systemctl, ["--user", "daemon-reload"]);
      env.err(`${failedCommand(c, r)} (nothing installed)`);
      return 1;
    }
  }
  env.out(`installed ${env.label} (${tilde(file, env.home)})`);

  if (env.waitMs > 0) {
    const verdict = await waitForReceiver(env, { port, state });
    if (verdict !== "answered") return afterWait(env, verdict, port, state);
    env.out(`running on http://127.0.0.1:${port} · state ${tilde(state, env.home)}`);
    return 0;
  }
  env.out(`starting on http://127.0.0.1:${port} · state ${tilde(state, env.home)}`);
  return 0;
}

/** A service of ours is installed: the new node and cli in its file, its options kept
 *  unless flags replace them, a restart, and the new version answering. */
async function upgrade(o: ServiceOptions, env: ServiceEnv, inst: Installed): Promise<number> {
  const was = installedOptions(inst.argv);
  const port = o.port ?? was.port ?? DEFAULT_PORT;
  const state = path.resolve(o.state ?? was.state ?? env.defaultState);
  const host = o.host ?? was.host;
  const extra = o.extra ?? was.extra;
  const argv = serviceArgv(env, { port, state, host, extra });
  const url = `http://127.0.0.1:${port}`;
  const same = argv.length === inst.argv.length && argv.every((a, i) => a === inst.argv[i]);

  // Who answers on the port now: this service at its old version, or something that isn't it.
  const who = await env.probe(port);
  if (who === "other") {
    env.err(`${o.dryRun ? "would refuse: " : ""}port ${port} is in use by another program (try --port)`);
    return 1;
  }
  const running = who === "gui" ? await env.running(port) : undefined;
  if (same && running !== undefined) {
    env.out(`already running ${running} on ${url}`);
    return 0;
  }
  // The same service, up but not answering yet (a big board loading): leave it to it.
  if (same && managerState(env).running && !o.dryRun) {
    env.out(`already installed ${env.label}; it is starting`);
    if (env.waitMs > 0) {
      const verdict = await waitForReceiver(env, { port, state, version: env.version });
      if (verdict !== "answered") return afterWait(env, verdict, port, state);
    }
    env.out(`running ${env.version} on ${url} · state ${tilde(state, env.home)}`);
    return 0;
  }
  const from = running ?? readRunFileRaw(state)?.version;
  const change = `${env.label}: ${from && from !== env.version ? `${from} → ` : ""}${env.version}`;

  const text = serviceText(env, argv, state);
  const commands: string[][] =
    env.platform === "darwin"
      ? [
          ...(managerState(env).loaded ? [[env.launchctl, "bootout", `gui/${env.uid}/${env.label}`]] : []),
          [env.launchctl, "bootstrap", `gui/${env.uid}`, inst.file],
        ]
      : [
          [env.systemctl, "--user", "daemon-reload"],
          [env.systemctl, "--user", "restart", unitName(env.label)],
        ];

  if (o.dryRun) {
    env.out(`# ${inst.file}`);
    env.out(text.trimEnd());
    env.out("");
    for (const c of commands) env.out(`$ ${c.join(" ")}`);
    env.out("");
    env.out(`dry run: nothing written or restarted; it would update ${change} on ${url}`);
    return 0;
  }

  env.out(`updating ${change}`);
  mkdirSync(state, { recursive: true });
  writeFileSync(inst.file, text, { mode: 0o644 });
  for (const c of commands) {
    const r = env.exec(c[0]!, c.slice(1));
    if (r.code !== 0) {
      env.err(
        `${failedCommand(c, r)} (${tilde(inst.file, env.home)} is rewritten; \`service uninstall\` then \`service install\` starts over)`,
      );
      return 1;
    }
    // launchd lets go of the old job a moment after bootout; bootstrapping before that fails.
    if (c[1] === "bootout" && !(await waitUnloaded(env))) {
      env.err(`${env.label} is still loaded after bootout; try again`);
      return 1;
    }
  }
  env.out(`updated ${change} (${tilde(inst.file, env.home)})`);

  if (env.waitMs > 0) {
    const verdict = await waitForReceiver(env, { port, state, version: env.version });
    if (verdict !== "answered") return afterWait(env, verdict, port, state);
    env.out(`running ${env.version} on ${url} · state ${tilde(state, env.home)}`);
    return 0;
  }
  env.out(`starting on ${url} · state ${tilde(state, env.home)}`);
  return 0;
}

async function uninstall(o: ServiceOptions, env: ServiceEnv): Promise<number> {
  const file = serviceFile(env)!;
  const st = managerState(env);
  const has = existsSync(file);
  if (!has && !st.loaded) {
    env.out(`no service ${env.label} installed: nothing to do`);
    return 0;
  }
  const commands: string[][] =
    env.platform === "darwin"
      ? st.loaded
        ? [[env.launchctl, "bootout", `gui/${env.uid}/${env.label}`]]
        : []
      : [[env.systemctl, "--user", "disable", "--now", unitName(env.label)]];
  if (o.dryRun) {
    for (const c of commands) env.out(`$ ${c.join(" ")}`);
    if (has) env.out(`$ rm ${file}`);
    if (env.platform === "linux") env.out(`$ ${env.systemctl} --user daemon-reload`);
    env.out("dry run: nothing stopped or removed");
    return 0;
  }
  let failed = "";
  for (const c of commands) {
    const r = env.exec(c[0]!, c.slice(1));
    if (r.code !== 0) failed = `${c.slice(0, 3).join(" ")}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`;
  }
  rmSync(file, { force: true });
  if (env.platform === "linux") env.exec(env.systemctl, ["--user", "daemon-reload"]);
  if (!(await waitUnloaded(env))) {
    env.err(
      `${env.label} is still loaded${failed ? ` (${failed})` : ""}; try again, or \`${env.launchctl} bootout gui/${env.uid}/${env.label}\``,
    );
    return 1;
  }
  env.out(`removed ${env.label}: stopped, and it won't start at login`);
  return 0;
}

async function status(env: ServiceEnv): Promise<number> {
  const inst = readInstalled(env);
  const st = managerState(env);
  const manager = env.platform === "darwin" ? "launchd" : "systemd --user";
  if (!inst && !st.loaded) {
    env.out(`service   ${env.label} (${manager}) · not installed`);
    env.out("          `sessionpipe-gui service install` runs the receiver at login");
    return 3;
  }
  const argv = inst?.argv ?? [];
  const port = Number(flag(argv, "--port") ?? DEFAULT_PORT);
  const state = flag(argv, "--state") ?? env.defaultState;
  const parts = [st.running ? "running" : st.loaded ? "stopped" : "installed, not loaded"];
  if (st.pid) parts.push(`pid ${st.pid}`);
  const version = st.running ? await env.running(port) : undefined;
  if (version) parts.push(version);
  else if (st.running) parts.push(`not answering on :${port} yet`);
  env.out(`service   ${env.label} (${manager}) · ${parts.join(" · ")}`);
  if (inst) env.out(`file      ${tilde(inst.file, env.home)}`);
  env.out(`port      ${port}`);
  env.out(`url       http://127.0.0.1:${port}`);
  if (state) {
    const run = readRunFile(state);
    env.out(`state     ${tilde(state, env.home)}`);
    env.out(
      run
        ? `run.json  pid ${run.pid} · ${run.version} · since ${run.startedAt}`
        : `run.json  none (${tilde(runFilePath(state), env.home)})`,
    );
    env.out(`log       ${tilde(path.join(state, SERVICE_LOG), env.home)}`);
  }
  return st.running ? 0 : 3;
}
