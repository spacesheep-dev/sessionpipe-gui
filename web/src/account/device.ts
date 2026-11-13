// SPDX-License-Identifier: Apache-2.0
// Owned by: web. This phone's own device key with the account this window shows: asks
// spacesheep to trust it (`acct_device_ask`, through the hub), looks where it stands (the
// device door) and keeps what approve.ts needs to say when it can send. One watch per
// window. It looks when somebody shows it (once, then at most once a minute when the app
// comes back to the front) and, while the Approve page is open and something is waited
// for, every five seconds: the device door is not counted against the relay's limit (only
// the relay's read is), and the hub's room for an account is six requests at a time. When
// the key is first seen trusted the machines are read again at once, so the composer
// agrees. Nothing here draws or holds a sentence.
import { useSyncExternalStore } from "react";
import { rpId } from "../control/api";
import { onSigner, ownKeys } from "../control/signer";
import {
  type ApproveView,
  approveView,
  type DeviceDoor,
  type DeviceMemo,
  deviceDoor,
  type KnownMachine,
  memoFrom,
  remember,
} from "./approve";
import { accountBackend } from "./current";
import type { DoorAnswer } from "./doors";
import { type DeviceAsked, type HubError, hubError } from "./shell";

/** Between two looks while the Approve page is open and waiting. */
export const LOOK_FAST_MS = 5000;
/** The least between two looks nobody asked for. */
export const LOOK_IDLE_MS = 60_000;

export interface PhoneState {
  /** Where the key stands; null until the first look came back. */
  view: ApproveView | null;
  memo: DeviceMemo;
  asking: boolean;
  /** The last ask's refusal, or the last look's. */
  error: HubError | null;
  /** When that refusal came, on this page's clock: a time it names ("ask again at") is
   *  counted from here, once, and does not move while the page stays open. */
  errorAt: number | null;
}

export interface PhoneWatch {
  get(): PhoneState;
  subscribe(l: () => void): () => void;
  /** Asks spacesheep to trust this phone's key, then looks. */
  ask(): Promise<void>;
  look(): Promise<void>;
  /** The Approve page is open (or closed again). */
  watch(on: boolean): void;
  stop(): void;
  /** The app is in front again (the page's own listener calls this): the clock is read
   *  again and spacesheep is asked once. */
  front(): void;
  /** What the page itself knows of the key changed (its machine list, its own keys). */
  refresh(): void;
}

export interface PhoneWatchOptions {
  /** The account's id: what is remembered is kept under it. */
  id: string;
  deviceAsk(): Promise<DeviceAsked>;
  device(): Promise<DoorAnswer>;
  machinesNow(): Promise<void>;
  onCooling(l: (until: number) => void): () => void;
  store?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
  /** Whether the app is in front (a hidden page asks nothing). */
  visible?: () => boolean;
  /** The account's computers as the page lists them, each with whether it trusts a key
   *  this phone holds (approve.ts KnownMachine): read where the hub has no word of the key. */
  known?: () => KnownMachine[];
}

export const memoKey = (id: string): string => `sessionpipe-gui.account.device.${id}`;

