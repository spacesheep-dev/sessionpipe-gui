// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Test helper: the native shell as a page finds it, for a plain browser (docs/rfcs/08, "The
// phone on an account"). An init script, so it runs before any page script, as the shell's
// does: `window.sessionpipeShell` (the contract, read from the hub stood in behind
// test/account/serve.ts) and `__TAURI_INTERNALS__` (the app's IPC: the hub's commands and
// events, and the `identity` plugin). The plugin is a software P-256 key kept in
// localStorage that signs exactly what CONTROL.md §2-3 says a device key signs, where the
// app has the Secure Enclave and Face ID; a real spacesheep verifies what it signs.
// Nothing here is the shell itself: it pins the page's side of the contract.

export interface ShellInitOptions {
  /** `false`: the signer says it cannot sign here, with this reason (Android today). */
  signer?: false | string;
  /** The page's settings, so a test starts where a person who has used the app is. */
  settled?: boolean;
}

export function fakeShell(o: ShellInitOptions = {}) {
  // The contract is the hub's word at the moment the window opens: read before any script.
  const x = new XMLHttpRequest();
  x.open("GET", "/__hub/contract", false);
  x.send();
  const contract = JSON.parse(x.responseText) as { receiver: { id: string } | null; platform: string };
  (window as unknown as Record<string, unknown>).sessionpipeShell = Object.freeze(contract);
  if (o.settled !== false) {
    localStorage.setItem("sessionpipe-gui.setup.seen", "1");
    localStorage.setItem("sessionpipe-gui.native.firstRun", "1");
    if (!localStorage.getItem("sessionpipe-gui.settings"))
      localStorage.setItem("sessionpipe-gui.settings", JSON.stringify({ mode: "advanced" }));
  }

  const b64u = (buf: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const enc = new TextEncoder();
  const sha = async (v: string | Uint8Array) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", (typeof v === "string" ? enc.encode(v) : v) as BufferSource));
  const P256 = { name: "ECDSA", namedCurve: "P-256" };
  const LS = "account-test.devicekey";
  type Dev = { key: Record<string, unknown> & { id: string }; jwk: JsonWebKey; priv: CryptoKey };
  let dev: Dev | null = null;
  const grants = new Map<string, { day: CryptoKeyPair; exp: number; grant: Record<string, unknown> }>();
  const taps: { purpose: string; at: number }[] = [];
  (window as unknown as Record<string, unknown>).__taps = taps;
  async function device(make: boolean): Promise<Dev | null> {
    if (dev) return dev;
    const saved = localStorage.getItem(LS);
    if (saved) {
      const k = JSON.parse(saved) as Dev;
      k.priv = await crypto.subtle.importKey("jwk", k.jwk, P256, false, ["sign"]);
      dev = k;
      return k;
    }
    if (!make) return null;
    const kp = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    const key = {
      id: b64u(await sha(spki)),
      alg: -7,
      spki: b64u(spki),
      type: "device",
      store: "hardware",
      uv: "each-use",
    };
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    localStorage.setItem(LS, JSON.stringify({ key, jwk }));
    dev = { key, jwk, priv: kp.privateKey };
    return dev;
  }
  const devSign = async (k: Dev, purpose: string, rp: string, challenge: Uint8Array) => {
    taps.push({ purpose, at: Date.now() });
    const msg = enc.encode(`sessionpipe.device.v1\n${purpose}\n${rp}\n${b64u(challenge)}`);
    return b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.priv, msg));
  };
  async function grantFor(k: Dev, rp: string, fresh: boolean) {
    const have = grants.get(rp);
    if (have && !fresh && have.exp > Date.now() + 60_000) return have;
    const day = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
    const pub = b64u(await crypto.subtle.exportKey("spki", day.publicKey));
    const iat = Date.now();
    const exp = iat + 23 * 3600_000;
    const str = JSON.stringify({ v: 1, t: "sessionpipe.grant", pub, iat, exp, rp });
    const g = { day, exp, grant: { cred: k.key.id, sig: await devSign(k, "grant", rp, await sha(str)), str } };
    grants.set(rp, g);
    return g;
  }
  const cannot = o.signer === undefined ? null : o.signer || "this phone can't sign yet";
  const identity: Record<string, (a: Record<string, unknown>) => Promise<unknown>> = {
    async status({ rp }) {
      if (cannot) return { available: false, reason: cannot };
      const k = await device(false);
      return { available: true, ...(k ? { key: k.key } : {}), grantExp: grants.get(String(rp))?.exp ?? null };
    },
    async key() {
      if (cannot) throw { code: "unsupported", message: cannot };
      return (await device(true))!.key;
    },
    async forget() {
      localStorage.removeItem(LS);
      dev = null;
    },
    async sign({ rp, cmd, mode, fresh }) {
      if (cannot) throw { code: "unsupported", message: cannot };
      const k = (await device(true))!;
      if (mode === "confirm")
        return {
          cmd,
          confirm: { cred: k.key.id, sig: await devSign(k, "confirm", String(rp), await sha(String(cmd))) },
        };
      const g = await grantFor(k, String(rp), !!fresh);
      if (cmd === null || cmd === undefined) return {};
      const csig = b64u(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, g.day.privateKey, enc.encode(String(cmd))),
      );
      return { cmd, csig, grant: g.grant };
    },
  };

  let n = 0;
  const cbs = new Map<number, (raw: unknown) => void>();
  const heard = new Map<number, string>();
  const invoked: string[] = [];
  (window as unknown as Record<string, unknown>).__invoked = invoked;
  const hub = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    // `acct_device_ask` reads the signer's key natively: here the page's software key rides along.
    const deviceKey = cmd === "acct_device_ask" && !cannot ? (await device(true))!.key : undefined;
    const r = await fetch("/__hub/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd, args, deviceKey }),
    });
    const j = (await r.json()) as { ok?: unknown; err?: unknown };
    if ("err" in j) throw j.err;
    return j.ok;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback(cb: (raw: unknown) => void) {
      const id = ++n;
      cbs.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      cbs.delete(id);
    },
    async invoke(cmd: string, args: Record<string, unknown> = {}) {
      invoked.push(cmd);
      if (cmd.startsWith("plugin:identity|")) return identity[cmd.split("|")[1]!]!(args);
      if (cmd === "plugin:event|listen") {
        heard.set(Number(args.handler), String(args.event));
        return Number(args.handler);
      }
      if (cmd === "plugin:event|unlisten") return void heard.delete(Number(args.eventId));
      if (cmd.startsWith("acct_") || cmd.startsWith("rx_")) return hub(cmd, args);
      if (cmd === "app_settings_get" || cmd === "app_settings_set")
        return { notifications: { enabled: false, kinds: {}, pausedUntil: null }, firstRunDone: true };
      if (cmd === "app_notify_status") return "undetermined";
      if (cmd === "app_update_status") return { state: "idle" };
      return null;
    },
  };
  // The hub's events, as the app's event plugin would deliver them.
  let since = 0;
  const pump = async (): Promise<void> => {
    for (;;) {
      try {
        const r = await fetch(`/__hub/events?since=${since}`);
        const j = (await r.json()) as { events: { n: number; event: string; payload: unknown }[]; next: number };
        for (const e of j.events) {
          since = Math.max(since, e.n);
          for (const [id, event] of heard) if (event === e.event) cbs.get(id)?.({ payload: e.payload });
        }
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  };
  void pump();
}
