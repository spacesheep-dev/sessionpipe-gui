// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. /pair?code=…: a terminal ran `sessionpipe control pair` and
// printed six digits; this page shows the same six from the receiver, and the person
// confirms with a passkey (CONTROL.md §2 step 2). The passkey's assertion over
// sha256("sessionpipe.pair:" + machine + ":" + code) goes to the receiver, which hands it
// to the daemon on its next status poll; the terminal finishes by itself. `PairBody` is
// the page without its frame (Pair.tsx draws it), so the setup page shows it inline too.
// In the native app there is no passkey: "Approve with Touch ID" asks the shell, which
// reads this pairing itself, puts its digits and machine in the Touch ID prompt, and signs
// the same challenge with the app's device key (CONTROL.md §3.2, purpose `pair`).
import { accountLabel } from "@shared/api";
import { useEffect, useState } from "react";
import { ActionButton, HarnessGlyph } from "../components/bits";
import "../lib/acp";
import { harnessMark } from "../lib/format";
import { ms, useNow } from "../lib/time";
import { ControlError, controlApi, httpsHere, type Pairing } from "./api";
import { fromB64url } from "./bytes";
import { assertPasskey, registerPasskey } from "./ceremony";
import { sentence } from "./PendingDevices";
import {
  deviceWords,
  machineTakes,
  nativeErrorWords,
  pairWithDevice,
  signerKind,
  signHint,
  updateWords,
} from "./signer";
import {
  forgetPasskey,
  guessDeviceName,
  insecureHint,
  passkeysAvailable,
  type StoredPasskey,
  storedPasskeys,
  webauthnError,
} from "./webauthn";
import "./pairing.css";

type Phase =
  | { k: "loading" }
  | { k: "missing"; why: string }
  | { k: "ready"; p: Pairing }
  | { k: "busy"; p: Pairing; what: string }
  | { k: "approved"; p: Pairing; keyName: string; firstPairing: boolean }
  | { k: "rejected"; p: Pairing };

function missingWords(e: unknown): string {
  if (e instanceof ControlError) {
    if (e.status === 404)
      return "No pairing with this code: it was rejected, renewed from the terminal, or never started here.";
    if (e.status === 401) return "This page lost its key. Open the board again through the terminal's link.";
    return e.detail ?? e.reason;
  }
  return e instanceof Error ? e.message : String(e);
}

function approveErrorWords(e: unknown, machine: string): string {
  if (e instanceof ControlError) {
    switch (e.reason) {
      case "expired":
        return `The code expired. On ${machine}, run sessionpipe control pair again for new digits.`;
      case "already_approved":
        return "This pairing was already approved; the terminal is collecting it.";
      case "not_found":
        return "The pairing is gone: rejected, renewed, or expired and forgotten.";
      case "bad_proof":
        return `The receiver could not verify the passkey's signature${e.detail ? `: ${e.detail}` : ""}.`;
      case "bad_key":
        return "This passkey is in a shape the machine cannot use; make a new one.";
      default:
        return e.detail ?? e.reason;
    }
  }
  return nativeErrorWords(e) ?? webauthnError(e);
}

/** The approval itself: the digits, the facts, Approve / Reject. `compact` drops the
 *  heading and the lead (the setup page has its own). */
