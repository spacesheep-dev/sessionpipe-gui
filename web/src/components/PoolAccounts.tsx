// SPDX-License-Identifier: Apache-2.0
// The Usage page's pooled section (UX-SPEC §3, §5, §9, §10): "Claude accounts on lab-mac",
// one per machine whose hello carries a pool with at least one account. The header row
// with the room count and its ··· menu; the switch row in the form grammar ("Switch
// accounts when one runs out", optimistic, flipping back on a refusal); the accounts in
// the machine's order, each its name, its status word from the hello alone (lib/pool.ts;
// never from the numbers), its window rows when it has a limits entry (the page's own
// WindowRow), and its menu; "Add account…" last. The order is reordered by pointer (the
// split panel's tab drag, turned vertical), by keyboard on each row's grip (Space, the
// arrows, Space; Esc puts it back) and by Move up / Move down in the menu; each sends one
// `order` command naming every account, and the list holds the new order, with "saving
// order…" in the header, until the machine's ack and the hello that follows (a refusal
// snaps it back). Every command goes through usePoolSend; the page never holds a
// credential and the raw account id never reaches the DOM (rows are keyed by a token).
import type { LimitsEntry, MachinePool, MachinePoolAccount, MachineSummary } from "@shared/api";
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { openPoolAdd } from "../control/poolAddState";
import { signerLabel } from "../control/signer";
import { usePoolSend } from "../control/usePoolSend";
import { isFinal } from "../control/words";
import { copyText } from "../lib/clipboard";
import { orderWindows, STALE_MS, staleWords, usageText } from "../lib/limits";
import { reducedMotion, tokenMs } from "../lib/motion";
import {
  IMPORT_COMMAND,
  moveIn,
  offlineNotice,
  removeConfirm,
  roomWords,
  rowTitle,
  SAVING_ORDER,
  sentenceName,
  statusWords,
  stillSaving,
  switchHint,
  USED_UP_TIP,
} from "../lib/pool";
import { ago, ms } from "../lib/time";
import { HarnessGlyph, Notice, Toggle } from "./bits";
import { confirmAction, type MenuList, MoreButton, useContextMenu } from "./ContextMenu";
import { WindowRow } from "./UsageWindows";
import "../styles/pool.css";

/** --ease-out (tokens.css), as a string the Web Animations API takes. */
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
/** A delivered command whose hello has not come after this long lets the hello's state show. */
const SETTLE_MS = 5_000;
export const SORT_HELP = "Press Space to pick up, arrow keys to move, Space to drop, Escape to cancel.";

// A row's DOM key: an opaque token per account id, so the id itself never reaches the page.
const tokens = new Map<string, string>();
let tokenCount = 0;
const tokenFor = (id: string): string => {
  let t = tokens.get(id);
  if (!t) {
    t = `r${++tokenCount}`;
    tokens.set(id, t);
  }
  return t;
};

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The shown order: a held or dragged order over the hello's, less the accounts the hello
 *  no longer lists, plus the ones it added at the end. */
function reconcile(shown: readonly string[] | null, hello: readonly string[]): string[] {
  if (!shown) return [...hello];
  const kept = shown.filter((id) => hello.includes(id));
  for (const id of hello) if (!kept.includes(id)) kept.push(id);
  return kept;
}

/** Rows slide to their new place instead of jumping (the tab strip's FLIP, vertical); the
 *  row under the pointer in a drag is the pointer's, not this. Off under reduced motion. */
function useRowFlip(ref: RefObject<HTMLElement | null>, sig: string, skip: string | null): void {
  const prev = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const els = [...box.querySelectorAll<HTMLElement>(":scope > [data-flip]")];
    const now = new Map(els.map((el) => [el.dataset.flip!, el.offsetTop]));
    const before = prev.current;
    prev.current = now;
    if (!before || els.length < 2 || reducedMotion() || typeof Element.prototype.animate !== "function") return;
    const dur = tokenMs("--dur", 200);
    for (const el of els) {
      const k = el.dataset.flip!;
      if (k === skip) continue;
      const was = before.get(k);
      if (was === undefined) continue;
      const dy = was - now.get(k)!;
      if (Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: dur, easing: EASE_OUT });
    }
  }, [sig]);
}

interface Pending {
  /** The message id once signed and queued; null while the signer is at it. */
  id: string | null;
}

