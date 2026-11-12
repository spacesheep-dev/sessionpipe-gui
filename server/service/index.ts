// SPDX-License-Identifier: Apache-2.0
// Owned by: packaging. `sessionpipe-gui service install|uninstall|status`: the receiver as a
// per-user background service, so it runs at login and outlives any window (the desktop
// app's "Start sessionpipe" runs `service install`). macOS: a LaunchAgent bootstrapped into
// gui/<uid>. Linux: a systemd --user unit. Windows: a scheduled task at this user's logon
// (windows.ts), under \\sessionpipe\\ in Task Scheduler.
//
// `install` finds a service of ours already there (every app upgrade does: the plist
// names the cli of the version that installed it) and upgrades it in place: the same port,
// state dir and options unless flags say otherwise, the new node and cli, a restart, and a
// wait until the receiver answers with the new version. A service whose file is already
// this one but whose receiver answers with another version is restarted too: the package
// was replaced under it (`npm i -g` over the same prefix) and the process still runs the
// old code. An older sessionpipe-gui does not put itself in place of a newer one that runs
// from elsewhere unless `--downgrade` says so. A plist under our label that runs
// something else is left alone. `--if-installed` (the desktop app's own check on launch)
// only ever upgrades: with no service of ours there it does nothing.
//
// Everything outside the process (the platform, HOME, the uid, launchctl / systemctl, the
// port probe) comes in through `ServiceEnv`, so tests run against a temp HOME and a fake
// launchctl (`SP_LAUNCHCTL`, `SP_SYSTEMCTL`, `SP_SCHTASKS`, `SP_TASKKILL`, `SP_POWERSHELL`)
// and never touch the real session.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT } from "../../shared/api.js";
import { compareVersions } from "../../shared/version.js";
import { packageVersion } from "../config.js";
import { pidAlive, readRunFile, readRunFileRaw, removeRunFile, runFilePath } from "../runfile.js";
import { launchAgentPath, launchAgentPlist, parseLaunchctlPrint, plistArgv } from "./launchd.js";
import { parseSystemctlShow, systemdUnit, unitArgv, unitName, unitPath } from "./systemd.js";
import {
  isReceiverCommandLine,
  parseTaskQuery,
  processQueryScript,
  system32,
  TASK_RUNNING,
  taskArgv,
  taskFolderRemoveScript,
  taskName,
  taskQueryScript,
  taskXml,
  unsafeWord,
} from "./windows.js";

export const SERVICE_LABEL = "dev.spacesheep.sessionpipe-gui";
export const SERVICE_LOG = "service.log";
/** Where `install` writes the task definition for `schtasks /Create /XML` (then removes it). */
export const TASK_XML = "service-task.xml";

