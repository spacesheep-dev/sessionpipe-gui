// SPDX-License-Identifier: Apache-2.0
// For the native unit tests (vitest runs in node, with no DOM package): the few window
// globals that lib/router.tsx and lib/shortcuts.ts touch when they load. Import it first.
const g = globalThis as Record<string, unknown>;
if (!g.window) {
  const target = new EventTarget();
  g.window = g;
  g.addEventListener = target.addEventListener.bind(target);
  g.removeEventListener = target.removeEventListener.bind(target);
  g.dispatchEvent = target.dispatchEvent.bind(target);
  g.location = new URL("http://127.0.0.1:7816/");
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  const attrs = new Map<string, string>();
  g.document = {
    documentElement: {
      dataset: {},
      hasAttribute: (n: string) => attrs.has(n),
      toggleAttribute: (n: string, on?: boolean) => {
        const v = on ?? !attrs.has(n);
        if (v) attrs.set(n, "");
        else attrs.delete(n);
        return v;
      },
    },
    activeElement: null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
}
if (!g.KeyboardEvent) {
  g.KeyboardEvent = class KeyboardEvent extends Event {
    key: string;
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    isComposing = false;
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type, init);
      this.key = (init.key as string) ?? "";
      this.code = (init.code as string) ?? "";
      this.metaKey = !!init.metaKey;
      this.ctrlKey = !!init.ctrlKey;
      this.altKey = !!init.altKey;
      this.shiftKey = !!init.shiftKey;
    }
  };
}

export {};
