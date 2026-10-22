// SPDX-License-Identifier: Apache-2.0
// The page's store: labels arrive whole and numbered, a change shows at once and goes
// back when the server refuses it, and a view's state version is kept per view.
import type { Labels, LabelsPatch } from "@shared/api";
import { describe, expect, it } from "vitest";
import { Store } from "./store";
import type { Transport } from "./transport";

const doc = (rev: number, sessions: Labels["sessions"] = {}, names: Labels["names"] = {}): Labels => ({
  rev,
  names,
  sessions,
});

function storeWith(patch: (p: LabelsPatch) => Promise<Labels>): Store {
  return new Store({ patchLabels: patch } as unknown as Transport);
}

describe("labels in the store", () => {
  it("takes the snapshot's labels, then newer frames only", () => {
    const store = storeWith(async () => doc(0));
    store.apply({
      kind: "snapshot",
      snapshot: {
        at: "",
        sessions: [],
        machines: [],
        stats: { events: 0, sessions: 0, machines: 0, eventsLastMinute: 0, storageBytes: 0, uptimeS: 0 },
        labels: doc(3, { a: "red" }),
      },
    });
    expect(store.get().labels.sessions).toEqual({ a: "red" });
    store.apply({ kind: "labels", labels: doc(2, { a: "blue" }) });
    expect(store.get().labels.rev).toBe(3);
    store.apply({ kind: "labels", labels: doc(4, { a: "green" }) });
    expect(store.get().labels.sessions).toEqual({ a: "green" });
  });

  it("shows a change at once, keeps the server's answer, and goes back on a refusal", async () => {
    let answer: (l: Labels) => void = () => {};
    const store = storeWith(() => new Promise<Labels>((r) => (answer = r)));
    const done = store.patchLabels({ sessions: { a: "red" }, names: { red: " Urgent " } });
    expect(store.get().labels).toEqual(doc(0, { a: "red" }, { red: "Urgent" }));
    answer(doc(1, { a: "red" }, { red: "Urgent" }));
    await done;
    expect(store.get().labels.rev).toBe(1);

    const refusing = storeWith(() => Promise.reject(new Error("not_found")));
    await expect(refusing.patchLabels({ sessions: { nope: "red" } })).rejects.toThrow("not_found");
    expect(refusing.get().labels).toEqual(doc(0));
  });

  it("keeps the newest version of each view's stored state", () => {
    const store = storeWith(async () => doc(0));
    store.apply({ kind: "viewState", id: "canvas", etag: '"a"' });
    store.apply({ kind: "viewState", id: "canvas", etag: '"b"' });
    expect(store.get().viewStates.get("canvas")).toBe('"b"');
  });
});