export function PoolSection({
  m,
  pool,
  entryFor,
  now,
  index,
  cursor,
}: {
  m: MachineSummary;
  pool: MachinePool;
  entryFor: (accountId: string) => LimitsEntry | undefined;
  now: number;
  index: number;
  cursor: boolean;
}) {
  const machine = m.name;
  const online = !!m.control?.online;
  const send = usePoolSend(m);
  const title = `Claude accounts on ${machine}`;
  const helloIds = pool.accounts.map((a) => a.id);
  const helloSig = helloIds.join("\n");
  const byId = new Map(pool.accounts.map((a) => [a.id, a]));

  // ----- the order: shown (held or in a drag) over the hello's -----
  const [shown, setShown] = useState<string[] | null>(null);
  const [held, setHeld] = useState<Pending | null>(null);
  const order = reconcile(shown, helloIds);
  const orderSig = order.join("\n");
  const listRef = useRef<HTMLUListElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [grabbed, setGrabbed] = useState<string | null>(null);
  const grabStart = useRef<string[] | null>(null);
  const [announce, setAnnounce] = useState("");
  useRowFlip(listRef, orderSig, dragging);

  const heldAck = held?.id ? send.activity.find((a) => a.id === held.id) : undefined;
  useEffect(() => {
    if (!held) return;
    if (shown && sameList(shown, helloIds)) {
      setShown(null);
      setHeld(null);
      return;
    }
    if (heldAck && isFinal(heldAck) && heldAck.outcome !== "delivered") {
      setShown(null);
      setHeld(null);
      return;
    }
    if (heldAck?.outcome === "delivered") {
      const t = window.setTimeout(() => {
        setShown(null);
        setHeld(null);
      }, SETTLE_MS);
      return () => window.clearTimeout(t);
    }
    // `helloSig` stands for helloIds; `shown` is compared by content.
  }, [held, heldAck, shown, helloSig]);

  const commitOrder = useCallback(
    async (ids: string[]) => {
      setShown(ids);
      setHeld({ id: null });
      const a = await send.send({ action: "order", order: ids });
      if (!a) {
        setShown(null);
        setHeld(null);
        return;
      }
      setHeld({ id: a.id });
    },
    [send.send],
  );

  // ----- the switch: optimistic while the machine is online -----
  const [opt, setOpt] = useState<{ on: boolean; id: string | null } | null>(null);
  const on = opt?.on ?? pool.on;
  const optAck = opt?.id ? send.activity.find((a) => a.id === opt.id) : undefined;
  useEffect(() => {
    if (!opt) return;
    if (pool.on === opt.on) {
      setOpt(null);
      return;
    }
    if (optAck && isFinal(optAck) && optAck.outcome !== "delivered") {
      setOpt(null);
      return;
    }
    if (optAck?.outcome === "delivered") {
      const t = window.setTimeout(() => setOpt(null), SETTLE_MS);
      return () => window.clearTimeout(t);
    }
  }, [opt, optAck, pool.on]);
  const toggle = async (v: boolean) => {
    if (online) setOpt({ on: v, id: null });
    const a = await send.send({ action: v ? "on" : "off" });
    if (!a) {
      setOpt(null);
      return;
    }
    if (online) setOpt({ on: v, id: a.id });
  };

  // ----- what is locked, and why -----
  const saving = held !== null || (opt !== null && !optAck) || !!send.inflight;
  const locked = !!send.blocked || saving;
  const lockReason = send.blocked ?? (saving ? stillSaving(machine) : undefined);

  // ----- the live region: adds and removes, the note's words -----
  const names = useRef(new Map<string, string>());
  const lastIds = useRef<string[] | null>(null);
  for (const a of pool.accounts) names.current.set(a.id, sentenceName(a, pool.accounts));
  useEffect(() => {
    const was = lastIds.current;
    lastIds.current = helloIds;
    if (!was) return;
    const added = helloIds.filter((id) => !was.includes(id));
    const gone = was.filter((id) => !helloIds.includes(id));
    if (added.length)
      setAnnounce(`Added ${added.map((id) => names.current.get(id) ?? "an account").join(", ")} to ${machine}`);
    else if (gone.length)
      setAnnounce(`Removed ${gone.map((id) => names.current.get(id) ?? "an account").join(", ")} from ${machine}`);
    // `helloSig` stands for helloIds.
  }, [helloSig, machine]);
  const noteText = send.note?.text ?? "";
  useEffect(() => {
    if (noteText) setAnnounce(noteText);
  }, [noteText]);

  // ----- the pointer drag -----
  /** While a row is dragged: puts it back under the pointer after the list re-renders. */
  const dragFix = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    dragFix.current?.();
  });
  const onRowDown = (e: ReactPointerEvent<HTMLDivElement>, id: string, name: string) => {
    if (e.button !== 0 || locked || grabbed) return;
    const target = e.target as HTMLElement;
    const onGrip = !!target.closest(".pool-grip");
    if (e.pointerType === "touch" ? !onGrip : !onGrip && target.closest("button, a, input, [role=switch]")) return;
    const li = e.currentTarget.parentElement;
    const list = listRef.current;
    if (!li || !list) return;
    const token = li.dataset.flip ?? "";
    const startY = e.clientY;
    const grab = e.clientY - li.getBoundingClientRect().top;
    const start = shown;
    let cur = order;
    let from = cur.indexOf(id);
    let moved = false;
    const pid = e.pointerId;
    const place = (clientY: number) => {
      const box = list.getBoundingClientRect();
      const want = Math.max(0, Math.min(clientY - grab - box.top, list.clientHeight - li.offsetHeight));
      li.style.transform = `translateY(${want - li.offsetTop}px)`;
      return want + li.offsetHeight / 2;
    };
    const off = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      dragFix.current = null;
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      if (!moved && Math.abs(ev.clientY - startY) < 6) return;
      if (!moved) {
        moved = true;
        setDragging(token);
        setAnnounce(`Picked up ${name}`);
      }
      ev.preventDefault();
      const y = ev.clientY;
      dragFix.current = () => place(y);
      const mid = place(y);
      const others = [...list.querySelectorAll<HTMLElement>(":scope > [data-flip]")].filter((el) => el !== li);
      // Kept inside the list, the row's middle reaches the last row's exactly: a pixel's grace.
      const to = others.filter((el) => el.offsetTop + el.offsetHeight / 2 < mid + 1).length;
      if (to !== from) {
        cur = moveIn(cur, from, to);
        from = to;
        setShown(cur);
      }
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      off();
      if (!moved) return;
      // Settle: from under the pointer into its slot, an exit (the row leaves the pointer).
      const left = li.style.transform;
      li.style.transform = "";
      setDragging(null);
      if (left && !reducedMotion() && typeof li.animate === "function")
        li.animate([{ transform: left }, { transform: "none" }], {
          duration: tokenMs("--dur-exit", 140),
          easing: EASE_OUT,
        });
      if (sameList(cur, helloIds)) {
        setShown(null);
        setAnnounce("Dropped");
      } else {
        setAnnounce("Dropped");
        void commitOrder(cur);
      }
    };
    const cancel = () => {
      off();
      if (!moved) return;
      li.style.transform = "";
      setDragging(null);
      setShown(start);
      setAnnounce("Cancelled, order unchanged");
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      cancel();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
  };

  // ----- the keyboard: Space picks up, the arrows move, Space drops, Esc puts back -----
  const drop = (id: string) => {
    if (grabbed !== id) return;
    setGrabbed(null);
    setAnnounce("Dropped");
    if (sameList(order, helloIds)) setShown(null);
    else void commitOrder(order);
  };
  const onGripKey = (e: ReactKeyboardEvent<HTMLButtonElement>, id: string, name: string) => {
    const i = order.indexOf(id);
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (grabbed === id) drop(id);
      else if (!grabbed && !locked) {
        grabStart.current = shown;
        setGrabbed(id);
        setAnnounce(`Picked up ${name}`);
      }
      return;
    }
    if (grabbed !== id) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const to = i + (e.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= order.length) return;
      setShown(moveIn(order, i, to));
      setAnnounce(`Moved to position ${to + 1} of ${order.length}`);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setShown(grabStart.current);
      setGrabbed(null);
      setAnnounce("Cancelled, order unchanged");
    }
  };
  // Focus follows the grabbed row's grip as the list reflows under it.
  useLayoutEffect(() => {
    if (!grabbed) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-flip="${tokenFor(grabbed)}"] .pool-grip`)
      ?.focus({ preventScroll: true });
  }, [grabbed, orderSig]);
  const onGripBlur = (e: ReactFocusEvent<HTMLButtonElement>, id: string) => {
    // Tab while grabbed drops it where it is; a blur with nowhere to go is the reflow's.
    if (grabbed === id && e.relatedTarget) drop(id);
  };

  // ----- the menus -----
  const sectionItems = (): MenuList => [
    { label: "Add account…", run: () => openPoolAdd({ machine }), disabled: send.blocked ?? undefined },
    { label: "Refresh usage", run: () => void send.send({ action: "refresh" }), disabled: send.blocked ?? undefined },
    { label: "Copy setup command", run: () => void copyText(IMPORT_COMMAND) },
  ];
  const rowItems = (a: MachinePoolAccount): MenuList => {
    const i = order.indexOf(a.id);
    const name = sentenceName(a, pool.accounts);
    const e = entryFor(a.id);
    const status = statusWords(a, on, now);
    const off = a.status === "disabled" || !a.enabled;
    const moveReason = lockReason;
    return [
      {
        label: "Move up",
        run: () => void commitOrder(moveIn(order, i, i - 1)),
        disabled: i <= 0 ? true : moveReason,
      },
      {
        label: "Move down",
        run: () => void commitOrder(moveIn(order, i, i + 1)),
        disabled: i >= order.length - 1 ? true : moveReason,
      },
      { sep: true },
      {
        label: off ? "Turn on" : "Turn off",
        run: () => void send.send({ action: off ? "enable" : "disable", account: a.id }),
        disabled: send.blocked ?? undefined,
      },
      {
        label: "Refresh usage",
        run: () => void send.send({ action: "refresh", account: a.id }),
        disabled: send.blocked ?? undefined,
      },
      status.action === "sign-in" && {
        label: "Sign in again…",
        run: () => openPoolAdd({ machine, again: a.email }),
        disabled: send.blocked ?? undefined,
      },
      e && { label: "Copy usage", run: () => void copyText(usageText(e, rowTitle(a).title, now)) },
      {
        label: "Remove…",
        danger: true,
        disabled: send.blocked ?? undefined,
        run: async () => {
          const c = removeConfirm(name, machine, pool.accounts.length === 1);
          if (await confirmAction({ ...c, action: "Remove", danger: true }))
            void send.send({ action: "remove", account: a.id });
        },
      },
    ];
  };
  const menu = useContextMenu(sectionItems, { title: () => title });

  // ----- the header's meta -----
  const helloAt = ms(m.control?.lastHelloAt);
  const helloStale =
    !Number.isNaN(helloAt) && now - helloAt > STALE_MS ? `as of ${ago(m.control?.lastHelloAt, now)}` : "";
  const meta = held ? SAVING_ORDER : [helloStale, roomWords(pool.accounts, now)].filter(Boolean).join(" · ");
  const hintId = `pool-hint-${machine}`;
  const helpId = `pool-help-${machine}`;
  const tip = send.tap ? `Confirm with ${signerLabel()}` : lockReason;

  return (
    <section
      className="form-group pool-section"
      id={`pool:${machine}`}
      aria-label={title}
      data-pool={machine}
      data-cursor={cursor ? String(index) : undefined}
      aria-current={cursor ? "true" : undefined}
      {...menu}
    >
      <header className="usage-head" data-nav-item="">
        <HarnessGlyph name={pool.harness} size="md" />
        <h2 className="usage-title">{title}</h2>
        <span className="pool-meta" data-pool-meta="" title={meta}>
          {meta}
        </span>
        <MoreButton build={sectionItems} label={`Actions for ${machine}'s accounts`} title={() => title} />
      </header>
      {!online && (
        <Notice>
          {offlineNotice(machine, on)}
          {on && (
            <>
              {" "}
              On {machine}, in a terminal: <code>sessionpipe pool</code> says why.
            </>
          )}
        </Notice>
      )}
      {send.note && (
        <p className={`page-note ${send.note.err ? "is-err" : ""}`} data-pool-note="">
          {send.note.text}
        </p>
      )}
      <div className="form-list">
        <div className="form-row pool-switch">
          <span className="form-row-text">
            <span className="form-label">Switch accounts when one runs out</span>
            <span className="form-caption" id={hintId}>
              {switchHint(on, machine)}
            </span>
          </span>
          <span className="pool-switch-tip" data-tip={tip} data-tip-side="top">
            <Toggle
              on={on}
              onChange={(v) => void toggle(v)}
              label="Switch accounts when one runs out"
              disabled={locked || send.tap}
              describedBy={hintId}
            />
          </span>
        </div>
        <ul className="pool-accounts" aria-label={`Accounts on ${machine}, in order`} ref={listRef}>
          {order.map((id) => {
            const a = byId.get(id);
            if (!a) return null;
            return (
              <AccountRow
                key={tokenFor(id)}
                token={tokenFor(id)}
                a={a}
                name={sentenceName(a, pool.accounts)}
                on={on}
                now={now}
                entry={entryFor(id)}
                machine={machine}
                helpId={helpId}
                dragging={dragging === tokenFor(id)}
                grabbed={grabbed === id}
                lockReason={lockReason}
                items={() => rowItems(a)}
                onDown={onRowDown}
                onGripKey={onGripKey}
                onGripBlur={onGripBlur}
              />
            );
          })}
        </ul>
        <button
          type="button"
          className="pool-add"
          aria-label={`Add an account to ${machine}`}
          disabled={!!send.blocked}
          data-tip={send.blocked ?? undefined}
          onClick={() => openPoolAdd({ machine })}
          data-pool-add=""
        >
          Add account…
        </button>
      </div>
      <p className="pool-foot">{meta}</p>
      <span id={helpId} className="sr-only">
        {SORT_HELP}
      </span>
      <div className="sr-only" role="status" aria-live="polite" data-pool-live="">
        {announce}
      </div>
    </section>
  );
}

