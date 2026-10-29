// SPDX-License-Identifier: Apache-2.0
// `service install|uninstall|status` against a temp HOME and a fake launchctl / systemctl
// (a shell script that logs its arguments): nothing here reaches the real session.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeRunFile } from "../runfile.js";
import {
  installedOptions,
  isOurs,
  type Probe,
  processEnv,
  runService,
  SERVICE_LABEL,
  type ServiceEnv,
  servicePath,
} from "./index.js";
import { launchAgentPath, launchAgentPlist, parseLaunchctlPrint, plistArgv } from "./launchd.js";
import { parseSystemctlShow, systemdUnit, unitArgv, unitPath } from "./systemd.js";

let dir: string;
let home: string;
let log: string;
let out: string[];
let errs: string[];

/** A fake launchctl / systemctl: logs "<argv>" to $FAKE_LOG; `print`/`show` succeed only
 *  while $FAKE_LOADED exists, and print $FAKE_PRINT; `bootstrap`/`enable` create the
 *  marker, `bootout`/`disable` remove it (after 300 ms when $FAKE_SLOW_BOOTOUT is set, as
 *  launchd lets go of a job a moment after bootout returns); $FAKE_FAIL names a verb that
 *  exits 5. */
function fakeTool(name: string): string {
  const p = path.join(dir, name);
  writeFileSync(
    p,
    `#!/bin/sh
echo "$*" >> "${log}"
verb="$1"; [ "$1" = "--user" ] && verb="$2"
[ -n "$FAKE_FAIL" ] && [ "$verb" = "$FAKE_FAIL" ] && { echo "boom: $verb" >&2; exit 5; }
case "$verb" in
  print|show) [ -f "${dir}/loaded" ] || { echo "Could not find service" >&2; exit 113; }; cat "${dir}/print" 2>/dev/null; exit 0;;
  bootstrap|enable) touch "${dir}/loaded";;
  bootout|disable) if [ -n "$FAKE_SLOW_BOOTOUT" ]; then (sleep 0.3; rm -f "${dir}/loaded") & else rm -f "${dir}/loaded"; fi;;
esac
exit 0
`,
  );
  chmodSync(p, 0o755);
  return p;
}

type Version = string | undefined;
/** `probe` and `running` answer from their lists in turn, repeating the last answer. */
function env(over: Partial<ServiceEnv> = {}, probe: Probe | Probe[] = null, running: Version | Version[] = undefined) {
  const probes = Array.isArray(probe) ? [...probe] : [probe];
  const versions = Array.isArray(running) ? [...running] : [running];
  return {
    platform: "darwin",
    home,
    uid: 501,
    label: SERVICE_LABEL,
    launchctl: fakeTool("launchctl"),
    systemctl: fakeTool("systemctl"),
    node: "/opt/homebrew/Cellar/node/23.6.1/bin/node",
    cli: "/opt/homebrew/lib/node_modules/sessionpipe-gui/dist/cli.js",
    defaultState: path.join(home, ".local", "state", "sessionpipe-gui"),
    version: "0.6.0",
    exec: (cmd, args) => {
      const r = spawnSync(cmd, args, {
        encoding: "utf8",
        env: { ...process.env, FAKE_FAIL: failVerb, FAKE_SLOW_BOOTOUT: slowBootout ? "1" : "" },
      });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    probe: async () => (probes.length > 1 ? probes.shift()! : probes[0]!),
    running: async () => (versions.length > 1 ? versions.shift() : versions[0]),
    waitMs: 0,
    settleMs: 1000,
    out: (s) => out.push(s),
    err: (s) => errs.push(s),
    ...over,
  } satisfies ServiceEnv;
}
let failVerb = "";
let slowBootout = false;
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "spgui-service-"));
  home = path.join(dir, "home");
  log = path.join(dir, "calls.log");
  out = [];
  errs = [];
  failVerb = "";
  slowBootout = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the LaunchAgent plist", () => {
  const spec = {
    label: SERVICE_LABEL,
    argv: ["/usr/local/bin/node", "/x/cli.js", "--port", "7373", "--state", "/s & <t>", "--quiet"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    logPath: "/s/service.log",
    workingDirectory: "/s",
  };

  it("runs at load, keeps alive, logs to the state dir, and escapes XML", () => {
    const text = launchAgentPlist(spec);
    expect(text).toContain("<key>Label</key>\n\t<string>dev.spacesheep.sessionpipe-gui</string>");
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(text).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(text).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/s\/service.log<\/string>/);
    expect(text).toMatch(/<key>StandardErrorPath<\/key>\s*<string>\/s\/service.log<\/string>/);
    expect(text).toContain("<string>/s &amp; &lt;t&gt;</string>");
    expect(plistArgv(text)).toEqual(spec.argv);
  });

  it.runIf(process.platform === "darwin")("is a valid plist (plutil -lint)", () => {
    const f = path.join(dir, "a.plist");
    writeFileSync(f, launchAgentPlist(spec));
    const r = spawnSync("plutil", ["-lint", f], { encoding: "utf8" });
    expect(r.stdout).toContain("OK");
  });

  it("reads launchctl print", () => {
    expect(parseLaunchctlPrint("\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n")).toEqual({
      running: true,
      pid: 4242,
      lastExit: 0,
    });
    expect(parseLaunchctlPrint("\tstate = waiting\n\tlast exit code = 1\n")).toEqual({ running: false, lastExit: 1 });
  });
});

