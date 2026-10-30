// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The runs this browser is the signer for: every run it
// started (actions.ts marks one as the server answers), and any run the person told this
// page to sign ("Sign here" on the run view). The runner (useRunner.ts) signs only these.
// A run started by anything else, a curl on the loopback or a page on another device,
// never gets this page's passkey without the person saying so once: the server trusts a
// loopback caller to start a run, and the signer must not be driven by that alone. Kept
// in localStorage (this browser's, per origin; the app's own in the native shell), so a
// reload and a new tab keep signing what this browser started; a page with none of it
// (a private window, cleared data) asks once per run.
import { useSyncExternalStore } from "react";

const KEY = "sessionpipe.workflows.mine";
/** Run ids kept at most (the newest; a run that ended stays only this long). */
const MAX = 200;

/** This tab's copy, the same object until something changes (the hook's snapshot). */
let held: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

/** What the storage holds right now: every write starts from this, not from `held`, so
 *  two tabs' runs add up instead of the later write dropping the other tab's. */
const load = (): Set<string> => {
  try {
    const raw = localStorage.getItem(KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set(held ?? []);
  }
};
const read = (): ReadonlySet<string> => {
  held ??= load();
  return held;
};
const write = (ids: string[]): void => {
  held = new Set(ids);
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // no storage: this tab remembers, a reload asks again
  }
  for (const l of listeners) l();
};

/** Another tab marked or forgot a run: read again, so this tab signs for it too. */
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    held = null;
    for (const l of listeners) l();
  });

/** The runs this browser signs for. */
export const mineNow = (): ReadonlySet<string> => read();

/** This browser signs for `runId` from now on. */
export function markMine(runId: string): void {
  const now = load();
  if (now.has(runId)) {
    held = now;
    return;
  }
  write([...[...now].slice(-(MAX - 1)), runId]);
}

/** Forget a run that is gone (deleted): nothing is signed for an id that comes back. */
export function forgetMine(runId: string): void {
  const now = load();
  if (!now.has(runId)) {
    held = now;
    return;
  }
  write([...now].filter((id) => id !== runId));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The set, the same object until it changes. */
export function useMine(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, read, read);
}

/** Tests: start over. */
export function resetMine(): void {
  held = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
  for (const l of listeners) l();
}
