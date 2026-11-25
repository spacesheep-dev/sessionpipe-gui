// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. How the person arranged the session tree (shared/api.ts
// Arrangement): which session they put under which, which they brought to the top level,
// which they pinned and in what order. One small document, the same on every device, like
// the labels: GET reads it, PATCH changes it (shared/arrangement.ts holds the rules), and
// every change goes to every page as one `arrangement` stream frame. It is the person's,
// not a reading of events: it lives beside the store, is never sent to a machine and never
// changes what a session's events say. Forgetting a session forgets its own placement and
// its pin. Where it is kept is its opener's (docKeep.ts): the receiver's is
// <stateDir>/arrangement.json (arrangement.ts ArrangementStore). Nothing here is Node's.
import type { Arrangement, ArrangementPatch, SessionKey, StreamMessage } from "../../shared/api.js";
import { ArrangementError, applyArrangement, cleanArrangement, forgetInArrangement } from "../../shared/arrangement.js";
import { utf8Bytes } from "../store/log.js";
import type { DocKeep } from "./docKeep.js";

export { ArrangementError };

/** The file's ceiling: 500 placements and 100 pins of the longest keys fit inside it. */
export const ARRANGEMENT_FILE_MAX = 256 * 1024;

export class ArrangementCore {
  private doc: Arrangement;
  private readonly listeners = new Set<(m: StreamMessage) => void>();

  /** `keep`: where the document is kept. `known`: whether the store has a session (a
   *  placement or a pin is only made for one it knows, so no orphan keys). */
  constructor(
    private readonly keep: DocKeep,
    private readonly known: (key: SessionKey) => boolean,
  ) {
    this.doc = this.load();
  }

  get(): Arrangement {
    return this.doc;
  }

  /** Apply a change; returns the document after it. Throws ArrangementError. */
  patch(p: ArrangementPatch): Arrangement {
    const next = applyArrangement(this.doc, p, this.known);
    if (next !== this.doc) this.commit(next);
    return this.doc;
  }

  /** The session is gone (the UI's forget, or a session.forgotten). */
  forget(key: SessionKey): void {
    const next = forgetInArrangement(this.doc, key);
    if (next !== this.doc) this.commit(next);
  }

  /** Follow the store: a `forgotten` message drops that session's placement and pin. */
  follow(store: { subscribe(l: (m: StreamMessage) => void): () => void }): () => void {
    return store.subscribe((m) => {
      if (m.kind === "forgotten") this.forget(m.key);
    });
  }

  subscribe(l: (m: StreamMessage) => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private commit(next: Arrangement): void {
    const value = { v: 1, ...next };
    if (utf8Bytes(JSON.stringify(value)) > ARRANGEMENT_FILE_MAX) throw new ArrangementError(413, "too_large");
    this.keep.save(value);
    this.doc = next;
    for (const l of this.listeners) {
      try {
        l({ kind: "arrangement", arrangement: next });
      } catch (e) {
        console.error("[arrangement] listener: %s", (e as Error).message);
      }
    }
  }

  /** What was kept; with nothing kept it is empty, a broken one is set aside (never lost)
   *  and read as empty. Entries that do not hold to the rules are dropped. */
  private load(): Arrangement {
    try {
      const raw = this.keep.load();
      if (raw === undefined) return { rev: 0, placed: {}, pinned: [] };
      return cleanArrangement(raw);
    } catch {
      this.keep.setAside?.();
      return { rev: 0, placed: {}, pinned: [] };
    }
  }
}
