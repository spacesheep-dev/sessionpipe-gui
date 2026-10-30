// SPDX-License-Identifier: Apache-2.0
// Owned by: demo. Demo mode's paired machines, so every 0.10 control surface and every
// pool state (DESIGN §3, UX-SPEC §13) can be seen and tested without a daemon:
//
//   lab-mac   sessionpipe 0.11 in `inherit` mode (its Claude Code and Codex start with no
//             permission flag unless a start names read or safe), an ACP agent among its
//             harnesses, a Claude Code home on another API among its accounts, and a pool
//             that is on: Misha (its own login, in use), Fiction (has room, no numbers yet)
//             and Spacesheep (used up, with when it is back and its idle numbers).
//   mini-mac  a pool that is on with an account in error (Misha, sign in again), one in use
//             (Work) and one turned off (Old).
//   desk-pc   the same accounts kept but the pool off: every session on its own login.
//
// The other demo machines (studio-mac, build-box) stay unpaired, as a receiver sees a
// machine before `control pair`. Each row is the one a daemon's pairing and hello leave
// (control.demo), kept online by a poll every 20 s; nothing is ever queued for them, and
// they go when demo mode does. lab-mac's hello says `ask` and `handoff`, so the
// agents-asking-each-other scenes (sim.ts) run on a machine the GUI offers those on.
import type { MachinePool } from "../../shared/api.js";
import type { Control } from "../control/index.js";
import type { Hello } from "../control/parse.js";
import { DEMO_MACHINE } from "../control/state.js";
import { DEMO_API_ACCOUNT, DEMO_POOL, DEMO_POOL_UNTIL_MS, type DemoStarted } from "./sim.js";

const POLL_MS = 20_000;
/** Where the demo's `~/…` folders live on its pretend machines, for a start's absolute `cwd`. */
const DEMO_HOME = "/Users/demo";
/** The two machines that exist for their pools alone. */
export const POOL_MACHINES = ["mini-mac", "desk-pc"] as const;

export const demoMachineId = (name: string): string => `${DEMO_MACHINE}${name}`.padEnd(18, "0");

/** The hellos of the paired demo machines: first the one sessionpipe 0.10's scenes run on
 *  (sim.ts `v010Machine`), then the two pool machines. `account` is the machine's own
 *  Claude Code account id as the cast drew it; `startedAt` dates Spacesheep's `until`. */
