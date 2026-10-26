// SPDX-License-Identifier: Apache-2.0
// The page's whole IPC to the native shell, over the `__TAURI_INTERNALS__` the Tauri 2
// runtime injects (withGlobalTauri stays off). Our own few lines instead of
// @tauri-apps/api, with the same semantics as its core.js and event.js (2.12):
// - invoke: the runtime's invoke, args serialised by its IPC (a channel turns into
//   "__CHANNEL__:<id>" through `__TAURI_TO_IPC_KEY__` / toJSON);
// - channel: a callback id from transformCallback; messages carry an index and are
//   delivered in that order, early ones held back; `{ index, end }` ends it once every
//   earlier message has been delivered; a handler that throws never stalls it;
// - listen: `plugin:event|listen` with a callback that receives the event's payload.
// Loaded only inside the shell (dynamic import), never in a browser.

interface Internals {
  invoke(cmd: string, args?: Record<string, unknown>, options?: unknown): Promise<unknown>;
  transformCallback(cb: (raw: never) => void, once?: boolean): number;
  unregisterCallback?(id: number): void;
}

const tauri = (): Internals => (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;

export const invoke = <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> =>
  tauri().invoke(cmd, args) as Promise<T>;

export interface Channel {
  id: number;
  toIPC(): string;
  toJSON(): string;
}

export function channel<T>(onMessage: (m: T) => void): Channel {
  let next = 0;
  let end: number | undefined;
  const held = new Map<number, T>();
  const deliver = (m: T) => {
    try {
      onMessage(m);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  };
  const id = tauri().transformCallback((raw: { index: number; message?: T; end?: true }) => {
    const i = raw.index;
    if ("end" in raw) {
      if (i === next) done();
      else end = i;
      return;
    }
    if (i !== next) {
      held.set(i, raw.message as T);
      return;
    }
    deliver(raw.message as T);
    next++;
    while (held.has(next)) {
      const m = held.get(next) as T;
      held.delete(next);
      deliver(m);
      next++;
    }
    if (next === end) done();
  });
  const done = () => tauri().unregisterCallback?.(id);
  const ipc = () => `__CHANNEL__:${id}`;
  return { id, toIPC: ipc, toJSON: ipc, __TAURI_TO_IPC_KEY__: ipc } as Channel;
}

export async function listen<T>(event: string, fn: (payload: T) => void): Promise<() => void> {
  const eventId = await invoke<number>("plugin:event|listen", {
    event,
    target: { kind: "Any" },
    handler: tauri().transformCallback((e: { payload: T }) => fn(e.payload)),
  });
  return () => {
    (
      window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener(e: string, id: number): void } }
    ).__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener(event, eventId);
    void invoke("plugin:event|unlisten", { event, eventId }).catch(() => {});
  };
}
