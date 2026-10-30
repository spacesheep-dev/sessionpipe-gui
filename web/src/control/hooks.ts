// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. React bindings for the control channel: the rp id, the cached
// grant's expiry, and the activity (AppState.control live from the stream, backed by one
// read of GET /activity so a reload still shows this morning's messages).
import type { ControlActivity } from "@shared/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppState } from "../data/hooks";
import { controlApi, rpId } from "./api";
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

let historyPromise: Promise<ControlActivity[]> | null = null;
const history = (): Promise<ControlActivity[]> => {
  if (!historyPromise)
    historyPromise = controlApi.activity(300).catch(() => {
      historyPromise = null;
      return [];
    });
  return historyPromise;
};

/** Control activity, newest first: the stream's messages over one fetched history. */
export function useControlActivity(filter?: (a: ControlActivity) => boolean): ControlActivity[] {
  const live = useAppState().control;
  const [past, setPast] = useState<ControlActivity[]>([]);
  useEffect(() => {
    let on = true;
    history().then((h) => on && setPast(h));
    return () => {
      on = false;
    };
  }, []);
  return useMemo(() => {
    const byId = new Map<string, ControlActivity>();
    for (const a of past) byId.set(a.id, a);
    for (const a of live) byId.set(a.id, a);
    const all = [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return filter ? all.filter(filter) : all;
  }, [live, past, filter]);
}

/** One message by id, as it moves through its lifecycle on the stream. */
export function useMessage(id: string | null): ControlActivity | undefined {
  const live = useAppState().control;
  return useMemo(() => (id ? live.find((a) => a.id === id) : undefined), [live, id]);
}