export type Verb = "install" | "uninstall" | "status";
export interface ServiceOptions {
  verb: Verb;
  port?: number;
  host?: string;
  state?: string;
  /** Receiver options after `--`, passed on to the service as they are. */
  extra?: string[];
  dryRun?: boolean;
  /** Let an older sessionpipe-gui replace a newer service that runs from elsewhere. */
  downgrade?: boolean;
  /** Upgrade a service of ours when there is one; never install one. */
  ifInstalled?: boolean;
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
  schtasks: string;
  taskkill: string;
  /** Windows: reads the task and a process's command line back (see windows.ts). */
  powershell: string;
  /** Windows: DOMAIN\\user, whose logon starts the task. */
  user: string;
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

/** The programs `service` runs. On Windows schtasks, taskkill and PowerShell are named in
 *  full, under %SystemRoot%\System32 (windows.ts), never by a bare name; an `SP_*` variable
 *  names a stand-in, as the tests do. */
export function serviceTools(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Pick<ServiceEnv, "launchctl" | "systemctl" | "schtasks" | "taskkill" | "powershell"> {
  const win = platform === "win32";
  return {
    launchctl: env.SP_LAUNCHCTL || "launchctl",
    systemctl: env.SP_SYSTEMCTL || "systemctl",
    schtasks: env.SP_SCHTASKS || (win ? system32(env, "schtasks.exe") : "schtasks"),
    taskkill: env.SP_TASKKILL || (win ? system32(env, "taskkill.exe") : "taskkill"),
    powershell:
      env.SP_POWERSHELL || (win ? system32(env, "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe"),
  };
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
    ...serviceTools(env, process.platform),
    user: env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : os.userInfo().username,
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

const tilde = (p: string, home: string) =>
  p === home || p.startsWith(`${home}/`) || p.startsWith(`${home}\\`) ? `~${p.slice(home.length)}` : p;
/** The last part of a path written with either separator (a Windows argv read on any OS). */
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How a message names a program. On Windows by its file name (`schtasks.exe`), not the full
 *  path it is run by: `--dry-run` shows that one. */
const named = (env: ServiceEnv, cmd: string) => (env.platform === "win32" ? path.win32.basename(cmd) : cmd);
/** The first words of a command, as a message names it. */
const head = (env: ServiceEnv, c: string[]) => [named(env, c[0] ?? ""), ...c.slice(1, 3)].join(" ");

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

/** The plist or unit file; on Windows the task's name (the task lives in Task Scheduler). */
function serviceFile(env: ServiceEnv): string {
  if (env.platform === "darwin") return launchAgentPath(env.home, env.label);
  if (env.platform === "win32") return taskName(env.label);
  return unitPath(env.home, env.label);
}

const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-Command"];

/** Windows: runs a script that may write text to the file it is given (see windows.ts);
 *  `text` is what it wrote, without Out-File's byte-order mark and last line end. */
function powershell(env: ServiceEnv, script: (file: string) => string): ExecResult & { text: string } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sessionpipe-gui-"));
  const file = path.join(tmp, "answer.txt");
  try {
    const r = env.exec(env.powershell, [...POWERSHELL_FLAGS, script(file)]);
    let text = "";
    try {
      text = readFileSync(file, "utf8")
        .replace(/^\uFEFF/, "")
        .trimEnd();
    } catch {}
    return { ...r, text };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Windows: what takes Task Scheduler's \sessionpipe\ folder away once no task is left in
 *  it (another label's can be: SP_SERVICE_LABEL). */
const taskFolderCommand = (env: ServiceEnv): string[] => [
  env.powershell,
  ...POWERSHELL_FLAGS,
  taskFolderRemoveScript(),
];
/** Runs it, after our task is deleted. Best-effort (windows.ts): where the folder can't be
 *  removed it stays, empty, as it did; that fails nothing and nothing is said. */
function removeTaskFolder(env: ServiceEnv): void {
  const c = taskFolderCommand(env);
  env.exec(c[0]!, c.slice(1));
}

/** Task Scheduler didn't answer: nothing is known about the task, so nothing is done to it. */
class TaskQueryError extends Error {}

/** Windows: our task's state and definition; null when there is no such task. */
function queryTask(env: ServiceEnv): { state: number; xml: string } | null {
  const r = powershell(env, (file) => taskQueryScript(env.label, file));
  try {
    if (r.code !== 0) {
      const said = (r.stderr || r.stdout).split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#< CLIXML"));
      throw new Error(said?.trim() || (r.code === 127 ? "it didn't run, or took too long" : `exit ${r.code}`));
    }
    const state = parseTaskQuery(r.stdout);
    if (state === null) return null;
    if (!r.text) throw new Error("it wrote no task definition");
    return { state, xml: r.text };
  } catch (e) {
    throw new TaskQueryError(
      `can't read Task Scheduler through ${named(env, env.powershell)}: ${(e as Error).message}`,
    );
  }
}

/** managerState where the work is already done and only a last look is wanted: an
 *  unreadable Task Scheduler there is not a failure of the verb. */
function managerStateOr(env: ServiceEnv, otherwise: { loaded: boolean; running: boolean }) {
  try {
    return managerState(env);
  } catch (e) {
    if (e instanceof TaskQueryError) return otherwise;
    throw e;
  }
}

function readInstalled(env: ServiceEnv): Installed | null {
  const file = serviceFile(env);
  if (env.platform === "win32") {
    const t = queryTask(env);
    return t ? { file, argv: taskArgv(t.xml) } : null;
  }
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  return { file, argv: env.platform === "darwin" ? plistArgv(text) : unitArgv(text) };
}

/** Where the service file is shown: a path under ~, or the task's name. */
const where = (env: ServiceEnv, file: string) => (env.platform === "win32" ? `task ${file}` : tilde(file, env.home));

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
  if (base(program) === "sessionpipe-gui") return true;
  if (!script) return false;
  if (cli && script === cli) return true;
  return /(^|[\\/])sessionpipe-gui[\\/]dist[\\/]cli\.js$/.test(script) || base(script) === "sessionpipe-gui";
}

/** The CLI an installed service runs: the script node is given, or the sessionpipe-gui bin. */
export function installedCli(argv: string[]): string | undefined {
  return base(argv[0] ?? "") === "sessionpipe-gui" ? argv[0] : argv[1];
}
const realPath = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
/** The package a CLI belongs to: two folders up from `dist/cli.js` (a bin is followed to it).
 *  Undefined for a path that isn't absolute: nothing is looked up from the working directory. */
function packageDir(cli: string): string | undefined {
  if (!path.isAbsolute(cli)) return undefined;
  return path.dirname(path.dirname(realPath(cli)));
}
/** The version in that package's package.json: what the installed file runs, whatever the
 *  process on the port says. Undefined when it can't be read. */
export function packageVersionAt(cli: string): string | undefined {
  const dir = packageDir(cli);
  if (!dir) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    return pkg.name === "sessionpipe-gui" && typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
/** A developer's checkout, not an install: its package folder has the sources (server/cli.ts)
 *  or a .git beside dist/. npm, npx and the installer never put either there. */
export function isCheckout(cli: string): boolean {
  const dir = packageDir(cli);
  if (!dir) return false;
  return existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, "server", "cli.ts"));
}

/** The receiver options an installed service was given: port, state, host, and the rest. */
export function installedOptions(argv: string[]): { port?: number; state?: string; host?: string; extra: string[] } {
  const rest = argv.slice(base(argv[0] ?? "") === "sessionpipe-gui" ? 1 : 2);
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
  if (env.platform === "win32") {
    const t = queryTask(env);
    return t ? { loaded: true, running: t.state === TASK_RUNNING } : { loaded: false, running: false };
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

/** Is pid the service's own receiver? macOS and Linux: the manager's pid for the job (it
 *  starts node itself). Windows: the task starts conhost and cmd, so the pid's command line
 *  is read: the task's cli on the task's state dir. */
function ownsPid(
  env: ServiceEnv,
  mgr: { running: boolean; pid?: number },
  pid: number,
  cli: string,
  state: string,
): boolean {
  if (env.platform !== "win32") return mgr.running && mgr.pid === pid;
  const line = powershell(env, (file) => processQueryScript(pid, file));
  return line.code === 0 && isReceiverCommandLine(line.text, cli, state);
}

/** `launchctl bootout` returns before the job is gone; a bootstrap (or a "still loaded"
 *  verdict) right after it is too early. Polls the manager until the label is unloaded. */
async function waitUnloaded(env: ServiceEnv): Promise<boolean> {
  const until = Date.now() + env.settleMs;
  for (;;) {
    if (!managerStateOr(env, { loaded: true, running: false }).loaded) return true;
    if (Date.now() >= until) return false;
    await sleep(100);
  }
}

/** Run one `service` verb; resolves to the process exit code. */
export async function runService(o: ServiceOptions, env: ServiceEnv): Promise<number> {
  if (env.platform !== "darwin" && env.platform !== "linux" && env.platform !== "win32") {
    env.err(`a background service on ${env.platform} is not here yet: run \`sessionpipe-gui\` in a terminal`);
    return 1;
  }
  try {
    if (o.verb === "install") return await install(o, env);
    if (o.verb === "uninstall") return await uninstall(o, env);
    return await status(env);
  } catch (e) {
    if (!(e instanceof TaskQueryError)) throw e;
    env.err(e.message);
    return 1;
  }
}

const failedCommand = (env: ServiceEnv, c: string[], r: ExecResult) =>
  `${head(env, c)} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`;

/** The file the service runs from. */
function serviceText(env: ServiceEnv, argv: string[], state: string): string {
  const logPath = path.join(state, SERVICE_LOG);
  if (env.platform === "win32") {
    return taskXml({
      description: "sessionpipe-gui (the board: a sessionpipe receiver)",
      user: env.user,
      argv,
      logPath,
      workingDirectory: state,
    });
  }
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
  return managerStateOr(env, { loaded: true, running: false }).running ? "running" : "silent";
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

/** Exit code of an upgrade that stopped the old receiver and whose new one isn't running. */
export const EXIT_NOT_RUNNING = 4;

/** After an upgrade's restart: still loading is fine (exit 0); not running at all is a
 *  failure, and says the old receiver is gone (EXIT_NOT_RUNNING). */
function afterUpgradeWait(env: ServiceEnv, verdict: "running" | "silent", port: number, state: string): number {
  if (verdict === "running") return afterWait(env, verdict, port, state);
  const secs = Math.round(env.waitMs / 1000);
  const log = tilde(path.join(state, SERVICE_LOG), env.home);
  env.err(
    `${env.version} isn't running on :${port} after ${secs} s, and the old receiver was stopped for the update: see ${log}`,
  );
  return EXIT_NOT_RUNNING;
}

/** One `service install` at a time per label: `<default state>/service-<label>.lock`, made
 *  exclusively. A lock whose pid is gone, or older than STALE_LOCK_MS, is a crashed run's and
 *  is taken over. Returns the release, or the line that says who holds it. */
const STALE_LOCK_MS = 15 * 60_000;
export const lockPath = (env: ServiceEnv): string => path.join(env.defaultState, `service-${env.label}.lock`);
function takeLock(env: ServiceEnv): (() => void) | string {
  const file = lockPath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const mine = `${process.pid} ${new Date().toISOString()}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, mine, { flag: "wx", mode: 0o644 });
      return () => {
        try {
          if (readFileSync(file, "utf8") === mine) rmSync(file, { force: true });
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let pid = 0;
    let age = 0;
    try {
      pid = Number.parseInt(readFileSync(file, "utf8"), 10) || 0;
      age = Date.now() - statSync(file).mtimeMs;
    } catch {
      continue; // it went while we looked: try again
    }
    if (pid && pidAlive(pid) && age < STALE_LOCK_MS)
      return `another \`service install\` for ${env.label} is running (pid ${pid}); try again when it is done`;
    rmSync(file, { force: true });
  }
  return `can't take ${tilde(file, env.home)}; try again`;
}

/** `schtasks /Create /XML` reads UTF-16 with a byte-order mark. */
function writeTaskXml(file: string, text: string): void {
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\n/g, "\r\n"), "utf16le")]));
}

/** Windows: ending the task stops conhost, not the receiver under it; the receiver goes by
 *  the pid in its run.json, with its tree. A receiver killed that way leaves its run.json
 *  behind and Windows reuses pids, so the pid is killed only while its command line is the
 *  receiver's: the cli the task runs, on the task's state dir. `left` is a live pid that
 *  couldn't be told to be that receiver, and so was left running. */
function stopTask(env: ServiceEnv, argv: string[], state: string): { commands: string[][]; left?: number } {
  const pid = readRunFileRaw(state)?.pid;
  const line = pid ? powershell(env, (file) => processQueryScript(pid, file)) : undefined;
  const ours = line?.code === 0 && isReceiverCommandLine(line.text, argv[1] ?? "", state);
  return {
    commands: [
      [env.schtasks, "/End", "/TN", taskName(env.label)],
      ...(ours ? [[env.taskkill, "/PID", String(pid), "/T", "/F"]] : []),
    ],
    left: pid && !ours && pidAlive(pid) ? pid : undefined,
  };
}
/** The command to type names taskkill in full, as the ones `service` runs itself do. */
const leftRunning = (env: ServiceEnv, pid: number, state: string): string =>
  `pid ${pid} (${tilde(runFilePath(state), env.home)}) is running, and its command line doesn't show it to be this service's receiver: left alone. If it is one, stop it yourself (${env.taskkill} /PID ${pid} /T /F)`;
/** The receiver we killed never got to remove its run.json: remove it, if it is still that one. */
function afterStop(env: ServiceEnv, c: string[], r: ExecResult, state: string): void {
  if (c[0] === env.taskkill && r.code === 0) removeRunFile(state, Number(c[2]));
}
/** Windows: every word of the task's command line goes through conhost and cmd as it is. */
function taskCarries(env: ServiceEnv, argv: string[], state: string, dryRun?: boolean): boolean {
  if (env.platform !== "win32") return true;
  const bad = unsafeWord([...argv, path.join(state, SERVICE_LOG)]);
  if (bad === undefined) return true;
  env.err(
    `${dryRun ? "would refuse: " : ""}the scheduled task can't carry ${JSON.stringify(bad)} (a quote, & | < > ^ or %); choose another --state or option`,
  );
  return false;
}
const isStop = (env: ServiceEnv, c: string[]) => c[0] === env.taskkill || (c[0] === env.schtasks && c[1] === "/End");

/** `install` under the label's lock (a dry run changes nothing and takes none). */
async function install(o: ServiceOptions, env: ServiceEnv): Promise<number> {
  if (o.dryRun) return installUnlocked(o, env);
  const release = takeLock(env);
  if (typeof release === "string") {
    env.err(release);
    return 1;
  }
  try {
    return await installUnlocked(o, env);
  } finally {
    release();
  }
}

async function installUnlocked(o: ServiceOptions, env: ServiceEnv): Promise<number> {
  const file = serviceFile(env);
  const prefix = o.dryRun ? "would refuse: " : "";

  // A service under our label already: ours is upgraded in place; anything else is refused.
  const inst = readInstalled(env);
  const loaded = inst !== null || managerState(env).loaded;
  if (!loaded && o.ifInstalled) {
    env.out(`no service ${env.label} installed: nothing to do`);
    return 0;
  }
  if (loaded) {
    if (inst && isOurs(inst.argv, env.cli)) return upgrade(o, env, inst);
    env.err(
      inst
        ? `${prefix}a service is already installed under ${env.label} (${where(env, file)}), and it isn't sessionpipe-gui's: it runs ${inst.argv[0] ?? "nothing"}; \`service uninstall\` removes it`
        : `${prefix}a service is already installed (${where(env, file)}); \`sessionpipe-gui service status\` shows it, \`service uninstall\` removes it`,
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
  if (!taskCarries(env, argv, state, o.dryRun)) return 1;
  const text = serviceText(env, argv, state);
  // Windows: the definition goes through a file in the state dir, then into Task Scheduler.
  const xmlFile = path.join(state, TASK_XML);
  const commands: string[][] =
    env.platform === "darwin"
      ? [[env.launchctl, "bootstrap", `gui/${env.uid}`, file]]
      : env.platform === "win32"
        ? [
            [env.schtasks, "/Create", "/TN", file, "/XML", xmlFile, "/F"],
            [env.schtasks, "/Run", "/TN", file],
          ]
        : [
            [env.systemctl, "--user", "daemon-reload"],
            [env.systemctl, "--user", "enable", "--now", unitName(env.label)],
          ];

  if (o.dryRun) {
    env.out(`# ${env.platform === "win32" ? xmlFile : file}`);
    env.out(text.trimEnd());
    env.out("");
    for (const c of commands) env.out(`$ ${c.join(" ")}`);
    env.out("");
    env.out(
      `dry run: nothing written or started; it would serve http://127.0.0.1:${port} from ${tilde(state, env.home)}`,
    );
    return 0;
  }

  mkdirSync(state, { recursive: true });
  if (env.platform === "win32") writeTaskXml(xmlFile, text);
  else {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, { mode: 0o644 });
  }
  for (const c of commands) {
    const r = env.exec(c[0]!, c.slice(1));
    if (r.code !== 0) {
      if (env.platform === "win32") {
        if (c[1] !== "/Create") env.exec(env.schtasks, ["/Delete", "/TN", file, "/F"]);
        removeTaskFolder(env);
        rmSync(xmlFile, { force: true });
      } else rmSync(file, { force: true });
      if (env.platform === "linux") env.exec(env.systemctl, ["--user", "daemon-reload"]);
      env.err(`${failedCommand(env, c, r)} (nothing installed)`);
      return 1;
    }
  }
  if (env.platform === "win32") rmSync(xmlFile, { force: true });
  env.out(`installed ${env.label} (${where(env, file)})`);

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
  const prefix = o.dryRun ? "would refuse: " : "";
  const wasState = path.resolve(was.state ?? env.defaultState);
  const instCli = installedCli(inst.argv);
  // The file runs this very CLI (by its real path), or another one.
  const sameCli = instCli !== undefined && realPath(instCli) === env.cli;
  // A developer's checkout is theirs to update: a release never takes its place unasked.
  if (!sameCli && instCli && isCheckout(instCli)) {
    env.err(
      `${prefix}${env.label} runs a development checkout (${tilde(packageDir(instCli) ?? instCli, env.home)}): left as it is. \`service install\` from that checkout updates it; \`service uninstall\` first puts this one in its place`,
    );
    return 1;
  }
  const mgr = managerState(env);
  const answered = who === "gui" ? await env.running(port) : undefined;
  // Is the receiver that answers this service's own? Its run.json (written once, when it
  // starts) names its pid: the manager's pid on macOS and Linux, the task's cli on the
  // task's state dir on Windows. Only then does run.json say what it runs: up to 0.8.0
  // /api/ui/info read package.json on every request, so a receiver whose package was
  // replaced under it answered with the new version while it ran the old code.
  const run = answered !== undefined ? readRunFileRaw(wasState) : null;
  const live = run && run.port === port && pidAlive(run.pid) ? run : null;
  const owned = live !== null && ownsPid(env, mgr, live.pid, instCli ?? "", wasState);
  const running = owned ? live.version : answered;
  // The same file answering with this version: nothing to do.
  if (same && running === env.version) {
    env.out(`already running ${running} on ${url}`);
    return 0;
  }
  // Something answers that isn't this service's receiver (one started by hand, a stale
  // run.json): a restart of the service can't reach it, and would only fight it for the port.
  if (answered !== undefined && !owned) {
    env.err(
      `${prefix}a sessionpipe-gui ${answered} answers on :${port}, and it isn't ${env.label}'s receiver (${
        mgr.running
          ? mgr.pid
            ? `the service's is pid ${mgr.pid}`
            : "the service runs another process"
          : "the service isn't running"
      }): left as it is. Stop that one, then \`service install\` again`,
    );
    return 1;
  }
  // The same service, up but not answering yet (a big board loading): leave it to it.
  if (same && running === undefined && mgr.running && !o.dryRun) {
    env.out(`already installed ${env.label}; it is starting`);
    if (env.waitMs > 0) {
      const verdict = await waitForReceiver(env, { port, state, version: env.version });
      if (verdict !== "answered") return afterWait(env, verdict, port, state);
    }
    env.out(`running ${env.version} on ${url} · state ${tilde(state, env.home)}`);
    return 0;
  }
  // With the same CLI's files and another version answering, the process is a stale one
  // (the package was replaced under it): it is restarted below, whichever way it differs.
  const from = running ?? readRunFileRaw(wasState)?.version;
  // What the installed file runs: the package.json beside its cli, else what last ran.
  const installed = (instCli && packageVersionAt(instCli)) || from;
  const change = `${env.label}: ${from && from !== env.version ? `${from} → ` : ""}${env.version}`;
  // --if-installed (the app's check) only ever moves a service forward.
  const newest = [from, installed]
    .filter((v): v is string => !!v)
    .sort(compareVersions)
    .at(-1);
  if (o.ifInstalled && newest && compareVersions(newest, env.version) > 0) {
    env.out(`${env.label} runs ${newest}, newer than this sessionpipe-gui (${env.version}): left as it is`);
    return 0;
  }
  // Another CLI in the file, at a newer version than this one: putting this one there is
  // a downgrade, done only when asked for.
  if (!sameCli && installed && compareVersions(installed, env.version) > 0 && !o.downgrade) {
    env.err(
      `${prefix}${env.label} runs ${installed}, newer than this sessionpipe-gui (${env.version}): left as it is. \`service install\` from ${installed} or later keeps it; --downgrade puts ${env.version} in its place`,
    );
    return 1;
  }

