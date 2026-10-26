// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The rows of PendingDevices.tsx: approve (a signed key.add) or
// reject a device asking to be trusted. Loaded only once a request shows up, so the board
// carries none of it until then.
import type { MachineSummary } from "@shared/api";
import { useState } from "react";
import { ActionButton } from "../components/bits";
import { useContextMenu } from "../components/ContextMenu";
import { Select } from "../components/Select";
import { useMachines } from "../data/hooks";
import { ms, useNow } from "../lib/time";
import { ControlError, controlApi, type DeviceRequest } from "./api";
import { sendCommand } from "./command";
import { useControlActivity, useGrant, useRpId } from "./hooks";
import { deviceKeyLabel, sentence } from "./PendingDevices";
import { approveBlocker, canSign, signerKind, signerLabel, signHint } from "./signer";
import { outcomeWords, sendErrorWords } from "./words";

/** The grant did not satisfy the verifier even after a fresh tap: one passkey confirm over the command itself. */
const CONFIRM_FALLBACK = new Set(["bad_grant", "outside_grant", "bad_csig", "bad_assertion"]);

export function PendingDevicesBody({ bar = false, list }: { bar?: boolean; list: DeviceRequest[] }) {
  const machines = useMachines();
  const paired = machines.filter((m) => m.control);
  const rp = useRpId();
  const secure = canSign(rp);
  const grant = useGrant(rp);
  const now = useNow();
  const [target, setTarget] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [tap, setTap] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Requests this page approved: request id → the key.add's activity id, so the row stays
   *  until the machine's word is in, even once the server stops listing it. */
  const [approved, setApproved] = useState<{ requestId: string; name: string; activityId: string; machine: string }[]>(
    [],
  );
  const activity = useControlActivity();

  const machineFor = (d: DeviceRequest) => {
    const id = target[d.requestId] ?? d.machineId ?? paired[0]?.control?.machineId;
    return paired.find((m) => m.control?.machineId === id);
  };

  const approve = async (d: DeviceRequest) => {
    const m = machineFor(d);
    if (!rp || !m?.control || busy) return;
    setBusy(d.requestId);
    setErrors((e) => ({ ...e, [d.requestId]: "" }));
    const fields = { kind: "key.add" as const, key: d.key, name: d.name };
    try {
      let a: Awaited<ReturnType<typeof sendCommand>>;
      try {
        // The app vouches with one Touch ID that names the device (Rust never signs a
        // key.add under the day grant).
        const confirm = signerKind() === "device";
        a = await sendCommand(rp, m.control.machineId, fields, { confirm, onTap: () => setTap(true) });
      } catch (e) {
        if (signerKind() === "device" || !(e instanceof ControlError && e.code && CONFIRM_FALLBACK.has(e.code)))
          throw e;
        a = await sendCommand(rp, m.control.machineId, fields, { confirm: true, onTap: () => setTap(true) });
      }
      setApproved((list) => [...list, { requestId: d.requestId, name: d.name, activityId: a.id, machine: m.name }]);
    } catch (e) {
      setErrors((x) => ({ ...x, [d.requestId]: sendErrorWords(e) }));
    } finally {
      setTap(false);
      setBusy(null);
      grant.refresh();
    }
  };

  const reject = async (d: DeviceRequest) => {
    if (busy) return;
    setBusy(d.requestId);
    try {
      await controlApi.rejectDevice(d.requestId);
    } catch (e) {
      setErrors((x) => ({ ...x, [d.requestId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const open = list.filter((d) => !approved.some((a) => a.requestId === d.requestId));
  const settled = approved
    .map((a) => ({ ...a, msg: activity.find((x) => x.id === a.activityId) }))
    .filter((a) => !list.some((d) => d.requestId === a.requestId && d.status === "pending"));
  if (open.length === 0 && settled.length === 0) return null;

  return (
    <section
      className={`pending pending-devices ${bar ? "pending--bar" : ""}`}
      aria-label="Devices asking to be trusted"
    >
      <h2 className="section-label">
        {open.length === 0
          ? "A device was added"
          : open.length === 1
            ? "A device asks to be trusted"
            : `${open.length} devices ask to be trusted`}
      </h2>
      <ul className="pending-list">
        {open.map((d) => (
          <DeviceRow
            key={d.requestId}
            d={d}
            left={Math.max(0, Math.ceil((ms(d.expiresAt) - now) / 1000))}
            m={machineFor(d)}
            paired={paired}
            secure={secure}
            rp={rp}
            busy={busy}
            tap={tap}
            err={errors[d.requestId]}
            onTarget={(id) => setTarget((t) => ({ ...t, [d.requestId]: id }))}
            onApprove={() => void approve(d)}
            onReject={() => void reject(d)}
          />
        ))}
        {settled.map((a) => (
          <li key={a.requestId} className="pending-item pending-item--settled" data-device={a.requestId}>
            <span className="pending-who">
              <span className="pending-name">{a.name}</span>
              <span className="pending-meta" data-outcome={a.msg?.outcome ?? "queued"}>
                {a.msg?.outcome === "delivered"
                  ? `Added: ${a.machine} now answers to it; the device can answer and send`
                  : a.msg
                    ? outcomeWords(a.msg, { machine: a.machine })
                    : `Queued: waiting for ${a.machine} to take it`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One device asking: who it is on two lines, its six digits large (the one earned
 *  prominent thing in the app), when the request expires, Reject and Approve. Its menu
 *  offers the same two. */
function DeviceRow({
  d,
  left,
  m,
  paired,
  secure,
  rp,
  busy,
  tap,
  err,
  onTarget,
  onApprove,
  onReject,
}: {
  d: DeviceRequest;
  left: number;
  m: MachineSummary | undefined;
  paired: MachineSummary[];
  secure: boolean;
  rp: string | null;
  busy: string | null;
  tap: boolean;
  err: string | undefined;
  onTarget: (id: string) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const why = !secure ? sentence(signHint(rp)) : !rp ? "Reading the receiver…" : approveBlocker(d, m);
  const menu = useContextMenu(
    () => [
      { label: "Approve", run: onApprove, disabled: why ?? (busy ? "Busy" : undefined) },
      { sep: true },
      { label: "Reject", danger: true, run: onReject, disabled: busy ? "Busy" : undefined },
    ],
    { title: () => d.name, subtitle: () => `${d.check.slice(0, 3)} ${d.check.slice(3)}` },
  );
  return (
    <li className="pending-item pending-item--device" data-device={d.requestId} {...menu}>
      <span className="pending-who">
        <span className="pending-name">{d.name}</span>
        <span className="pending-meta" title={`from ${d.fromIp}`}>
          {d.key.type === "device"
            ? deviceKeyLabel(d.device, d.name)
            : `${d.name !== d.device ? `${d.device} · ` : ""}from ${d.fromIp}`}
        </span>
      </span>
      <span className="pending-check">
        <span className="pending-digits num" title="The digits the device shows">
          {d.check.slice(0, 3)} {d.check.slice(3)}
        </span>
        <span className="pending-meta pending-expires num">
          Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
        </span>
      </span>
      <span className="pending-actions">
        {paired.length > 1 && (
          <Select<string>
            size="sm"
            align="end"
            aria-label="Machine to trust it on"
            value={m?.control?.machineId ?? ""}
            onChange={onTarget}
            disabled={!!busy}
            options={paired.map((p) => ({ value: p.control!.machineId, label: p.name }))}
          />
        )}
        <button type="button" className="btn" disabled={!!busy} onClick={onReject}>
          Reject
        </button>
        <ActionButton
          className="btn btn--primary"
          disabled={!!why || (!!busy && busy !== d.requestId)}
          data-tip={why ?? (m ? `Trust it on ${m.name}` : undefined)}
          onClick={onApprove}
          pending={busy === d.requestId}
          pendingLabel={tap ? `Confirm with ${signerLabel()}…` : "Approving…"}
        >
          Approve
        </ActionButton>
      </span>
      {why && <span className="pending-meta pending-wide">{why}</span>}
      {err ? (
        <span className="pending-meta pending-wide pending-err" role="alert">
          {err}
        </span>
      ) : null}
    </li>
  );
}
