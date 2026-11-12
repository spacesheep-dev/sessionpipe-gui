// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A send the receiver held for a confirm (command.ts HeldForConfirm),
// shown where it was pressed: what will be sent (the held words; a start's machine and
// folder), why it was held in the receiver's own words (as text, never markup, and said to
// be theirs), and one button that confirms that one send. The press on the button is the
// fresh gesture the confirm's prompt needs; nothing confirms without it. The hold's state is
// held.ts; this is the hook over it and its drawing.
import { cleanReason } from "@shared/reason";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HeldForConfirm } from "./command";
import { type HeldMeta, HeldSlot, type HeldView } from "./held";
import { HELD_WORDS, heldFrom, heldReason } from "./heldWords";
import { signerLabel } from "./signer";
import "./control.css";

export interface Held<T, M extends HeldMeta = HeldMeta> {
  /** The hold (or a confirm held again), while it is shown. */
  view: HeldView<T, M> | null;
  /** After a refusal: true when `e` is a hold, now shown; the caller says nothing else.
   *  `meta` is what its "done" needs; `key` what the hold depends on when it pressed. */
  catchHeld(e: unknown, meta: M, key?: string): boolean;
  /** From the notice's button: the one confirm. */
  confirm(): void;
  /** Let it go. */
  drop(): void;
}

/** A caller's one hold at a time. `key` is what a hold depends on now (undefined: nothing
 *  that can change); a different key drops it. `done` runs after the confirmed send went,
 *  with the hold and what was kept beside it (never the form as it is now); `failed` with
 *  a refusal that is not another hold. */
export function useHeld<T, M extends HeldMeta = HeldMeta>(
  done: (r: T, held: HeldForConfirm<T>, meta: M) => void,
  failed: (e: unknown, meta: M) => void,
  key?: string,
): Held<T, M> {
  const [, bump] = useState(0);
  const slot = useRef<HeldSlot<T, M> | null>(null);
  slot.current ??= new HeldSlot<T, M>(() => bump((n) => n + 1));
  const keyNow = useRef(key);
  keyNow.current = key;
  useEffect(() => slot.current?.keyed(key), [key]);
  const after = useRef({ done, failed });
  after.current = { done, failed };
  const catchHeld = useCallback(
    (e: unknown, meta: M, keyAtSend?: string) => !!slot.current?.hold(e, meta, keyAtSend, keyNow.current),
    [],
  );
  const confirm = useCallback(() => {
    void slot.current?.confirm(
      (r, h, m) => after.current.done(r, h, m),
      (e, m) => after.current.failed(e, m),
    );
  }, []);
  const drop = useCallback(() => slot.current?.drop(), []);
  return { view: slot.current.view, catchHeld, confirm, drop };
}

/** The words a send carries, for the notice: a message's or a start's text. */
const heldText = (h: HeldForConfirm<unknown>): string | null => {
  const f = h.fields;
  return f.kind === "prompt" || f.kind === "start" ? f.text : null;
};

/** The notice, in a live region that is there before it is: a screen reader hears it
 *  come. When it goes (confirmed, let go, or dropped by an edit) and the focus went with
 *  it, `focusBack` names where the focus returns: the composer, or the sheet's Start. */
export function HeldNotice<T, M extends HeldMeta>({
  h,
  focusBack,
}: {
  h: Held<T, M>;
  focusBack?: (live: HTMLElement) => HTMLElement | null | undefined;
}) {
  const live = useRef<HTMLDivElement>(null);
  const dropBtn = useRef<HTMLButtonElement>(null);
  const v = h.view;
  const kind = v?.kind ?? null;
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const was = shown.current;
    shown.current = kind;
    const el = live.current;
    const a = document.activeElement;
    const lost = !a || a === document.body || (!!el && el.contains(a));
    if (!lost) return;
    // Held again: the one button left takes the focus the disabled Confirm lost.
    if (kind === "still" && was !== "still") dropBtn.current?.focus();
    else if (!kind && was && el) focusBack?.(el)?.focus();
  }, [kind, focusBack]);
  const busy = v?.kind === "held" && v.busy;
  const text = v ? heldText(v.held) : null;
  const who = v ? heldFrom(v.held.from) : "";
  const raw = v ? (v.kind === "still" ? v.why : v.held.why) : "";
  // The receiver's words are said to be theirs; with none, the line is ours and says so.
  const whyLine = cleanReason(raw) ? HELD_WORDS.says(who, heldReason(raw)) : HELD_WORDS.noReason;
  return (
    <div className="held-live" aria-live="polite" ref={live}>
      {v && (
        <div className="held" data-held={v.kind}>
          <b className="held-title">{v.kind === "still" ? HELD_WORDS.still(who) : HELD_WORDS.title}</b>
          {text && (
            <span className="held-what" data-held-what>
              {text.length > 400 ? `${text.slice(0, 399)}…` : text}
            </span>
          )}
          {v.meta.where && (
            <span className="held-where" data-held-where>
              {v.meta.where}
            </span>
          )}
          <span className="held-why" data-held-why>
            {whyLine}
          </span>
          <span className="held-acts">
            {v.kind === "held" && (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={h.confirm}
                disabled={busy}
                aria-busy={busy || undefined}
                data-held-confirm
              >
                {busy ? HELD_WORDS.confirming : HELD_WORDS.confirm(signerLabel())}
              </button>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={h.drop}
              disabled={busy}
              ref={dropBtn}
              data-held-drop
            >
              {HELD_WORDS.drop}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
