// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The person's colour labels (shared/api.ts Labels): one small
// document, the same on every device. A label is the person's, not a reading of events,
// so it lives beside the store rather than on a SessionSummary: GET reads it, PATCH merges
// into it, and every change goes to every page as one `labels` stream frame. Forgetting a
// session forgets its label. Where the document is kept is its opener's (docKeep.ts): the
// receiver's is <stateDir>/labels.json (labels.ts LabelStore). Nothing here is Node's.
import {
  LABEL_COLORS,
  LABEL_NAME_MAX,
  LABELS_MAX,
  type LabelColor,
  type Labels,
  type LabelsPatch,
  type SessionKey,
  type StreamMessage,
} from "../../shared/api.js";
import { utf8Bytes } from "../store/log.js";
import type { DocKeep } from "./docKeep.js";

/** The file's ceiling, like a view's state: 5000 labels fit well inside it. */
export const LABELS_FILE_MAX = 256 * 1024;
const COLORS = new Set<string>(LABEL_COLORS);
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why a patch was refused, as the route's `reason`. */
export class LabelsError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

export class LabelsCore {
  private doc: Labels;
  private readonly listeners = new Set<(m: StreamMessage) => void>();

  /** `keep`: where the document is kept. `known`: whether the store has a session (a label
   *  is only set on one it knows, so no orphan keys). */
  constructor(
    private readonly keep: DocKeep,
    private readonly known: (key: SessionKey) => boolean,
  ) {
    this.doc = this.load();
  }

  get(): Labels {
    return this.doc;
  }

  /** Apply a merge; returns the document after it. Throws LabelsError. */
  patch(p: LabelsPatch): Labels {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new LabelsError(400, "malformed");
    const sessions = { ...this.doc.sessions };
    const names = { ...this.doc.names };
    let changed = false;
    if (p.sessions !== undefined) {
      if (!p.sessions || typeof p.sessions !== "object" || Array.isArray(p.sessions))
        throw new LabelsError(400, "malformed");
      for (const [key, color] of Object.entries(p.sessions)) {
        if (color !== null && !COLORS.has(color as string)) throw new LabelsError(400, "bad_label");
        if (color === null) {
          if (key in sessions) {
            delete sessions[key];
            changed = true;
          }
          continue;
        }
        if (!this.known(key)) throw new LabelsError(404, "not_found");
        if (sessions[key] !== color) {
          sessions[key] = color as LabelColor;
          changed = true;
        }
      }
      if (Object.keys(sessions).length > LABELS_MAX) throw new LabelsError(413, "too_many");
    }
    if (p.names !== undefined) {
      if (!p.names || typeof p.names !== "object" || Array.isArray(p.names)) throw new LabelsError(400, "malformed");
      for (const [color, raw] of Object.entries(p.names)) {
        if (!COLORS.has(color)) throw new LabelsError(400, "bad_label");
        const c = color as LabelColor;
        const name = raw === null ? "" : typeof raw === "string" ? raw.trim() : undefined;
        if (name === undefined || name.length > LABEL_NAME_MAX || CONTROL.test(name))
          throw new LabelsError(400, "bad_name");
        if (!name) {
          if (c in names) {
            delete names[c];
            changed = true;
          }
        } else if (names[c] !== name) {
          names[c] = name;
          changed = true;
        }
      }
    }
    if (!changed) return this.doc;
    this.commit({ rev: this.doc.rev + 1, names, sessions });
    return this.doc;
  }

  /** The session is gone (the UI's forget, or a session.forgotten): so is its label. */
  forget(key: SessionKey): void {
    if (!(key in this.doc.sessions)) return;
    const sessions = { ...this.doc.sessions };
    delete sessions[key];
    this.commit({ ...this.doc, rev: this.doc.rev + 1, sessions });
  }

  /** Follow the store: a `forgotten` message drops that session's label. */
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

  private commit(next: Labels): void {
    const value = { v: 1, ...next };
    if (utf8Bytes(JSON.stringify(value)) > LABELS_FILE_MAX) throw new LabelsError(413, "too_large");
    this.keep.save(value);
    this.doc = next;
    for (const l of this.listeners) {
      try {
        l({ kind: "labels", labels: next });
      } catch (e) {
        console.error("[labels] listener: %s", (e as Error).message);
      }
    }
  }

  /** What was kept, as it is; with nothing kept it is empty, a broken one is set aside
   *  (never lost) and read as empty. Entries that do not validate are dropped. */
  private load(): Labels {
    try {
      const raw = this.keep.load() as Partial<Labels> | undefined;
      if (raw === undefined) return { rev: 0, names: {}, sessions: {} };
      const names: Labels["names"] = {};
      const sessions: Labels["sessions"] = {};
      for (const [c, n] of Object.entries(raw.names ?? {}))
        if (COLORS.has(c) && typeof n === "string" && n.trim() && n.length <= LABEL_NAME_MAX && !CONTROL.test(n))
          names[c as LabelColor] = n.trim();
      for (const [k, c] of Object.entries(raw.sessions ?? {}))
        if (typeof c === "string" && COLORS.has(c)) sessions[k] = c as LabelColor;
      const rev = typeof raw.rev === "number" && Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;
      return { rev, names, sessions };
    } catch {
      this.keep.setAside?.();
      return { rev: 0, names: {}, sessions: {} };
    }
  }
}