  if (!taskCarries(env, argv, state, o.dryRun)) return 1;
  const text = serviceText(env, argv, state);
  const xmlFile = path.join(state, TASK_XML);
  const stop = env.platform === "win32" ? stopTask(env, inst.argv, was.state ?? env.defaultState) : undefined;
  const commands: string[][] =
    env.platform === "darwin"
      ? [
          ...(mgr.loaded ? [[env.launchctl, "bootout", `gui/${env.uid}/${env.label}`]] : []),
          [env.launchctl, "bootstrap", `gui/${env.uid}`, inst.file],
        ]
      : env.platform === "win32"
        ? [
            [env.schtasks, "/Create", "/TN", inst.file, "/XML", xmlFile, "/F"],
            ...stop!.commands,
            [env.schtasks, "/Run", "/TN", inst.file],
          ]
        : [
            [env.systemctl, "--user", "daemon-reload"],
            [env.systemctl, "--user", "restart", unitName(env.label)],
          ];

  if (o.dryRun) {
    env.out(`# ${env.platform === "win32" ? xmlFile : inst.file}`);
    env.out(text.trimEnd());
    env.out("");
    for (const c of commands) env.out(`$ ${c.join(" ")}`);
    env.out("");
    if (stop?.left) env.out(leftRunning(env, stop.left, was.state ?? env.defaultState));
    env.out(`dry run: nothing written or restarted; it would update ${change} on ${url}`);
    return 0;
  }

