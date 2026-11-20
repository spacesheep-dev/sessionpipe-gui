// SPDX-License-Identifier: Apache-2.0
// Pictures for a computer paired on spacesheep (docs/rfcs/08), the receiver's part: a send
// names files only where the computer's hello said it takes them, and the upload of each
// goes to spacesheep's files door as this account, where the computer fetches it; nothing
// of it is held here. Against a stand-in spacesheep: first the upload as a dependency, then
// through the whole receiver with a link to a spacesheep on this machine.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROUTES } from "../../shared/api.js";
import { FakeSpacesheep } from "../../test/account/fake-spacesheep.js";
import { type App, createApp } from "../app.js";
import { Router } from "../http/router.js";
import { type ControlDeps, createControl } from "./index.js";
import { fileSha256, type RemoteUploadAnswer, uploadTimeoutMs } from "./remote.js";
import { commandStr } from "./testkeys.js";

const SINK = "spg_test_sink_token_0123456789";
const UI = ROUTES.ui.control;
const REMOTE = { via: "spacesheep" as const, origin: "https://spacesheep.dev", rpId: "spacesheep.dev" };
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3,
]);

const tmpDirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "spgui-relayfiles-"));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function boot(o: Pick<ControlDeps, "remoteSend" | "remoteUpload"> = {}) {
  const stateDir = tmp();
  const control = createControl({
    stateDir,
    sinkToken: () => SINK,
    rpId: "localhost",
    testDoor: false,
    uiAuth: (ctx) => ctx.remote.loopback,
    ...o,
  });
  const router = new Router();
  control.register(router);
  const server = http.createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    control,
    close: async () => {
      control.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function call(url: string, p: string, body: unknown) {
  const r = await fetch(`${url}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function upload(url: string, machine: string, bytes = PNG, type = "image/png", name = "kiwi.png") {
  const r = await fetch(`${url}${UI}/files?name=${encodeURIComponent(name)}&machine=${machine}`, {
    method: "POST",
    headers: { "content-type": type },
    body: bytes,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

const listed = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: "lab-mac",
  online: true,
  agents: ["claude-code"],
  passkey_ids: ["k1"],
  ...over,
});

describe("a send for a computer reached through spacesheep", () => {
  it("names files only where the computer's hello said it takes them", async () => {
    const asked: string[] = [];
    const b = await boot({
      remoteSend: async (_m, body) => {
        asked.push(JSON.parse(String(body.cmd)).kind);
        return { status: 202, json: { job: asked.length } };
      },
    });
    try {
      const OLD = "m_relayfilesold0000001";
      const TAKES = "m_relayfilestakes00002";
      const START_ONLY = "m_relayfilesstart00003";
      b.control.remote.upsert(
        [
          listed(OLD, { name: "old-mac" }),
          listed(TAKES, { name: "new-mac", files: true, prompt_files: true }),
          listed(START_ONLY, { name: "mid-mac", files: true }),
        ],
        REMOTE,
      );
      const file = { name: "kiwi.png", type: "image/png", size: PNG.length, sha256: await fileSha256(PNG) };
      const send = (machine: string, fields: Record<string, unknown>) =>
        call(b.url, `${UI}/send`, {
          machineId: machine,
          cmd: commandStr(machine, { iat: Date.now(), ...fields }),
          csig: "c2ln",
        });
      const start = { kind: "start", session: "claude-code:s-new", cwd: "/Users/demo/acme/web", files: [file] };
      const prompt = { files: [file] };

      expect(await send(OLD, start)).toEqual({
        status: 422,
        body: { reason: "Update sessionpipe on old-mac to send files.", code: "relay_files" },
      });
      expect(await send(OLD, prompt)).toEqual({
        status: 422,
        body: { reason: "Update sessionpipe on old-mac to 0.10 or later to send pictures.", code: "relay_files" },
      });
      expect(await send(START_ONLY, prompt)).toEqual({
        status: 422,
        body: { reason: "Update sessionpipe on mid-mac to 0.10 or later to send pictures.", code: "relay_files" },
      });
      expect(asked).toEqual([]);

      expect((await send(START_ONLY, start)).status).toBe(201);
      expect((await send(TAKES, start)).status).toBe(201);
      const sent = await send(TAKES, prompt);
      expect(sent.status).toBe(201);
      expect(sent.body.files).toEqual([file]);
      expect(asked).toEqual(["start", "start", "prompt"]);
    } finally {
      await b.close();
    }
  });
});

describe("an upload for a computer reached through spacesheep", () => {
  it("goes to spacesheep and not to this disk; spacesheep's answer is held against the receiver's own hash", async () => {
    const got: { bytes: Uint8Array; type: string; name: string }[] = [];
    let answer: (own: string) => RemoteUploadAnswer = (own) => ({
      status: 200,
      json: { sha256: own, size: PNG.length, type: "image/png", url: "https://spacesheep.dev/talk-files/x" },
    });
    const b = await boot({
      remoteUpload: async (file) => {
        got.push(file);
        return answer(await fileSha256(file.bytes));
      },
    });
    try {
      const M = "m_relayfilestakes00002";
      b.control.remote.upsert([listed(M, { files: true, prompt_files: true })], REMOTE);
      const own = await fileSha256(PNG);
      const ok = await upload(b.url, M, PNG, "image/png", "Screenshot at 10.41 PM.png");
      // The entry a command names, and the pixels the receiver read; nothing of spacesheep's link.
      expect(ok).toEqual({
        status: 201,
        body: {
          name: "Screenshot at 10.41 PM.png",
          type: "image/png",
          size: PNG.length,
          sha256: own,
          width: 2,
          height: 3,
        },
      });
      expect(got.map((f) => [f.name, f.type, f.bytes.length])).toEqual([
        ["Screenshot at 10.41 PM.png", "image/png", PNG.length],
      ]);
      // Nothing is held here: the page's thumbnail route has none of it.
      expect((await fetch(`${b.url}${UI}/files/${own}`)).status).toBe(404);

      // Another hash, or another size: not what the page signs.
      answer = () => ({ status: 200, json: { sha256: "A".repeat(43), size: PNG.length, type: "image/png" } });
      expect(await upload(b.url, M)).toEqual({
        status: 502,
        body: { reason: "not_whole", error: "The picture didn't arrive whole. Try again." },
      });
      answer = (sha256) => ({ status: 200, json: { sha256, size: 1, type: "image/png" } });
      expect((await upload(b.url, M)).body.reason).toBe("not_whole");

      // spacesheep's refusals, in the words every page says them with.
      const cases: [RemoteUploadAnswer, number, Record<string, unknown>][] = [
        [
          { status: 401, json: { error: "unauthorized" } },
          502,
          { reason: "spacesheep_refused", error: "spacesheep.dev can't take pictures from here yet." },
        ],
        [
          { status: 403, json: { error: "Turn on Talk.", code: "talk_off" } },
          502,
          { reason: "spacesheep_refused", error: "spacesheep.dev can't take pictures from here yet." },
        ],
        [
          { status: 415, json: { error: "That file isn't the picture its type says.", code: "not_a_picture" } },
          415,
          { reason: "not_an_image", error: "That file isn't a picture." },
        ],
        [
          { status: 429, json: { error: "rate_limited", retry_after: 290 }, retryAfter: 290 },
          429,
          {
            reason: "rate_limited",
            error: "That's a lot of pictures in a short time. Try again in 5 minutes.",
            retry_after: 290,
          },
        ],
        [
          { status: 429, json: { error: "rate_limited", retry_after: 30 } },
          429,
          {
            reason: "rate_limited",
            error: "That's a lot of pictures in a short time. Try again in a minute.",
            retry_after: 30,
          },
        ],
        [
          { status: 413, json: { error: "That file is over 25 MB.", code: "too_large" } },
          413,
          { reason: "too_large", error: "That file is over 25 MB." },
        ],
        [
          { status: 500, json: { error: "internal" } },
          502,
          { reason: "spacesheep_failed", error: "spacesheep.dev couldn't save the picture. Try again." },
        ],
      ];
      for (const [a, status, body] of cases) {
        answer = () => a;
        expect(await upload(b.url, M), JSON.stringify(a)).toEqual({ status, body });
      }
      // A file that is not the picture its type says goes nowhere.
      const before = got.length;
      expect((await upload(b.url, M, new Uint8Array([1, 2, 3, 4]))).status).toBe(415);
      expect(got.length).toBe(before);
    } finally {
      await b.close();
    }
  });

  it("a machine paired here keeps its uploads here, as before", async () => {
    const asked: unknown[] = [];
    const b = await boot({
      remoteUpload: async (f) => {
        asked.push(f);
        return { status: 200, json: {} };
      },
    });
    try {
      const r = await upload(b.url, "m_pairedhere0000000001");
      expect(r.status).toBe(201);
      expect(asked).toEqual([]);
      expect((await fetch(`${b.url}${UI}/files/${r.body.sha256}`)).status).toBe(200);
    } finally {
      await b.close();
    }
  });

  it("is given as long as the app's hub gives its files door: 15 s, a second more a 32 KiB, 10 minutes at most", () => {
    expect(uploadTimeoutMs(0)).toBe(15_000);
    expect(uploadTimeoutMs(1)).toBe(16_000);
    expect(uploadTimeoutMs(5_000_000)).toBe(168_000);
    expect(uploadTimeoutMs(26_214_400)).toBe(600_000);
  });
});

describe("a receiver connected to spacesheep", () => {
  let app: App | null = null;
  let ss: http.Server | null = null;
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => (ss ? ss.close(() => r()) : r()));
  });

  it("uploads a picture for one of its spacesheep computers with the account's key, and keeps none of it", async () => {
    const fake = new FakeSpacesheep();
    const M = "m_relayfilestakes00002";
    fake.machines = [listed(M, { files: true, prompt_files: true, key_types: ["passkey"] })];
    const auth: string[] = [];
    ss = http.createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const c of req) parts.push(c as Buffer);
      const bytes = Buffer.concat(parts);
      if (req.url?.startsWith("/api/machines/files")) auth.push(String(req.headers.authorization));
      const a = await fake.handle({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(bytes.length ? { body: bytes.toString("utf8"), bytes: new Uint8Array(bytes) } : {}),
        headers: {
          "content-type": String(req.headers["content-type"] ?? ""),
          "x-file-name": String(req.headers["x-file-name"] ?? ""),
        },
      });
      res.writeHead(a.status, a.headers);
      res.end(a.body);
    });
    await new Promise<void>((r) => ss!.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(ss.address() as { port: number }).port}`;
    const dir = tmp();
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        spacesheep: { origin, key: fake.key, email: "you@example.com", connectedAt: new Date().toISOString() },
      }),
    );
    app = await createApp({ port: 0, stateDir: dir, outbox: false, quiet: true });
    // The relay's list makes the computer a row here.
    for (let i = 0; i < 50 && !app.control.machines().has("lab-mac"); i++) await new Promise((r) => setTimeout(r, 50));
    expect(app.control.machines().get("lab-mac")).toMatchObject({ promptFiles: true, files: true });

    const r = await upload(app.url, M, PNG, "image/png", "kiwi ü.png");
    const own = await fileSha256(PNG);
    expect(r).toEqual({
      status: 201,
      body: { name: "kiwi ü.png", type: "image/png", size: PNG.length, sha256: own, width: 2, height: 3 },
    });
    expect(auth).toEqual([`Bearer ${fake.key}`]);
    expect(fake.files).toEqual([{ sha256: own, size: PNG.length, type: "image/png", name: "kiwi ü.png" }]);
    expect((await fetch(`${app.url}${UI}/files/${own}`)).status).toBe(404);

    // A spacesheep that takes no key on that door yet.
    fake.fileAnswer = {
      status: 401,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "unauthorized" }),
    };
    expect(await upload(app.url, M)).toEqual({
      status: 502,
      body: { reason: "spacesheep_refused", error: "spacesheep.dev can't take pictures from here yet." },
    });

    // A computer on another spacesheep than the one this board is connected to: its picture
    // goes nowhere, as a send to it would not.
    const FAR = "m_relayfilesfar0000004";
    app.control.remote.upsert([listed(FAR, { name: "far-mac", files: true, prompt_files: true })], {
      via: "spacesheep",
      origin: "https://other.example.com",
      rpId: "other.example.com",
    });
    const sent = auth.length;
    expect(await upload(app.url, FAR)).toEqual({
      status: 503,
      body: { reason: "no_relay", error: "Not connected to spacesheep any more." },
    });
    expect(auth).toHaveLength(sent);
  });
});