export function PairBody({ code, compact = false }: { code: string; compact?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(guessDeviceName());
  const [known, setKnown] = useState<StoredPasskey[]>([]);
  const device = signerKind() === "device";
  const secure = device || passkeysAvailable("p" in phase ? phase.p.rpId : undefined);
  const now = useNow();

  useEffect(() => {
    if (!code) {
      setPhase({ k: "missing", why: "This page needs the link the terminal printed (it carries ?code=…)." });
      return;
    }
    let on = true;
    controlApi
      .pairing(code)
      .then((p) => {
        if (!on) return;
        setKnown(storedPasskeys(p.rpId));
        setPhase({ k: "ready", p });
      })
      .catch((e) => on && setPhase({ k: "missing", why: missingWords(e) }));
    return () => {
      on = false;
    };
  }, [code]);

  const approve = async (p: Pairing, fresh: boolean) => {
    setError(null);
    const challenge = fromB64url(p.challenge);
    if (!challenge) {
      setError("The receiver sent an unreadable challenge.");
      return;
    }
    const deviceName = name.trim() || guessDeviceName();
    if (device) {
      try {
        setPhase({ k: "busy", p, what: `Confirm with ${deviceWords().auth}: the prompt shows the same digits…` });
        const { key, proof } = await pairWithDevice(p.code);
        setPhase({ k: "busy", p, what: "Sending the proof to the receiver…" });
        const r = await controlApi.approve(p.code, { key, proof, name: "Mac app" });
        setPhase({ k: "approved", p, keyName: "Mac app", firstPairing: r.firstPairing });
      } catch (e) {
        setError(approveErrorWords(e, p.machine.name));
        setPhase({ k: "ready", p });
      }
      return;
    }
    try {
      let key: StoredPasskey | undefined;
      let proof: Awaited<ReturnType<typeof assertPasskey>>;
      const reuse = fresh ? [] : storedPasskeys(p.rpId);
      if (reuse.length) {
        setPhase({ k: "busy", p, what: "Waiting for your passkey…" });
        proof = await assertPasskey(
          p.rpId,
          challenge,
          reuse.map((k) => k.id),
        );
        key = reuse.find((k) => k.id === proof.cred);
        if (!key) {
          forgetPasskey(p.rpId, proof.cred);
          throw new Error("The passkey that answered is not one this browser remembers; make a new one.");
        }
      } else {
        setPhase({ k: "busy", p, what: "Making a passkey for this browser…" });
        key = await registerPasskey(p.rpId, deviceName);
        setPhase({ k: "busy", p, what: "Confirming the digits with it…" });
        proof = await assertPasskey(p.rpId, challenge, [key.id]);
      }
      setPhase({ k: "busy", p, what: "Sending the proof to the receiver…" });
      const r = await controlApi.approve(p.code, {
        key: { id: key.id, alg: key.alg, spki: key.spki },
        proof,
        name: key.name ?? deviceName,
      });
      setKnown(storedPasskeys(p.rpId));
      setPhase({ k: "approved", p, keyName: key.name ?? deviceName, firstPairing: r.firstPairing });
    } catch (e) {
      setError(approveErrorWords(e, p.machine.name));
      setPhase({ k: "ready", p });
    }
  };

  const reject = async (p: Pairing) => {
    setError(null);
    setPhase({ k: "busy", p, what: "Rejecting…" });
    try {
      await controlApi.reject(p.code);
      setPhase({ k: "rejected", p });
    } catch (e) {
      setError(approveErrorWords(e, p.machine.name));
      setPhase({ k: "ready", p });
    }
  };

  if (phase.k === "loading") return <p className="page-note">Looking up the pairing…</p>;
  if (phase.k === "missing") return <p className="pair-note pair-note--err">{phase.why}</p>;

  const p = phase.p;
  const m = p.machine;
  const left = ms(p.expiresAt) - now;
  const expired = p.status === "expired" || left <= 0;
  const digits = p.check.padStart(6, "0");
  // The daemon printed http://localhost/pair?code=…; with TLS mode on that origin cannot
  // sign, so the same page on the https origin is one click away.
  const https = secure ? null : httpsHere();
  // The app's device key goes only to a daemon that said it takes one (CONTROL.md §2).
  const old = device && !machineTakes(m) ? updateWords(m.name) : null;

  return (
    <div className={`pair-body ${compact ? "pair-body--compact" : ""}`}>
      {!compact && (
        <p className="caption pair-lead">
          A terminal on {m.name} asked to be controlled from here. Compare the six digits with the ones it printed, then
          approve with {device ? deviceWords().auth : "a passkey"}.
        </p>
      )}

      <div className="pair-check">
        <span className="pair-check-label">The terminal shows</span>
        <div
          className="pair-digits num"
          role="img"
          aria-label={`check digits ${digits.split("").join(" ")}`}
          data-check={p.check}
        >
          {digits.slice(0, 3)}
          <span className="pair-digits-gap" />
          {digits.slice(3)}
        </div>
        {phase.k !== "approved" && phase.k !== "rejected" && (
          <span className={`pair-countdown ${left < 90_000 ? "is-soon" : ""}`}>
            {expired ? "This code expired." : `Expires in ${countdown(left)}`}
          </span>
        )}
      </div>

      <section className="form-group" aria-label="The machine">
        <ul className="form-list pair-facts">
          <li className="form-row form-row--kv">
            <span className="form-key">Machine</span>
            <span className="form-kv">
              {m.name} <span className="pair-ver num">· sessionpipe {m.version}</span>
            </span>
          </li>
          <li className="form-row form-row--kv">
            <span className="form-key">Harnesses</span>
            <span className="form-kv">
              {m.harnesses.length
                ? m.harnesses.map((h) => (
                    <span key={h} className="machine-harness">
                      <HarnessGlyph name={h} size="sm" /> {harnessMark(h).label}
                    </span>
                  ))
                : "None reported"}
            </span>
          </li>
          <li className="form-row form-row--kv">
            <span className="form-key">From</span>
            <span className="form-kv mono">{p.fromIp}</span>
          </li>
          {m.folders && m.folders.length > 0 && (
            <li className="form-row form-row--kv">
              <span className="form-key">Folders</span>
              <span className="form-kv mono">{m.folders.join("  ")}</span>
            </li>
          )}
          {m.mode && (
            <li className="form-row form-row--kv">
              <span className="form-key">Mode</span>
              <span className="form-kv">
                {m.mode}
                {m.mode === "inherit" && (
                  <span className="machine-caution">
                    Sessions run as your own do on {m.name}, with whatever the agents' own settings allow, which can
                    include skipping permission checks.
                  </span>
                )}
              </span>
            </li>
          )}
          {m.accounts && m.accounts.length > 0 && (
            <li className="form-row form-row--kv">
              <span className="form-key">Accounts</span>
              <span className="form-kv">{m.accounts.map((a) => `${accountLabel(a)} (${a.harness})`).join(", ")}</span>
            </li>
          )}
          <li className="form-row form-row--kv">
            <span className="form-key">Keys</span>
            <span className="form-kv">{m.keys === 0 ? "None yet" : `${m.keys} trusted already`}</span>
          </li>
        </ul>
      </section>

      {phase.k === "approved" ? (
        <div className="pair-note pair-note--ok" role="status">
          <strong>Approved.</strong> The terminal on {m.name} will finish by itself
          {phase.firstPairing ? " and collect its own token" : ""}. {m.name} now trusts{" "}
          {device ? `${deviceWords().its} key` : `the passkey “${phase.keyName}” from this browser`}.
          <br />
          Every device you send from needs its own approval: on another phone or laptop, run{" "}
          <code>sessionpipe control pair</code> again on {m.name} and approve there.
        </div>
      ) : phase.k === "rejected" ? (
        <div className="pair-note pair-note--quiet" role="status">
          <strong>Rejected.</strong> The terminal stops on its next poll. Nothing was trusted.
        </div>
      ) : (
        <>
          {m.firstPairing && (
            <p className="pair-note">
              First pairing: approving hands {m.name} its own token for polls and acks, and makes{" "}
              {device ? `${deviceWords().its} key` : "this browser's passkey"} the first one it trusts.
            </p>
          )}
          {p.open && (
            <p className="pair-note">
              This request came with no sink token (open pairing). Approving also hands {m.name} this receiver's sink
              token, so its sessions show here without a second step. Only approve a request you just made.
            </p>
          )}
          {old && <p className="pair-note pair-note--quiet">{old}</p>}
          {!secure && (
            <div className="pair-note pair-note--err">
              {sentence(device ? signHint() : insecureHint())}
              {https && (
                <p className="pair-https">
                  <a className="btn btn--primary" href={https}>
                    Open on {new URL(https).host} →
                  </a>
                </p>
              )}
            </div>
          )}
          {error && (
            <p className="pair-note pair-note--err" role="alert">
              {error}
            </p>
          )}
          {/* The form stays while the passkey works: the pressed button reads its pending
              verb at its own width, the rest wait, and one line says what is happening. */}
          <form
            className="pair-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (phase.k !== "busy") void approve(p, false);
            }}
          >
            {known.length === 0 && !device && (
              <div className="pair-field">
                <label htmlFor="pair-device-name">What to call this device on {m.name}</label>
                <input
                  id="pair-device-name"
                  className="field"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  autoComplete="off"
                  aria-label="Device name"
                  disabled={phase.k === "busy"}
                />
              </div>
            )}
            <div className="pair-actions">
              <ActionButton
                type="submit"
                className="btn btn--primary"
                disabled={!secure || expired || !!old}
                pending={phase.k === "busy" && phase.what !== "Rejecting…"}
                pendingLabel="Approving…"
              >
                {device
                  ? `Approve with ${deviceWords().auth}`
                  : known.length
                    ? `Approve with passkey “${known[0]?.name ?? "this browser"}”`
                    : "Approve with passkey"}
              </ActionButton>
              <ActionButton
                className="btn"
                onClick={() => reject(p)}
                disabled={expired || (phase.k === "busy" && phase.what !== "Rejecting…")}
                pending={phase.k === "busy" && phase.what === "Rejecting…"}
                pendingLabel="Rejecting…"
              >
                Reject
              </ActionButton>
              {known.length > 0 && !device && secure && !expired && phase.k !== "busy" && (
                <button type="button" className="btn btn--ghost" onClick={() => void approve(p, true)}>
                  Use a new passkey instead
                </button>
              )}
            </div>
            {phase.k === "busy" && (
              <p className="pair-status" role="status">
                {phase.what}
              </p>
            )}
          </form>
        </>
      )}
    </div>
  );
}

function countdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
