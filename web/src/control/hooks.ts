// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. React bindings for the control channel: the rp id, the cached
// grant's expiry, and the activity (AppState.control: the stream's frames over a read of
// GET /activity, so a reload still shows this morning's messages, and a page that
// dropped reads what it missed; data/store.ts `loadControl`).
import type { ControlActivity } from "@shared/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppState, useStore } from "../data/hooks";
import { rpId } from "./api";
import { GRANT_EVENT, grantExpiry } from "./signer";

export function useRpId(): string | null {
  const [rp, setRp] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    rpId()
      .then((r) => on && setRp(r))
      .catch(() => on && setRp("localhost"));
    return () => {
      on = false;
    };
  }, []);
  return rp;
}

/** When the day grant for `rp` ends (ms), null when the next send will ask (a passkey, or Touch ID),
 *  undefined while unknown. `refresh` re-reads it (after a send). */
export function useGrant(rp: string | null): { exp: number | null | undefined; refresh: () => void } {
  const [exp, setExp] = useState<number | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!rp) return;
    let on = true;
    grantExpiry(rp).then((e) => on && setExp(e));
    return () => {
      on = false;
    };
  }, [rp, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  // A grant taken or dropped anywhere on the page (a send, Unlock now) is read here too.
  useEffect(() => {
    window.addEventListener(GRANT_EVENT, refresh);
    return () => window.removeEventListener(GRANT_EVENT, refresh);
  }, [refresh]);
  return { exp, refresh };
}

/** Control activity, newest first: the stream's messages over the receiver's history,
 *  which the store reads when the first page asks and again each time the stream comes
 *  back. */
export function useControlActivity(filter?: (a: ControlActivity) => boolean): ControlActivity[] {
  const store = useStore();
  const known = useAppState().control;
  useEffect(() => store.loadControl(), [store]);
  return useMemo(() => {
    const all = [...known].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return filter ? all.filter(filter) : all;
  }, [known, filter]);
}

/** One message by id, as it moves through its lifecycle on the stream. */
export function useMessage(id: string | null): ControlActivity | undefined {
  const live = useAppState().control;
  return useMemo(() => (id ? live.find((a) => a.id === id) : undefined), [live, id]);
}
