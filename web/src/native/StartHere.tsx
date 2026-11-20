// SPDX-License-Identifier: Apache-2.0
// "Start sessionpipe" on this computer: the background service, started by the shell
// (`rx_start_local`, with its progress lines), and what the person is told when it didn't
// start. One row and one button in every state; the decisions are logic.ts's startStep.
// The welcome's first row is this (Welcome.tsx), and so is the Board's and the Inbox's
// first load that can't reach this computer's receiver (components/NoConnection.tsx).
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { CommandWell, EmptyState } from "../components/bits";
import { NEW_WORDS } from "./accountWords.new";
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

/** Where the start stands, one for the page: a start outlives the screen it was pressed on
 *  (the board's first load gives way to its loading rows and back while the stream
 *  retries, a person goes to the Inbox), and the next screen picks it up where it is. */
let current: StartState = { kind: "idle" };
const watchers = new Set<() => void>();
const setStart = (next: (s: StartState) => StartState) => {
  current = next(current);
  for (const w of watchers) w();
};
const watch = (w: () => void) => {
  watchers.add(w);
  return () => watchers.delete(w);
};
const read = () => current;
const isBusy = (s: StartState) => s.kind === "starting" || s.kind === "busy";

/** The receiver a start brought, selected; with `then`, the start is over here. */
/** The one sentence for a computer without a Node sessionpipe runs on (the floor the
 *  desktop app's StartError::NoNode says too). */
function NeedsNode() {
  return (
    <>
      Install Node 22.12 or later (or Node 20 from 20.19 on) from{" "}
      <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">
        nodejs.org
      </a>
      , then try again.
    </>
  );
}

async function take(id: string, then?: () => void): Promise<void> {
  await invoke("rx_select", { id });
  if (!then) return;
  setStart(() => ({ kind: "idle" }));
  then();
}

/** The start and where it stands. `begin` is the button's, and does nothing while `busy`
 *  (it is at work, or another install is). A receiver it started is selected: the shell
 *  opens a new window on it, or, where this window already shows it (`onStarted`: the
 *  board of this computer's receiver), the start is over and the window connects again. */
export function useStartHere(onStarted?: () => void): {
  start: StartState;
  busy: boolean;
  begin: () => Promise<void>;
} {
  const start = useSyncExternalStore(watch, read, read);
  const busy = isBusy(start);
  const started = useRef(onStarted);
  started.current = onStarted;

  const begin = async () => {
    if (isBusy(current)) return;
    setStart((s) => startStep(s, { type: "begin" }));
    try {
      const onProgress = channel<{ step?: string; message?: string }>((p) =>
        setStart((s) => startStep(s, { type: "progress", ...p })),
      );
      const rx = await invoke<Receiver>("rx_start_local", { onProgress });
      await take(rx.id, started.current);
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
        await take(found.local.id, started.current).catch(
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
            <NeedsNode />
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

/** The Board's and the Inbox's first load that can't reach this computer's receiver
 *  (components/NoConnection.tsx, which loads this only for one). One sentence as the
 *  title, and the start beside Retry: while it works the title is its progress line and
 *  Retry steps aside; a start that ended without a receiver says it as the welcome does,
 *  with Try again, which starts it again. A receiver it brings is this window's own, so
 *  the window connects again (`onStarted`). `where`: "sessionpipe on this Mac". */
export function NoConnectionStart({
  where,
  retry,
  onStarted,
}: {
  where: string;
  retry: ReactNode;
  onStarted: () => void;
}) {
  const { start, busy, begin } = useStartHere(onStarted);
  const ended = start.kind === "failed" || start.kind === "needsNode";
  const title =
    start.kind === "starting" ? (
      start.message
    ) : start.kind === "busy" ? (
      "Starting sessionpipe…"
    ) : start.kind === "failed" ? (
      start.sentence
    ) : start.kind === "needsNode" ? (
      <NeedsNode />
    ) : (
      NEW_WORDS.reachFailed(where)
    );
  return (
    <EmptyState
      center
      role="status"
      className="no-conn no-conn--start"
      title={title}
      actions={
        <>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void begin()}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
          >
            {ended ? "Try again" : "Start sessionpipe"}
          </button>
          {busy || ended ? null : retry}
          {start.kind === "failed" && start.detail ? <StartDetails detail={start.detail} /> : null}
        </>
      }
    />
  );
}
