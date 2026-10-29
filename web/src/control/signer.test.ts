// SPDX-License-Identifier: Apache-2.0
// Who signs on this page: the passkey in a browser, the app's device key inside the shell
// (through a mocked Tauri runtime); key.add carries a device key whole; the receiver's and
// the machine's key_types gate the app; Approve's one line where a daemon is too old.
import type { KeyType } from "@shared/api";
import "../native/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetInfoCache, rpId } from "./api";
import { commandString } from "./command";
import { keyTypesOf, refresh } from "./nativeSigner";
import {
  approveBlocker,
  approveTarget,
  canSign,
  dropGrant,
  grantExpiry,
  machineTakes,
  NoGrantError,
  nativeErrorWords,
  nativeSigner,
  ownKeys,
  setupWords,
  sign,
  signerKind,
  signerLabel,
  signHint,
  unlock,
  updateWords,
} from "./signer";

const g = globalThis as Record<string, unknown>;
const DEVICE = {
  id: "Zq3v9Vw0dI5w8l0yQkVg2dYk1Yb8a1sXnXcI3pK2m8o",
  alg: -7,
  spki: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
  type: "device" as const,
  store: "hardware" as const,
  uv: "each-use" as const,
};
const MACHINE = "m_testmachine0000000001";

/** The shell's flag and a stand-in Tauri runtime whose `invoke` the test scripts. */
function inShell(
  answer: (cmd: string, args: Record<string, unknown>) => unknown,
  features = ["signer"],
  shell: Record<string, unknown> = {},
) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  g.sessionpipeShell = {
    v: 1,
    platform: "macos",
    features,
    receiver: { id: "rx0123abcd", name: "This Mac", origin: "http://127.0.0.1:7819", local: true },
    rxBase: null,
    ...shell,
  };
  g.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      return answer(cmd, args);
    },
    transformCallback: () => 1,
  };
  return calls;
}

afterEach(() => {
  delete g.sessionpipeShell;
  delete g.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  resetInfoCache();
});

describe("signer selection", () => {
  it("a browser signs with its passkey; the app with its device key", () => {
    expect(signerKind()).toBe("passkey");
    expect(signerLabel()).toBe("your passkey");
    inShell(() => null);
    expect(signerKind()).toBe("device");
    expect(signerLabel()).toBe("Touch ID");
  });

  it("the app can sign only where the shell says `signer` and the receiver carries device keys", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        control: { rpId: "localhost" },
        wellKnown: { control: { signing: { rp_id: "localhost", key_types: ["passkey", "device"] } } },
      }),
    );
    inShell(() => ({ available: true }), []);
    await nativeSigner();
    expect(canSign("localhost")).toBe(false);
    inShell(() => ({ available: true }));
    // Before Info is read: passkeys only, so no.
    expect(canSign("localhost")).toBe(false);
    await rpId();
    expect(canSign("localhost")).toBe(true);
  });

  it("today's receiver (passkeys only) and a shell without the signer: no device key, the browser fallback in words", async () => {
    // What a receiver says while its sessionpipe-core can't verify device keys (devicekeys.ts).
    vi.stubGlobal("fetch", async () =>
      Response.json({
        control: { enabled: true, rpId: "localhost", machines: 1, keyTypes: ["passkey"] },
        wellKnown: { control: { signing: { rp_id: "localhost", algs: [-7, -257] } } },
      }),
    );
    inShell(() => ({ available: true }));
    await nativeSigner();
    await rpId();
    expect(canSign("localhost")).toBe(false);
    expect(signHint("localhost")).toBe(
      "the receiver can't check this Mac's key yet: update sessionpipe-gui on this Mac to send from the app, or send from a browser",
    );
    // A build without the `identity` feature advertises no signer.
    inShell(() => ({ available: true }), []);
    expect(canSign("localhost")).toBe(false);
    expect(signHint("localhost")).toBe("this build of the app has no signer: send from a browser");
    // A browser on the same receiver still signs with its passkey, whatever the app can't.
    delete g.sessionpipeShell;
    expect(signerKind()).toBe("passkey");
    expect(machineTakes({ keyTypes: undefined })).toBe(true);
  });

  it("the line says exactly why the app can't sign, with the next step", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ control: { enabled: true, rpId: "localhost", machines: 1, keyTypes: ["passkey"] } }),
    );
    await nativeSigner();
    // The app on Linux or Windows: built without the signer.
    inShell(() => null, [], { platform: "linux" });
    expect(signHint("localhost")).toBe("the app signs on a Mac only for now: send from a browser");
    // No receiver in this window yet.
    inShell(() => null, ["signer"], { receiver: null });
    expect(canSign("localhost")).toBe(false);
    expect(signHint("localhost")).toBe("no receiver is open in this window");
    // A receiver on another computer, whose sessionpipe-core predates device keys: named.
    inShell(() => null, ["signer"], {
      receiver: { id: "rx0123abcd", name: "studio", origin: "https://studio.local:7373", local: false },
    });
    await rpId();
    expect(signHint("localhost")).toBe(
      "the receiver can't check this Mac's key yet: update sessionpipe-gui on studio to send from the app, or send from a browser",
    );
  });

  it("a Mac that can't hold the key: Rust's reason, and nothing offered", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ control: { enabled: true, rpId: "localhost", machines: 1, keyTypes: ["passkey", "device"] } }),
    );
    const reason = "Sending needs a Mac with a Secure Enclave and Touch ID or a password";
    const calls = inShell(() => ({ available: false, reason, grantExp: null }));
    await nativeSigner();
    await rpId();
    expect(await refresh("localhost")).toBeNull();
    expect(canSign("localhost")).toBe(false);
    expect(signHint("localhost")).toBe(reason);
    expect(calls.map((c) => c.cmd)).toEqual(["plugin:identity|status"]);
    // Once it can (a password set, say), the reason goes.
    inShell(() => ({ available: true, grantExp: null }));
    await refresh("localhost");
    expect(canSign("localhost")).toBe(true);
  });

  it("keyTypesOf: Info.control.keyTypes, else the well-known, else passkeys only", () => {
    expect(
      keyTypesOf({ control: { enabled: true, rpId: "x", machines: 0, keyTypes: ["device"] }, wellKnown: {} }),
    ).toEqual(["device"]);
    expect(
      keyTypesOf({
        control: { enabled: true, rpId: "x", machines: 0 },
        wellKnown: { control: { signing: { key_types: ["passkey", "device", "tpm"] } } },
      }),
    ).toEqual(["passkey", "device"]);
    expect(keyTypesOf({ control: { enabled: true, rpId: "x", machines: 0 }, wellKnown: {} })).toEqual(["passkey"]);
  });
});

