// SPDX-License-Identifier: Apache-2.0
// `sessionpipe-gui key renew`: a receiver serving the state folder is found by its door in
// `<state>/run/` and takes the new key at once, also bound to one address; with none, the
// command writes config.json for the next start; one it cannot ask means nothing changes.
// It prints no key. And config.json is the owner's: a receiver takes the newest secrets
// written there, so no later write of its own puts an older key back.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROUTES, UI_KEY_COOKIE } from "../shared/api.js";
import { tempDir } from "../test/events.js";
import { type App, createApp } from "./app.js";
import { hashSecret, readGuiConfig, writeGuiConfig } from "./config.js";
import { lanAddresses } from "./http/net.js";
import { RENEWED_LATER, renewed, runKeyCommand } from "./keyCommand.js";
import { DOOR_HEADER, doorsDir, listDoors } from "./localDoor.js";
import { writeRunFile } from "./runfile.js";

const PUBLIC = "https://laptop.tail1234.ts.net";
const VISITOR = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };

let tmp: { dir: string; cleanup: () => void };
const apps: App[] = [];
beforeEach(() => {
  tmp = tempDir("spgui-keycmd-");
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  tmp.cleanup();
}, 60_000);

/** Captured output, and a port nothing listens on for the probe unless a test says so. */
function io(o: { probePort?: number; stateDir?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  /** Both streams, in the order they were written. */
  const all: string[] = [];
  return {
    io: {
      stateDir: o.stateDir ?? tmp.dir,
      stdout: {
        write: (s: string) => {
          out.push(s);
          all.push(s);
        },
      },
      stderr: {
        write: (s: string) => {
          err.push(s);
          all.push(s);
        },
      },
      probePort: o.probePort ?? 9,
    },
    out: () => out.join(""),
    err: () => err.join(""),
    all: () => all.join(""),
  };
}

async function boot(o: { host?: string } = {}): Promise<App> {
  const a = await createApp({
    port: 0,
    stateDir: tmp.dir,
    outbox: false,
    quiet: true,
    publicUrl: PUBLIC,
    ...(o.host ? { host: o.host } : {}),
  });
  apps.push(a);
  await a.keyLooked;
  return a;
}

/** Wait until `cond` holds (the other receiver reads config.json when it changes). */
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
}

const visitorStatus = async (a: App, key: string) =>
  (await fetch(`${a.url}${ROUTES.ui.info}`, { headers: { ...VISITOR, cookie: `${UI_KEY_COOKIE}=${key}` } })).status;

