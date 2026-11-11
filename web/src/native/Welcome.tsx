// SPDX-License-Identifier: Apache-2.0
// The welcome (NATIVE-SPEC §3.9): the app found no receiver. One grouped list, no cards:
// start sessionpipe on this Mac (the background service, with its progress), connect to
// another computer by its address or its phone link, or try the demo board offline. A
// phone runs no receiver of its own, so there the first run is Onboarding.tsx: scan the
// code on your computer, or type its address.
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CommandWell } from "../components/bits";
import { channel, invoke } from "./bridge";
import { INSTALL_COMMAND, isCancel, parseAddress, type StartState, startStep } from "./logic";
import { Onboarding } from "./PhoneOnboarding";
import type { ShellInfo } from "./shell";
import "./native.css";

interface Receiver {
  id: string;
}

export function showWelcome(info: ShellInfo): void {
  const root = document.getElementById("root");
  if (!root) return;
  document.title = "Welcome · sessionpipe";
  const phone = info.platform === "ios" || info.platform === "android";
  createRoot(root).render(<StrictMode>{phone ? <Onboarding info={info} /> : <Welcome info={info} />}</StrictMode>);
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The desktop app's welcome (a phone never reaches it: Onboarding.tsx is its first run). */
export function Welcome({ info }: { info: ShellInfo }) {
  // What this device is, in the welcome's words: a Windows or Linux PC is no Mac.
  const here = info.platform === "macos" ? "Mac" : "computer";
  const [start, setStart] = useState<StartState>({ kind: "idle" });
  const [connecting, setConnecting] = useState(false);
  const [address, setAddress] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const startHere = async () => {
    setStart((s) => startStep(s, { type: "begin" }));
    try {
      const onProgress = channel<{ step?: string; message?: string }>((p) =>
        setStart((s) => startStep(s, { type: "progress", ...p })),
      );
      const rx = await invoke<Receiver>("rx_start_local", { onProgress });
      await invoke("rx_select", { id: rx.id });
    } catch (error) {
      setStart((s) => startStep(s, { type: "error", error }));
    }
  };

  const connect = async () => {
    const url = parseAddress(address);
    if (!url) {
      setConnectError("That isn't an address. Try studio-mac.local:7373, or paste the link from its phone code.");
      field.current?.focus();
      return;
    }
    setConnectError(null);
    setAdding(true);
    try {
      // The shell asks first, in a native sheet; Cancel rejects quietly.
      const rx = await invoke<Receiver | null>("rx_add", { url });
      if (rx) await invoke("rx_select", { id: rx.id });
    } catch (e) {
      if (!isCancel(e)) setConnectError(reason(e));
    } finally {
      setAdding(false);
    }
  };

  const busy = start.kind === "starting";
  return (
    <div className="welcome">
      <header className="welcome-bar" />
      <main className="welcome-body page page--doc page--grouped" id="main">
        <div className="welcome-head">
          <h1 className="welcome-title">Welcome to sessionpipe</h1>
          <p className="welcome-lede">Every coding agent you run, on one board. Where are your sessions?</p>
        </div>
        <section className="form-group" aria-label="Get started">
          <ul className="form-list welcome-list">
            <li className="form-row" data-welcome="start">
              <span className="form-row-text">
                <span className="form-label">This {here}</span>
                <span className="form-caption" aria-live="polite">
                  {start.kind === "starting"
                    ? start.message
                    : start.kind === "failed"
                      ? `It didn't start: ${start.message}`
                      : start.kind === "needsNode"
                        ? "sessionpipe needs Node 20 or later. Install it from nodejs.org, then run:"
                        : `Runs sessionpipe in the background, so this ${here}'s sessions show up here.`}
                </span>
              </span>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void startHere()}
                disabled={busy}
                aria-busy={busy || undefined}
              >
                {start.kind === "failed" || start.kind === "needsNode" ? "Try again" : "Start sessionpipe"}
              </button>
            </li>
            {start.kind === "needsNode" && (
              <li className="form-row form-row--stack">
                <CommandWell command={INSTALL_COMMAND} />
              </li>
            )}
            <li className="form-row" data-welcome="connect">
              <span className="form-row-text">
                <span className="form-label">Another computer</span>
                <span className="form-caption">Its address, or the link from its phone code.</span>
              </span>
              {!connecting && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setConnecting(true);
                    requestAnimationFrame(() => field.current?.focus());
                  }}
                >
                  Connect…
                </button>
              )}
            </li>
            {connecting && (
              <li className="form-row welcome-connect">
                <form
                  className="welcome-connect-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void connect();
                  }}
                >
                  <input
                    ref={field}
                    className="field"
                    type="text"
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="studio-mac.local:7373"
                    aria-label="Address of the other computer"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setConnecting(false);
                        setConnectError(null);
                      }
                    }}
                  />
                  <button type="submit" className="btn btn--primary" disabled={adding || !address.trim()}>
                    Connect
                  </button>
                </form>
                {connectError && <p className="form-caption welcome-error">{connectError}</p>}
              </li>
            )}
            <li className="form-row" data-welcome="demo">
              <span className="form-row-text">
                <span className="form-label">Just looking</span>
                <span className="form-caption">A board of made-up sessions. Nothing leaves this {here}.</span>
              </span>
              <button type="button" className="btn" onClick={() => location.assign("/?mock=1")}>
                Try the demo
              </button>
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
