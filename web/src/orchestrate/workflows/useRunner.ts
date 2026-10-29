// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The signer, mounted once in the Shell (RunnerHost): keeps the
// page's copy of the runs (state.ts) following the stream, and for every ready step of a
// live run that runner.ts offers (one this browser signs for, mine.ts, on a machine that
// trusts a key of this page's), claims it (PATCH, If-Match), signs the one command with
// the day grant (control/command.ts signAndDeliver, the same signing the composer uses)
// and hands the signed body back through the run's PATCH: the server verifies it, queues
// it and marks the step sent in one move, or queues nothing when the step is no longer
// this claim's. A 412 is another tab's, or the run moved on; the run it hands back is
// taken as the truth. A refusal of the command itself comes back as the run with the
// step failed (nothing to retry). A signer's fault (the passkey prompt dismissed, a key
// the machine stopped trusting) holds the claim off for HOLD_MS, which is when the server
// offers it again anyway. Nothing here asks for a passkey out of the blue: with no day
// grant the runner offers nothing, one that lapsed while a run waited is read again
// rather than trusted (grantGoodAt), the signing itself is `noPrompt` (a grant the
// machine refused is dropped, never replaced from here), and the run view says "Waiting
// for your passkey" with Unlock now.
import { useEffect, useRef } from "react";
import { uuid } from "../../control/bytes";
import { signAndDeliver } from "../../control/command";
import { useGrant, useRpId } from "../../control/hooks";
import { canSign, useOwnKeys } from "../../control/signer";
import { useMachinesMap, useStore } from "../../data/hooks";
import { useNow } from "../../lib/time";
import { noteOwnSend } from "../../lib/toasts";
import { WorkflowsError, workflowsApi } from "./api";
import { useMine } from "./mine";
import { type Claim, claimKey, grantGoodAt, plan } from "./runner";
import { applyRun, attachStore, useWorkflowsState } from "./state";
import { runLive } from "./words";

/** How long a claim that failed here is left alone (the server's CLAIM_TTL_MS). */
export const HOLD_MS = 60_000;
/** A send refused for the rev alone (another step settled meanwhile) is tried again
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
  const own = useOwnKeys(live ? rp : null);
  const mine = useMine();
  useEffect(() => attachStore(store), [store]);
  /** Claims in flight or just refused, by key, until when (ms). */
  const held = useRef(new Map<string, number>());
  const grantRef = useRef(grant);
  grantRef.current = grant;

  useEffect(() => {
    if (!live || !rp || !secure || grant.exp === undefined || grant.exp === null) return;
    if (!grantGoodAt(grant.exp, now)) {
      // Lapsed since it was read: read again (null, and the run view asks), sign nothing.
      grant.refresh();
      return;
    }
    for (const [k, until] of held.current) if (until <= now) held.current.delete(k);
    const paired = [...machines.values()].flatMap((m) => (m.control ? [m.control] : []));
    const claims = plan({
      runs,
      machines: paired,
      signer: { canSign: secure, grant: true, keyIds: new Set(own.map((k) => k.id)) },
      mine,
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
        run = await signAndDeliver(
          rp!,
          c.machineId,
          c.fields,
          async (body) => {
            // The signed body is the server's to queue, once it has seen the step is still
            // this claim's; a rev that lagged (another step settled) is read again.
            for (let tries = 0; ; tries++) {
              try {
                return await workflowsApi.send(c.runId, c.stepId, body, run.rev);
              } catch (e) {
                const stillOurs =
                  e instanceof WorkflowsError && e.status === 412 && e.run?.steps[c.stepId]?.status === "sending";
                if (!stillOurs || tries >= SENT_RETRIES) throw e;
                run = e.run!;
              }
            }
          },
          { noPrompt: true },
        );
        const id = run.steps[c.stepId]?.commandId;
        if (id) noteOwnSend(id);
        applyRun(run);
        held.current.delete(key);
      } catch (e) {
        if (e instanceof WorkflowsError && e.run) applyRun(e.run);
        // Another tab's claim, or the run moved on: nothing to hold, the run says so.
        // Anything else (the passkey dismissed, a signer's fault the server named) waits
        // HOLD_MS; a refusal of the command itself came back as the run, the step failed.
        if (e instanceof WorkflowsError && e.status === 412) held.current.delete(key);
        else held.current.set(key, Date.now() + HOLD_MS);
      } finally {
        grantRef.current.refresh();
      }
    }
  }, [runs, machines, rp, secure, grant.exp, grant.refresh, now, live, own, mine]);
}

/** Mounted once, in the Shell: the runner, and nothing drawn. */
export function RunnerHost(): null {
  useRunner();
  return null;
}
