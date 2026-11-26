// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. React bindings for the control channel: the rp id, the cached
// grant's expiry, and the activity (AppState.control: the stream's frames over a read of
// GET /activity, so a reload still shows this morning's messages, and a page that
// dropped reads what it missed; data/store.ts `loadControl`).
import { type Attention, type ControlActivity, isEmptySession, splitKey } from "@shared/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppState, useMachines, useStore } from "../data/hooks";
import { useNow } from "../lib/time";
import { type AnswerOut, answersOut } from "./answers";
import { rpId } from "./api";
import { ALIAS_WINDOW_MS } from "./newSessionState";
import { GRANT_EVENT, grantExpiry } from "./signer";
import { isFinal } from "./words";

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

/** Per prompt of `open` with an answer out (or closed by its computer), what became of it,
 *  as the page's activity says (answers.ts): the same on every surface, and after a reload. */
export function useAnswersOut(open: readonly Attention[]): Readonly<Record<string, AnswerOut>> {
  const store = useStore();
  const known = useAppState().control;
  useEffect(() => store.loadControl(), [store]);
  return useMemo(() => answersOut(known, open), [known, open]);
}

/** A start older than this is not waited on any more. */
const PENDING_MAX_MS = 3600_000;
const isStart = (a: ControlActivity) => a.kind === "start";

/** Starts from here whose session is not listed yet: the Board's starting cards and the
 *  sidebar's starting rows, the same list. A start's session takes over from its row once
 *  the list shows it: at its first turn, not at its bare start (the lists leave an empty
 *  session out). `machine` and `harness` are the Board's filters. Also the starts
 *  themselves, the clock they were read on (fine while one is in the alias window,
 *  newSessionState.ts) and the paired computers, for the Board's alias check. */
export function usePendingStarts(o: { machine?: string; harness?: string } = {}) {
  const { machine, harness } = o;
  const paired = useMachines().filter((m) => m.control);
  const starts = useControlActivity(isStart);
  const { sessions } = useAppState();
  const recentStart = starts.some((a) => Date.now() - Date.parse(a.at) < ALIAS_WINDOW_MS);
  const now = useNow(recentStart ? "fine" : "coarse");
  const listed = useCallback(
    (key: string | undefined) => {
      const s = key ? sessions.get(key) : undefined;
      return !!s && !isEmptySession(s);
    },
    [sessions],
  );
  const pending = useMemo(
    () =>
      starts.filter(
        (a) =>
          !!a.session &&
          !listed(a.session) &&
          !listed(a.ackSession) &&
          !isFinal(a) &&
          now - Date.parse(a.at) < PENDING_MAX_MS &&
          (!machine || paired.find((m) => m.control?.machineId === a.machineId)?.name === machine) &&
          (!harness || splitKey(a.session).harness === harness),
      ),
    [starts, listed, now, machine, harness, paired],
  );
  return { pending, starts, recentStart, now, paired };
}