  env.out(`updating ${change}`);
  mkdirSync(state, { recursive: true });
  if (env.platform === "win32") writeTaskXml(xmlFile, text);
  else writeFileSync(inst.file, text, { mode: 0o644 });
  for (const c of commands) {
    const r = env.exec(c[0]!, c.slice(1));
    afterStop(env, c, r, was.state ?? env.defaultState);
    // Stopping what isn't running fails, and is fine: on Windows ending a task that isn't
    // running; on macOS booting out a job launchd no longer has ("No such process").
    const notLoaded =
      c[1] === "bootout" && r.code !== 0 && !managerStateOr(env, { loaded: true, running: false }).loaded;
    if (r.code !== 0 && !isStop(env, c) && !notLoaded) {
      if (env.platform === "win32") rmSync(xmlFile, { force: true });
      env.err(
        `${failedCommand(env, c, r)} (${where(env, inst.file)} is rewritten; \`service uninstall\` then \`service install\` starts over)`,
      );
      return 1;
    }
    // launchd lets go of the old job a moment after bootout; bootstrapping before that fails.
    if (c[1] === "bootout" && !(await waitUnloaded(env))) {
      env.err(`${env.label} is still loaded after bootout; try again`);
      return 1;
    }
  }
  if (env.platform === "win32") rmSync(xmlFile, { force: true });
  env.out(`updated ${change} (${where(env, inst.file)})`);
  if (stop?.left) env.err(leftRunning(env, stop.left, was.state ?? env.defaultState));

