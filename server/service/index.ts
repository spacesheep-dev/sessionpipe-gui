// SPDX-License-Identifier: Apache-2.0
// Owned by: packaging. `sessionpipe-gui service install|uninstall|status`: the receiver as a
// per-user background service, so it runs at login and outlives any window (the desktop
// app's "Start sessionpipe" runs `service install`). macOS: a LaunchAgent bootstrapped into
// gui/<uid>. Linux: a systemd --user unit. Windows: not yet.
//
// Everything outside the process (the platform, HOME, the uid, launchctl / systemctl, the
// port probe) comes in through `ServiceEnv`, so tests run against a temp HOME and a fake
// launchctl (`SP_LAUNCHCTL`, `SP_SYSTEMCTL`) and never touch the real session.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT } from "../../shared/api.js";
import { readRunFile, runFilePath } from "../runfile.js";
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
  /** Who answers on 127.0.0.1:<port>: this GUI, something else, or nothing. */
  probe(port: number): Promise<Probe>;
  /** How long `install` waits for the receiver to answer (0: don't wait). */
  waitMs: number;
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
    exec: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
      return {
        code: r.status ?? (r.error ? 127 : 1),
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? r.error?.message ?? "",
      };
    },
    probe: probePort,
    waitMs: env.SP_SERVICE_WAIT_MS !== undefined ? Number(env.SP_SERVICE_WAIT_MS) : 10_000,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`sessionpipe-gui: ${s}\n`),
  };
}

/** Is anything listening on loopback:<port>, and is it a sessionpipe-gui? */
export async function probePort(port: number, timeoutMs = 1000): Promise<Probe> {
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
    const j = (await res.json()) as { name?: string };
    return j?.name === "sessionpipe-gui" ? "gui" : "other";
  } catch {
    return "other";
  }
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

async function install(o: ServiceOptions, env: ServiceEnv): Promise<number> {
  const port = o.port ?? DEFAULT_PORT;
  const state = path.resolve(o.state ?? env.defaultState);
  const file = serviceFile(env)!;
  const prefix = o.dryRun ? "would refuse: " : "";

  // Refusals: one service per label, one receiver per port.
  if (existsSync(file) || managerState(env).loaded) {
    env.err(
      `${prefix}a service is already installed (${tilde(file, env.home)}); \`sessionpipe-gui service status\` shows it, \`service uninstall\` removes it`,
    );
    return 1;
  }
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
  const logPath = path.join(state, SERVICE_LOG);
  const envVars = { PATH: servicePath(env.node) };
  const text =
    env.platform === "darwin"
      ? launchAgentPlist({ label: env.label, argv, env: envVars, logPath, workingDirectory: state })
      : systemdUnit({
          description: "sessionpipe-gui (the board: a sessionpipe receiver)",
          argv,
          env: envVars,
          logPath,
          workingDirectory: state,
        });
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
      env.err(
        `${c.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`} (nothing installed)`,
      );
      return 1;
    }
  }
  env.out(`installed ${env.label} (${tilde(file, env.home)})`);

  if (env.waitMs > 0) {
    const until = Date.now() + env.waitMs;
    while (Date.now() < until) {
      if ((await env.probe(port)) === "gui") {
        env.out(`running on http://127.0.0.1:${port} · state ${tilde(state, env.home)}`);
        return 0;
      }
      await sleep(200);
    }
    env.out(
      `not answering on :${port} after ${Math.round(env.waitMs / 1000)} s; it keeps trying: see ${tilde(logPath, env.home)}`,
    );
    return 0;
  }
  env.out(`starting on http://127.0.0.1:${port} · state ${tilde(state, env.home)}`);
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
  if (managerState(env).loaded) {
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
