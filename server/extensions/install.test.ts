// SPDX-License-Identifier: Apache-2.0
// The shared installer on each platform: how an archive is unpacked, how npm is run and
// what `link` makes, with the platform handed in; then add (a .zip, a .tgz through npm)
// and link / list / remove on the machine running the tests (CI runs Linux; run on
// Windows, the second block takes the Windows path end to end).
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../../test/events.js";
import { addSkin, linkSkin, listSkins, removeSkin } from "../skins/install.js";
import { extractCommand, linkFolder, npmCommand } from "./install.js";

const NO_BUNDLED = { bundledDir: "/nonexistent/spgui-bundled" };

function makeSkin(dir: string, id: string, name = "Mint"): string {
  mkdirSync(dir, { recursive: true });
  const m = {
    id,
    name,
    version: "0.1.0",
    kind: "skin",
    api: 1,
    scheme: "light",
    tokens: { "--bg": "oklch(0.975 0.012 160)" },
  };
  writeFileSync(path.join(dir, "skin.json"), JSON.stringify(m));
  return dir;
}

function touch(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
}

/** A .zip with stored (uncompressed) entries, so the test needs no zip tool. */
function zipOf(files: Record<string, string>): Buffer {
  const crc32 = (b: Buffer): number => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const n = Buffer.from(name);
    const d = Buffer.from(body);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x21, 12); // 1980-01-01
    head.writeUInt32LE(crc32(d), 14);
    head.writeUInt32LE(d.length, 18);
    head.writeUInt32LE(d.length, 22);
    head.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc32(d), 16);
    entry.writeUInt32LE(d.length, 20);
    entry.writeUInt32LE(d.length, 24);
    entry.writeUInt16LE(n.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(head, n, d);
    central.push(entry, n);
    offset += head.length + n.length + d.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}

describe("the installer's commands on each platform", () => {
  let tmp: { dir: string; cleanup: () => void };
  beforeAll(() => {
    tmp = tempDir();
  });
  afterAll(() => tmp.cleanup());

  it("unpacks with unzip / tar off Windows, and with the tar.exe Windows ships, by its full path, on Windows", () => {
    expect(extractCommand("/t/mint.zip", "/t/out", "darwin")).toEqual([
      "unzip",
      ["-q", "-o", "/t/mint.zip", "-d", "/t/out"],
    ]);
    expect(extractCommand("/t/mint.tgz", "/t/out", "linux")).toEqual(["tar", ["-xzf", "/t/mint.tgz", "-C", "/t/out"]]);
    const env = { SystemRoot: "C:\\Windows" };
    expect(extractCommand("C:\\Temp\\R&D (x)\\mint.ZIP", "C:\\Temp\\out", "win32", env)).toEqual([
      "C:\\Windows\\System32\\tar.exe",
      ["-xf", "C:\\Temp\\R&D (x)\\mint.ZIP", "-C", "C:\\Temp\\out"],
    ]);
    expect(extractCommand("C:\\Temp\\mint.tgz", "C:\\Temp\\out", "win32", { SystemRoot: "D:\\WINNT" })).toEqual([
      "D:\\WINNT\\System32\\tar.exe",
      ["-xzf", "C:\\Temp\\mint.tgz", "-C", "C:\\Temp\\out"],
    ]);
    expect(extractCommand("C:\\Temp\\mint.zip", "C:\\Temp\\out", "win32", {})[0]).toBe(
      "C:\\Windows\\System32\\tar.exe",
    );
  });

  it("runs npm by name off Windows, and on Windows npm-cli.js under this node, beside node.exe first", () => {
    expect(npmCommand("darwin", "/usr/local/bin/node", {})).toEqual({ cmd: "npm", args: [] });
    const nodeDir = path.join(tmp.dir, "node dir");
    const node = path.join(nodeDir, "node.exe");
    const cli = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    touch(node);
    touch(cli);
    const other = path.join(tmp.dir, "other");
    touch(path.join(other, "npm.cmd"));
    touch(path.join(other, "node_modules", "npm", "bin", "npm-cli.js"));
    expect(npmCommand("win32", node, { PATH: other })).toEqual({ cmd: node, args: [cli] });
  });

  it("on Windows, finds npm-cli.js beside an npm on PATH when node.exe has none", () => {
    const node = path.join(tmp.dir, "bare", "node.exe");
    touch(node);
    // On PATH, in order: an empty entry; a folder with npm-cli.js but no npm the PATHEXT
    // list runs; a folder with an npm.cmd but no npm-cli.js beside it; then npm's own
    // folder, quoted, with a space, & and ( ) in its name.
    const noShim = path.join(tmp.dir, "no-shim");
    touch(path.join(noShim, "node_modules", "npm", "bin", "npm-cli.js"));
    touch(path.join(noShim, "npm.ps1"));
    const noCli = path.join(tmp.dir, "no-cli");
    touch(path.join(noCli, "npm.cmd"));
    const npmDir = path.join(tmp.dir, "R&D (x) npm");
    touch(path.join(npmDir, "npm.cmd"));
    const cli = path.join(npmDir, "node_modules", "npm", "bin", "npm-cli.js");
    touch(cli);
    const PATH = ["", noShim, noCli, `"${npmDir}"`].join(";");
    expect(npmCommand("win32", node, { PATH, PATHEXT: ".COM;.EXE;.BAT;.CMD" })).toEqual({ cmd: node, args: [cli] });
    // With no npm anywhere, it says where it looked, which the error then names.
    const none = npmCommand("win32", node, { PATH: ["", noShim, noCli].join(";") });
    expect(none).toEqual({
      where: `${path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js")}, or beside an npm on PATH`,
    });
  });

  it("links with a directory symlink, and on Windows with a junction when the symlink is refused (no Developer Mode)", () => {
    const at = (name: string) => path.join(tmp.dir, "links", name);
    mkdirSync(at(""), { recursive: true });
    const calls: string[] = [];
    // A fake symlinkSync: refuses "dir" with `code`; a "junction" is made (a folder) when `reach`.
    const fake =
      (code: string | null, reach = true) =>
      (_target: string, dest: string, type: string) => {
        calls.push(type);
        if (type === "dir" && code) throw Object.assign(new Error(code), { code });
        if (type === "junction" && reach) mkdirSync(dest);
      };
    linkFolder("C:\\src\\mint", at("a"), "win32", fake("EPERM"));
    expect(calls).toEqual(["dir", "junction"]);
    calls.length = 0;
    linkFolder("C:\\src\\mint", at("b"), "win32", fake(null));
    expect(calls).toEqual(["dir"]);
    // Only EPERM on Windows falls back; anything else is thrown as it was.
    expect(() => linkFolder("/src/mint", at("c"), "darwin", fake("EPERM"))).toThrow("EPERM");
    expect(() => linkFolder("C:\\src\\mint", at("d"), "win32", fake("EEXIST"))).toThrow("EEXIST");
    // A junction that fails, or one made to a network folder that cannot be followed, is an
    // error naming what would let a symlink through.
    const neither = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    expect(() => linkFolder("\\\\nas\\mint", at("e"), "win32", neither)).toThrow(
      /^cannot link \\\\nas\\mint: Windows allows a symlink only with Developer Mode on .*, and a junction failed too \(EPERM\)$/,
    );
    expect(() => linkFolder("\\\\nas\\mint", at("f"), "win32", fake("EPERM", false))).toThrow(
      /Developer Mode on .*, and a junction cannot reach a network folder$/,
    );
  });
});

