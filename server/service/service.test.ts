// SPDX-License-Identifier: Apache-2.0
// `service install|uninstall|status` against a temp HOME and a fake launchctl / systemctl
// (a shell script that logs its arguments): nothing here reaches the real session.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeRunFile } from "../runfile.js";
import { type Probe, processEnv, runService, SERVICE_LABEL, type ServiceEnv, servicePath } from "./index.js";
import { launchAgentPath, launchAgentPlist, parseLaunchctlPrint, plistArgv } from "./launchd.js";
import { parseSystemctlShow, systemdUnit, unitArgv, unitPath } from "./systemd.js";

let dir: string;
let home: string;
let log: string;
let out: string[];
let errs: string[];

/** A fake launchctl / systemctl: logs "<argv>" to $FAKE_LOG; `print`/`show` succeed only
 *  while $FAKE_LOADED exists, and print $FAKE_PRINT; `bootstrap`/`enable` create the
 *  marker, `bootout`/`disable` remove it; $FAKE_FAIL names a verb that exits 5. */
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
  bootout|disable) rm -f "${dir}/loaded";;
esac
exit 0
`,
  );
  chmodSync(p, 0o755);
  return p;
}

function env(over: Partial<ServiceEnv> = {}, probe: Probe | Probe[] = null): ServiceEnv {
  const probes = Array.isArray(probe) ? [...probe] : [probe];
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
    exec: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, FAKE_FAIL: failVerb } });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    probe: async () => (probes.length > 1 ? probes.shift()! : probes[0]!),
    waitMs: 0,
    out: (s) => out.push(s),
    err: (s) => errs.push(s),
    ...over,
  };
}
let failVerb = "";
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "spgui-service-"));
  home = path.join(dir, "home");
  log = path.join(dir, "calls.log");
  out = [];
  errs = [];
  failVerb = "";
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
    const e = env({ waitMs: 2000 }, [null, null, "gui"]);
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

  it("refuses when a service is installed already (file, or loaded without one)", async () => {
    const e = env();
    expect(await runService({ verb: "install", port: 7829, state: path.join(dir, "s") }, e)).toBe(0);
    expect(await runService({ verb: "install", port: 7830, state: path.join(dir, "s") }, e)).toBe(1);
    expect(errs.join("\n")).toContain("a service is already installed");
    rmSync(launchAgentPath(home, SERVICE_LABEL));
    errs = [];
    expect(await runService({ verb: "install", port: 7830 }, e)).toBe(1); // still loaded
    expect(errs.join("\n")).toContain("already installed");
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

describe("service uninstall and status (macOS)", () => {
  it("status says not installed (exit 3)", async () => {
    expect(await runService({ verb: "status" }, env())).toBe(3);
    expect(out[0]).toContain("not installed");
  });

  it("status prints the label, pid, port, url and run.json", async () => {
    const e = env();
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
    expect(text).toContain("dev.spacesheep.sessionpipe-gui (launchd) · running · pid 4242");
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
