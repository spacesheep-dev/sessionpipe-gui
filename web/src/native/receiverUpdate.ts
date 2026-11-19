// SPDX-License-Identifier: Apache-2.0
// The page's side of this computer's background service being behind the app: what the
// app's launch check found about this computer's receiver (rx_local_update), and the
// click that brings it to the app's version (rx_update_local: the app's release through
// npx, with its progress lines). Settings › About's row under the app's own update says
// it (serviceRow), and Settings › Data's notice uses it when the service is too old for
// an option (lib/serverAge.ts). The shell's IPC (./bridge) is loaded only inside the app
// (a dynamic import), never in a browser: there the hooks read nothing and say nothing.

import { compareVersions } from "@shared/version";
import { useCallback, useEffect, useState } from "react";

/** lifecycle/supervisor.rs LocalUpdate. */
export interface LocalUpdate {
  /** The receiver checked: this computer's (its run.json names it). */
  origin: string;
  running: string;
  app: string;
  state: "current" | "updated" | "click" | "failed" | "unchanged";
  why?: string;
  /** An install or update is running from the app now, and its last progress line. */
  busy: boolean;
  progress?: string;
}

/** lifecycle/supervisor.rs UpdateFailure: why Update didn't work, and the welcome's
 *  "Start sessionpipe" (logic.ts startStep reads the same kinds). */
export interface UpdateFailure {
  kind: "noNode" | "timeout" | "notRunning" | "download" | "stillRunning" | "busy" | "failed";
  line: string;
  log?: string;
}

const inShell = (): boolean => "sessionpipeShell" in globalThis && "__TAURI_INTERNALS__" in globalThis;
const bridge = () => import("./bridge");

/** What the launch check found; null when it found nothing to say, or can't be asked. */
export const localUpdate = (): Promise<LocalUpdate | null> =>
  inShell()
    ? bridge()
        .then((b) => b.invoke<LocalUpdate | null>("rx_local_update"))
        .catch(() => null)
    : Promise.resolve(null);

const asFailure = (e: unknown): UpdateFailure =>
  e && typeof e === "object" && "kind" in e && "line" in e
    ? (e as UpdateFailure)
    : { kind: "failed", line: e instanceof Error ? e.message : String(e) };

/** Runs the update; each progress line goes to `onProgress`. Rejects with an UpdateFailure. */
export async function updateLocal(onProgress: (message: string) => void): Promise<LocalUpdate | null> {
  try {
    const { channel, invoke } = await bridge();
    const ch = channel<{ step?: string; message?: string }>((p) => {
      if (p.message) onProgress(p.message);
    });
    return await invoke<LocalUpdate | null>("rx_update_local", { onProgress: ch });
  } catch (e) {
    throw asFailure(e);
  }
}

/** A failure, in the words Settings › About's row and Settings › Data's notice show: the
 *  sentence, and the line folded away under it. */
export function failureWords(f: UpdateFailure): { sentence: string; detail?: string } {
  if (f.kind === "notRunning")
    return {
      sentence: "The update didn't finish and the service isn't running. Press Update again.",
      detail: f.log || f.line || undefined,
    };
  return { sentence: "Couldn't update it. Press Update again.", detail: f.line || undefined };
}

/** What the launch check found, read when the caller mounts, when the window comes
 *  forward, and every 1.5 s while an install or update runs (from any window). `on`: false
 *  where nothing is to be asked (an app that has no such check). */
export function useLocalUpdate(on = true): { local: LocalUpdate | null; reload: () => void } {
  const [local, setLocal] = useState<LocalUpdate | null>(null);
  const reload = useCallback(() => {
    if (on && inShell()) void localUpdate().then(setLocal);
  }, [on]);
  useEffect(() => {
    if (!on) return;
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [on, reload]);
  const busy = !!local?.busy;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [busy, reload]);
  return { local, reload };
}

export interface UpdateRun {
  /** This window's run, or another's the launch check reports. */
  busy: boolean;
  /** The last progress line while busy. */
  progress: string | null;
  /** How this window's last run failed; null while busy. */
  failed: UpdateFailure | null;
  run: () => Promise<void>;
}

/** Update, pressed here: its progress, how it failed, and `onDone` when it ends. A run
 *  still at work in the background, or another window's, is shown as working, never as a
 *  failure. */
export function useUpdateRun(local: LocalUpdate | null, onDone: () => void): UpdateRun {
  const [working, setWorking] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [failed, setFailed] = useState<UpdateFailure | null>(null);
  const run = async () => {
    setWorking(true);
    setFailed(null);
    setLine(null);
    try {
      await updateLocal(setLine);
    } catch (e) {
      const f = e as UpdateFailure;
      if (f.kind !== "stillRunning" && f.kind !== "busy") setFailed(f);
    } finally {
      setWorking(false);
      setLine(null);
      onDone();
    }
  };
  const elsewhere = !working && !!local?.busy;
  const busy = working || elsewhere;
  return {
    busy,
    progress: working ? line : elsewhere ? (local?.progress ?? null) : null,
    failed: busy ? null : failed,
    run,
  };
}

/** Settings › About's row for this computer's background service, under the app's own
 *  update: what it has to say, or null when it has nothing. */
export type ServiceRow =
  | { kind: "behind"; running: string; app: string }
  | { kind: "working"; running: string; progress: string }
  | { kind: "failed"; running: string; sentence: string; detail?: string }
  | { kind: "done"; running: string };

/** The row, from what the launch check found and this window's run.
 *  - `live`: the version this window's receiver answers, when it is the one checked (a
 *    service updated from a terminal since launch is no longer behind);
 *  - `shown`: the row was shown in this window, so a service brought current says so,
 *    in place, until the window closes. "unchanged" (no service of ours, where Update would
 *    install one) and a service that was never behind say nothing;
 *  - `seen`: the version the row last said, for a check that knows none (a run that
 *    failed before its new service answered), after `live`. */
export function serviceRow(
  local: LocalUpdate | null,
  run: Pick<UpdateRun, "busy" | "progress" | "failed">,
  o: { live?: string; shown?: boolean; seen?: string } = {},
): ServiceRow | null {
  if (!local) return null;
  const caughtUp = !!o.live && compareVersions(o.live, local.app) >= 0;
  const behind = (local.state === "click" || local.state === "failed") && !caughtUp;
  const running = local.running || o.live || o.seen || "";
  if (behind || o.shown) {
    if (run.busy) return { kind: "working", running, progress: run.progress || "Updating the background service…" };
    if (run.failed) return { kind: "failed", running, ...failureWords(run.failed) };
  }
  if (behind)
    return local.state === "failed"
      ? { kind: "failed", running, ...failureWords({ kind: "failed", line: local.why ?? "" }) }
      : { kind: "behind", running, app: local.app };
  if (!o.shown || local.state === "unchanged") return null;
  return { kind: "done", running: caughtUp ? (o.live as string) : local.running || local.app };
}