describe("add and link on this machine", () => {
  let tmp: { dir: string; cleanup: () => void };
  let skins: string;
  beforeAll(() => {
    tmp = tempDir();
    skins = path.join(tmp.dir, "state & (x)", "skins");
  });
  afterAll(() => tmp.cleanup());

  it("adds a .zip, finding skin.json one folder down", async () => {
    const zip = path.join(tmp.dir, "mint.zip");
    const m = { id: "zipped", name: "Zipped", version: "0.1.0", kind: "skin", api: 1, scheme: "light", tokens: {} };
    writeFileSync(zip, zipOf({ "zipped/skin.json": JSON.stringify(m), "zipped/skin.css": "" }));
    const r = await addSkin(skins, zip);
    expect(r.manifest).toMatchObject({ id: "zipped", source: zip });
    expect(existsSync(path.join(skins, "zipped", "skin.css"))).toBe(true);
  });

  it("adds a .tgz given as a file: spec, which goes through npm", { timeout: 120_000 }, async () => {
    const pkg = makeSkin(path.join(tmp.dir, "npm-src", "package"), "packed", "Packed");
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "spgui-test-packed", version: "0.1.0" }));
    execFileSync("tar", ["-czf", "packed.tgz", "package"], { cwd: path.dirname(pkg) });
    const tgz = path.join(path.dirname(pkg), "packed.tgz");
    const saved = { cache: process.env.npm_config_cache, offline: process.env.npm_config_offline };
    process.env.npm_config_cache = path.join(tmp.dir, "npm-cache");
    process.env.npm_config_offline = "true";
    try {
      const r = await addSkin(skins, `file:${tgz}`);
      expect(r.manifest).toMatchObject({ id: "packed", source: `npm:file:${tgz}` });
      expect(existsSync(path.join(skins, "packed", "skin.json"))).toBe(true);
    } finally {
      for (const [k, v] of [
        ["npm_config_cache", saved.cache],
        ["npm_config_offline", saved.offline],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("links a folder, lists it as linked, replaces the link, and removes the link alone", async () => {
    const src = makeSkin(path.join(tmp.dir, "dev & (x)", "mint"), "mint");
    expect(linkSkin(skins, src).message).toMatch(/^linked mint \(Mint 0\.1\.0\) → /);
    const dest = path.join(skins, "mint");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(listSkins(skins, NO_BUNDLED).find((s) => s.id === "mint")).toMatchObject({ linked: true, name: "Mint" });
    // The link is live: an edit in the folder shows.
    makeSkin(src, "mint", "Mint 2");
    expect(listSkins(skins, NO_BUNDLED).find((s) => s.id === "mint")).toMatchObject({ name: "Mint 2" });
    // Linking again replaces the link; adding the linked folder is refused, the folder kept.
    expect(linkSkin(skins, src).message).toMatch(/^replaced mint /);
    await expect(addSkin(skins, src)).rejects.toThrow(/already the installed copy/);
    expect(readFileSync(path.join(src, "skin.json"), "utf8")).toContain("Mint 2");
    expect(removeSkin(skins, "mint").message).toBe("removed mint (the link; the folder it pointed to is untouched)");
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(path.join(src, "skin.json"))).toBe(true);
  });

  it("replaces a link with an installed copy, leaving the linked folder alone", async () => {
    const src = makeSkin(path.join(tmp.dir, "dev2", "mint"), "mint");
    linkSkin(skins, src);
    const copy = makeSkin(path.join(tmp.dir, "copy", "mint"), "mint", "Mint copy");
    expect((await addSkin(skins, copy)).replaced).toBe(true);
    expect(lstatSync(path.join(skins, "mint")).isSymbolicLink()).toBe(false);
    expect(listSkins(skins, NO_BUNDLED).find((s) => s.id === "mint")).toMatchObject({ name: "Mint copy" });
    expect(readFileSync(path.join(src, "skin.json"), "utf8")).toContain('"name":"Mint"');
  });
});