describe("key renew", () => {
  it("asks the receiver serving the folder, by its door; the new key is in use at once, and no key is printed", async () => {
    const a = await boot();
    expect(listDoors(tmp.dir).map((d) => d.port)).toEqual([a.port]);
    const old = a.config().uiKey;
    const sink = a.config().sinkToken;
    const t = io();
    expect(await runKeyCommand("renew", t.io)).toBe(0);
    const next = a.config().uiKey;
    expect(next).not.toBe(old);
    expect(readGuiConfig(tmp.dir).uiKey).toBe(next);
    expect(t.out()).toBe(`${renewed(`http://localhost:${a.port}`)}\n`);
    expect(t.out() + t.err()).not.toContain(next);
    expect(t.out() + t.err()).not.toContain(old);
    expect(await visitorStatus(a, old)).toBe(401);
    expect(await visitorStatus(a, next)).toBe(200);
    // The sink token is not the key: untouched.
    expect(readGuiConfig(tmp.dir).sinkToken).toBe(sink);
  });

  it("the door is this run's own: written 0600 when it listens, gone when it stops", async () => {
    const a = await boot();
    const [door] = listDoors(tmp.dir);
    const file = path.join(doorsDir(tmp.dir), `${process.pid}-${a.port}.json`);
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    // Through the proxy the secret opens nothing: the door is for this computer's own requests.
    const old = a.config().uiKey;
    const r = await fetch(`${a.url}${ROUTES.ui.renewKey}`, {
      method: "POST",
      headers: { ...VISITOR, [DOOR_HEADER]: door!.secret },
    });
    expect(r.status).toBe(403);
    expect(a.config().uiKey).toBe(old);
    await a.close();
    apps.splice(0);
    expect(readdirSync(doorsDir(tmp.dir))).toEqual([]);
  });

  const lan = lanAddresses()[0];
  it.skipIf(!lan)("a receiver bound to one address that is not loopback: that address is this computer", async () => {
    const a = await boot({ host: lan });
    expect(a.url).toBe(`http://${lan}:${a.port}`);
    const old = a.config().uiKey;
    // From this computer by that address: no key needed, the sink line shown, New link's route open.
    const info = (await (await fetch(`${a.url}${ROUTES.ui.info}`)).json()) as {
      sinkToken: string;
      urls: { local: string };
    };
    expect(info.sinkToken).toBe(a.config().sinkToken);
    expect(info.urls.local).toBe(`http://${lan}:${a.port}`);
    expect((await fetch(`${a.url}${ROUTES.ui.renewKey}`, { method: "POST" })).status).toBe(204);
    const mid = a.config().uiKey;
    expect(mid).not.toBe(old);
    // The 401 page names that address, not localhost.
    const page = await fetch(`${a.url}/`, { headers: VISITOR });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain(`<code>http://${lan}:${a.port}</code> needs no key`);
    // Through the proxy that same address is a visitor: no sink token, no renewal.
    const away = await fetch(`${a.url}${ROUTES.ui.info}?k=${mid}`, { headers: VISITOR });
    expect(((await away.json()) as { sinkToken: string }).sinkToken).toBe("");
    expect((await fetch(`${a.url}${ROUTES.ui.renewKey}?k=${mid}`, { method: "POST", headers: VISITOR })).status).toBe(
      403,
    );
    // And the command reaches it, and names where Connect is.
    const t = io();
    expect(await runKeyCommand("renew", t.io)).toBe(0);
    expect(t.out()).toBe(`${renewed(`http://${lan}:${a.port}`)}\n`);
    expect(a.config().uiKey).not.toBe(mid);
  });

  it("with no receiver, writes config.json for the next start and prints no key", async () => {
    const before = readGuiConfig(tmp.dir);
    const t = io();
    expect(await runKeyCommand("renew", t.io)).toBe(0);
    const after = readGuiConfig(tmp.dir);
    expect(after.uiKey).not.toBe(before.uiKey);
    expect(after.sinkToken).toBe(before.sinkToken);
    expect(t.out()).toBe(`${RENEWED_LATER}\n`);
    expect(t.out()).not.toContain(after.uiKey);
  });

  it("a run file whose pid lives but whose port answers nothing is from an earlier run: passed, and said", async () => {
    // A door and a run.json naming this live process, and nothing on their port.
    mkdirSync(doorsDir(tmp.dir), { recursive: true });
    writeFileSync(
      path.join(doorsDir(tmp.dir), `${process.pid}-9.json`),
      JSON.stringify({ pid: process.pid, port: 9, urls: ["http://127.0.0.1:9"], secret: "s" }),
    );
    writeRunFile(tmp.dir, { port: 9, pid: process.pid, version: "0.8.5", url: "http://127.0.0.1:9", startedAt: "" });
    const before = readGuiConfig(tmp.dir).uiKey;
    const t = io();
    expect(await runKeyCommand("renew", t.io)).toBe(0);
    expect(t.err()).toBe(
      `sessionpipe-gui: no receiver for ${tmp.dir} answered at the address its run file names (port 9); the file is from an earlier run.\n`,
    );
    expect(t.out()).toBe(`${RENEWED_LATER}\n`);
    // The note first, then the result.
    expect(t.all()).toBe(`${t.err()}${t.out()}`);
    expect(readGuiConfig(tmp.dir).uiKey).not.toBe(before);
  });

  it("waits for a receiver that answers late, and one that applied the key but answered an error is said to have", async () => {
    const before = readGuiConfig(tmp.dir).uiKey;
    let mode: "late" | "error" = "late";
    const fake = http.createServer((_q, res) => {
      // The stand-in applies a new key, as a receiver does, then answers.
      writeGuiConfig(tmp.dir, { ...readGuiConfig(tmp.dir), uiKey: `Applied-${mode}-0123456789` });
      if (mode === "late")
        setTimeout(() => {
          res.writeHead(204);
          res.end();
        }, 6_000);
      else {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const port = (fake.address() as { port: number }).port;
      mkdirSync(doorsDir(tmp.dir), { recursive: true });
      writeFileSync(
        path.join(doorsDir(tmp.dir), `${process.pid}-${port}.json`),
        JSON.stringify({
          pid: process.pid,
          port,
          urls: [`http://127.0.0.1:${port}`],
          home: "http://localhost:7373",
          secret: "s",
        }),
      );
      let t = io();
      expect(await runKeyCommand("renew", t.io)).toBe(0);
      expect(t.all()).toBe(`${renewed("http://localhost:7373")}\n`);
      expect(readGuiConfig(tmp.dir).uiKey).not.toBe(before);
      mode = "error";
      t = io();
      expect(await runKeyCommand("renew", t.io)).toBe(0);
      expect(t.all()).toBe(`${renewed("http://localhost:7373")}\n`);
      expect(readGuiConfig(tmp.dir).uiKey).toBe("Applied-error-0123456789");
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
  }, 30_000);

  it("a symlinked --state is the folder it points at", async () => {
    const a = await boot();
    rmSync(doorsDir(tmp.dir), { recursive: true, force: true });
    const link = `${tmp.dir}-link`;
    symlinkSync(tmp.dir, link);
    try {
      const old = a.config().uiKey;
      const t = io({ probePort: a.port, stateDir: link });
      expect(await runKeyCommand("renew", t.io)).toBe(0);
      expect(t.out()).toBe(`${renewed(`http://localhost:${a.port}`)}\n`);
      expect(a.config().uiKey).not.toBe(old);
    } finally {
      rmSync(link, { force: true });
    }
  }, 60_000);

  it("a short key the owner set is retired by `key renew` without its hash in the list", async () => {
    writeGuiConfig(tmp.dir, { ...readGuiConfig(tmp.dir), uiKey: "short" });
    const t = io();
    expect(await runKeyCommand("renew", t.io)).toBe(0);
    const after = readGuiConfig(tmp.dir);
    expect(after.uiKey).not.toBe("short");
    expect(after.retired ?? []).not.toContain(hashSecret("short"));
  }, 60_000);

  it("a receiver that left no door is asked over loopback, and takes the new key", async () => {
    const a = await boot();
    rmSync(doorsDir(tmp.dir), { recursive: true, force: true });
    const old = a.config().uiKey;
    const t = io({ probePort: a.port });
    expect(await runKeyCommand("renew", t.io)).toBe(0);
    expect(t.out()).toBe(`${renewed(`http://localhost:${a.port}`)}\n`);
    expect(a.config().uiKey).not.toBe(old);
  });

  it("a receiver for this folder that does not take the new key: nothing changed, and what it answered", async () => {
    const before = readGuiConfig(tmp.dir).uiKey;
    const fake = http.createServer((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "sessionpipe-gui", storage: { dir: tmp.dir } }));
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const port = (fake.address() as { port: number }).port;
      const t = io({ probePort: port });
      expect(await runKeyCommand("renew", t.io)).toBe(1);
      expect(t.err()).toBe(
        `sessionpipe-gui: the receiver on port ${port} serves ${tmp.dir} but did not take a new key (it answered 200); nothing was changed.\n`,
      );
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
    expect(readGuiConfig(tmp.dir).uiKey).toBe(before);
    const u = io();
    expect(await runKeyCommand("rotate", u.io)).toBe(2);
    expect(u.err()).toContain('unknown key command "rotate" (renew)');
  });

  it("another folder's run file on a port where this folder's door is not: the other board is not touched", async () => {
    // Y, a receiver for another folder, on a port that X's run file (a live, reused pid) names.
    const yDir = path.join(tmp.dir, "y");
    const y = await createApp({ port: 0, stateDir: yDir, outbox: false, quiet: true });
    apps.push(y);
    await y.keyLooked;
    const yKey = y.config().uiKey;
    const xDir = path.join(tmp.dir, "x");
    readGuiConfig(xDir);
    mkdirSync(doorsDir(xDir), { recursive: true });
    writeFileSync(
      path.join(doorsDir(xDir), `${process.pid}-${y.port}.json`),
      JSON.stringify({ pid: process.pid, port: y.port, urls: [`http://127.0.0.1:${y.port}`], secret: "x-left-this" }),
    );
    // The door's header with another secret: refused outright, never taken as this computer.
    const direct = await fetch(`${y.url}${ROUTES.ui.renewKey}`, {
      method: "POST",
      headers: { [DOOR_HEADER]: "x-left-this" },
    });
    expect(direct.status).toBe(403);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runKeyCommand("renew", {
      stateDir: xDir,
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      probePort: y.port,
    });
    expect(code).toBe(1);
    expect(err.join("")).toBe(
      `sessionpipe-gui: no receiver for ${xDir} answered at the address its run file names (port ${y.port}); the file is from an earlier run.\n` +
        `sessionpipe-gui: the receiver on port ${y.port} serves ${yDir}, not ${xDir}; nothing was changed.\n`,
    );
    expect(out).toEqual([]);
    expect(y.config().uiKey).toBe(yKey);
  });
});

describe("key renew says only what happened", () => {
  it("a folder with no board: nothing is made, nothing changed", async () => {
    const typo = path.join(tmp.dir, "sessionpipe-gu");
    const out: string[] = [];
    const err: string[] = [];
    const code = await runKeyCommand("renew", {
      stateDir: typo,
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      probePort: 9,
    });
    expect(code).toBe(1);
    expect(err.join("")).toBe(`sessionpipe-gui: no board in ${typo}: it holds no config.json. Nothing was changed.\n`);
    expect(out).toEqual([]);
    expect(existsSync(typo)).toBe(false);
  });

  it("a receiver on the port that serves another folder: nothing changed, and that folder named", async () => {
    const before = readGuiConfig(tmp.dir).uiKey;
    const other = path.join(tmp.dir, "other");
    const fake = http.createServer((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "sessionpipe-gui", storage: { dir: other } }));
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const port = (fake.address() as { port: number }).port;
      const t = io({ probePort: port });
      expect(await runKeyCommand("renew", t.io)).toBe(1);
      expect(t.err()).toBe(
        `sessionpipe-gui: the receiver on port ${port} serves ${other}, not ${tmp.dir}; nothing was changed.\n`,
      );
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
    expect(readGuiConfig(tmp.dir).uiKey).toBe(before);
  });

  it("a 204 from something else on a door's port: success is not said, the key is the same", async () => {
    const before = readGuiConfig(tmp.dir).uiKey;
    const fake = http.createServer((_q, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const port = (fake.address() as { port: number }).port;
      mkdirSync(doorsDir(tmp.dir), { recursive: true });
      writeFileSync(
        path.join(doorsDir(tmp.dir), `${process.pid}-${port}.json`),
        JSON.stringify({ pid: process.pid, port, urls: [`http://127.0.0.1:${port}`], secret: "left-by-a-crash" }),
      );
      const t = io();
      expect(await runKeyCommand("renew", t.io)).toBe(1);
      expect(t.err()).toBe(
        `sessionpipe-gui: the receiver on port ${port} answered but ${tmp.dir} has the same key; nothing was changed.\n`,
      );
      expect(t.out()).toBe("");
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
    expect(readGuiConfig(tmp.dir).uiKey).toBe(before);
  });
});

describe("config.json is the owner's: the newest secrets on disk win", () => {
  it("two receivers on one folder: a renewal through one is taken up by the other, and its next write keeps it", async () => {
    const a = await boot();
    const b = await boot();
    const old = a.config().uiKey;
    expect(b.config().uiKey).toBe(old);
    const t = io();
    expect(await runKeyCommand("renew", t.io)).toBe(0);
    const next = readGuiConfig(tmp.dir).uiKey;
    expect(next).not.toBe(old);
    // The other one takes it up without being asked: the old key is refused there too.
    await until(() => (b as unknown as { info(): { uiKey: string } }).info().uiKey === next);
    expect(await visitorStatus(b, old)).toBe(401);
    expect(await visitorStatus(b, next)).toBe(200);
    // A sink-token rotate there writes the new key, never the old one.
    expect((await fetch(`${b.url}${ROUTES.ui.rotateToken}`, { method: "POST" })).status).toBe(200);
    const disk = JSON.parse(readFileSync(path.join(tmp.dir, "config.json"), "utf8"));
    expect(disk.uiKey).toBe(next);
    expect(disk.sinkToken).toBe(b.config().sinkToken);
    // And the first takes up the second's new sink token.
    await until(() => a.info().sinkToken === disk.sinkToken);
  });

  it("one receiver: a sink-token rotate after a renewal keeps the new key", async () => {
    const a = await boot();
    const old = a.config().uiKey;
    a.renewUiKey();
    const next = a.config().uiKey;
    expect((await fetch(`${a.url}${ROUTES.ui.rotateToken}`, { method: "POST" })).status).toBe(200);
    expect(readGuiConfig(tmp.dir).uiKey).toBe(next);
    expect(next).not.toBe(old);
  });

  it("a key the owner wrote by hand is in use at once, and refuses the one before it", async () => {
    const a = await boot();
    const old = a.config().uiKey;
    writeGuiConfig(tmp.dir, { ...readGuiConfig(tmp.dir), uiKey: "OwnerWroteThisKey1" });
    await until(() => a.info().uiKey === "OwnerWroteThisKey1");
    expect(await visitorStatus(a, old)).toBe(401);
    expect(await visitorStatus(a, "OwnerWroteThisKey1")).toBe(200);
  });
});

// The command as typed, through the CLI bundled from source (as config.test.ts does).
describe("sessionpipe-gui key renew", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  let out: string;
  let cli: string;
  beforeAll(async () => {
    mkdirSync(path.join(root, "..", ".tmp"), { recursive: true });
    out = mkdtempSync(path.join(root, "..", ".tmp", "keycmd-"));
    cli = path.join(out, "cli.js");
    await build({
      entryPoints: [path.join(root, "cli.ts")],
      outfile: cli,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "external",
      logLevel: "silent",
    });
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("writes a new key for the next start, prints no key, and is in --help", () => {
    const before = readGuiConfig(tmp.dir);
    const none = spawnSync(
      process.execPath,
      [cli, "key", "renew", "--state", path.join(tmp.dir, "no-board"), "--port", "9"],
      {
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("no board in");
    expect(existsSync(path.join(tmp.dir, "no-board"))).toBe(false);
    const r = spawnSync(process.execPath, [cli, "key", "renew", "--state", tmp.dir, "--port", "9"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(r.status).toBe(0);
    const after = readGuiConfig(tmp.dir);
    expect(after.uiKey).not.toBe(before.uiKey);
    expect(r.stdout + r.stderr).not.toContain(after.uiKey);
    expect(r.stdout + r.stderr).not.toContain(before.uiKey);
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 15_000 });
    expect(help.stdout).toContain("sessionpipe-gui key renew");
  }, 30_000);
});