describe("commandString: key.add", () => {
  it("carries a device key whole, in the spec's field order", () => {
    const s = commandString(MACHINE, { kind: "key.add", key: DEVICE, name: "Mac app" });
    const o = JSON.parse(s);
    expect(o.key).toEqual(DEVICE);
    expect(Object.keys(o.key)).toEqual(["id", "alg", "spki", "type", "store", "uv"]);
    expect(Object.keys(o)).toEqual(["v", "t", "machine", "kind", "session", "key", "name", "nonce", "iat"]);
  });
  it("a passkey stays id, alg and spki, whatever else the page holds of it", () => {
    const pk = { id: "AAAAAAAAAAAAAAAAAAAAAA", alg: -7, spki: "MFkw", name: "iPhone", createdAt: "x" };
    expect(Object.keys(JSON.parse(commandString(MACHINE, { kind: "key.add", key: pk })).key)).toEqual([
      "id",
      "alg",
      "spki",
    ]);
  });
});

describe("the machine's key_types", () => {
  it("a passkey goes to any machine; the app's device key only where the daemon says device", () => {
    expect(machineTakes(undefined, "passkey")).toBe(true);
    expect(machineTakes({ keyTypes: undefined }, "device")).toBe(false);
    expect(machineTakes({ keyTypes: ["passkey"] }, "device")).toBe(false);
    expect(machineTakes({ keyTypes: ["passkey", "device"] }, "device")).toBe(true);
    expect(updateWords("studio-mac")).toBe("Update sessionpipe on studio-mac to send from the app.");
    expect(setupWords("studio-mac")).toBe(
      "studio-mac doesn't trust this Mac yet. Approve it once, and Touch ID signs what you send from here.",
    );
  });

  it("PendingDevices' Approve: disabled with one line for a device key, or from the app, on an old daemon", () => {
    const old = { name: "studio-mac", control: { keyTypes: undefined } };
    const fresh = { name: "studio-mac", control: { keyTypes: ["passkey", "device"] as ("passkey" | "device")[] } };
    // A browser approving a phone's passkey: any machine.
    expect(approveBlocker({ key: {} }, old, "passkey")).toBeNull();
    // A browser approving the Mac app's device key: only a machine that takes it.
    expect(approveBlocker({ key: { type: "device" } }, old, "passkey")).toBe(
      "Update sessionpipe on studio-mac to send from the app.",
    );
    expect(approveBlocker({ key: { type: "device" } }, fresh, "passkey")).toBeNull();
    // The app approving anything signs with its device key.
    expect(approveBlocker({ key: {} }, old, "device")).toBe("Update sessionpipe on studio-mac to send from the app.");
    expect(approveBlocker({ key: {} }, fresh, "device")).toBeNull();
    expect(approveBlocker({ key: {} }, undefined, "device")).toBe("Pair a machine before adding devices.");
  });
});

