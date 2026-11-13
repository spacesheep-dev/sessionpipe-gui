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
import {
  type ApproveView,
  approveView,
  type DeviceDoor,
  type DeviceMemo,
  deviceDoor,
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
    const view = looked ? approveView(memo, door, now()) : null;
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
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || !watching || !waiting()) return;
    timer = setTimeout(() => {
      timer = null;
      if (visible()) void look();
      else schedule();
    }, LOOK_FAST_MS);
  };

  const look = (): Promise<void> => {
    looking ??= (async () => {
      try {
        const a = await o.device();
        lookedAt = now();
        if (a.hub === "no_device_key") {
          door = null;
          looked = true;
          return show(state.memo, { error: null });
        }
        if (a.hub || a.status < 200 || a.status >= 300) {
          const code = a.hub ?? (typeof a.json.code === "string" ? a.json.code : "refused");
          const message = typeof a.json.error === "string" ? a.json.error : "";
          return set({ error: { code, message, ...(a.hub ? {} : { upstream: code }) } });
        }
        const was = door?.trusted ?? false;
        door = deviceDoor(a.json);
        looked = true;
        const memo = remember(state.memo, door, now());
        keep(memo);
        show(memo, { error: null });
        if (door.trusted && !was) void o.machinesNow().catch(() => {});
      } catch (e) {
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
  const front = (): void => {
    if (!visible()) return;
    if (watching ? waiting() : now() - lookedAt >= LOOK_IDLE_MS) void look();
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
  watch = startPhoneWatch({
    id: b.view().id,
    deviceAsk: b.deviceAsk,
    device: b.device,
    machinesNow: b.machinesNow,
    onCooling: b.onCooling,
  });
  return watch;
}

const NOTHING: PhoneState = { view: null, memo: {}, asking: false, error: null, errorAt: null };
const never = (): (() => void) => () => {};

/** Where this phone's key stands, for a component; `view: null` where there is no account. */
export function usePhone(): PhoneState {
  const w = phoneWatch();
  return useSyncExternalStore(w ? w.subscribe : never, w ? w.get : () => NOTHING);
}