function AccountRow({
  token,
  a,
  name,
  on,
  now,
  entry,
  machine,
  helpId,
  dragging,
  grabbed,
  lockReason,
  items,
  onDown,
  onGripKey,
  onGripBlur,
}: {
  token: string;
  a: MachinePoolAccount;
  name: string;
  on: boolean;
  now: number;
  entry: LimitsEntry | undefined;
  machine: string;
  helpId: string;
  dragging: boolean;
  grabbed: boolean;
  lockReason: string | undefined;
  items: () => MenuList;
  onDown: (e: ReactPointerEvent<HTMLDivElement>, id: string, name: string) => void;
  onGripKey: (e: ReactKeyboardEvent<HTMLButtonElement>, id: string, name: string) => void;
  onGripBlur: (e: ReactFocusEvent<HTMLButtonElement>, id: string) => void;
}) {
  const t = rowTitle(a);
  const s = statusWords(a, on, now);
  const stale = entry ? staleWords(entry, now) : "";
  const menu = useContextMenu(items, { title: () => t.title, subtitle: t.muted ? () => t.muted! : undefined });
  return (
    <li
      className={`pool-acct ${s.word === "Off" ? "pool-acct--off" : ""}`}
      data-flip={token}
      data-dragging={dragging ? "" : undefined}
      data-grabbed={grabbed ? "" : undefined}
      data-status={s.word === "Sign in again…" ? "error" : s.word.toLowerCase().replace(" ", "-")}
      aria-roledescription="sortable account"
      aria-describedby={helpId}
    >
      <div className="pool-row" onPointerDown={(e) => onDown(e, a.id, name)} {...menu}>
        <button
          type="button"
          className="pool-grip"
          aria-label={`Reorder ${name}`}
          aria-describedby={helpId}
          disabled={!!lockReason && !grabbed}
          data-tip={lockReason}
          onKeyDown={(e) => onGripKey(e, a.id, name)}
          onBlur={(e) => onGripBlur(e, a.id)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <circle cx="6" cy="4" r="1.3" />
            <circle cx="10" cy="4" r="1.3" />
            <circle cx="6" cy="8" r="1.3" />
            <circle cx="10" cy="8" r="1.3" />
            <circle cx="6" cy="12" r="1.3" />
            <circle cx="10" cy="12" r="1.3" />
          </svg>
        </button>
        <span className="pool-name">
          <span className="pool-title">{t.title}</span>
          {t.muted && <span className="pool-email">{t.muted}</span>}
        </span>
        <span className={`pool-status pool-status--${s.tone}`} data-pool-status="">
          {s.action === "sign-in" ? (
            <button
              type="button"
              className="btn btn--sm btn--ghost pool-word"
              onClick={() => openPoolAdd({ machine, again: a.email })}
            >
              {s.word}
            </button>
          ) : (
            <span className="pool-word" data-tip={s.tone === "needs" ? USED_UP_TIP : undefined} data-tip-wrap="">
              {s.word}
            </span>
          )}
          {(s.after || stale) && (
            <span className="pool-status-sub num">
              {s.after && <span className="pool-status-after">{s.after.replace(/^ · /, "")}</span>}
              {stale && <span className="pool-age">numbers {stale}</span>}
            </span>
          )}
        </span>
        <MoreButton build={items} label={`Actions for ${name}`} title={() => t.title} />
      </div>
      {entry && (
        <ul className="pool-windows">
          {orderWindows(entry.windows).map((w) => (
            <WindowRow key={w.id} w={w} now={now} />
          ))}
        </ul>
      )}
    </li>
  );
}
