// SPDX-License-Identifier: Apache-2.0
// Owned by: demo. Demo mode's paired machine, so every 0.10 control surface can be seen
// and tested without a daemon: a sessionpipe 0.10 machine in `inherit` mode (its Claude
// Code and Codex start with no permission flag unless a start names read or safe), with an
// ACP agent among its harnesses and a Claude Code home on another API among its accounts.
// The other demo machines stay unpaired, as a receiver sees a machine before `control
// pair`. The row is the one a daemon's pairing and hello leave (control.demo), kept online
// by a poll every 20 s; nothing is ever queued for it, and it goes when demo mode does.
import type { Control } from "../control/index.js";
import type { Hello } from "../control/parse.js";
import { DEMO_MACHINE } from "../control/state.js";
import { DEMO_API_ACCOUNT, type DemoStarted } from "./sim.js";

const POLL_MS = 20_000;
/** Where the demo's `~/…` folders live on its pretend machines, for a start's absolute `cwd`. */
const DEMO_HOME = "/Users/demo";

export const demoMachineId = (name: string): string => `${DEMO_MACHINE}${name}`.padEnd(18, "0");

/** The hello of the machine sessionpipe 0.10's scenes run on (sim.ts `v010Machine`). */
export function demoHellos(newer: string, account: (machine: string) => string): Hello[] {
  return [
    {
      name: newer,
      harnesses: ["claude-code", "codex", "gemini-cli", "goose"],
      modes: ["sdk", "waiter", "turn", "api", "resume", "fork"],
      keys: [],
      version: "0.10.0",
      waiting: [],
      folders: [`${DEMO_HOME}/code`, `${DEMO_HOME}/work`],
      mode: "inherit",
      accounts: [
        { harness: "claude-code", id: account(newer), email: "dev@example.com" },
        { harness: "claude-code", id: DEMO_API_ACCOUNT, name: "api.z.ai" },
      ],
      files: true,
      promptFiles: true,
      // CONTROL.md §2, §3.1: on an inherit machine a start that names no level runs with no
      // permission flag, and one may name read or safe at most.
      start: {
        "claude-code": { permissions: ["read", "safe"], permission: "inherit", anyModel: true },
        codex: { permissions: ["read", "safe"], permission: "inherit", models: ["gpt-5.4-codex"] },
      },
      keyTypes: ["passkey", "device"],
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
): DemoMachines {
  const hellos = demoHellos(machine, account);
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
      });
    },
    stop() {
      clearInterval(timer);
      control.demo.remove();
    },
  };
}
