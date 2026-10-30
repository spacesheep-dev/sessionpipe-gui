// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The phone app (apps/mobile), played in a test browser: `window.sessionpipeShell` with
// platform "ios" (or "android") and a stand-in `__TAURI_INTERNALS__` whose commands live
// in memory: the receiver list, `rx_add` / `rx_select` (a "switch" reloads the page with
// the receiver set, as the shell rebuilds the window), the settings, notifications,
// haptics, and tauri-plugin-barcode-scanner's commands (`plugin:barcode-scanner|*`), each
// answering as the test says. Nothing here is the shell itself: it pins the page's side
// of the contract (NATIVE-SPEC §2.5, §11.5). The Mac's twin is native-shell.spec.ts.
import type { Page } from "@playwright/test";

export interface PhoneShellOptions {
  platform?: "ios" | "android";
  /** The window shows a receiver (the board); false: none yet (the onboarding). */
  receiver?: boolean;
  firstRunDone?: boolean;
  features?: string[];
  /** `check_permissions`' answer. */
  camera?: "granted" | "denied" | "prompt";
  /** `request_permissions`' answer, when the page asks. */
  grant?: "granted" | "denied";
  /** What `scan` does: resolve with this text ("{origin}" stands for the page's), reject as
   *  cancelled, reject with the plugin's words, or stay pending until the test settles it
   *  through `window.__scan.settle(text | null | Error)`. */
  scan?: { text: string } | { cancel: true } | { throws: string } | { hold: true };
  /** What `rx_add` does: a receiver, a refusal with these words, Cancel in the sheet, or
   *  pending until `window.__add.settle()`. The test may change it live: `window.__fake.add`. */
  add?: "ok" | "cancel" | "hold" | { error: string };
}

type Args = Required<
  Pick<PhoneShellOptions, "platform" | "receiver" | "firstRunDone" | "features" | "camera" | "grant">
> &
  Pick<PhoneShellOptions, "scan" | "add">;

export const PHONE_FEATURES = ["notifications", "signer", "haptics", "scanner"];

