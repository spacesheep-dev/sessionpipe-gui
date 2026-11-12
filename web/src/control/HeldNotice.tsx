// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A send the receiver held for a confirm (command.ts HeldForConfirm),
// shown where it was pressed: what was held and why, in the receiver's own words (as text,
// never markup), and one button that confirms that one send. The press on the button is
// the fresh gesture the confirm's prompt needs; nothing confirms without it.
import { useCallback, useRef, useState } from "react";
import type { HeldForConfirm } from "./command";
import { HELD_WORDS, heldReason } from "./heldWords";
import { signerLabel } from "./signer";
import "./control.css";

export interface Held<T> {
  /** The hold, while it is shown. */
  held: HeldForConfirm<T> | null;
  /** The confirm is under way (its prompt is up, or its send). */
  busy: boolean;
  /** True when `e` is a hold: it is shown, and the caller says nothing else. */
  catchHeld(e: unknown): boolean;
  /** From the notice's button: the one confirm; `done` with what it sent, `failed` with its refusal. */
  confirm(): void;
  /** Let it go. */
  drop(): void;
}

/** A caller's one hold at a time. `done` runs after the confirmed send went (with what it
 *  answered and the hold it was); `failed` with the refusal when it did not. The notice is
 *  gone either way. */
export function useHeld<T>(done: (r: T, h: HeldForConfirm<T>) => void, failed: (e: unknown) => void): Held<T> {
  const [held, setHeld] = useState<HeldForConfirm<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const after = useRef({ done, failed });
  after.current = { done, failed };
  const catchHeld = useCallback((e: unknown) => {
    if (!(e instanceof Error) || e.name !== "HeldForConfirm") return false;
    setHeld(e as HeldForConfirm<T>);
    return true;
  }, []);
  const drop = useCallback(() => setHeld(null), []);
  const confirm = useCallback(() => {
    if (!held || busy) return;
    setBusy(true);
    held.confirm().then(
      (r) => {
        setHeld(null);
        setBusy(false);
        after.current.done(r, held);
      },
      (e: unknown) => {
        setHeld(null);
        setBusy(false);
        after.current.failed(e);
      },
    );
  }, [held, busy]);
  return { held, busy, catchHeld, confirm, drop };
}

export function HeldNotice<T>({ h }: { h: Held<T> }) {
  if (!h.held) return null;
  // A live region: a screen reader hears the notice when it comes, as the eye sees it.
  return (
    <div className="held" aria-live="polite" data-held>
      <b className="held-title">{HELD_WORDS.title}</b>
      <span className="held-why" data-held-why>
        {heldReason(h.held.why)}
      </span>
      <span className="held-acts">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={h.confirm}
          disabled={h.busy}
          aria-busy={h.busy || undefined}
          data-held-confirm
        >
          {h.busy ? HELD_WORDS.confirming : HELD_WORDS.confirm(signerLabel())}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={h.drop} disabled={h.busy} data-held-drop>
          {HELD_WORDS.drop}
        </button>
      </span>
    </div>
  );
}
