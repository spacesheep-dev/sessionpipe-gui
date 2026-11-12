// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The person's colour labels (shared/api.ts Labels): one small
// document at <stateDir>/labels.json, the same on every device. A label is the person's,
// not a reading of events, so it lives beside the store rather than on a SessionSummary:
// GET reads it, PATCH merges into it, and every change goes to every page as one
// `labels` stream frame. Forgetting a session forgets its label.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LABEL_COLORS,
  LABEL_NAME_MAX,
  LABELS_MAX,
  type LabelColor,
  type Labels,
  type LabelsPatch,
  ROUTES,
  type SessionKey,
  type StreamMessage,
} from "../../shared/api.js";
import type { Handler, Reply, Router } from "../http/router.js";
import type { Store } from "../store/store.js";

/** The file's ceiling, like a view's state: 5000 labels fit well inside it. */
export const LABELS_FILE_MAX = 256 * 1024;
const PATCH_MAX = 64 * 1024;
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

export class LabelStore {
  private doc: Labels;
  private readonly file: string;
  private readonly listeners = new Set<(m: StreamMessage) => void>();

  /** `stateDir`: the GUI's state dir. `known`: whether the store has a session (a label
   *  is only set on one it knows, so no orphan keys). */
  constructor(
    stateDir: string,
    private readonly known: (key: SessionKey) => boolean,
  ) {
    this.file = path.join(stateDir, "labels.json");
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
  follow(store: Store): () => void {
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
    const text = JSON.stringify({ v: 1, ...next });
    if (Buffer.byteLength(text) > LABELS_FILE_MAX) throw new LabelsError(413, "too_large");
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, this.file);
    this.doc = next;
    for (const l of this.listeners) {
      try {
        l({ kind: "labels", labels: next });
      } catch (e) {
        process.stderr.write(`[labels] listener: ${(e as Error).message}\n`);
      }
    }
  }

  /** The file as it is; a missing one is empty, a broken one is set aside (never lost)
   *  and read as empty. Entries that do not validate are dropped. */
  private load(): Labels {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return { rev: 0, names: {}, sessions: {} };
    }
    try {
      const raw = JSON.parse(text) as Partial<Labels>;
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
      try {
        renameSync(this.file, `${this.file}.bad-${Date.now()}`);
      } catch {
        // nothing to set aside
      }
      return { rev: 0, names: {}, sessions: {} };
    }
  }
}

/** GET and PATCH ROUTES.ui.labels, behind the UI guard. PATCH takes JSON only: the
 *  content type forces a CORS preflight this server never answers, so a page on another
 *  origin cannot write labels through the loopback-is-trusted rule. */
export function registerLabels(router: Router, labels: LabelStore, guard: (h: Handler) => Handler): void {
  router.get(
    ROUTES.ui.labels,
    guard(() => ({ status: 200, json: labels.get(), headers: { "cache-control": "no-store" } })),
  );
  router.add(
    "PATCH",
    ROUTES.ui.labels,
    guard(async (ctx): Promise<Reply> => {
      const type = String(ctx.req.headers["content-type"] ?? "");
      if (!/^application\/json\b/i.test(type)) return { status: 415, json: { reason: "json_only" } };
      const announced = Number(ctx.req.headers["content-length"]);
      if (Number.isFinite(announced) && announced > PATCH_MAX) return { status: 413, json: { reason: "too_large" } };
      let body: LabelsPatch;
      try {
        body = await ctx.json<LabelsPatch>(PATCH_MAX);
      } catch {
        return { status: 400, json: { reason: "malformed" } };
      }
      try {
        return { status: 200, json: labels.patch(body) };
      } catch (e) {
        if (e instanceof LabelsError) return { status: e.status, json: { reason: e.reason } };
        throw e;
      }
    }),
  );
}
