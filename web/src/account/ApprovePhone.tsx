// SPDX-License-Identifier: Apache-2.0
// Owned by: web. "Approve this iPhone", on a spacesheep account (docs/rfcs/08, "This
// phone's device key"): so the phone can send. The phone asks spacesheep to trust its own
// key (the hub does, with the key the signer holds; this page supplies nothing); spacesheep
// shows a request with a two-digit number on its Devices page, where a device that can
// already send types the number and approves; a key approved that way waits an hour before
// spacesheep carries what it signs. This page is each of those states with the one thing to
// do in it. Where the phone cannot sign at all (Android today), one line says so and the
// way on is spacesheep itself. The state is approve.ts's, the asking and looking device.ts's.
import { useEffect, useRef, useState } from "react";
import { ActionButton } from "../components/bits";
import { BackButton, PageBar } from "../components/PageBar";
import { useRpId } from "../control/hooks";
import { sentence } from "../control/PendingDevices";
import { canSign, deviceWords, signHint, useOwnKeys } from "../control/signer";
import { receiverOrigin } from "../lib/net";
import { back, useSearchParam } from "../lib/router";
import { clock, NEW_WORDS as N, ThisPhone, thisPhone } from "../native/accountWords";
import { invoke } from "../native/bridge";
import { Mark } from "./AccountSettings";
import type { ApproveView } from "./approve";
import { phoneWatch, usePhone } from "./device";
import { approveError } from "./screenWords";
import "../control/pairing.css";
import "./account.css";

const openOutside = (url: string) => void invoke("app_open_external", { url }).catch(() => {});

