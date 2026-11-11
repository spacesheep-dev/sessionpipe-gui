// SPDX-License-Identifier: Apache-2.0
// Which openssl TLS mode runs: the one on the PATH, else on Windows the one its installers
// leave off the PATH.
import { beforeEach, describe, expect, it } from "vitest";
import { forgetOpenssl, openssl, opensslCommand, windowsOpenssl, windowsOpensslPaths } from "./certs.js";

const env = {
  PATH: "C:\\WINDOWS\\system32;D:\\Tools\\Git\\cmd\\;C:\\tools\\node",
  ProgramFiles: "C:\\Program Files",
  ProgramW6432: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
};
const D_GIT_EXE = "D:\\Tools\\Git\\cmd\\git.exe";
const D_GIT = "D:\\Tools\\Git\\usr\\bin\\openssl.exe";
const GIT = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
const WINGET_ARM = "C:\\Program Files\\OpenSSL-Win64-ARM\\bin\\openssl.exe";
const enoent = () => Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
/** A machine with only these files; `openssl` among them means one on the PATH. It notes
 *  what it was asked to run. */
const machine = (files: string[]) => {
  const ran: string[] = [];
  return {
    files,
    ran,
    run: (command: string, args: string[]) => {
      ran.push(`${command} ${args[0]}`);
      if (!files.includes(command)) throw enoent();
    },
    exists: (file: string) => files.includes(file),
  };
};

beforeEach(forgetOpenssl);

