// SPDX-License-Identifier: Apache-2.0
// How long a prompt can be answered from here. Claude Code's PermissionRequest hook waits
// 125 s for the owner's signed answer (sessionpipe packages/cli/src/hook.ts, CONTROL.md
// §6); when it lets go, the daemon forgets the prompt and refuses a later answer
// (`no_attention`, `expired`). Only Claude Code prompts are parked that way, a plan
// review among them, so no other harness's prompt runs out here. `at` is stamped by the
// computer that raised it, and the two clocks are taken to agree.
import type { Attention, MachineControl } from "@shared/api";
import { useEffect, useReducer } from "react";

/** The hook's 125 s, less the time a signed answer takes to arrive. */
export const ANSWER_WINDOW_MS = 120_000;

/** The prompt's hook has let go: an answer from here would only be refused. Only for a
 *  paired computer (an unpaired one says that first). */
export const answerLate = (a: Attention, control: MachineControl | undefined, harness: string, now: number): boolean =>
  !!control && a.kind === "permission" && harness === "claude-code" && now - Date.parse(a.at) > ANSWER_WINDOW_MS;

/** The time to read `answerLate` with: now, and a render again as the first of `atts`
 *  still inside its window runs out, so a prompt turns late on screen without a tick. */
export function useAnswerClock(atts: readonly Attention[]): number {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();
  let due = Number.POSITIVE_INFINITY;
  for (const a of atts) {
    const end = Date.parse(a.at) + ANSWER_WINDOW_MS;
    if (end >= now && end < due) due = end;
  }
  useEffect(() => {
    if (!Number.isFinite(due)) return;
    const t = window.setTimeout(tick, due - Date.now() + 1);
    return () => window.clearTimeout(t);
  }, [due]);
  return now;
}
