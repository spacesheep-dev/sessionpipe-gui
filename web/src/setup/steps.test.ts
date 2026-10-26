// SPDX-License-Identifier: Apache-2.0
// The step rules: the optional sixth never gates anything, and a public https url stands in
// for TLS mode as the secure origin.
import type { SetupStatus } from "@shared/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const passkeys = vi.hoisted(() => ({ available: true }));
vi.mock("../control/webauthn", () => ({ passkeysAvailable: () => passkeys.available }));

import {
  needsSetup,
  OPTIONAL_STEPS,
  publicUrl,
  REQUIRED_STEPS,
  STEP_ORDER,
  secureHere,
  setupComplete,
  stepsDone,
} from "./steps";

type Deep = { [K in keyof SetupStatus]?: Partial<SetupStatus[K]> };

/** A machine with sessions, paired and tried, TLS off, no remote: only step 2 (and 6) wait. */
function status(over: Deep = {}): SetupStatus {
  const base: SetupStatus = {
    sessionpipe: { installed: true, outbox: { path: "/o", present: true, sessions: 2 } },
    events: { total: 12 },
    harnesses: [],
    tls: {
      on: false,
      hostname: "box.local",
      httpsUrl: "https://box.local:7373",
      rpId: "localhost",
      caTrusted: null,
      opensslPresent: true,
      mdns: { resolves: true },
    },
    daemon: { running: true, pairedHere: true, online: true, pairing: { active: false }, suggestedFolders: [] },
    viewers: { phones: 0 },
    tried: { delivered: 1 },
    remote: { tailscale: { installed: false, running: false, serving: null }, viewers: 0 },
    platform: "darwin",
    uiKey: "k",
  };
  const out: Record<string, unknown> = { ...base };
  const b = base as unknown as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...b[k], ...(v as Record<string, unknown>) } : v;
  }
  return out as unknown as SetupStatus;
}

const REMOTE_ON = {
  publicUrl: "https://box.tail1234.ts.net",
  tailscale: { installed: true, running: true, serving: true },
  viewers: 1,
};

beforeEach(() => {
  passkeys.available = true;
});

describe("pairing in the Mac app", () => {
  it("is done only once the machine trusts this Mac's key", () => {
    expect(stepsDone(status(), false).pair).toBe(true);
    expect(stepsDone(status(), false, false).pair).toBe(false);
    expect(stepsDone(status(), false, true).pair).toBe(true);
  });
});

describe("the sixth step is optional", () => {
  it("comes last and is the only optional one", () => {
    expect(STEP_ORDER).toHaveLength(6);
    expect(STEP_ORDER[5]).toBe("remote");
    expect([...OPTIONAL_STEPS]).toEqual(["remote"]);
    expect(REQUIRED_STEPS).toEqual(["sessions", "secure", "pair", "phone", "try"]);
  });

  it("is done exactly when a public url is set", () => {
    expect(stepsDone(status(), false).remote).toBe(false);
    expect(stepsDone(status({ remote: REMOTE_ON }), false).remote).toBe(true);
    expect(publicUrl(status({ remote: { publicUrl: "" } as never }))).toBeUndefined();
  });

  it("tolerates an older server with no `remote` at all", () => {
    const s = status();
    delete (s as Partial<SetupStatus>).remote;
    expect(stepsDone(s, false).remote).toBe(false);
    expect(publicUrl(s)).toBeUndefined();
    expect(needsSetup(s)).toBe(true);
    expect(setupComplete(s)).toBe(false);
  });

  it("never counts for the first-run redirect or the rail's dot", () => {
    const tlsOn = status({ tls: { on: true, caTrusted: true, rpId: "box.local" } });
    expect(stepsDone(tlsOn, false).remote).toBe(false);
    expect(needsSetup(tlsOn)).toBe(false);
    expect(setupComplete(tlsOn)).toBe(true);
  });
});

describe("a public url is a secure origin", () => {
  it("makes step 2 green with TLS off, as long as passkeys work on this page", () => {
    expect(secureHere(status())).toBe(false);
    expect(secureHere(status({ remote: REMOTE_ON }))).toBe(true);
    passkeys.available = false;
    expect(secureHere(status({ remote: REMOTE_ON }))).toBe(false);
  });

  it("stands in for TLS on in step 4", () => {
    expect(stepsDone(status({ viewers: { phones: 1 } }), false).phone).toBe(false);
    expect(stepsDone(status({ viewers: { phones: 1 }, remote: REMOTE_ON }), false).phone).toBe(true);
    expect(stepsDone(status({ viewers: { phones: 0 }, remote: REMOTE_ON }), false).phone).toBe(false);
  });

  it("satisfies the redirect and the rail without TLS, and despite an untrusted CA", () => {
    expect(needsSetup(status())).toBe(true);
    expect(setupComplete(status())).toBe(false);
    expect(needsSetup(status({ remote: REMOTE_ON }))).toBe(false);
    expect(setupComplete(status({ remote: REMOTE_ON }))).toBe(true);
    const untrusted = status({ tls: { on: true, caTrusted: false } });
    expect(setupComplete(untrusted)).toBe(false);
    expect(setupComplete(status({ tls: { on: true, caTrusted: false }, remote: REMOTE_ON }))).toBe(true);
  });

  it("still wants sessions and a paired daemon", () => {
    expect(needsSetup(status({ remote: REMOTE_ON, events: { total: 0 } }))).toBe(true);
    expect(needsSetup(status({ remote: REMOTE_ON, daemon: { pairedHere: false } }))).toBe(true);
  });
});
