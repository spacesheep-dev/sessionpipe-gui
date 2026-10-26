// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. /add-device: this browser (a phone, usually) makes its own passkey
// for the receiver's rp id and asks to be trusted (CONTROL.md §2, "a trusted device vouches
// for a new one"). The page shows six digits; on a device the machine already trusts, the
// person compares them and approves, which sends a signed `key.add` carrying this key.
// The machine verifies it like any command, adds the key and acks `delivered`; this page
// polls until then. Nothing here is trusted on its own word.
import { useEffect, useState } from "react";
import { ActionButton } from "../components/bits";
import { BackButton, PageBar } from "../components/PageBar";
import { back, Link } from "../lib/router";
import { ms, useNow } from "../lib/time";
import { controlApi, httpsHere } from "./api";
import { useRpId } from "./hooks";
import { sentence } from "./PendingDevices";
import { canSign, signerKind, signHint } from "./signer";
import { NAME_MAX, useDeviceRequest } from "./useDeviceRequest";
import { guessDeviceName } from "./webauthn";
import { refusalWords } from "./words";
import "./pairing.css";

export function AddDevicePage() {
  const rp = useRpId();
  const secure = canSign(rp);
  const device = signerKind() === "device";
  const now = useNow();
  const { phase, error, known, ask } = useDeviceRequest(rp);
  const [name, setName] = useState(device ? "Mac app" : guessDeviceName());
  const [paired, setPaired] = useState<number | null>(null);
  const httpsHref = secure || device ? null : httpsHere();

  useEffect(() => {
    if (known[0]?.name) setName(known[0].name);
  }, [known]);

  useEffect(() => {
    let on = true;
    controlApi
      .machines()
      .then((m) => on && setPaired(m.length))
      .catch(() => on && setPaired(null));
    return () => {
      on = false;
    };
  }, []);

  const d = "d" in phase ? phase.d : null;
  const left = d ? ms(d.expiresAt) - now : 0;
  const digits = d?.check.padStart(6, "0");

  return (
    <div className="page page--doc page--grouped pair add-device">
      <PageBar
        title={device ? "Add this Mac" : "Add this device"}
        back={<BackButton onClick={() => back("/machines")} label="Machines" />}
      />
      <p className="caption pair-lead">
        {device
          ? "This Mac keeps its own key in its Secure Enclave, and a device the machine already trusts vouches for it: the same six digits on both, one approval."
          : "This device makes its own passkey, and one the machine already trusts vouches for it: the same six digits on both, one tap to approve."}
      </p>

      {d && digits && (
        <div className="pair-check">
          <span className="pair-check-label">
            {phase.k === "waiting" ? "Approve on a device that is already trusted. It shows" : "The digits were"}
          </span>
          <div
            className="pair-digits num"
            role="img"
            aria-label={`check digits ${digits.split("").join(" ")}`}
            data-check={d.check}
          >
            {digits.slice(0, 3)}
            <span className="pair-digits-gap" />
            {digits.slice(3)}
          </div>
          {phase.k === "waiting" && (
            <span className={`pair-countdown ${left < 90_000 ? "is-soon" : ""}`}>
              {phase.d.status === "sent"
                ? "Approved; waiting for the machine to add the key…"
                : `Waiting for approval · expires in ${countdown(left)}`}
            </span>
          )}
        </div>
      )}

      {phase.k === "added" ? (
        <div className="pair-note pair-note--ok" role="status" data-added>
          <strong>Done.</strong> This device can now answer and send: “{phase.d.name}” is{" "}
          {device ? "a key" : "a passkey"} the machine trusts.
          <br />
          <Link to="/">Open the board →</Link>
        </div>
      ) : phase.k === "failed" ? (
        <div className="pair-note pair-note--err" role="alert">
          <strong>Not added.</strong> The machine said no: {refusalWords(phase.d.code)}
          {phase.d.detail && !phase.d.code ? ` (${phase.d.detail})` : ""}.
        </div>
      ) : phase.k === "expired" ? (
        <div className="pair-note pair-note--quiet" role="status">
          <strong>The request expired.</strong> Nobody approved it within ten minutes. Ask again when a trusted device
          is at hand.
        </div>
      ) : phase.k === "rejected" ? (
        <div className="pair-note pair-note--quiet" role="status">
          <strong>Rejected.</strong> A trusted device turned this request down. Nothing was trusted.
        </div>
      ) : phase.k === "waiting" ? (
        <p className="pair-note">
          On the Mac (or any device the machine already trusts), open <strong>Machines</strong> in the GUI: this request
          is listed there with the same digits. Approve it with the {device ? "device" : "passkey"} that paired.
        </p>
      ) : null}

      {!secure && (
        <p className="pair-note pair-note--err">
          {sentence(signHint(rp))}
          {httpsHref ? (
            <>
              {" "}
              <a href={httpsHref}>Open on {new URL(httpsHref).host} →</a>
            </>
          ) : null}
        </p>
      )}
      {secure && paired === 0 && (
        <p className="pair-note">
          No machine is paired with this receiver yet. Pair one from its terminal first (
          <Link to="/machines">Machines</Link>
          ), then add this device.
        </p>
      )}
      {error && (
        <p className="pair-note pair-note--err" role="alert">
          {error}
        </p>
      )}

      {phase.k === "busy" ||
      phase.k === "idle" ||
      phase.k === "expired" ||
      phase.k === "rejected" ||
      phase.k === "failed" ? (
        <form
          className="pair-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (phase.k !== "busy") void ask(name);
          }}
        >
          <div className="pair-field">
            <label htmlFor="add-device-name">What to call this device</label>
            <input
              id="add-device-name"
              className="field"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX}
              autoComplete="off"
              aria-label="Device name"
              placeholder={guessDeviceName()}
              disabled={phase.k === "busy"}
            />
          </div>
          <div className="pair-actions">
            <ActionButton
              type="submit"
              className="btn btn--primary"
              disabled={!secure || !rp}
              pending={phase.k === "busy"}
              pendingLabel="Asking…"
            >
              {device
                ? "Add this Mac"
                : known.length
                  ? `Add this device with its passkey “${known[0]?.name ?? "here"}”`
                  : "Add this device"}
            </ActionButton>
            {known.length > 0 && !device && secure && phase.k !== "busy" && (
              <button type="button" className="btn btn--ghost" onClick={() => void ask(name, true)}>
                Make a new passkey instead
              </button>
            )}
          </div>
          {phase.k === "busy" && (
            <p className="pair-status" role="status">
              {phase.what}
            </p>
          )}
        </form>
      ) : null}
    </div>
  );
}

function countdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
