// SPDX-License-Identifier: Apache-2.0
// The stand-in server for the app's half (serve.ts): what it answers when it fails itself.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSpacesheep } from "./fake-spacesheep.js";
import { HubRefused, HubStandIn } from "./hub.js";
import { type AccountServer, FAILED, startAccountServer } from "./serve.js";

describe("the stand-in server for the app's half", () => {
  let server: AccountServer | null = null;
  const web = mkdtempSync(path.join(tmpdir(), "spgui-serve-"));
  afterEach(async () => {
    await server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  it("answers its own faults in fixed words: no error's text, and no stack, leaves in an answer", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const ss = new FakeSpacesheep();
    const hub = new HubStandIn({ upstream: { origin: "https://spacesheep.test", ask: (req) => ss.handle(req) } });
    const secret = "ENOENT: /Users/somebody/private/thing.ts:12:3";
    const invoke = hub.invoke.bind(hub);
    hub.invoke = async (cmd, args) => {
      if (cmd === "boom") throw new Error(secret);
      if (cmd === "no") throw new HubRefused("busy", "Another question is open.");
      return invoke(cmd, args);
    };
    server = await startAccountServer({ web, hub });
    const call = async (cmd: string) =>
      (await fetch(`${server!.url}/__hub/invoke`, { method: "POST", body: JSON.stringify({ cmd }) })).text();
    // A fault of the stand-in: fixed words; the error is in the test's console.
    const boom = await call("boom");
    expect(JSON.parse(boom)).toEqual({ err: { code: "failed", message: FAILED } });
    expect(boom).not.toContain("ENOENT");
    expect(boom).not.toMatch(/\bat \S+ \(|\.ts:\d+/);
    expect(said).toHaveBeenCalled();
    // The hub's own refusal is its answer, as it is.
    expect(JSON.parse(await call("no"))).toMatchObject({ err: { code: "busy", message: "Another question is open." } });
    // A request the server itself cannot read: the same fixed words.
    const bad = await (await fetch(`${server.url}/__hub/invoke`, { method: "POST", body: "{not json" })).text();
    expect(bad).not.toContain("JSON");
    expect(JSON.parse(bad)).toEqual({ error: FAILED });
    rmSync(web, { recursive: true, force: true });
  });
});