function fakePhone(a: Args) {
  const KINDS = [
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
  const w = window as unknown as Record<string, unknown>;
  const receiver = a.receiver || sessionStorage.getItem("fake.selected") === "1";
  const rx = { id: "e2erx00001", name: "studio-mac", origin: location.origin, local: false };
  w.sessionpipeShell = {
    v: 1,
    platform: a.platform,
    appVersion: "0.6.2",
    features: a.features,
    receiver: receiver ? rx : null,
    rxBase: receiver ? "" : null,
  };
  if (document.documentElement) document.documentElement.dataset.shell = a.platform;
  const callbacks = new Map<number, (raw: unknown) => void>();
  const listeners = new Map<string, number[]>();
  const streams = new Map<number, EventSource>();
  let next = 1;
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const fake = { add: a.add ?? "ok", scan: a.scan ?? { hold: true }, camera: a.camera, grant: a.grant };
  const settings = {
    notifications: { enabled: false, kinds: {}, pausedUntil: null as string | null },
    firstRunDone: a.firstRunDone,
  };
  const haptics: string[] = [];
  const send = (id: number, raw: unknown) => callbacks.get(id)?.(raw);
  w.__calls = calls;
  w.__fake = fake;
  w.__haptics = haptics;
  // A pending scan or add the test settles by hand.
  const held = <T>(name: "__scan" | "__add") =>
    new Promise<T>((resolve, reject) => {
      w[name] = { settle: (v: unknown) => (v instanceof Error ? reject(v) : resolve(v as T)) };
    });
  w.__TAURI_INTERNALS__ = {
    transformCallback(cb: (raw: unknown) => void) {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    async invoke(cmd: string, args: Record<string, unknown> = {}) {
      calls.push({ cmd, args });
      switch (cmd) {
        case "plugin:event|listen": {
          const list = listeners.get(args.event as string) ?? [];
          list.push(args.handler as number);
          listeners.set(args.event as string, list);
          return list.length;
        }
        case "rx_stream": {
          const ch = (args.onFrame as { id: number }).id;
          let index = 0;
          const out = (message: unknown) => send(ch, { index: index++, message });
          const sid = next++;
          const es = new EventSource(args.path as string);
          es.onopen = () => out({ event: "open" });
          es.onerror = () => out({ event: "error", retryInMs: 1000 });
          for (const k of KINDS) es.addEventListener(k, (e) => out({ event: k, data: (e as MessageEvent).data }));
          streams.set(sid, es);
          return sid;
        }
        case "rx_stream_close":
          streams.get(args.streamId as number)?.close();
          return null;
        case "rx_list":
          return receiver ? [{ ...rx, connected: true }] : [];
        case "rx_add": {
          const how = fake.add;
          if (how === "cancel") throw new Error("cancelled");
          if (how === "hold") return held<{ id: string } | null>("__add");
          if (typeof how === "object") throw new Error(how.error);
          return { id: rx.id };
        }
        case "rx_select":
          setTimeout(() => {
            sessionStorage.setItem("fake.selected", "1");
            location.reload();
          }, 50);
          return null;
        case "app_settings_get":
          return { ...settings };
        case "app_settings_set":
          Object.assign(settings, args.settings);
          return { ...settings };
        case "app_first_run_done":
          settings.firstRunDone = true;
          return null;
        case "app_notify_status":
          return "undetermined";
        case "app_notify_request":
          return "granted";
        case "app_notify_open_settings":
        case "app_open_external":
        case "app_mark":
        case "app_appearance":
          return null;
        case "app_haptic":
          haptics.push(args.kind as string);
          return null;
        case "app_update_status":
          return { state: "idle" };
        case "plugin:identity|status":
          return { available: false, reason: "Sending needs a real iPhone" };
        case "plugin:barcode-scanner|check_permissions":
          return { camera: fake.camera };
        case "plugin:barcode-scanner|request_permissions":
          fake.camera = fake.grant;
          return { camera: fake.grant };
        case "plugin:barcode-scanner|scan": {
          const how = fake.scan;
          if ("cancel" in how) throw "cancelled";
          if ("throws" in how) throw how.throws;
          if ("text" in how) return { content: how.text.replace("{origin}", location.origin), format: "QR_CODE" };
          const text = await held<string | null>("__scan");
          if (text === null) throw "cancelled";
          return { content: text.replace("{origin}", location.origin), format: "QR_CODE" };
        }
        case "plugin:barcode-scanner|cancel": {
          const s = w.__scan as { settle(v: unknown): void } | undefined;
          s?.settle(null);
          return null;
        }
        case "plugin:barcode-scanner|open_app_settings":
          return null;
        default:
          throw new Error(`fake phone: no ${cmd}`);
      }
    },
  };
}

/** The page at `path`, inside the fake phone app. */
export async function openInPhone(page: Page, path: string, opts: PhoneShellOptions = {}): Promise<void> {
  await page.addInitScript(fakePhone, {
    platform: opts.platform ?? "ios",
    receiver: opts.receiver ?? false,
    firstRunDone: opts.firstRunDone ?? true,
    features: opts.features ?? PHONE_FEATURES,
    camera: opts.camera ?? "granted",
    grant: opts.grant ?? "granted",
    scan: opts.scan,
    add: opts.add,
  } satisfies Args);
  await page.goto(path);
}

export const shellCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: { cmd: string }[] }).__calls.map((c) => c.cmd));

export const shellCallArgs = (page: Page, cmd: string) =>
  page.evaluate(
    (cmd) =>
      (window as unknown as { __calls: { cmd: string; args: unknown }[] }).__calls
        .filter((c) => c.cmd === cmd)
        .map((c) => c.args),
    cmd,
  );

export const haptics = (page: Page) => page.evaluate(() => (window as unknown as { __haptics: string[] }).__haptics);

/** Ends the scan in progress: with a code's text, null (cancelled) or an Error (thrown). */
export const settleScan = (page: Page, v: string | null | { error: string }) =>
  page.evaluate((v) => {
    const s = (window as unknown as { __scan: { settle(v: unknown): void } }).__scan;
    s.settle(v && typeof v === "object" ? new Error(v.error) : v);
  }, v);

export const settleAdd = (page: Page, v: { id: string } | null | { error: string }) =>
  page.evaluate((v) => {
    const s = (window as unknown as { __add: { settle(v: unknown): void } }).__add;
    s.settle(v && "error" in v ? new Error(v.error) : v);
  }, v);

/** Changes what the next `rx_add` does. */
export const setAdd = (page: Page, how: PhoneShellOptions["add"]) =>
  page.evaluate((how) => {
    (window as unknown as { __fake: { add: unknown } }).__fake.add = how;
  }, how);
