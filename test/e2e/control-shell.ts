// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The native app, played in a test browser: `window.sessionpipeShell` and a stand-in for
// the Tauri runtime's `__TAURI_INTERNALS__`, set before any page script runs. The
// `identity` plugin's commands go to the receiver's test door (_test/device/*), whose
// software TestDeviceKey signs exactly what sp-identity would (CONTROL.md §3.2); the live
// stream goes over the same IPC channel shape as `rx_stream`, fed by a real EventSource.
// Nothing here is the shell itself: it pins the page's side of the contract.
import type { BrowserContext } from "@playwright/test";

export const STREAM_KINDS = [
  "snapshot",
  "event",
  "session",
  "forgotten",
  "machine",
  "stats",
  "control",
  "viewers",
  "suggestion",
  "labels",
  "viewState",
];

export async function asMacApp(context: BrowserContext, origin: string): Promise<void> {
  await context.addInitScript(
    ({ origin, kinds }) => {
      localStorage.setItem("sessionpipe-gui.setup.seen", "1");
      localStorage.setItem("sessionpipe-gui.settings", JSON.stringify({ mode: "advanced" }));
      localStorage.setItem("sessionpipe-gui.native.firstRun", "1");
      (window as unknown as Record<string, unknown>).sessionpipeShell = {
        v: 1,
        platform: "macos",
        appVersion: "0.0.0-e2e",
        features: ["signer"],
        receiver: { id: "rxe2e000", name: "This Mac", origin, local: true },
        rxBase: null,
      };
      const cbs = new Map<number, (raw: unknown) => void>();
      let next = 1;
      const streams = new Map<number, EventSource>();
      const calls: { cmd: string; args: Record<string, unknown> }[] = [];
      (window as unknown as Record<string, unknown>).__identityCalls = calls;
      const door = (p: string, body: unknown = {}) =>
        fetch(`/api/sessionpipe/v1/control/_test/device/${p}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw { code: "failed", message: j.error ?? j.reason ?? `HTTP ${r.status}` };
          return j;
        });
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        transformCallback(cb: (raw: unknown) => void) {
          const id = next++;
          cbs.set(id, cb);
          return id;
        },
        unregisterCallback(id: number) {
          cbs.delete(id);
        },
        async invoke(cmd: string, args: Record<string, unknown> = {}) {
          if (cmd.startsWith("plugin:identity|")) calls.push({ cmd, args: { ...args } });
          switch (cmd) {
            case "plugin:identity|status":
              // Rust answers status from the keychain alone: no key yet where the door has none.
              return { available: true, key: (await door("key").catch(() => ({}))).key, grantExp: null };
            case "plugin:identity|key":
              return (await door("key")).key;
            case "plugin:identity|sign":
              return args.cmd ? door("sign", { cmd: args.cmd, mode: args.mode }) : {};
            case "plugin:identity|pair":
              return door("pair", { code: args.code });
            case "plugin:event|listen":
              return 1;
            case "rx_stream": {
              const ch = args.onFrame as { id: number };
              const send = (() => {
                let i = 0;
                return (message: unknown) => cbs.get(ch.id)?.({ index: i++, message });
              })();
              const es = new EventSource(String(args.path));
              for (const k of kinds) es.addEventListener(k, (e) => send({ event: k, data: (e as MessageEvent).data }));
              es.onopen = () => send({ event: "open" });
              es.onerror = () => {
                es.close();
                send({ event: "error", retryInMs: 1000 });
              };
              const id = next++;
              streams.set(id, es);
              return id;
            }
            case "rx_stream_close":
              streams.get(args.streamId as number)?.close();
              return null;
            default:
              return null;
          }
        },
      };
    },
    { origin, kinds: STREAM_KINDS },
  );
}
