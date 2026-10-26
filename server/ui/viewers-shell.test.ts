// SPDX-License-Identifier: Apache-2.0
// The desktop app's menu-bar stream (`x-sessionpipe-client: shell`) is not a viewer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES, type Snapshot, type Viewer } from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { CLIENT_HEADER, isShellClient } from "./viewers.js";

let app: App;
let tmp: { dir: string; cleanup: () => void };

beforeAll(async () => {
  tmp = tempDir();
  app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true });
});
afterAll(async () => {
  await app.close();
  tmp.cleanup();
});

/** Opens a stream and returns its first frame (the snapshot) and a way to close it. */
async function open(headers: Record<string, string>) {
  const ac = new AbortController();
  const res = await fetch(`${app.url}${ROUTES.ui.stream}`, { headers, signal: ac.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!buf.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buf += dec.decode(value, { stream: true });
  }
  const data = buf.split("\n").find((l) => l.startsWith("data: "))!;
  const first = JSON.parse(data.slice(6)) as { kind: string; snapshot: Snapshot };
  return { first, close: () => ac.abort() };
}

const listed = async (): Promise<Viewer[]> =>
  ((await (await fetch(`${app.url}${ROUTES.ui.viewers}`)).json()) as { viewers: Viewer[] }).viewers;

describe("the shell client", () => {
  it("is told apart by its header only", () => {
    expect(isShellClient({ [CLIENT_HEADER]: "shell" })).toBe(true);
    expect(isShellClient({ [CLIENT_HEADER]: " Shell " })).toBe(true);
    expect(isShellClient({ [CLIENT_HEADER]: ["shell", "x"] })).toBe(true);
    expect(isShellClient({ [CLIENT_HEADER]: "browser" })).toBe(false);
    expect(isShellClient({ "user-agent": "sessionpipe-desktop/0.2.0" })).toBe(false);
    expect(isShellClient({})).toBe(false);
  });

  it("gets the snapshot but is never listed as a viewer", async () => {
    const before = (await listed()).length;
    const shell = await open({ [CLIENT_HEADER]: "shell", "user-agent": "sessionpipe-desktop/0.2.0" });
    expect(shell.first.kind).toBe("snapshot");
    expect(shell.first.snapshot.viewers?.some((v) => v.current)).toBe(false);
    expect(await listed()).toHaveLength(before);

    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
    const page = await open({ "user-agent": mac });
    const mine = page.first.snapshot.viewers?.filter((v) => v.current) ?? [];
    expect(mine).toHaveLength(1);
    const now = await listed();
    expect(now).toHaveLength(before + 1);
    expect(now.some((v) => v.label === "Mac · Safari")).toBe(true);

    shell.close();
    page.close();
    for (let i = 0; i < 50 && (await listed()).length > before; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await listed()).toHaveLength(before);
  });
});