describe("the openssl command", () => {
  it("is the one on the PATH when there is one, on every platform, with nothing else tried", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const m = machine(["openssl", GIT]);
      expect(opensslCommand(platform, env, m)).toBe("openssl");
      expect(m.ran).toEqual(["openssl version"]);
    }
  });

  it("on Windows is looked for where Git for Windows and the winget package leave it, in this order", () => {
    expect(windowsOpensslPaths(env, (f) => f === D_GIT_EXE)).toEqual([
      // A Git wherever it is installed: its cmd folder, with git.exe in it, is on the PATH.
      D_GIT,
      GIT,
      "C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe",
      WINGET_ARM,
      "C:\\Program Files\\OpenSSL-Win32\\bin\\openssl.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
      "C:\\Program Files (x86)\\OpenSSL-Win64\\bin\\openssl.exe",
      "C:\\Program Files (x86)\\OpenSSL-Win64-ARM\\bin\\openssl.exe",
      "C:\\Program Files (x86)\\OpenSSL-Win32\\bin\\openssl.exe",
      "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\usr\\bin\\openssl.exe",
    ]);
    // One machine after another, with no forgetting in between: what the first found is
    // not the second's answer, because its file isn't there.
    expect(opensslCommand("win32", env, machine([GIT, WINGET_ARM]))).toBe(GIT);
    expect(opensslCommand("win32", env, machine([WINGET_ARM]))).toBe(WINGET_ARM);
  });

  it("takes a Git from the PATH only by an absolute cmd folder that holds git.exe", () => {
    const everything = () => true;
    const paths = (PATH: string, exists: (f: string) => boolean = everything) => windowsOpensslPaths({ PATH }, exists);
    // Relative entries would be read against wherever the receiver was started; an
    // unexpanded variable is relative too; a root with no drive depends on the drive.
    for (const entry of [".\\cmd", "cmd", "tools\\cmd", "..\\Git\\cmd", "%USERPROFILE%\\cmd", "\\Git\\cmd", "C:cmd"])
      expect(paths(`C:\\WINDOWS;${entry}`)).toEqual([]);
    // A cmd folder that isn't Git's: anyone can make C:\cmd, and C:\usr\bin beside it.
    expect(paths("C:\\cmd", (f) => f !== "C:\\cmd\\git.exe")).toEqual([]);
    expect(paths('"E:\\Dev Tools\\Git\\cmd\\";e:/git/cmd')).toEqual([
      "E:\\Dev Tools\\Git\\usr\\bin\\openssl.exe",
      "e:\\git\\usr\\bin\\openssl.exe",
    ]);
    // The folders the environment names count only when absolute as well.
    expect(windowsOpensslPaths({ ProgramFiles: "Program Files", LOCALAPPDATA: ".\\Local" }, everything)).toEqual([]);
  });

  it("is none when nothing runs; runs only files that are there; never a Windows folder off Windows", () => {
    const none = machine([]);
    expect(opensslCommand("win32", env, none)).toBeUndefined();
    expect(none.ran).toEqual(["openssl version"]);
    expect(windowsOpensslPaths({})).toEqual([]);
    const linux = machine([GIT]);
    expect(opensslCommand("linux", env, linux)).toBeUndefined();
    expect(linux.ran).toEqual(["openssl version"]);
  });

  it("keeps the one it found while its file is there, and looks again when it is gone", () => {
    const m = machine([GIT, WINGET_ARM]);
    expect(windowsOpenssl(env, m)).toBe(GIT);
    expect(m.ran).toEqual([`${GIT} version`]);
    // The setup page asks every two seconds: the second look starts nothing.
    expect(windowsOpenssl(env, m)).toBe(GIT);
    expect(m.ran).toEqual([`${GIT} version`]);
    // Git is uninstalled: the winget one is found, with no restart.
    m.files.splice(m.files.indexOf(GIT), 1);
    expect(windowsOpenssl(env, m)).toBe(WINGET_ARM);
    // And one installed later is found: nothing, then the winget package.
    forgetOpenssl();
    const later = machine([]);
    expect(windowsOpenssl(env, later)).toBeUndefined();
    later.files.push(WINGET_ARM);
    expect(windowsOpenssl(env, later)).toBe(WINGET_ARM);
  });

  it("runs the one the setup page reports: the PATH's, on Windows the installer's when the PATH has none", () => {
    const onPath = machine(["openssl", GIT]);
    openssl(["ecparam", "-genkey"], "C:\\state\\tls", "win32", env, onPath);
    expect(onPath.ran.at(-1)).toBe("openssl ecparam");

    const off = machine([WINGET_ARM]);
    openssl(["ecparam", "-genkey"], "C:\\state\\tls", "win32", env, off);
    expect(off.ran.at(-1)).toBe(`${WINGET_ARM} ecparam`);

    // An openssl on the PATH that doesn't run: the page says the installer's, and so does this.
    forgetOpenssl();
    const broken = machine([GIT]);
    const run = broken.run;
    broken.run = (command, args) => {
      if (command !== "openssl") return run(command, args);
      broken.ran.push(`openssl ${args[0]}`);
      throw Object.assign(new Error("exit 1"), { stderr: Buffer.from("missing dll") });
    };
    expect(opensslCommand("win32", env, broken)).toBe(GIT);
    openssl(["ecparam", "-genkey"], "C:\\state\\tls", "win32", env, broken);
    expect(broken.ran.at(-1)).toBe(`${GIT} ecparam`);

    expect(() => openssl(["ecparam"], "C:\\state\\tls", "win32", env, machine([]))).toThrow(
      "none was found on the PATH, in Git for Windows or in an OpenSSL folder under Program Files",
    );
    // Off Windows: the PATH's and nothing before it, as ever.
    const linux = machine(["openssl", GIT]);
    openssl(["ecparam"], "/state/tls", "linux", env, linux);
    expect(linux.ran).toEqual(["openssl ecparam"]);
    const bare = machine([GIT]);
    expect(() => openssl(["ecparam"], "/state/tls", "linux", env, bare)).toThrow("which is not on the PATH");
    expect(bare.ran).toEqual(["openssl ecparam"]);
  });

  it("says what openssl said when it ran and failed", () => {
    const fails = {
      run: () => {
        throw Object.assign(new Error("exit 1"), { stderr: Buffer.from("unknown option -x\n") });
      },
      exists: () => false,
    };
    expect(() => openssl(["req", "-x"], "/state/tls", "linux", env, fails)).toThrow(
      "openssl req failed: unknown option -x",
    );
  });
});
