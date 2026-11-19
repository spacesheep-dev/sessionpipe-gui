// SPDX-License-Identifier: Apache-2.0
// One boot through createApp on a temp dir: the receiver, the UI API and the store
// wired together, a restart that finds its own files again, and a clean close.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { type Info, ROUTES, type Snapshot } from "../shared/api.js";
import { Session, tempDir } from "./events.js";

describe("createApp", () => {
  it("boots on a temp dir, takes events over HTTP, serves them to the UI, restarts and closes", async () => {
    const tmp = tempDir();
    try {
      const app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true });
      expect(app.port).toBeGreaterThan(0);
      expect(existsSync(path.join(tmp.dir, "config.json"))).toBe(true);
      const cfg = JSON.parse(readFileSync(path.join(tmp.dir, "config.json"), "utf8"));
      expect(cfg.sinkToken).toMatch(/^spg_/);
      expect(app.config().sinkToken).toBe(cfg.sinkToken);

      const s = new Session("boot");
      const res = await fetch(`${app.url}${ROUTES.events}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.sinkToken}`,
          "sessionpipe-protocol": "1",
        },
        body: JSON.stringify({ events: [s.ev("session.started", { source: "startup" }), s.ev("turn.started")] }),
      });
      expect(res.status).toBe(202);
      const snap = (await (await fetch(`${app.url}${ROUTES.ui.snapshot}`)).json()) as Snapshot;
      expect(snap.sessions.map((x) => x.id)).toEqual(["boot"]);
      const info = (await (await fetch(`${app.url}${ROUTES.ui.info}`)).json()) as Info;
      expect(info.storage.dir).toBe(tmp.dir);
      expect(info.storage.bytes).toBeGreaterThan(0);
      expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
      await app.close();

      const again = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true });
      expect(again.config().sinkToken).toBe(cfg.sinkToken);
      expect(again.store.session("claude-code:boot")!.counts.events).toBe(2);
      await again.close();
      await expect(fetch(`${again.url}/`)).rejects.toThrow();
    } finally {
      tmp.cleanup();
    }
  });

  it("answers a pairing started with no token with the code alone, and one the sink token started with the board's key", async () => {
    const tmp = tempDir();
    const app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true });
    try {
      const key = app.config().uiKey;
      const hello = { name: "box", harnesses: ["claude-code"], modes: ["waiter", "turn"], version: "0.13.6" };
      const pair = (body: unknown, bearer?: string) =>
        fetch(`${app.url}${ROUTES.control}/pair`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
          body: JSON.stringify(body),
        });
      const open = await pair({ ...hello, poll_key: "k".repeat(43) });
      expect(open.status).toBe(201);
      const answer = await open.text();
      expect(answer).not.toContain(key);
      const { code, url } = JSON.parse(answer) as { code: string; url: string };
      expect(url).toBe(`http://localhost:${app.port}/pair?code=${code}`);
      // The well-known file, the one other thing a caller with no token can read, has no key either.
      expect(await (await fetch(`${app.url}${ROUTES.wellKnown}`)).text()).not.toContain(key);
      const keyed = await pair(hello, app.config().sinkToken);
      expect(keyed.status).toBe(201);
      const k = (await keyed.json()) as { code: string; url: string };
      expect(k.url).toBe(`http://localhost:${app.port}/pair?code=${k.code}&k=${encodeURIComponent(key)}`);
    } finally {
      await app.close();
      tmp.cleanup();
    }
  });
});