describe("the systemd unit", () => {
  it("quotes every word and reads them back", () => {
    const argv = ["/usr/bin/node", "/x y/cli.js", "--state", '/s/"q"/50%'];
    const text = systemdUnit({
      description: "d",
      argv,
      env: { PATH: "/a:/b" },
      logPath: "/s/service.log",
      workingDirectory: "/s",
    });
    expect(text).toContain("Restart=always");
    expect(text).toContain("WantedBy=default.target");
    expect(text).toContain("StandardOutput=append:/s/service.log");
    expect(text).toContain('Environment="PATH=/a:/b"');
    expect(unitArgv(text)).toEqual(argv);
    expect(parseSystemctlShow("LoadState=loaded\nActiveState=active\nMainPID=77\n")).toEqual({
      running: true,
      pid: 77,
    });
  });
});

describe("service install (macOS)", () => {
  it("writes the LaunchAgent with absolute node and cli and bootstraps it into gui/<uid>", async () => {
    const e = env();
    const state = path.join(dir, "state");
    expect(await runService({ verb: "install", port: 7829, state, extra: ["--demo", "--no-outbox"] }, e)).toBe(0);
    const file = launchAgentPath(home, SERVICE_LABEL);
    const text = readFileSync(file, "utf8");
    expect(plistArgv(text)).toEqual([
      e.node,
      e.cli,
      "--port",
      "7829",
      "--state",
      state,
      "--quiet",
      "--demo",
      "--no-outbox",
    ]);
    expect(text).toContain(`<string>${path.join(state, "service.log")}</string>`);
    expect(text).toContain(`<string>${servicePath(e.node)}</string>`);
    expect(calls()).toContain(`bootstrap gui/501 ${file}`);
    expect(existsSync(state)).toBe(true);
    expect(out.join("\n")).toContain("installed dev.spacesheep.sessionpipe-gui");
  });

  it("waits for the receiver to answer", async () => {
    const e = env({ waitMs: 2000 }, null, [undefined, undefined, "0.6.0"]);
    expect(await runService({ verb: "install", port: 7829, state: path.join(dir, "s") }, e)).toBe(0);
    expect(out.join("\n")).toContain("running on http://127.0.0.1:7829");
  });

  it("--dry-run prints the plist and the command and writes nothing", async () => {
    const e = env();
    expect(await runService({ verb: "install", port: 7828, state: path.join(dir, "s"), dryRun: true }, e)).toBe(0);
    expect(existsSync(launchAgentPath(home, SERVICE_LABEL))).toBe(false);
    expect(existsSync(path.join(dir, "s"))).toBe(false);
    expect(out.join("\n")).toContain("<key>KeepAlive</key>");
    expect(out.join("\n")).toContain(`$ ${e.launchctl} bootstrap gui/501`);
    expect(calls().filter((c) => c.startsWith("bootstrap"))).toEqual([]);
  });

  it("refuses when a sessionpipe-gui already answers on the port", async () => {
    expect(await runService({ verb: "install", port: 7829 }, env({}, "gui"))).toBe(1);
    expect(errs.join("\n")).toContain("already answers on :7829");
    expect(existsSync(launchAgentPath(home, SERVICE_LABEL))).toBe(false);
  });

  it("refuses when something else holds the port", async () => {
    expect(await runService({ verb: "install", port: 7829 }, env({}, "other"))).toBe(1);
    expect(errs.join("\n")).toContain("port 7829 is in use by another program");
  });

  it("refuses when the label is loaded without a file (nothing says whose it is)", async () => {
    const e = env();
    expect(await runService({ verb: "install", port: 7829, state: path.join(dir, "s") }, e)).toBe(0);
    rmSync(launchAgentPath(home, SERVICE_LABEL));
    expect(await runService({ verb: "install", port: 7830 }, e)).toBe(1);
    expect(errs.join("\n")).toContain("a service is already installed");
    expect(existsSync(launchAgentPath(home, SERVICE_LABEL))).toBe(false);
  });

  it("says a slow receiver is still starting (exit 0), and one that isn't running keeps trying", async () => {
    writeFileSync(path.join(dir, "print"), "\tstate = running\n\tpid = 4242\n");
    const e = env({ waitMs: 300 });
    expect(await runService({ verb: "install", port: 7829, state: path.join(dir, "s") }, e)).toBe(0);
    expect(out.join("\n")).toContain("starting on :7829… a big board takes a minute");
    expect(out.at(-1)).toMatch(/^still starting on :7829 after 0 s; it keeps going \(.*service\.log\)$/);
    writeFileSync(path.join(dir, "print"), "\tstate = waiting\n\tlast exit code = 1\n");
    out = [];
    expect(await runService({ verb: "install", port: 7829, state: path.join(dir, "s") }, e)).toBe(0);
    expect(out.at(-1)).toContain("not answering on :7829 after 0 s; it keeps trying");
  });

  it("removes the plist again when bootstrap fails", async () => {
    failVerb = "bootstrap";
    expect(await runService({ verb: "install", port: 7829, state: path.join(dir, "s") }, env())).toBe(1);
    expect(existsSync(launchAgentPath(home, SERVICE_LABEL))).toBe(false);
    expect(errs.join("\n")).toMatch(/bootstrap gui\/501 failed: boom: bootstrap \(nothing installed\)/);
  });

  it("uses the label from SP_SERVICE_LABEL and the tools from SP_LAUNCHCTL / SP_SYSTEMCTL", () => {
    const saved = { ...process.env };
    try {
      process.env.SP_SERVICE_LABEL = "dev.spacesheep.sessionpipe-gui.test-7829";
      process.env.SP_LAUNCHCTL = "/fake/launchctl";
      process.env.SP_SYSTEMCTL = "/fake/systemctl";
      const e = processEnv("/d");
      expect(e.label).toBe("dev.spacesheep.sessionpipe-gui.test-7829");
      expect(e.launchctl).toBe("/fake/launchctl");
      expect(e.systemctl).toBe("/fake/systemctl");
      expect(e.node).toBe(process.execPath);
    } finally {
      process.env = saved;
    }
  });
});

