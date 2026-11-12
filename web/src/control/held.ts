// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. One caller's held send (command.ts HeldForConfirm), as plain state
// HeldNotice.tsx draws: shown until the person confirms it, lets it go, or changes anything
// it was made of. What a hold depends on is a `key` the caller builds from its fields (the
// composer's words and attachments; every row of a sheet): a different key drops the hold,
// so a confirm can only ever send what is on screen. A confirm the receiver holds again is
// "still held", with its reason, and nothing more is offered.
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

  /** After a refusal: true when it was a hold, now shown. `keyAtSend` is the caller's key
   *  when it pressed; `keyNow` its key now (an edit while the send was on its way drops it). */
  hold(e: unknown, meta: M, keyAtSend: string | undefined, keyNow: string | undefined): boolean {
    if (!isHold(e)) return false;
    this.key = keyAtSend;
    this.view = { kind: "held", held: e as HeldForConfirm<T>, meta, busy: false };
    if (keyAtSend !== undefined && keyNow !== keyAtSend) this.view = null;
    this.changed();
    return true;
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
    if (!v || v.kind !== "held" || v.busy) return;
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
