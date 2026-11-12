// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. One caller's held send (command.ts HeldForConfirm), as plain state
// HeldNotice.tsx draws: shown until the person confirms it, lets it go, or changes anything
// it was made of. What a hold depends on is a `key` the caller builds from its fields (the
// composer's words and attachments; every row of a sheet): a different key drops the hold,
// so a confirm can only ever send what is on screen. A confirm the receiver holds again is
// "still held", with its reason, and nothing more is offered.
import { splitAttachments } from "@shared/attachments";
import type { HeldForConfirm } from "./command";
import { heldWhy } from "./command";

/** What a caller keeps beside a hold, at the moment it sent: everything its "done" needs,
 *  so nothing after a confirm reads the form as it is now. `where` is the small line under
 *  the held words (a start's machine and folder). */
export interface HeldMeta {
  where?: string;
}

export type HeldView<T, M extends HeldMeta> =
  | { kind: "held"; held: HeldForConfirm<T>; meta: M; busy: boolean }
  /** The confirm was held too: its reason, and who held it. */
  | { kind: "still"; held: HeldForConfirm<T>; why: string; meta: M };

const isHold = (e: unknown): e is HeldForConfirm<never> => e instanceof Error && e.name === "HeldForConfirm";
const heldAgain = (e: unknown): boolean =>
  !!e &&
  typeof e === "object" &&
  (e as { status?: unknown; code?: unknown }).status === 422 &&
  (e as { code?: unknown }).code === "confirm_required";

export class HeldSlot<T, M extends HeldMeta> {
  view: HeldView<T, M> | null = null;
  /** The key the hold was made with; undefined when it depends on nothing that can change. */
  private key: string | undefined;

  constructor(private readonly changed: () => void) {}

  /** After a refusal: "held" when it was a hold, now shown; "changed" when it was one but
   *  what it was made of changed while the send was on its way, so it is not shown and
   *  the caller says it did not go; false when it was not a hold. `keyAtSend` is the
   *  caller's key when it pressed; `keyNow` its key now. */
  hold(e: unknown, meta: M, keyAtSend: string | undefined, keyNow: string | undefined): false | "held" | "changed" {
    if (!isHold(e)) return false;
    this.key = keyAtSend;
    const changedSince = keyAtSend !== undefined && keyNow !== keyAtSend;
    this.view = changedSince ? null : { kind: "held", held: e as HeldForConfirm<T>, meta, busy: false };
    this.changed();
    return changedSince ? "changed" : "held";
  }

  /** The caller's key now: anything the hold was made of changed, and it goes. Not while
   *  its confirm is under way: that send is the held one, whatever happens next. */
  keyed(now: string | undefined): void {
    if (!this.view || this.key === undefined || now === this.key) return;
    if (this.view.kind === "held" && this.view.busy) return;
    this.drop();
  }

  drop(): void {
    if (!this.view || (this.view.kind === "held" && this.view.busy)) return;
    this.view = null;
    this.changed();
  }

  /** From the notice's button only. `done` with what the confirmed send answered, the hold
   *  and what was kept beside it; `failed` with a refusal that is not another hold. */
  async confirm(
    done: (r: T, held: HeldForConfirm<T>, meta: M) => void,
    failed: (e: unknown, meta: M) => void,
  ): Promise<void> {
    const v = this.view;
    if (v?.kind !== "held" || v.busy) return;
    this.view = { ...v, busy: true };
    this.changed();
    try {
      const r = await v.held.confirm();
      this.view = null;
      this.changed();
      done(r, v.held, v.meta);
    } catch (e) {
      if (heldAgain(e)) {
        this.view = { kind: "still", held: v.held, why: heldWhy(e), meta: v.meta };
        this.changed();
        return;
      }
      this.view = null;
      this.changed();
      failed(e, v.meta);
    }
  }
}

/** The held words as the notice shows them: all of them when they are short, else the
 *  beginning and the end (`head`, `tail`) with what was left out between, so the end of a
 *  long message (where a reason may point) is never cut away. */
export interface HeldPreview {
  head: string;
  /** Null when `head` is all of it. */
  tail: string | null;
}

/** Lines shown at each end, and characters at each end of one long line. */
const END_LINES = 2;
const END_CHARS = 160;

export function heldPreview(text: string): HeldPreview {
  const lines = text.split("\n");
  if (lines.length > END_LINES * 2) {
    const head = lines.slice(0, END_LINES).join("\n");
    const tail = lines.slice(-END_LINES).join("\n");
    return { head: endsOf(head, "head"), tail: endsOf(tail, "tail") };
  }
  const chars = Array.from(text);
  if (chars.length > END_CHARS * 2 + 40)
    return { head: chars.slice(0, END_CHARS).join(""), tail: chars.slice(-END_CHARS).join("") };
  return { head: text, tail: null };
}

/** One end, itself cut to its own end's characters when its lines are long. */
function endsOf(s: string, side: "head" | "tail"): string {
  const chars = Array.from(s);
  if (chars.length <= END_CHARS * 2) return s;
  return side === "head" ? chars.slice(0, END_CHARS * 2).join("") : chars.slice(-END_CHARS * 2).join("");
}

/** What a send carries, for the notice: the words (a message's or a start's text, or the
 *  note of an answer typed in the composer) without a message's attachments block, and
 *  the names of its images or a start's files, which are listed whole. */
export function heldContent(h: HeldForConfirm<unknown>): { text: string | null; names: string[] } {
  const f = h.fields;
  if (f.kind === "prompt") {
    const { body, items } = splitAttachments(f.text);
    return { text: body || null, names: items.map((i) => `${i.id}.${i.ext}`) };
  }
  if (f.kind === "start") return { text: f.text, names: (f.files ?? []).map((x) => x.name) };
  if (f.kind === "permission.answer") return { text: f.note ?? null, names: [] };
  return { text: null, names: [] };
}
