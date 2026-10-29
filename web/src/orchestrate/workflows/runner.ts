// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The signer's reading of the runs (DESIGN §3.1 "The browser is
// the signer only"): given the runs, the paired machines and what this page can sign,
// which `ready` steps this tab should claim now, and the one command each would sign (a
// `start` for a harness, its session a fresh uuid and its folder the step's or the
// machine's first; a `prompt` for a session). Pure: no clock, no fetch, no DOM. The claim
// (routes.ts PATCH, If-Match) is the idempotency guard across tabs: a 412 means another
// tab has it, and the run it hands back shows the step `sending`, so the next reading
// offers nothing for it. A page that cannot sign, or holds no day grant yet, offers
// nothing either (the server says `waiting`, the run view says what to do), nor for a run
// this browser did not start or was not told to sign (mine.ts: a loopback caller may
// start a run, and must not drive this page's passkey by that alone), nor for a machine
// that trusts none of this page's keys (the signature would be refused, and the claim
// would sit for CLAIM_TTL_MS keeping a device that could sign from it). A step that names
// a permission or a model the machine's hello does not offer is never signed without it
// (the start would run at the machine's own mode, maybe wider than the author chose):
// `unsignable` says so, and the run view shows it. The runner never signs anything but
// what a ready step says.
import {
  type HarnessStartOptions,
  type MachineControl,
  sessionKey,
  type WorkflowRun,
  type WorkflowStep,
} from "@shared/api";
import type { CommandFields } from "../../control/command";
import { runLive } from "./words";

/** What the runner needs of a machine: its id, whether it polls, its hello, and the keys it trusts. */
export type RunnerMachine = Pick<MachineControl, "machineId" | "online" | "folders" | "harnesses" | "start" | "keys">;

export interface RunnerInput {
  runs: readonly WorkflowRun[];
  machines: readonly RunnerMachine[];
  /** This page can sign here, holds the day grant (a run never asks for a passkey out of
   *  the blue: the run view offers "Unlock now" instead), and signs with one of `keyIds`
   *  (signer.ts ownKeys), which the step's machine must trust. */
  signer: { canSign: boolean; grant: boolean; keyIds: ReadonlySet<string> };
  /** The runs this browser signs for (mine.ts): started here, or "Sign here" was taken. */
  mine: ReadonlySet<string>;
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

/** Does the hello offer this level for the harness? */
const offersPermission = (opts: HarnessStartOptions | undefined, p: WorkflowStep["permission"]) =>
  !!p && !!opts?.permissions.includes(p);
/** Does the hello offer this model (or any)? */
const offersModel = (opts: HarnessStartOptions | undefined, m: string | undefined) =>
  !!m && !!opts && (opts.anyModel || !!opts.models?.includes(m));

/** Why a step cannot be signed for its machine as written, in the run view's words after
 *  the machine's name ("lab-mac doesn't offer read for Claude Code"), or null when it can.
 *  A level or a model the hello does not offer is a refusal, not an omission: dropped,
 *  the start would run at the machine's mode, which may be wider than the author chose.
 *  `label` names the harness as the page prints it. */
export function unsignable(
  step: WorkflowStep,
  machine: RunnerMachine,
  label: (harness: string) => string,
): string | null {
  if ("session" in step.agent) return null;
  const harness = step.agent.harness;
  if (!machine.harnesses?.includes(harness)) return `doesn't run ${label(harness)}`;
  if (!(step.cwd ?? machine.folders?.[0])) return "has no folder a new session could start in";
  const opts = machine.start?.[harness];
  if (step.permission && !offersPermission(opts, step.permission))
    return `doesn't offer ${step.permission} for ${label(harness)}`;
  if (step.model && !offersModel(opts, step.model))
    return `doesn't offer the model ${step.model} for ${label(harness)}`;
  return null;
}

/** The command a ready step signs, or null when nothing can be signed for it (`unsignable`,
 *  or a text not resolved yet). A start carries the step's level and model as written. */
export function commandFor(
  run: WorkflowRun,
  step: WorkflowStep,
  machine: RunnerMachine,
  uuid: () => string,
): CommandFields | null {
  const text = run.steps[step.id]?.text ?? "";
  if (!text.trim()) return null;
  if ("session" in step.agent) return { kind: "prompt", session: step.agent.session, text };
  if (unsignable(step, machine, (h) => h)) return null;
  const harness = step.agent.harness;
  return {
    kind: "start",
    session: sessionKey(harness, uuid()),
    text,
    cwd: step.cwd ?? machine.folders![0]!,
    ...(step.permission ? { permission: step.permission } : {}),
    ...(step.model ? { model: step.model } : {}),
  };
}

/** Is a grant read as ending at `exp` (useGrant: ms, null when a tap is due, undefined
 *  while unread) still good at `now`? useGrant re-reads only on a change it hears of, so
 *  one that lapsed while a run waited still reads as a number: the clock says otherwise,
 *  and the runner then asks for a fresh read instead of a fresh grant. */
export const grantGoodAt = (exp: number | null | undefined, now: number): exp is number =>
  typeof exp === "number" && exp > now;

/** Does the machine trust a key this page signs with? */
export const trustsOne = (machine: Pick<RunnerMachine, "keys">, keyIds: ReadonlySet<string>): boolean =>
  machine.keys.some((k) => keyIds.has(k.id));

/** The claims this tab should make now, one per ready step of a live run this browser
 *  signs for, whose machine is paired, polling and trusts a key of this page's, in run
 *  order then plan order. */
export function plan(input: RunnerInput): Claim[] {
  if (!input.signer.canSign || !input.signer.grant) return [];
  const out: Claim[] = [];
  const byId = new Map(input.machines.map((m) => [m.machineId, m]));
  for (const run of input.runs) {
    if (!runLive(run) || !input.mine.has(run.id)) continue;
    for (const step of run.plan) {
      if (run.steps[step.id]?.status !== "ready") continue;
      if (input.held.has(claimKey(run.id, step.id))) continue;
      const machine = byId.get(step.machineId);
      if (!machine?.online || !trustsOne(machine, input.signer.keyIds)) continue;
      const fields = commandFor(run, step, machine, input.uuid);
      if (!fields) continue;
      out.push({ runId: run.id, stepId: step.id, rev: run.rev, machineId: machine.machineId, fields });
    }
  }
  return out;
}
