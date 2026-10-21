// SPDX-License-Identifier: Apache-2.0
// Owned by: control. The receiver side of spec/CONTROL.md and HTTP.md §3: pairing, the
// per-machine long-poll, acks, off, the queue with redelivery and the `taken` pause,
// the UI's routes under /api/ui/control/*, and the loopback test door the conformance
// runner needs. `createControl(deps)` is the contract app.ts and the UI code against.
//
//   state.ts     machines, pairings, queues; persisted under <stateDir>/control/
//   routes.ts    the machine wire (pair, hello, poll, ack, off)
//   ui.ts        /api/ui/control/* (README.md documents each route)
//   testdoor.ts  {control}/_test/* when deps.testDoor, loopback only
//   parse.ts     body parsers; testkeys.ts  a test-only authenticator
import path from "node:path";
import {
  type ControlActivity,
  type MachineControl,
  type MachineSummary,
  ROUTES,
  type StreamMessage,
} from "../../shared/api.js";
import type { Ctx, Router } from "../http/router.js";
import { registerMachineRoutes } from "./routes.js";
import { ControlState, type DeviceRequestRow, toActivity, WAIT_MAX_S } from "./state.js";
import { registerTestDoor } from "./testdoor.js";
import { registerUiRoutes } from "./ui.js";

export interface ControlDeps {
  stateDir: string;
  /** The current sink token: pairing with a sink token presents it (CONTROL.md §2 step 1). */
  sinkToken: () => string;
  /** WebAuthn rp id passkeys are made for; "localhost" by default. A getter when it can
   *  change while running (the setup page turning TLS mode on switches it to `<name>.local`). */
  rpId: string | (() => string);
  /** Loopback-only test door for the conformance runner (`enqueue`, `approve`); off by default. */
  testDoor: boolean;
  /** Whether a request may use the UI API (loopback or UI-key cookie); supplied by server-core. */
  uiAuth: (ctx: Ctx) => boolean;
  /** Harness:session keys the store knows, for validating a command's session (optional help). */
  sessionExists?: (key: string) => boolean;
}

export interface Control {
  /** Machine routes (pair, hello, poll, ack, off) under ROUTES.control, and the UI's
   *  /api/ui/control/* routes. */
  register(router: Router): void;
  /** Paired machines, keyed by the daemon's `name` (the same name events carry in session.machine). */
  machines(): Map<string, MachineControl>;
  activity(limit?: number): ControlActivity[];
  subscribe(l: (m: StreamMessage) => void): () => void;
  /** Pairings still waiting for a person, newest first (the setup page shows this machine's inline). */
  pendingPairings(): { code: string; check: string; expiresAt: string; machine: string; machineId: string }[];
  /** Device requests a trusted device could still approve, newest first (the phone page). */
  pendingDevices(): { id: string; name: string; digits: string; since: string }[];
  /** One device request as the phone reads it back; undefined when rejected or never made.
   *  `machine` is the name of the machine the `key.add` went to, once it did. */
  deviceRequest(id: string): { status: DeviceRequestRow["status"]; digits: string; machine?: string } | undefined;
  /** The `control` member of the well-known file (HTTP.md §1). */
  wellKnown(): {
    wait_max_s: number;
    open_pairing?: boolean;
    /** MCP servers a session answering our message may use unasked (CONTROL.md §6); none here. */
    session_tools?: string[];
    signing: { rp_id: string; algs: number[] };
  };
  close(): void;
}

export function createControl(deps: ControlDeps): Control {
  const state = new ControlState(path.join(deps.stateDir, "control"));
  const rpId = (): string => (typeof deps.rpId === "function" ? deps.rpId() : deps.rpId);
  const listeners = new Set<(m: StreamMessage) => void>();
  let machinesTimer: NodeJS.Timeout | null = null;
  state.onMachines = () => {
    if (machinesTimer) return;
    machinesTimer = setTimeout(() => {
      machinesTimer = null;
      for (const m of state.allMachines()) {
        if (!m.tokenHash && !m.keys.length) continue;
        const control = state.machineControl(m);
        const machine: MachineSummary = {
          name: m.name,
          lastAt: control.lastPollAt ?? control.lastHelloAt ?? new Date().toISOString(),
          harnesses: Object.fromEntries((control.harnesses ?? []).map((h) => [h, undefined])),
          sessions: 0,
          working: 0,
          needsYou: 0,
          control,
        };
        for (const l of listeners)
          try {
            l({ kind: "machine", machine });
          } catch {}
      }
    }, 300);
    machinesTimer.unref();
  };
  state.onMessage = (row) => {
    const message = toActivity(row);
    for (const l of listeners)
      try {
        l({ kind: "control", message });
      } catch {}
  };
  return {
    register(router) {
      registerMachineRoutes(router, { state, sinkToken: deps.sinkToken, base: ROUTES.control });
      registerUiRoutes(router, { state, rpId, uiAuth: deps.uiAuth, base: ROUTES.ui.control });
      if (deps.testDoor) registerTestDoor(router, { state, rpId, base: ROUTES.control });
    },
    machines() {
      const out = new Map<string, MachineControl>();
      for (const m of state.allMachines()) if (m.tokenHash || m.keys.length) out.set(m.name, state.machineControl(m));
      return out;
    },
    activity: (limit) => state.activity(limit),
    pendingPairings: () =>
      state.pendingPairings().map(({ machine, pairing }) => ({
        code: pairing.code,
        check: pairing.check,
        expiresAt: pairing.expiresAt,
        machine: machine.name,
        machineId: machine.id,
      })),
    pendingDevices: () =>
      state
        .pendingDeviceRequests()
        .map((d) => ({ id: d.requestId, name: d.name, digits: d.check, since: d.createdAt })),
    deviceRequest: (id) => {
      const d = state.deviceRequest(id);
      if (!d) return undefined;
      const machine = d.machineId ? state.machine(d.machineId)?.name : undefined;
      return { status: d.status, digits: d.check, ...(machine ? { machine } : {}) };
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    wellKnown: () => ({
      wait_max_s: WAIT_MAX_S,
      open_pairing: true,
      session_tools: [],
      signing: { rp_id: rpId(), algs: [-7, -257] },
    }),
    close: () => {
      if (machinesTimer) clearTimeout(machinesTimer);
      state.close();
    },
  };
}