describe("the native adapter (mocked invoke)", () => {
  it("sign hands Rust the receiver, the rp id and the exact bytes; key.add always as a confirm", async () => {
    const calls = inShell((cmd, args) =>
      cmd === "plugin:identity|sign"
        ? { cmd: args.cmd, csig: "c", grant: { cred: DEVICE.id, sig: "s", str: "{}" } }
        : null,
    );
    const cmd = commandString(MACHINE, { kind: "prompt", session: "claude-code:x", text: "hi" });
    let tapped = 0;
    const out = await sign("localhost", cmd, { onTap: () => tapped++ });
    expect(out).toMatchObject({ cmd, csig: "c" });
    expect(tapped).toBe(1);
    expect(calls.at(-1)).toEqual({
      cmd: "plugin:identity|sign",
      args: { receiver: "rx0123abcd", rp: "localhost", cmd, mode: "grant", fresh: false },
    });
    await sign("localhost", cmd, { confirm: true });
    expect(calls.at(-1)?.args.mode).toBe("confirm");
    await sign("localhost", cmd, { fresh: true });
    expect(calls.at(-1)?.args.fresh).toBe(true);
    const add = commandString(MACHINE, { kind: "key.add", key: DEVICE });
    await sign("localhost", add);
    expect(calls.at(-1)?.args).toMatchObject({ cmd: add, mode: "confirm" });
  });

  it("a grant a machine refused reads as gone in the app until a fresh one is taken", async () => {
    const exp = Date.now() + 3_600_000;
    const calls = inShell((cmd, args) =>
      cmd === "plugin:identity|status"
        ? { available: true, key: DEVICE, grantExp: exp }
        : cmd === "plugin:identity|sign"
          ? { cmd: args.cmd, csig: "c", grant: { cred: DEVICE.id, sig: "s", str: "{}" } }
          : null,
    );
    const cmd = commandString(MACHINE, { kind: "prompt", session: "claude-code:x", text: "hi" });
    await nativeSigner();
    expect(await grantExpiry("localhost")).toBe(exp);
    // The machine refused it (command.ts drops it): Rust still says it holds one, the page
    // reads none, and the runner's no-prompt signing stops here instead of looping.
    await dropGrant("localhost");
    expect(await grantExpiry("localhost")).toBeNull();
    await expect(sign("localhost", cmd, { noPrompt: true })).rejects.toBeInstanceOf(NoGrantError);
    expect(calls.filter((c) => c.cmd === "plugin:identity|sign")).toHaveLength(0);
    // A send that asks Rust for a fresh grant puts it back; so does Unlock now.
    await sign("localhost", cmd, { fresh: true });
    expect(await grantExpiry("localhost")).toBe(exp);
    await dropGrant("localhost");
    expect(await grantExpiry("localhost")).toBeNull();
    await unlock("localhost");
    expect(await grantExpiry("localhost")).toBe(exp);
    // Another rp id is its own: dropping one leaves the other.
    await dropGrant("other.example");
    expect(await grantExpiry("localhost")).toBe(exp);
    await unlock("other.example");
  });

  it("status fills this Mac's key for the rp id; nothing is made and no prompt shows", async () => {
    const calls = inShell(() => ({ available: true, key: DEVICE, grantExp: null }));
    await nativeSigner();
    expect(await refresh("localhost")).toEqual(DEVICE);
    expect(ownKeys("localhost")).toEqual([DEVICE]);
    expect(calls.map((c) => c.cmd)).toEqual(["plugin:identity|status"]);
  });

  it("a plugin refusal reads as words; anything else is not one", async () => {
    inShell(() => null);
    await nativeSigner();
    expect(nativeErrorWords({ code: "busy", message: "x" })).toBe("finish the Touch ID prompt first");
    expect(nativeErrorWords({ code: "cancelled", message: "x" })).toMatch(/cancelled/);
    expect(nativeErrorWords({ code: "refused", message: "key.add is signed with a confirm" })).toBe(
      "key.add is signed with a confirm",
    );
    expect(nativeErrorWords(new Error("no"))).toBeNull();
    expect(nativeErrorWords("busy")).toBeNull();
  });
});

describe("the machine a device request is approved on by default", () => {
  const old = { name: "ho-ask", control: { keyTypes: undefined } };
  const fresh = { name: "studio-mac", control: { keyTypes: ["passkey", "device"] as KeyType[] } };
  it("a device key goes to the first machine that takes one, however the list is ordered", () => {
    expect(approveTarget({ key: { type: "device" } }, [old, fresh], "passkey")).toBe(fresh);
    expect(approveTarget({ key: {} }, [old, fresh], "device")).toBe(fresh);
  });
  it("a passkey from a browser, or no machine that takes device keys: the first paired one", () => {
    expect(approveTarget({ key: {} }, [old, fresh], "passkey")).toBe(old);
    expect(approveTarget({ key: { type: "device" } }, [old], "passkey")).toBe(old);
    expect(approveTarget({ key: { type: "device" } }, [], "passkey")).toBeUndefined();
  });
});