export function demoHellos(newer: string, account: (machine: string) => string, startedAt = Date.now()): Hello[] {
  const own = account(newer);
  const misha = { harness: "claude-code", id: own, email: "dev@example.com" };
  const fiction = { harness: "claude-code", id: DEMO_POOL.fiction.id, email: DEMO_POOL.fiction.email };
  const spacesheep = { harness: "claude-code", id: DEMO_POOL.spacesheep.id, email: DEMO_POOL.spacesheep.email };
  const work = { harness: "claude-code", id: DEMO_POOL.work.id, email: DEMO_POOL.work.email };
  const old = { harness: "claude-code", id: DEMO_POOL.old.id, email: DEMO_POOL.old.email };
  const until = new Date(startedAt + DEMO_POOL_UNTIL_MS).toISOString();
  const week = new Date(startedAt + 4 * 86_400_000 + 6 * 3_600_000).toISOString();
  const labPool: MachinePool = {
    on: true,
    harness: "claude-code",
    accounts: [
      { id: own, email: "dev@example.com", label: "Misha", enabled: true, status: "ready", current: true },
      { ...DEMO_POOL.fiction, enabled: true, status: "ready", current: false },
      {
        ...DEMO_POOL.spacesheep,
        enabled: true,
        status: "limited",
        current: false,
        until,
        limitedBy: "five_hour",
        windows: [
          { id: "five_hour", usedPercent: 99.2, windowMinutes: 300, resetsAt: until },
          { id: "seven_day", usedPercent: 3, windowMinutes: 10_080, resetsAt: week },
        ],
      },
    ],
  };
  const miniPool: MachinePool = {
    on: true,
    harness: "claude-code",
    accounts: [
      {
        id: own,
        email: "dev@example.com",
        label: "Misha",
        enabled: true,
        status: "error",
        current: false,
        limitedBy: "error",
      },
      {
        ...DEMO_POOL.work,
        enabled: true,
        status: "ready",
        current: true,
        windows: [
          {
            id: "five_hour",
            usedPercent: 61,
            windowMinutes: 300,
            resetsAt: new Date(startedAt + 3_600_000).toISOString(),
          },
          { id: "seven_day", usedPercent: 44, windowMinutes: 10_080, resetsAt: week },
        ],
      },
      { ...DEMO_POOL.old, enabled: false, status: "disabled", current: false },
    ],
  };
  const deskPool: MachinePool = {
    on: false,
    harness: "claude-code",
    accounts: [
      { id: own, email: "dev@example.com", label: "Misha", enabled: true, status: "ready", current: false },
      { ...DEMO_POOL.fiction, enabled: true, status: "ready", current: false },
    ],
  };
  const base = {
    modes: ["sdk", "waiter", "turn", "api", "resume", "fork"],
    keys: [],
    version: "0.11.0",
    waiting: [],
    promptFiles: true,
    files: true,
    keyTypes: ["passkey", "device"] as Hello["keyTypes"],
  };
  return [
    {
      ...base,
      name: newer,
      harnesses: ["claude-code", "codex", "gemini-cli", "goose"],
      folders: [`${DEMO_HOME}/code`, `${DEMO_HOME}/work`],
      mode: "inherit",
      accounts: [misha, { harness: "claude-code", id: DEMO_API_ACCOUNT, name: "api.z.ai" }, fiction, spacesheep],
      // CONTROL.md §2, §3.1: on an inherit machine a start that names no level runs with no
      // permission flag, and one may name read or safe at most.
      start: {
        "claude-code": { permissions: ["read", "safe"], permission: "inherit", anyModel: true },
        codex: { permissions: ["read", "safe"], permission: "inherit", models: ["gpt-5.4-codex"] },
      },
      // CONTROL.md §13 and §3.1: its agents can ask each other through the daemon, and a
      // prompt or a start may name a session to bring the answer back into.
      ask: true,
      handoff: true,
      pool: labPool,
    },
    {
      ...base,
      name: POOL_MACHINES[0],
      harnesses: ["claude-code"],
      folders: [`${DEMO_HOME}/code`],
      mode: "safe",
      accounts: [misha, work, old],
      start: { "claude-code": { permissions: ["read", "safe"], permission: "safe" } },
      pool: miniPool,
    },
    {
      ...base,
      name: POOL_MACHINES[1],
      harnesses: ["claude-code"],
      folders: [`${DEMO_HOME}/code`],
      mode: "safe",
      accounts: [misha, fiction],
      start: { "claude-code": { permissions: ["read", "safe"], permission: "safe" } },
      pool: deskPool,
    },
  ];
}

/** The demo's goose run on the first machine: an ACP agent (CONTROL.md §6 `api`), which
 *  answers in the ack and sends no hook events; its session lives in the activity alone. */
export const DEMO_ACP_SESSION = "goose:01K8DEMO0ACP0GOOSE0000000";

export interface DemoMachines {
  /** A start the demo says it sent (sim.ts onStart). */
  started(s: DemoStarted): void;
  stop(): void;
}

export function startDemoMachines(
  control: Control,
  machine: string,
  account: (machine: string) => string,
  startedAt = Date.now(),
): DemoMachines {
  const hellos = demoHellos(machine, account, startedAt);
  for (const h of hellos) control.demo.machine(demoMachineId(h.name), h);
  const first = hellos[0];
  if (first)
    control.demo.start(demoMachineId(first.name), {
      session: DEMO_ACP_SESSION,
      text: "List the open pull requests that touch the billing service and say which one is oldest.",
      cwd: `${DEMO_HOME}/code/billing`,
      at: new Date(Date.now() - 6 * 60_000).toISOString(),
      mode: "api",
      reply:
        "There are three open pull requests that touch billing:\n\n- #412 Prorate mid-cycle downgrades (9 days)\n- #418 Retry webhooks with backoff (4 days)\n- #421 Invoice PDF footer (1 day)\n\n#412 is the oldest.",
    });
  const timer = setInterval(() => {
    for (const h of hellos) control.demo.poll(demoMachineId(h.name));
  }, POLL_MS);
  timer.unref();
  return {
    started(s) {
      if (!hellos.some((h) => h.name === s.machine)) return;
      control.demo.start(demoMachineId(s.machine), {
        session: `${s.harness}:${s.id}`,
        text: s.text,
        cwd: s.cwd.replace(/^~(?=\/|$)/, DEMO_HOME),
        at: new Date(s.at - 2000).toISOString(),
        mode: "sdk",
        applied: { permission: "inherit" },
        ...(s.replyTo ? { replyTo: s.replyTo } : {}),
        ...(s.from ? { from: s.from } : {}),
      });
    },
    stop() {
      clearInterval(timer);
      control.demo.remove();
    },
  };
}
