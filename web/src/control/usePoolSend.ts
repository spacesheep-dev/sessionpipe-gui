// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The one signed send path for a machine's account pool (UX-SPEC
// §3.6), shared by the Usage page's pooled section and the Add account sheet: it signs a
// `pool` command with the day grant (a fresh confirm for the actions the contract names,
// POOL_CONFIRM_ACTIONS), remembers why this page cannot sign when it cannot, reads the
// pool's own activity for this machine (newest first), and words the note under the
// section header: queued, refused, failed, expired for 8 s, unsupported for longer. The
// page itself redraws from the hello that follows a delivered command; nothing is cached.
import { type ControlActivity, type MachineSummary, POOL_CONFIRM_ACTIONS, type PoolAction } from "@shared/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { type CommandNote, commandNote } from "../lib/pool";
import { rpId } from "./api";
import { type CommandFields, sendCommand } from "./command";
import { useControlActivity, useGrant, useRpId } from "./hooks";
import { canSign, machineTakes, signHint, updateWords } from "./signer";
import { isFinal, refusalWords, sendErrorWords } from "./words";

/** How long a final note (refused, failed, expired, a send error) stays. */
export const NOTE_MS = 8_000;
/** An activity older than this is history, never a note on today's page load. */
const RECENT_MS = 10 * 60_000;
/** An `unsupported` stays this long at most: the person has read it by then. */
const UNSUPPORTED_MS = 10 * 60_000;

export type PoolFields = Omit<Extract<CommandFields, { kind: "pool" }>, "kind">;

export interface PoolSend {
  rp: string | null;
  /** Why nothing can be signed from this page for this machine, or null. */
  blocked: string | null;
  /** The signer's prompt (a passkey, Touch ID) is up right now. */
  tap: boolean;
  /** The machine's pool activity, newest first; `login.*` included. */
  activity: ControlActivity[];
  /** The newest command still on its way (not a sign-in), or null. */
  inflight: ControlActivity | null;
  /** The note under the section header, or null. */
  note: CommandNote | null;
  /** Signs and sends one pool command; null when it could not be sent (the note says why). */
  send: (fields: PoolFields) => Promise<ControlActivity | null>;
}

const isLogin = (a: ControlActivity): boolean => !!a.poolAction?.startsWith("login");
const onItsWay = (a: ControlActivity, now: number): boolean => !isFinal(a) && Date.parse(a.expiresAt) > now;

export function usePoolSend(m: MachineSummary): PoolSend {
  const control = m.control;
  const machineId = control?.machineId;
  const online = !!control?.online;
  const rp = useRpId();
  const grant = useGrant(rp);
  const [tap, setTap] = useState(false);
  const [error, setError] = useState<{ text: string; at: number } | null>(null);
  const mine = useCallback((a: ControlActivity) => a.kind === "pool" && a.machineId === machineId, [machineId]);
  const activity = useControlActivity(mine);

  const blocked = !control
    ? `Pair ${m.name} to manage its accounts.`
    : !canSign(rp)
      ? signHint(rp)
      : !machineTakes(control)
        ? updateWords(m.name)
        : null;

  // When a final outcome was first seen here: the note counts its 8 s from then, not from
  // the machine's clock.
  const seen = useRef(new Map<string, number>());
  const [, bump] = useState(0);
  const now = Date.now();
  const newest = activity.find((a) => !isLogin(a) && now - Date.parse(a.at) < RECENT_MS) ?? null;
  const inflight = newest && onItsWay(newest, now) ? newest : null;
  let note: CommandNote | null = null;
  if (newest) {
    if (inflight) note = commandNote(newest, m.name, online, refusalWords);
    else if (isFinal(newest)) {
      const key = `${newest.id}:${newest.outcome}`;
      let at = seen.current.get(key);
      if (at === undefined) {
        at = now;
        seen.current.set(key, at);
      }
      const n = commandNote(newest, m.name, online, refusalWords);
      if (n && now - at < (n.sticky ? UNSUPPORTED_MS : NOTE_MS)) note = n;
    }
  }
  if (!note && error && now - error.at < NOTE_MS) note = { text: error.text, err: true };
  // A note that ends by time re-renders once to go.
  const noteText = note && !note.sticky ? note.text : null;
  useEffect(() => {
    if (!noteText) return;
    const t = window.setTimeout(() => bump((n) => n + 1), NOTE_MS + 50);
    return () => window.clearTimeout(t);
  }, [noteText]);

  const send = useCallback(
    async (fields: PoolFields): Promise<ControlActivity | null> => {
      if (!machineId) return null;
      // The rp id is one fetch away at first paint; a send that early waits for it.
      const rpHere = rp ?? (await rpId().catch(() => "localhost"));
      setError(null);
      const confirm = (POOL_CONFIRM_ACTIONS as readonly PoolAction[]).includes(fields.action);
      try {
        return await sendCommand(
          rpHere,
          machineId,
          { kind: "pool", ...fields },
          { confirm, onTap: () => setTap(true) },
        );
      } catch (e) {
        setError({ text: sendErrorWords(e), at: Date.now() });
        return null;
      } finally {
        setTap(false);
        grant.refresh();
      }
    },
    [machineId, rp, grant.refresh],
  );

  return { rp, blocked, tap, activity, inflight, note, send };
}