export default function ApprovePhone() {
  const watch = phoneWatch();
  const st = usePhone();
  const rp = useRpId();
  const [now, setNow] = useState(() => Date.now());
  const auto = useSearchParam("ask") === "1";
  const asked = useRef(false);
  const origin = receiverOrigin();
  const host = new URL(origin).host;
  const devices = st.memo.devicesUrl ?? `${origin}/devices`;
  // Reading the phone's own keys is what asks the signer whether it can sign here at all,
  // and draws this again when it has said.
  useOwnKeys(rp);
  const secure = canSign(rp);
  const view = st.view;
  const phase = view?.phase.kind;

  // The page is open: the watch looks often while something is waited for.
  useEffect(() => {
    watch?.watch(true);
    return () => watch?.watch(false);
  }, [watch]);
  // "Approve this iPhone" from the first run's sheet asks at once, once.
  useEffect(() => {
    if (!auto || asked.current || !secure || phase !== "idle") return;
    asked.current = true;
    void watch?.ask();
  }, [auto, secure, phase, watch]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /** Approved, and inside the hour a new device waits: no computer's row says it can send. */
  const cooling = view?.phase.kind === "cooling" ? view.phase : null;
  const ask = () => void watch?.ask();
  const err = st.error ? approveError(st.error, now) : null;
  const elsewhere = (
    <a className="btn" href={`${origin}/sessions`} target="_blank" rel="noreferrer noopener" data-elsewhere>
      {`Open on ${host}`}
    </a>
  );

  return (
    <div
      className="page page--doc page--grouped pair approve"
      data-approve={rp === null ? "reading" : !secure ? "cannot" : (phase ?? "reading")}
    >
      <PageBar title={N.machinesApprove(thisPhone())} back={<BackButton onClick={() => back("/machines")} />} />
      {rp !== null && !secure ? (
        // This phone cannot sign at all: one honest line, and where sending does work.
        <section className="form-group approve-panel">
          <p className="approve-line">
            <Mark kind="warn">{sentence(signHint(rp)).replace(/\.?$/, ".")}</Mark>
          </p>
          <div className="approve-actions">{elsewhere}</div>
        </section>
      ) : (
        <>
          <section className="form-group approve-panel" aria-live="polite">
            {!view && err ? (
              // Where the key stands could not be read, and spacesheep (or the app) said why:
              // that is the line; nothing is offered that would only be refused again.
              <p className="approve-line">
                <Mark kind="warn">{err.words}</Mark>
              </p>
            ) : !view || phase === "idle" ? (
              <>
                <p className="approve-lead">{N.approveLead(thisPhone(), deviceWords().auth)}</p>
                <div className="approve-actions">
                  <ActionButton
                    className="btn btn--primary btn--lg"
                    onClick={ask}
                    disabled={!view || rp === null}
                    pending={st.asking}
                    pendingLabel="Asking…"
                  >
                    {N.approveAsk}
                  </ActionButton>
                </div>
              </>
            ) : phase === "waiting" ? (
              <Waiting view={view} devices={devices} asking={st.asking} onAsk={ask} />
            ) : phase === "cooling" && view.phase.kind === "cooling" ? (
              <>
                <p className="approve-line">
                  <Mark kind="wait">
                    {view.phase.exact
                      ? N.approveCoolingAt(ThisPhone(), clock(view.phase.until))
                      : N.approveCoolingBy(ThisPhone(), clock(view.phase.until))}
                  </Mark>
                </p>
                <p className="approve-note">{N.approveCoolingWhy}</p>
              </>
            ) : phase === "approved" ? (
              <p className="approve-line">
                <Mark kind="ok">{N.approveDone(ThisPhone())}</Mark>
              </p>
            ) : (
              <>
                <p className="approve-line">
                  <Mark kind="warn">{N.approveDroppedTitle}</Mark>
                </p>
                <p className="approve-note">{N.approveDroppedBody}</p>
                <div className="approve-actions">
                  <ActionButton className="btn btn--primary" onClick={ask} pending={st.asking} pendingLabel="Asking…">
                    {N.approveAskAgain}
                  </ActionButton>
                </div>
              </>
            )}
            {view?.rest && (
              <p className="approve-note" data-rest>
                {N.approveRest(view.rest)}{" "}
                <button type="button" className="link" onClick={() => openOutside(devices)}>
                  {N.openDevices}
                </button>
              </p>
            )}
            {err && view && (
              <p className="approve-note approve-err" role="alert">
                {err.words}
              </p>
            )}
            {err?.elsewhere && <div className="approve-actions">{elsewhere}</div>}
          </section>

          {view && view.machines.length > 0 && (
            <section className="form-group" aria-label="Machines">
              <ul className="form-list">
                {view.machines.map((m) => (
                  <li
                    key={m.id}
                    className="form-row form-row--kv"
                    data-machine={m.state === "can" && cooling ? "waits" : m.state}
                  >
                    <span className="form-key approve-machine">{m.name}</span>
                    <span className="form-kv">
                      {m.state === "can" && cooling ? (
                        // Approved there, and inside the hour: it does not say the phone can send.
                        <Mark kind="wait">
                          {cooling.exact
                            ? N.approveRowFrom(clock(cooling.until))
                            : N.approveRowBy(clock(cooling.until))}
                        </Mark>
                      ) : m.state === "can" ? (
                        <Mark kind="ok">{N.approveCanSend}</Mark>
                      ) : m.state === "old" ? (
                        <Mark kind="warn">{N.approveOld}</Mark>
                      ) : (
                        <Mark kind="wait">{N.approveNotYet}</Mark>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {view && view.machines.length === 0 && phase !== "idle" && (
            <p className="approve-note">{N.approveNoMachines}</p>
          )}

          {view && phase !== "idle" && phase !== "dropped" && (
            <section className="form-group">
              <ul className="form-list">
                <li className="form-row">
                  <span className="form-row-text">
                    <span className="form-label">{N.removeLabel(thisPhone())}</span>
                    <span className="form-caption">{N.removeHint(thisPhone())}</span>
                  </span>
                  <button type="button" className="btn btn--sm" onClick={() => openOutside(devices)} data-remove>
                    {N.openDevices}
                  </button>
                </li>
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** A request is open on spacesheep: the number, the two things to do there, the wait. */
function Waiting({
  view,
  devices,
  asking,
  onAsk,
}: {
  view: ApproveView;
  devices: string;
  asking: boolean;
  onAsk: () => void;
}) {
  const code = view.phase.kind === "waiting" ? view.phase.code : null;
  return (
    <>
      <p className="approve-line">
        <Mark kind="wait">{N.approveWaiting}</Mark>
        <span className="spinner spinner--sm" aria-hidden="true" />
      </p>
      {code ? (
        <>
          <p className="approve-code num" data-code={code} role="img" aria-label={code.split("").join(" ")}>
            {code}
          </p>
          <ol className="approve-steps">
            <li>
              <span className="approve-n" aria-hidden="true">
                1
              </span>
              <span className="form-row-text">
                <span className="form-label">{N.approveStepOpen}</span>
                <span className="form-caption">{N.approveStepOpenHint}</span>
              </span>
              <button type="button" className="btn btn--sm" onClick={() => openOutside(devices)} data-devices>
                {N.openDevices}
              </button>
            </li>
            <li>
              <span className="approve-n" aria-hidden="true">
                2
              </span>
              <span className="form-row-text">
                <span className="form-label">{N.approveStepType(code)}</span>
                <span className="form-caption">{N.approveStepTypeHint}</span>
              </span>
            </li>
          </ol>
        </>
      ) : (
        <>
          <p className="approve-note">{N.approveNoNumber(ThisPhone())}</p>
          <div className="approve-actions">
            <ActionButton className="btn btn--primary" onClick={onAsk} pending={asking} pendingLabel="Asking…">
              {N.approveAskAgain}
            </ActionButton>
          </div>
        </>
      )}
      <p className="approve-note">{N.approveLasts}</p>
    </>
  );
}
