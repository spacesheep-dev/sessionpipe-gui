// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Devices asking to be trusted (GET /devices, every 3 s while the
// page is open), each with its six digits. This browser, when the machine trusts its
// passkey, vouches for one with Approve: a signed `key.add` (session sessionpipe:keys)
// carrying the device's key goes through the same path as any command (CONTROL.md §2);
// the machine's `delivered` ack settles the request on the server. Shown on /machines and
// /phone: a row each, the digits large, Reject and Approve (and the same in its menu).
// A request from the native app carries a device key (CONTROL.md §2): it reads "Mac app ·
// Secure Enclave", and Approve waits for a machine whose daemon takes device keys. In the
// app itself, Approve is one Touch ID that names the device (a confirm, never the grant).
import { useEffect, useState } from "react";
import { lazyModule } from "../lib/lazy";
import { controlApi, type DeviceRequest, rpId } from "./api";
import "./pairing.css";

// The rows load only once a device asks: most pages never show one.
const body = lazyModule(() => import("./PendingDevicesBody"));

const POLL_MS = 3000;

/** A hint from control/webauthn.ts as a sentence: its first letter upper-cased. */
export const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function usePendingDevices(): DeviceRequest[] {
  const [list, setList] = useState<DeviceRequest[]>([]);
  useEffect(() => {
    let on = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const d = await controlApi.devices();
        if (on) setList(d);
      } catch {
        // the next tick tries again
      }
      if (on) timer = setTimeout(tick, document.visibilityState === "hidden" ? POLL_MS * 4 : POLL_MS);
    };
    void tick();
    return () => {
      on = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return list;
}

/** The one muted line for a request that carries a device key: which app, and where its key lives. */
export function deviceKeyLabel(device: string, name?: string): string {
  const app = device === "iPhone" || device === "iPad" ? `${device} app` : "Mac app";
  return name === app ? "Secure Enclave" : `${app} · Secure Enclave`;
}

/** Devices asking to be trusted: nothing (and nothing loaded) until one asks; from then
 *  on, the rows, which keep this page's approvals until the machine's word is in. */
export function PendingDevices({ bar = false }: { bar?: boolean }) {
  const list = usePendingDevices();
  // The rp id, read as the page opens: the Session view's composer (lazy, mounted after
  // this) can't send until it has it, and this strip mounts first.
  useEffect(() => {
    void rpId().catch(() => {});
  }, []);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (list.length) setSeen(true);
  }, [list.length]);
  return seen || list.length ? <Rows bar={bar} list={list} /> : null;
}

function Rows({ bar, list }: { bar: boolean; list: DeviceRequest[] }) {
  const m = body.use();
  return m ? <m.PendingDevicesBody bar={bar} list={list} /> : null;
}
