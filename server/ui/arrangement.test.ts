// SPDX-License-Identifier: Apache-2.0
// The arrangement as the receiver keeps it: its file (private, written whole, read back,
// a broken one set aside), its routes (the UI guard, JSON only, the rules' refusals), the
// snapshot and the stream frames, and a forgotten session losing its place and pin.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Arrangement, ROUTES, type Snapshot, type StreamMessage, sessionKey } from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { Router } from "../http/router.js";
import { ArrangementStore, registerArrangement } from "./arrangement.js";
import { uiGuard } from "./index.js";

describe("ArrangementStore", () => {
  it("changes, bumps rev, writes the file private and whole, and reads it back", () => {
    const tmp = tempDir();
    try {
      const store = new ArrangementStore(tmp.dir, () => true);
      const frames: StreamMessage[] = [];
      store.subscribe((m) => frames.push(m));
      expect(store.get()).toEqual({ rev: 0, placed: {}, pinned: [] });
      store.patch({ placed: { "codex:b": "claude-code:a" }, pinned: ["claude-code:a"] });
      store.patch({ placed: { "codex:b": "claude-code:a" } });
      expect(store.get()).toEqual({ rev: 1, placed: { "codex:b": "claude-code:a" }, pinned: ["claude-code:a"] });
      expect(frames.map((f) => (f as { arrangement: Arrangement }).arrangement.rev)).toEqual([1]);
      const file = path.join(tmp.dir, "arrangement.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readdirSync(tmp.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, ...store.get() });
      expect(new ArrangementStore(tmp.dir, () => true).get()).toEqual(store.get());
    } finally {
      tmp.cleanup();
    }
  });

  it("sets a broken file aside and starts empty", () => {
    const tmp = tempDir();
    try {
      writeFileSync(path.join(tmp.dir, "arrangement.json"), "{nope");
      expect(new ArrangementStore(tmp.dir, () => true).get()).toEqual({ rev: 0, placed: {}, pinned: [] });
      expect(readdirSync(tmp.dir).some((f) => f.startsWith("arrangement.json.bad-"))).toBe(true);
      expect(existsSync(path.join(tmp.dir, "arrangement.json"))).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });

  it("refuses a page off this machine without the UI key, reading or changing", async () => {
    const tmp = tempDir();
    try {
      const router = new Router();
      registerArrangement(
        router,
        new ArrangementStore(tmp.dir, () => true),
        uiGuard(() => "key"),
      );
      const ctx = {
        remote: { ip: "192.168.1.9", loopback: false, thisComputer: false },
        url: new URL("http://x/"),
        cookies: () => ({}),
        req: { headers: { "content-type": "application/json" } },
      };
      for (const method of ["GET", "PATCH"] as const) {
        const reply = await router.match(method, ROUTES.ui.arrangement)!.handler(ctx as never);
        expect(reply).toEqual({ status: 401, json: { reason: "unauthorized" } });
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe("arrangement routes", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  const url = (p: string) => `${app.url}${p}`;
  const patch = (body: unknown, type = "application/json") =>
    fetch(url(ROUTES.ui.arrangement), {
      method: "PATCH",
      headers: { "content-type": type },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const a = new Session("0b9e4c1e-1111-4a4a-9a9a-000000000001");
  const b = new Session("0b9e4c1e-2222-4a4a-9a9a-000000000002");
  const A = sessionKey("claude-code", a.id);
  const B = sessionKey("claude-code", b.id);

  beforeAll(async () => {
    tmp = tempDir();
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true });
    app.store.ingest(
      [a.ev("session.started", { source: "startup" }), b.ev("session.started", { source: "startup" })],
      "http",
    );
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("GET reads, PATCH changes, the snapshot and the stream carry it, forget drops it", async () => {
    expect(await (await fetch(url(ROUTES.ui.arrangement))).json()).toEqual({ rev: 0, placed: {}, pinned: [] });
    const res = await fetch(url(ROUTES.ui.stream));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const next = async (kind: string): Promise<StreamMessage> => {
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          const m = data ? (JSON.parse(data.slice(6)) as StreamMessage) : null;
          if (m?.kind === kind) return m;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value, { stream: true });
      }
    };
    const first = (await next("snapshot")) as { snapshot: Snapshot };
    expect(first.snapshot.arrangement).toEqual({ rev: 0, placed: {}, pinned: [] });

    const ok = await patch({ placed: { [B]: A }, pinned: [A] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ rev: 1, placed: { [B]: A }, pinned: [A] });
    expect(((await next("arrangement")) as { arrangement: Arrangement }).arrangement.rev).toBe(1);
    expect(((await (await fetch(url(ROUTES.ui.snapshot))).json()) as Snapshot).arrangement?.placed[B]).toBe(A);

    // The rules' refusals, each changing nothing.
    expect((await patch({ placed: { [A]: B } })).status).toBe(400);
    expect(await (await patch({ placed: { [A]: B } })).json()).toEqual({ reason: "bad_place" });
    expect(await (await patch({ placed: {}, nope: true })).json()).toEqual({ reason: "malformed" });
    expect(await (await patch({ placed: { "not a key": A } })).json()).toEqual({ reason: "malformed" });
    expect((await patch({ placed: { "claude-code:nobody": A } })).status).toBe(404);
    expect((await patch({ pinned: [A] }, "text/plain")).status).toBe(415);
    expect((await patch("{nope")).status).toBe(400);
    const pins = Array.from({ length: 101 }, (_, i) => `codex:pin-${i}`);
    expect((await patch({ pinned: pins })).status).toBe(413);
    expect(((await (await fetch(url(ROUTES.ui.arrangement))).json()) as Arrangement).rev).toBe(1);

    // Forgetting the parent keeps the placement under it (inert); forgetting the child drops it.
    expect((await fetch(url(`${ROUTES.ui.forget}/claude-code/${a.id}/forget`), { method: "POST" })).status).toBe(204);
    expect(((await next("arrangement")) as { arrangement: Arrangement }).arrangement).toEqual({
      rev: 2,
      placed: { [B]: A },
      pinned: [],
    });
    expect((await fetch(url(`${ROUTES.ui.forget}/claude-code/${b.id}/forget`), { method: "POST" })).status).toBe(204);
    expect(((await next("arrangement")) as { arrangement: Arrangement }).arrangement.placed).toEqual({});
    await reader.cancel();
  });
});
