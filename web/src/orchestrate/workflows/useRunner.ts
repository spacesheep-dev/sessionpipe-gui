// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The signer, mounted once in the Shell (RunnerHost): keeps the
// page's copy of the runs (state.ts) following the stream, and for every ready step of a
// live run that runner.ts offers, claims it (PATCH, If-Match), signs the one command with
// the day grant (control/command.ts sendCommand, the same door the composer uses) and
// brings the command's id back. A 412 on the claim is another tab's; the run it hands
// back is taken as the truth. A claim whose signing failed (the passkey prompt dismissed,
// a refusal) is held off for HOLD_MS, which is when the server offers it again anyway.
// Nothing here asks for a passkey out of the blue: with no day grant the runner offers
// nothing, and the run view says "Waiting for your passkey" with Unlock now.
import { useEffect, useRef } from "react";
import { uuid } from "../../control/bytes";
import { sendCommand } from "../../control/command";
import { useGrant, useRpId } from "../../control/hooks";
import { canSign } from "../../control/signer";
import { useMachinesMap, useStore } from "../../data/hooks";
import { useNow } from "../../lib/time";
import { WorkflowsError, workflowsApi } from "./api";
import { type Claim, claimKey, plan } from "./runner";
import { applyRun, attachStore, useWorkflowsState } from "./state";
import { runLive } from "./words";

/** How long a claim that failed here is left alone (the server's CLAIM_TTL_MS). */
export const HOLD_MS = 60_000;
/** A `sent` refused for the rev alone (another step settled meanwhile) is tried again
 *  with the rev the refusal hands back, this many times. */
const SENT_RETRIES = 3;

export function useRunner(): void {
  const store = useStore();
  const { runs } = useWorkflowsState();
  const machines = useMachinesMap();
  const live = runs.some(runLive);
  const rp = useRpId();
  const secure = canSign(rp);
  // The grant is read (the day key module loaded) only while a run could need it.
  const grant = useGrant(live ? rp : null);
  // Every second while a run is live: a step becomes ready on the server's clock, and a
  // held claim is let go on this one.
  const now = useNow(live ? "fine" : "off");
  useEffect(() => attachStore(store), [store]);
  /** Claims in flight or just refused, by key, until when (ms). */
  const held = useRef(new Map<string, number>());
  const grantRef = useRef(grant);
  grantRef.current = grant;

  useEffect(() => {
    if (!live || !rp || !secure || grant.exp === undefined || grant.exp === null) return;
    for (const [k, until] of held.current) if (until <= now) held.current.delete(k);
    const paired = [...machines.values()].flatMap((m) => (m.control ? [m.control] : []));
    const claims = plan({
      runs,
      machines: paired,
      signer: { canSign: secure, grant: true },
      held: new Set(held.current.keys()),
      uuid,
    });
    for (const c of claims) {
      held.current.set(claimKey(c.runId, c.stepId), Number.POSITIVE_INFINITY);
      void execute(c);
    }
    async function execute(c: Claim): Promise<void> {
      const key = claimKey(c.runId, c.stepId);
      try {
        let run = await workflowsApi.claim(c.runId, c.stepId, c.rev);
        applyRun(run);
        const carried = await sendCommand(rp!, c.machineId, c.fields);
        for (let tries = 0; ; tries++) {
          try {
            run = await workflowsApi.sent(c.runId, c.stepId, carried.id, run.rev);
            break;
          } catch (e) {
            const stillOurs =
              e instanceof WorkflowsError && e.status === 412 && e.run?.steps[c.stepId]?.status === "sending";
            if (!stillOurs || tries >= SENT_RETRIES) throw e;
            run = e.run!;
          }
        }
        applyRun(run);
        held.current.delete(key);
      } catch (e) {
        if (e instanceof WorkflowsError && e.run) applyRun(e.run);
        // Another tab's claim: nothing to hold, the run says who has it. Anything else
        // (the passkey dismissed, a refusal before queueing) waits HOLD_MS.
        if (e instanceof WorkflowsError && e.status === 412) held.current.delete(key);
        else held.current.set(key, Date.now() + HOLD_MS);
      } finally {
        grantRef.current.refresh();
      }
    }
  }, [runs, machines, rp, secure, grant.exp, now, live]);
}

/** Mounted once, in the Shell: the runner, and nothing drawn. */
export function RunnerHost(): null {
  useRunner();
  return null;
}
