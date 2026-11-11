// SPDX-License-Identifier: Apache-2.0
// Which openssl TLS mode runs: the one on the PATH, else on Windows the one its installers
// leave off the PATH.
import { describe, expect, it } from "vitest";
import { openssl, opensslCommand, windowsOpensslPaths } from "./certs.js";

const env = {
  PATH: "C:\\WINDOWS\\system32;D:\\Tools\\Git\\cmd\\;C:\\tools\\node",
  ProgramFiles: "C:\\Program Files",
  ProgramW6432: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
};
const GIT = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
const WINGET_ARM = "C:\\Program Files\\OpenSSL-Win64-ARM\\bin\\openssl.exe";
const enoent = () => Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
/** A run that knows only these commands, and notes what it was asked to run. */
const only = (have: string[], ran: string[] = []) => ({
  ran,
  run: (command: string, args: string[]) => {
    ran.push(`${command} ${args[0]}`);
    if (!have.includes(command)) throw enoent();
  },
});

describe("the openssl command", () => {
  it("is the one on the PATH when there is one, on every platform, with nothing else tried", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const r = only(["openssl", GIT]);
      expect(opensslCommand(platform, env, r.run)).toBe("openssl");
      expect(r.ran).toEqual(["openssl version"]);
    }
  });

  it("on Windows is looked for where Git for Windows and the winget package leave it, in this order", () => {
    expect(windowsOpensslPaths(env)).toEqual([
      // A Git wherever it is installed: its cmd folder is what is on the PATH.
      "D:\\Tools\\Git\\usr\\bin\\openssl.exe",
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
    expect(opensslCommand("win32", env, only([GIT, WINGET_ARM]).run)).toBe(GIT);
    expect(opensslCommand("win32", env, only([WINGET_ARM]).run)).toBe(WINGET_ARM);
  });

  it("is none when nothing runs, and never a Windows folder off Windows", () => {
    expect(opensslCommand("win32", env, only([]).run)).toBeUndefined();
    expect(windowsOpensslPaths({})).toEqual([]);
    const r = only([GIT]);
    expect(opensslCommand("linux", env, r.run)).toBeUndefined();
    expect(r.ran).toEqual(["openssl version"]);
  });

  it("runs the one it found: the PATH's first, on Windows the installer's when the PATH has none", () => {
    const onPath = only(["openssl", GIT]);
    openssl(["ecparam", "-genkey"], "C:\\state\\tls", "win32", env, onPath.run);
    expect(onPath.ran).toEqual(["openssl ecparam"]);

    const off = only([WINGET_ARM]);
    openssl(["ecparam", "-genkey"], "C:\\state\\tls", "win32", env, off.run);
    expect(off.ran.at(0)).toBe("openssl ecparam");
    expect(off.ran.at(-1)).toBe(`${WINGET_ARM} ecparam`);

    expect(() => openssl(["ecparam"], "C:\\state\\tls", "win32", env, only([]).run)).toThrow(
      "none was found on the PATH, in Git for Windows or in an OpenSSL folder under Program Files",
    );
    const linux = only([GIT]);
    expect(() => openssl(["ecparam"], "/state/tls", "linux", env, linux.run)).toThrow("which is not on the PATH");
    expect(linux.ran).toEqual(["openssl ecparam"]);
  });

  it("says what openssl said when it ran and failed", () => {
    const fails = () => {
      throw Object.assign(new Error("exit 1"), { stderr: Buffer.from("unknown option -x\n") });
    };
    expect(() => openssl(["req", "-x"], "/state/tls", "linux", env, fails)).toThrow(
      "openssl req failed: unknown option -x",
    );
  });
});