/** The plist an earlier version's `service install` left: its node, its npx-cached cli. */
const OLD_NODE = "/usr/local/bin/node";
const OLD_CLI = "/Users/m/.npm/_npx/f2e0e9d72c6b5f2d/node_modules/sessionpipe-gui/dist/cli.js";
function oldPlist(argvRest: string[], state: string): string {
  const file = launchAgentPath(home, SERVICE_LABEL);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    launchAgentPlist({
      label: SERVICE_LABEL,
      argv: [OLD_NODE, OLD_CLI, ...argvRest],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      logPath: path.join(state, "service.log"),
      workingDirectory: state,
    }),
  );
  writeFileSync(path.join(dir, "loaded"), "");
  writeFileSync(path.join(dir, "print"), "\tstate = running\n\tpid = 4242\n");
  return file;
}

describe("service install upgrades a service of ours in place", () => {
  it("tells ours from someone else's under our label", () => {
    expect(isOurs([OLD_NODE, OLD_CLI, "--port", "7373"])).toBe(true);
    expect(isOurs(["/opt/homebrew/bin/sessionpipe-gui", "--port", "7373"])).toBe(true);
    expect(isOurs(["/usr/local/bin/node", "/Users/m/.local/lib/sessionpipe-gui/bin/sessionpipe-gui"])).toBe(true);
    expect(isOurs(["/usr/bin/python3", "/Users/m/own/server.py"])).toBe(false);
    expect(isOurs(["/usr/local/bin/node", "/Users/m/sessionpipe-gui-fork/dist/cli.js"])).toBe(false);
    expect(isOurs([])).toBe(false);
    expect(isOurs(["/usr/local/bin/node", "/Users/m/src/gui/dist/cli.js"])).toBe(false);
    expect(isOurs(["/usr/local/bin/node", "/Users/m/src/gui/dist/cli.js"], "/Users/m/src/gui/dist/cli.js")).toBe(true);
    expect(
      installedOptions([
        OLD_NODE,
        OLD_CLI,
        "--port",
        "7373",
        "--state",
        "/s",
        "--quiet",
        "--host",
        "0.0.0.0",
        "--demo",
      ]),
    ).toEqual({
      port: 7373,
      state: "/s",
      host: "0.0.0.0",
      extra: ["--demo"],
    });
    expect(installedOptions(["/opt/homebrew/bin/sessionpipe-gui", "--quiet"])).toEqual({ extra: [] });
  });

  it("rewrites the old plist with this node and cli, keeps its options, restarts it and waits for the new version", async () => {
    const state = path.join(dir, "state");
    mkdirSync(path.join(state, "events", "claude-code"), { recursive: true });
    writeFileSync(path.join(state, "events", "claude-code", "a.jsonl"), "");
    writeFileSync(path.join(state, "events", "claude-code", "b.jsonl"), "");
    const file = oldPlist(["--port", "7373", "--state", state, "--quiet", "--demo"], state);
    const e = env({ waitMs: 3000 }, "gui", ["0.4.1", undefined, "0.4.1", "0.6.0"]);
    expect(await runService({ verb: "install", port: 7373 }, e)).toBe(0);
    expect(plistArgv(readFileSync(file, "utf8"))).toEqual([
      e.node,
      e.cli,
      "--port",
      "7373",
      "--state",
      state,
      "--quiet",
      "--demo",
    ]);
    const c = calls().filter((l) => !l.startsWith("print"));
    expect(c).toEqual([`bootout gui/501/${SERVICE_LABEL}`, `bootstrap gui/501 ${file}`]);
    expect(out).toContain("updating dev.spacesheep.sessionpipe-gui: 0.4.1 → 0.6.0");
    expect(out).toContain(
      `updated dev.spacesheep.sessionpipe-gui: 0.4.1 → 0.6.0 (~/Library/LaunchAgents/${SERVICE_LABEL}.plist)`,
    );
    expect(out).toContain("starting on :7373… 2 sessions to load; a big board takes a minute");
    expect(out.at(-1)).toBe(`running 0.6.0 on http://127.0.0.1:7373 · state ${state}`);
    expect(errs).toEqual([]);
  });

  it("takes the old version from run.json when the old receiver isn't answering, and flags over the old options", async () => {
    const state = path.join(dir, "state");
    const file = oldPlist(["--port", "7373", "--state", state, "--quiet"], state);
    writeRunFile(state, { port: 7373, pid: 999_999, version: "0.4.1", url: "http://127.0.0.1:7373", startedAt: "x" });
    rmSync(path.join(dir, "loaded")); // installed, not loaded: no bootout
    const e = env({}, null);
    expect(await runService({ verb: "install", port: 7374, host: "0.0.0.0" }, e)).toBe(0);
    expect(plistArgv(readFileSync(file, "utf8"))).toEqual([
      e.node,
      e.cli,
      "--port",
      "7374",
      "--state",
      state,
      "--quiet",
      "--host",
      "0.0.0.0",
    ]);
    expect(calls().filter((l) => !l.startsWith("print"))).toEqual([`bootstrap gui/501 ${file}`]);
    expect(out).toContain(
      "updated dev.spacesheep.sessionpipe-gui: 0.4.1 → 0.6.0 (~/Library/LaunchAgents/dev.spacesheep.sessionpipe-gui.plist)",
    );
    expect(out.at(-1)).toBe(`starting on http://127.0.0.1:7374 · state ${state}`);
  });

  it("is idempotent: the same argv answering is already running", async () => {
    const e = env({}, [null, "gui"], "0.6.0");
    const state = path.join(dir, "s");
    expect(await runService({ verb: "install", port: 7829, state }, e)).toBe(0);
    const file = launchAgentPath(home, SERVICE_LABEL);
    const before = readFileSync(file, "utf8");
    out = [];
    expect(await runService({ verb: "install", port: 7829, state }, e)).toBe(0);
    expect(out).toEqual(["already running 0.6.0 on http://127.0.0.1:7829"]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(calls().filter((l) => l.startsWith("bootout"))).toEqual([]);
  });

  it("leaves the same service alone while it is still starting, and waits for it", async () => {
    const e = env({ waitMs: 2000 }, null, [undefined, undefined, "0.6.0"]);
    const state = path.join(dir, "s");
    expect(await runService({ verb: "install", port: 7829, state }, e)).toBe(0);
    writeFileSync(path.join(dir, "print"), "\tstate = running\n\tpid = 4242\n");
    out = [];
    expect(await runService({ verb: "install", port: 7829, state }, e)).toBe(0);
    expect(out[0]).toBe("already installed dev.spacesheep.sessionpipe-gui; it is starting");
    expect(out.at(-1)).toBe(`running 0.6.0 on http://127.0.0.1:7829 · state ${state}`);
    expect(calls().filter((l) => l.startsWith("bootout") || l.startsWith("bootstrap"))).toEqual([
      `bootstrap gui/501 ${launchAgentPath(home, SERVICE_LABEL)}`,
    ]);
  });

  it("refuses a plist under our label that runs something else, and leaves it alone", async () => {
    const file = launchAgentPath(home, SERVICE_LABEL);
    mkdirSync(path.dirname(file), { recursive: true });
    const theirs = launchAgentPlist({
      label: SERVICE_LABEL,
      argv: ["/usr/bin/python3", "/Users/m/own/server.py"],
      env: {},
      logPath: "/tmp/x.log",
      workingDirectory: "/tmp",
    });
    writeFileSync(file, theirs);
    expect(await runService({ verb: "install", port: 7829 }, env())).toBe(1);
    expect(errs.join("\n")).toContain("isn't sessionpipe-gui's: it runs /usr/bin/python3");
    expect(readFileSync(file, "utf8")).toBe(theirs);
    expect(calls().filter((l) => !l.startsWith("print"))).toEqual([]);
  });

  it("keeps the port refusal when something else holds the port the service had", async () => {
    const state = path.join(dir, "state");
    oldPlist(["--port", "7373", "--state", state, "--quiet"], state);
    expect(await runService({ verb: "install" }, env({}, "other"))).toBe(1);
    expect(errs.join("\n")).toContain("port 7373 is in use by another program");
  });

  it("--dry-run prints the new plist and the restart and changes nothing", async () => {
    const state = path.join(dir, "state");
    const file = oldPlist(["--port", "7373", "--state", state, "--quiet"], state);
    const before = readFileSync(file, "utf8");
    const e = env({}, "gui", "0.4.1");
    expect(await runService({ verb: "install", dryRun: true }, e)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    const text = out.join("\n");
    expect(text).toContain(`<string>${e.cli}</string>`);
    expect(text).toContain(`$ ${e.launchctl} bootout gui/501/${SERVICE_LABEL}`);
    expect(text).toContain(`$ ${e.launchctl} bootstrap gui/501 ${file}`);
    expect(out.at(-1)).toBe(
      "dry run: nothing written or restarted; it would update dev.spacesheep.sessionpipe-gui: 0.4.1 → 0.6.0 on http://127.0.0.1:7373",
    );
    expect(calls().filter((l) => !l.startsWith("print"))).toEqual([]);
  });

  it("on Linux: the unit is rewritten, then daemon-reload and restart", async () => {
    const e = env({ platform: "linux" }, "gui", ["0.4.1", "0.6.0"]);
    const state = path.join(dir, "state");
    const file = unitPath(home, SERVICE_LABEL);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      systemdUnit({
        description: "d",
        argv: [
          "/usr/bin/node",
          "/usr/lib/node_modules/sessionpipe-gui/dist/cli.js",
          "--port",
          "7373",
          "--state",
          state,
          "--quiet",
        ],
        env: {},
        logPath: path.join(state, "service.log"),
        workingDirectory: state,
      }),
    );
    writeFileSync(path.join(dir, "loaded"), "");
    expect(await runService({ verb: "install" }, { ...e, waitMs: 1000 })).toBe(0);
    expect(unitArgv(readFileSync(file, "utf8"))).toEqual([
      e.node,
      e.cli,
      "--port",
      "7373",
      "--state",
      state,
      "--quiet",
    ]);
    expect(calls().filter((c) => !c.startsWith("--user show"))).toEqual([
      "--user daemon-reload",
      `--user restart ${SERVICE_LABEL}.service`,
    ]);
    expect(out).toContain(
      "updated dev.spacesheep.sessionpipe-gui: 0.4.1 → 0.6.0 (~/.config/systemd/user/dev.spacesheep.sessionpipe-gui.service)",
    );
  });
});

describe("service uninstall and status (macOS)", () => {
  it("status says not installed (exit 3)", async () => {
    expect(await runService({ verb: "status" }, env())).toBe(3);
    expect(out[0]).toContain("not installed");
  });

  it("status prints the label, pid, running version, port, url and run.json", async () => {
    const e = env({}, null, "0.2.0");
    const state = path.join(dir, "s");
    await runService({ verb: "install", port: 7829, state }, e);
    writeFileSync(path.join(dir, "print"), "\tstate = running\n\tpid = 4242\n");
    writeRunFile(state, {
      port: 7829,
      pid: process.pid,
      version: "0.2.0",
      url: "http://127.0.0.1:7829",
      startedAt: "2026-10-25T03:00:00.000Z",
    });
    out = [];
    expect(await runService({ verb: "status" }, e)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("dev.spacesheep.sessionpipe-gui (launchd) · running · pid 4242 · 0.2.0");
    expect(text).toContain("port      7829");
    expect(text).toContain("url       http://127.0.0.1:7829");
    expect(text).toContain(`run.json  pid ${process.pid} · 0.2.0`);
  });

  it("uninstall boots it out, deletes the plist and checks it is gone", async () => {
    const e = env();
    await runService({ verb: "install", port: 7829, state: path.join(dir, "s") }, e);
    expect(await runService({ verb: "uninstall" }, e)).toBe(0);
    expect(calls()).toContain(`bootout gui/501/${SERVICE_LABEL}`);
    expect(existsSync(launchAgentPath(home, SERVICE_LABEL))).toBe(false);
    expect(out.at(-1)).toContain("removed");
    out = [];
    expect(await runService({ verb: "uninstall" }, e)).toBe(0);
    expect(out[0]).toContain("nothing to do");
  });

  it("uninstall waits for launchd to let the job go", async () => {
    const e = env();
    await runService({ verb: "install", port: 7829, state: path.join(dir, "s") }, e);
    slowBootout = true;
    out = [];
    expect(await runService({ verb: "uninstall" }, e)).toBe(0);
    expect(errs).toEqual([]);
    expect(out.at(-1)).toContain("removed");
    expect(existsSync(path.join(dir, "loaded"))).toBe(false);
  });

  it("uninstall reports a service that stays loaded", async () => {
    const e = env();
    await runService({ verb: "install", port: 7829, state: path.join(dir, "s") }, e);
    failVerb = "bootout";
    expect(await runService({ verb: "uninstall" }, e)).toBe(1);
    expect(errs.join("\n")).toContain("still loaded");
  });
});

describe("service on Linux and Windows", () => {
  it("installs a systemd --user unit, enables it, and removes it", async () => {
    const e = env({ platform: "linux" });
    const state = path.join(dir, "s");
    expect(await runService({ verb: "install", port: 7829, state }, e)).toBe(0);
    const file = unitPath(home, SERVICE_LABEL);
    expect(unitArgv(readFileSync(file, "utf8"))).toEqual([
      e.node,
      e.cli,
      "--port",
      "7829",
      "--state",
      state,
      "--quiet",
    ]);
    expect(calls().filter((c) => !c.startsWith("--user show"))).toEqual([
      "--user daemon-reload",
      `--user enable --now ${SERVICE_LABEL}.service`,
    ]);
    writeFileSync(path.join(dir, "print"), "LoadState=loaded\nActiveState=active\nMainPID=99\n");
    expect(await runService({ verb: "status" }, e)).toBe(0);
    expect(out.join("\n")).toContain("(systemd --user) · running · pid 99");
    expect(await runService({ verb: "uninstall" }, e)).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(calls()).toContain(`--user disable --now ${SERVICE_LABEL}.service`);
  });

  it("says Windows is not yet supported", async () => {
    expect(await runService({ verb: "install" }, env({ platform: "win32" }))).toBe(1);
    expect(errs[0]).toContain("not here yet");
  });
});
