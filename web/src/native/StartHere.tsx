// SPDX-License-Identifier: Apache-2.0
// "Start sessionpipe" on this computer: the background service, started by the shell
// (`rx_start_local`, with its progress lines), and what the person is told when it didn't
// start. One row and one button in every state; the decisions are logic.ts's startStep.
// The welcome's first row is this (Welcome.tsx).
import { useEffect, useState } from "react";
import { CommandWell } from "../components/bits";
import { channel, invoke } from "./bridge";
import { type StartState, startStep } from "./logic";
import "./native.css";

interface Receiver {
  id: string;
}

/** While another install or update runs from this app, its receiver is looked for this
 *  often, for this long; then the row says it didn't start. */
const BUSY_POLL_MS = 2000;
const BUSY_WAIT_MS = 120_000;

/** The start and where it stands. `begin` is the button's, and does nothing while `busy`
 *  (it is at work, or another install is). A receiver it started is selected, and the
 *  shell then opens the window on it. */
export function useStartHere(): { start: StartState; busy: boolean; begin: () => Promise<void> } {
  const [start, setStart] = useState<StartState>({ kind: "idle" });
  const busy = start.kind === "starting" || start.kind === "busy";

  const begin = async () => {
    if (busy) return;
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

  // Another install or update is at work (the app bringing an older service up to its own
  // version, a Start from another window): starting again would only be refused, so the
  // receiver it brings is waited for and taken.
  const waiting = start.kind === "busy";
  useEffect(() => {
    if (!waiting) return;
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    const until = Date.now() + BUSY_WAIT_MS;
    const look = async () => {
      const found = await invoke<{ local: Receiver | null }>("rx_discover").catch(() => null);
      if (!on) return;
      if (found?.local?.id) {
        await invoke("rx_select", { id: found.local.id }).catch(
          (error) => on && setStart((s) => startStep(s, { type: "error", error })),
        );
      } else if (Date.now() >= until) setStart((s) => startStep(s, { type: "noAnswer" }));
      else timer = setTimeout(() => void look(), BUSY_POLL_MS);
    };
    timer = setTimeout(() => void look(), BUSY_POLL_MS);
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [waiting]);

  return { start, busy, begin };
}

/** The raw line of a start that failed, folded away: read when someone asks, with Copy
 *  for a bug report. Outside the row's live caption, so it is never read out unasked. */
export function StartDetails({ detail }: { detail: string }) {
  return (
    <details className="start-details">
      <summary>Details</summary>
      <CommandWell command={detail} prompt={false} label="Copy details" />
    </details>
  );
}

/** The row: what this computer is (`here`: "Mac", "computer"), one sentence for where the
 *  start stands, and the one button. While it works the button can't be pressed and is
 *  dimmed, by `aria-disabled`: a `disabled` button drops the focus (WebKit and Chromium
 *  both), and Return on "Try again" would then do nothing. */
export function StartRow({ here }: { here: string }) {
  const { start, busy, begin } = useStartHere();
  // A start that failed has a line to show; one still loading is no error.
  const error = start.kind === "failed" && start.detail !== undefined;
  return (
    <li className="form-row start-row" data-welcome="start">
      <span className="form-row-text">
        <span className="form-label">This {here}</span>
        <span className={error ? "form-caption welcome-error" : "form-caption"} aria-live="polite">
          {start.kind === "starting" ? (
            start.message
          ) : start.kind === "busy" ? (
            "Starting sessionpipe…"
          ) : start.kind === "failed" ? (
            start.sentence
          ) : start.kind === "needsNode" ? (
            <>
              Install Node 22.12 or later (or Node 20 from 20.19 on) from{" "}
              <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">
                nodejs.org
              </a>
              , then try again.
            </>
          ) : (
            `Runs sessionpipe in the background, so this ${here}'s sessions show up here.`
          )}
        </span>
      </span>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => void begin()}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
      >
        {start.kind === "failed" || start.kind === "needsNode" ? "Try again" : "Start sessionpipe"}
      </button>
      {start.kind === "failed" && start.detail ? <StartDetails detail={start.detail} /> : null}
    </li>
  );
}