export function startPhoneWatch(o: PhoneWatchOptions): PhoneWatch {
  const now = o.now ?? (() => Date.now());
  const visible = o.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const store = o.store === undefined ? safeStorage() : o.store;
  const listeners = new Set<() => void>();
  let door: DeviceDoor | null = null;
  let looked = false;
  let lookedAt = 0;
  let state: PhoneState = { view: null, memo: read(), asking: false, error: null, errorAt: null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let turn: ReturnType<typeof setTimeout> | null = null;
  let watching = false;
  let looking: Promise<void> | null = null;
  let stopped = false;

  function read(): DeviceMemo {
    try {
      return memoFrom(store?.getItem(memoKey(o.id)) ?? null);
    } catch {
      return {};
    }
  }
  const keep = (memo: DeviceMemo): void => {
    try {
      store?.setItem(memoKey(o.id), JSON.stringify(memo));
    } catch {
      // not kept: the hour's end is then worked out again from the next look
    }
  };
  const set = (patch: Partial<PhoneState>): void => {
    // A refusal is stamped as it comes, and its time stays while it is the one shown.
    if ("error" in patch) patch = { ...patch, errorAt: patch.error ? now() : null };
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  /** The view as of now, and a timer for the moment it changes by itself (the hour ends). */
  const show = (memo: DeviceMemo, more: Partial<PhoneState> = {}): void => {
    const view = looked ? approveView(memo, door, now(), door ? [] : (o.known?.() ?? [])) : null;
    if (turn) clearTimeout(turn);
    turn = null;
    if (view?.phase.kind === "cooling" && !stopped)
      turn = setTimeout(() => show(state.memo), Math.min(Math.max(view.phase.until - now(), 0) + 50, 2_147_000_000));
    set({ view, memo, ...more });
  };
  /** Something is still to come that only spacesheep knows of. */
  const waiting = (): boolean => {
    const v = state.view;
    return !looked || v?.phase.kind === "waiting" || !!v?.rest;
  };
  /** How the last look ended: `mend` is a refusal only a person can mend (spacesheep's own
   *  no, a key that is not there); `unreached` counts the looks in a row that reached nobody. */
  let mend = false;
  let unreached = 0;
  /** When the next look is due while the page is open, or null when none is.
   *  - A refusal only a person can mend: none. Asking again changes nothing; the state is
   *    shown with its one way on, and the app coming to the front looks once.
   *  - spacesheep out of reach: at a growing interval, five seconds up to a minute.
   *  - Something waited for: every five seconds.
   *  - Settled: at the slow cadence, so a phone removed on spacesheep is noticed. */
  const nextLook = (): number | null => {
    if (mend) return null;
    if (unreached) return Math.min(LOOK_FAST_MS * 2 ** (unreached - 1), LOOK_IDLE_MS);
    return waiting() ? LOOK_FAST_MS : LOOK_IDLE_MS;
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || !watching) return;
    const wait = nextLook();
    if (wait === null) return;
    timer = setTimeout(() => {
      timer = null;
      if (visible()) void look();
      else schedule();
    }, wait);
  };

  const look = (): Promise<void> => {
    looking ??= (async () => {
      try {
        const a = await o.device();
        lookedAt = now();
        if (a.hub === "no_device_key") {
          door = null;
          looked = true;
          // No key to ask about until the person asks for one.
          mend = true;
          unreached = 0;
          return show(state.memo, { error: null });
        }
        if (a.hub || a.status < 200 || a.status >= 300) {
          const code = a.hub ?? (typeof a.json.code === "string" ? a.json.code : "refused");
          const message = typeof a.json.error === "string" ? a.json.error : "";
          // Nobody was reached (the hub could not, spacesheep failed or asked to wait): asked
          // again, less and less often. Anything else is a no that asking again will not change.
          const nobody = a.hub
            ? a.hub === "unreachable" || a.hub === "timeout" || a.hub === "busy"
            : a.status >= 500 || a.status === 429;
          mend = !nobody;
          unreached = nobody ? unreached + 1 : 0;
          return set({ error: { code, message, ...(a.hub ? {} : { upstream: code }) } });
        }
        mend = false;
        unreached = 0;
        const was = door?.trusted ?? false;
        door = deviceDoor(a.json);
        looked = true;
        const memo = remember(state.memo, door, now());
        keep(memo);
        show(memo, { error: null });
        if (door.trusted && !was) void o.machinesNow().catch(() => {});
      } catch (e) {
        mend = false;
        unreached++;
        set({ error: hubError(e) });
      } finally {
        looking = null;
        schedule();
      }
    })();
    return looking;
  };

  const ask = async (): Promise<void> => {
    if (state.asking) return;
    set({ asking: true, error: null });
    try {
      // What is granted is never asked for again (an ask rings and mails the account). Where
      // the hub has no word of the key, the machines are read first: a computer that
      // already trusts a key of this phone means there is nothing to ask.
      if (!door && o.known) {
        await o.machinesNow().catch(() => {});
        if (o.known().some((m) => m.trusts)) {
          looked = true;
          return show(state.memo, { asking: false });
        }
      }
      const a = await o.deviceAsk();
      // Another key (a new install): nothing remembered of the old one applies.
      const base = state.memo.keyId === a.keyId ? state.memo : {};
      const memo: DeviceMemo = {
        ...base,
        keyId: a.keyId,
        code: a.code,
        askedAt: now(),
        ...(a.devicesUrl ? { devicesUrl: a.devicesUrl } : {}),
      };
      keep(memo);
      set({ memo });
      await look();
      set({ asking: false });
    } catch (e) {
      set({ asking: false, error: hubError(e) });
    }
  };

  const offCooling = o.onCooling((until) => {
    const memo = { ...state.memo, until };
    keep(memo);
    show(memo);
  });
  /** The app is in front again: the clock is read again (an hour may have ended while the
   *  phone slept, and no timer ran), and spacesheep is asked once, whatever the last look
   *  said and however long ago it was. */
  const front = (): void => {
    if (!visible()) return;
    if (looked) show(state.memo);
    void look();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", front);

  return {
    get: () => state,
    subscribe(l) {
      listeners.add(l);
      // Somebody shows it: one look, unless one came back a moment ago.
      if (!looking && now() - lookedAt >= LOOK_IDLE_MS) void look();
      return () => void listeners.delete(l);
    },
    ask,
    look,
    front,
    refresh() {
      // The machine list or the phone's own keys changed: the same look, read again.
      if (!looked || stopped) return;
      const next = approveView(state.memo, door, now(), door ? [] : (o.known?.() ?? []));
      if (JSON.stringify(next) !== JSON.stringify(state.view)) show(state.memo);
    },
    watch(on) {
      watching = on;
      if (on && !looking) void look();
      else schedule();
    },
    stop() {
      stopped = true;
      offCooling();
      if (timer) clearTimeout(timer);
      if (turn) clearTimeout(turn);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", front);
    },
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let watch: PhoneWatch | null = null;
/** The watch of the account this window shows; null where it shows none. */
export function phoneWatch(): PhoneWatch | null {
  if (watch) return watch;
  const b = accountBackend();
  if (!b) return null;
  /** The rp id the phone's keys are made for, once the page has read it. */
  let rp: string | null = null;
  const known = (): KnownMachine[] => {
    const own = new Set(rp ? ownKeys(rp).map((k) => k.id) : []);
    return b.machines().map((m) => ({ ...m, trusts: m.keys.some((k) => own.has(k)) }));
  };
  watch = startPhoneWatch({
    id: b.view().id,
    deviceAsk: b.deviceAsk,
    device: b.device,
    machinesNow: b.machinesNow,
    onCooling: b.onCooling,
    known,
  });
  // What the page knows of the key by itself: read again when the machines are listed, when
  // the signer has said which key this phone holds, and when the rp id is known.
  const w = watch;
  b.subscribe(() => w.refresh());
  onSigner(() => w.refresh());
  void rpId().then(
    (r) => {
      rp = r;
      w.refresh();
    },
    () => {},
  );
  return watch;
}

const NOTHING: PhoneState = { view: null, memo: {}, asking: false, error: null, errorAt: null };
const never = (): (() => void) => () => {};

/** Where this phone's key stands, for a component; `view: null` where there is no account. */
export function usePhone(): PhoneState {
  const w = phoneWatch();
  return useSyncExternalStore(w ? w.subscribe : never, w ? w.get : () => NOTHING);
}
