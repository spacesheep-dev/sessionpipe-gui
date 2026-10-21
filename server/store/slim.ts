// SPDX-License-Identifier: Apache-2.0
// The in-memory copy of an event is slim: the big strings of `data` are cut to a
// preview so 100k events fit, and the original length is kept beside them. The full
// event stays on disk and is read back by byte offset (files.ts).
import type { StoredEvent } from "../../shared/api.js";

/** Characters kept in memory of each big `data` string. */
export const PREVIEW_CHARS = 2048;

/** A flat copy of a string. V8 keeps a `slice` as a view on its parent, so a 2 KB
 *  preview would pin the 64 KB it was cut from; copying through a Buffer does not. */
export const detach = (s: string): string => Buffer.from(s, "utf8").toString("utf8");

/** `data` keys that can be large: tool input/output (≤ 64 KB each) and turn text (≤ 20 000). */
const BIG_KEYS = ["input", "output", "user", "assistant"] as const;

/** A stored event as the index keeps it. `preview` lists the `data` keys that were cut
 *  and their original length in characters; absent when nothing was. */
export interface SlimEvent extends StoredEvent {
  preview?: Record<string, number>;
}

/** Short strings every event of a session repeats (type, harness, machine, cwd, repo,
 *  model, source…): JSON.parse makes a fresh copy of each, so the index shares one.
 *  The table is bounded; when full it starts over. */
const INTERN_MAX_CHARS = 128;
const INTERN_MAX_ENTRIES = 8192;
let interned = new Map<string, string>();
export function intern(s: string): string {
  if (s.length > INTERN_MAX_CHARS) return s;
  const have = interned.get(s);
  if (have !== undefined) return have;
  if (interned.size >= INTERN_MAX_ENTRIES) interned = new Map();
  interned.set(s, s);
  return s;
}
const internField = <T extends object>(o: T, k: keyof T): void => {
  const v = o[k];
  if (typeof v === "string") (o as Record<string, unknown>)[k as string] = intern(v);
};

/** The slim copy with its repeated short strings shared (see `intern`). The event's own
 *  blocks are copied, never written through. */
function internEvent(ev: SlimEvent): SlimEvent {
  const out: SlimEvent = { ...ev, harness: { ...ev.harness }, session: { ...ev.session } };
  internField(out, "type");
  internField(out, "source");
  internField(out.harness, "name");
  internField(out.harness, "version");
  internField(out.harness, "event");
  for (const k of [
    "machine",
    "cwd",
    "repo",
    "branch",
    "model",
    "title",
    "title_source",
    "account_id",
    "parent_id",
    "launched_by",
  ] as const)
    internField(out.session, k);
  if (ev.privacy && Array.isArray(ev.privacy.rulesets))
    out.privacy = { ...ev.privacy, rulesets: ev.privacy.rulesets.map((r) => (typeof r === "string" ? intern(r) : r)) };
  return out;
}

export function slimEvent(ev: StoredEvent): SlimEvent {
  return internEvent(slimData(ev));
}

function slimData(ev: StoredEvent): SlimEvent {
  let data: Record<string, unknown> | null = null;
  let preview: Record<string, number> | null = null;
  for (const k of BIG_KEYS) {
    const v = ev.data[k];
    if (v === undefined || v === null) continue;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    if (text.length <= PREVIEW_CHARS) continue;
    data ??= { ...ev.data };
    preview ??= {};
    // A running assistant text keeps its end (spec §4 turn.progress); the rest its start.
    data[k] = detach(
      ev.type === "turn.progress" && k === "assistant" ? text.slice(-PREVIEW_CHARS) : text.slice(0, PREVIEW_CHARS),
    );
    preview[k] = text.length;
  }
  if (!data) return ev;
  return { ...ev, data, preview: preview! };
}

/** The same slim copy with each big `data` string cut to at most `chars` (a list page's
 *  shorter preview, or an old event's). `preview` keeps the original lengths. */
export function trimPreview(ev: SlimEvent, chars: number): SlimEvent {
  const had = ev.preview ?? {};
  let data: Record<string, unknown> | null = null;
  let preview: Record<string, number> | null = null;
  for (const k of BIG_KEYS) {
    const v = ev.data[k];
    if (v === undefined || v === null) continue;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    if (text.length <= chars) continue;
    data ??= { ...ev.data };
    preview ??= { ...had };
    data[k] = detach(text.slice(0, chars));
    preview[k] = had[k] ?? text.length;
  }
  return data ? { ...ev, data, preview: preview! } : ev;
}
