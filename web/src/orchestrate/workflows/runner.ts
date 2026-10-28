// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The signer's reading of the runs (DESIGN §3.1 "The browser is
// the signer only"): given the runs, the paired machines and what this page can sign,
// which `ready` steps this tab should claim now, and the one command each would sign (a
// `start` for a harness, its session a fresh uuid and its folder the step's or the
// machine's first; a `prompt` for a session). Pure: no clock, no fetch, no DOM. The claim
// (routes.ts PATCH, If-Match) is the idempotency guard across tabs: a 412 means another
// tab has it, and the run it hands back shows the step `sending`, so the next reading
// offers nothing for it. A page that cannot sign, or holds no day grant yet, offers
// nothing either (the server says `waiting`, the run view says what to do); the runner
// never signs anything but what a ready step says.
import {
  type HarnessStartOptions,
  type MachineControl,
  sessionKey,
  type WorkflowRun,
  type WorkflowStep,
} from "@shared/api";
import type { CommandFields } from "../../control/command";
import { runLive } from "./words";

/** What the runner needs of a machine: its id, whether it polls, and its hello. */
export type RunnerMachine = Pick<MachineControl, "machineId" | "online" | "folders" | "harnesses" | "start">;

export interface RunnerInput {
  runs: readonly WorkflowRun[];
  machines: readonly RunnerMachine[];
  /** This page can sign here, and holds the day grant (a run never asks for a passkey
   *  out of the blue: the run view offers "Unlock now" instead). */
  signer: { canSign: boolean; grant: boolean };
  /** `claimKey(run, step)` of the claims this tab has in flight, or that failed a moment
   *  ago (the server offers a stale claim again after CLAIM_TTL_MS; this keeps a refused
   *  passkey from being asked for every second meanwhile). */
  held: ReadonlySet<string>;
  /** A fresh session id for a `start` (control/bytes.ts uuid; a test passes its own). */
  uuid: () => string;
}

export interface Claim {
  runId: string;
  stepId: string;
  /** The run's rev the claim names (`If-Match`). */
  rev: number;
  machineId: string;
  fields: CommandFields;
}

export const claimKey = (runId: string, stepId: string): string => `${runId}/${stepId}`;

/** A start's level, only when the machine's hello offers it for that harness. */
const permissionFor = (opts: HarnessStartOptions | undefined, p: WorkflowStep["permission"]) =>
  p && opts?.permissions.includes(p) ? p : undefined;
/** A start's model, only when the hello offers it (or any). */
const modelFor = (opts: HarnessStartOptions | undefined, m: string | undefined) =>
  m && opts && (opts.anyModel || opts.models?.includes(m)) ? m : undefined;

/** The command a ready step signs, or null when nothing can be signed for it: a harness
 *  the machine does not run, a start with no folder anywhere, an empty text. */
export function commandFor(
  run: WorkflowRun,
  step: WorkflowStep,
  machine: RunnerMachine,
  uuid: () => string,
): CommandFields | null {
  const text = run.steps[step.id]?.text ?? "";
  if (!text.trim()) return null;
  if ("session" in step.agent) return { kind: "prompt", session: step.agent.session, text };
  const harness = step.agent.harness;
  if (!machine.harnesses?.includes(harness)) return null;
  const cwd = step.cwd ?? machine.folders?.[0];
  if (!cwd) return null;
  const opts = machine.start?.[harness];
  const permission = permissionFor(opts, step.permission);
  const model = modelFor(opts, step.model);
  return {
    kind: "start",
    session: sessionKey(harness, uuid()),
    text,
    cwd,
    ...(permission ? { permission } : {}),
    ...(model ? { model } : {}),
  };
}

/** The claims this tab should make now, one per ready step of a live run whose machine
 *  is paired and polling, in run order then plan order. */
export function plan(input: RunnerInput): Claim[] {
  if (!input.signer.canSign || !input.signer.grant) return [];
  const out: Claim[] = [];
  const byId = new Map(input.machines.map((m) => [m.machineId, m]));
  for (const run of input.runs) {
    if (!runLive(run)) continue;
    for (const step of run.plan) {
      if (run.steps[step.id]?.status !== "ready") continue;
      if (input.held.has(claimKey(run.id, step.id))) continue;
      const machine = byId.get(step.machineId);
      if (!machine?.online) continue;
      const fields = commandFor(run, step, machine, input.uuid);
      if (!fields) continue;
      out.push({ runId: run.id, stepId: step.id, rev: run.rev, machineId: machine.machineId, fields });
    }
  }
  return out;
}