  if (env.waitMs > 0) {
    const verdict = await waitForReceiver(env, { port, state, version: env.version });
    if (verdict !== "answered") return afterUpgradeWait(env, verdict, port, state);
    env.out(`running ${env.version} on ${url} · state ${tilde(state, env.home)}`);
    return 0;
  }
  env.out(`starting on ${url} · state ${tilde(state, env.home)}`);
  return 0;
}

async function uninstall(o: ServiceOptions, env: ServiceEnv): Promise<number> {
  const file = serviceFile(env);
  const st = managerState(env);
  const inst = env.platform === "win32" ? readInstalled(env) : null;
  const has = env.platform === "win32" ? st.loaded : existsSync(file);
  const wasState = (inst && installedOptions(inst.argv).state) || env.defaultState;
  if (!has && !st.loaded) {
    // An uninstall by 0.8.0 left the task folder behind, empty: it goes now.
    if (env.platform === "win32" && !o.dryRun) removeTaskFolder(env);
    env.out(`no service ${env.label} installed: nothing to do`);
    return 0;
  }
  const stop = env.platform === "win32" ? stopTask(env, inst?.argv ?? [], wasState) : undefined;
  const commands: string[][] =
    env.platform === "darwin"
      ? st.loaded
        ? [[env.launchctl, "bootout", `gui/${env.uid}/${env.label}`]]
        : []
      : env.platform === "win32"
        ? [...stop!.commands, [env.schtasks, "/Delete", "/TN", file, "/F"]]
        : [[env.systemctl, "--user", "disable", "--now", unitName(env.label)]];
  if (o.dryRun) {
    for (const c of commands) env.out(`$ ${c.join(" ")}`);
    if (has && env.platform !== "win32") env.out(`$ rm ${file}`);
    if (env.platform === "linux") env.out(`$ ${env.systemctl} --user daemon-reload`);
    if (env.platform === "win32") env.out(`$ ${taskFolderCommand(env).join(" ")}`);
    if (stop?.left) env.out(leftRunning(env, stop.left, wasState));
    env.out("dry run: nothing stopped or removed");
    return 0;
  }
  let failed = "";
  for (const c of commands) {
    const r = env.exec(c[0]!, c.slice(1));
    afterStop(env, c, r, wasState);
    if (r.code !== 0 && !isStop(env, c))
      failed = `${head(env, c)}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`;
  }
  if (env.platform !== "win32") rmSync(file, { force: true });
  if (env.platform === "linux") env.exec(env.systemctl, ["--user", "daemon-reload"]);
  if (!(await waitUnloaded(env))) {
    env.err(
      `${env.label} is still loaded${failed ? ` (${failed})` : ""}; try again, or ${
        env.platform === "win32"
          ? `\`${env.schtasks} /Delete /TN ${file} /F\``
          : `\`${env.launchctl} bootout gui/${env.uid}/${env.label}\``
      }`,
    );
    return 1;
  }
  if (env.platform === "win32") removeTaskFolder(env);
  if (stop?.left) {
    env.out(`removed ${env.label}: it won't start at login`);
    env.err(leftRunning(env, stop.left, wasState));
    return 0;
  }
  env.out(`removed ${env.label}: stopped, and it won't start at login`);
  return 0;
}

async function status(env: ServiceEnv): Promise<number> {
  const inst = readInstalled(env);
  const st = managerState(env);
  const manager =
    env.platform === "darwin" ? "launchd" : env.platform === "win32" ? "Task Scheduler" : "systemd --user";
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
  if (inst)
    env.out(`${env.platform === "win32" ? "task" : "file"}      ${where(env, inst.file).replace(/^task /, "")}`);
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
