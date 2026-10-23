// SPDX-License-Identifier: Apache-2.0
// Notifications on the inbox: one bell in the page bar, as Mail and Slack keep it, that
// opens a small popover with "Notify me" (the one switch for system notifications,
// lib/notify.ts; turning it on asks the browser once, a refusal there keeps it off) and
// the way to the sounds. The bell is struck through while nothing will notify. The
// switch on its own (NotifyToggle) stays for anywhere else that wants it.
import { useEffect, useId, useRef, useState } from "react";
import { usePresence } from "../lib/motion";
import { setNotifyPref, useNotifyPref } from "../lib/notify";
import { Link } from "../lib/router";
import { Notice, Toggle } from "./bits";

const hintFor = (on: boolean, permission: string) =>
  permission === "unsupported"
    ? "Not available in this browser."
    : permission === "denied"
      ? "Off for this site in the browser's settings."
      : on
        ? "When a prompt needs you and this tab is in the background."
        : "A system notification when a prompt needs you.";

export function NotifyToggle({ compact = false }: { compact?: boolean }) {
  const { on, permission } = useNotifyPref();
  const blocked = permission === "denied" || permission === "unsupported";
  const hint = hintFor(on, permission);
  return (
    <div className="notify" data-notify={on ? "on" : "off"} title={compact ? hint : undefined}>
      <Toggle on={on} onChange={(v) => void setNotifyPref(v)} label="Notify me" disabled={blocked} />
      <span className="notify-text">Notify me</span>
      {!compact && <span className="notify-hint">{hint}</span>}
    </div>
  );
}

/** The bell and its popover. */
export function NotifyMenu() {
  const { on } = useNotifyPref();
  const [open, setOpen] = useState(false);
  const { mounted, closing } = usePresence(open);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const close = () => {
    setOpen(false);
    btn.current?.focus({ preventScroll: true });
  };
  return (
    <div className="notify-menu" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="icon-btn notify-bell"
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={mounted ? id : undefined}
        data-notify={on ? "on" : "off"}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          viewBox="0 0 20 20"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.2 1.5H4.3z" />
          <path d="M8.3 17a1.8 1.8 0 0 0 3.4 0" />
          {!on && <path d="M3.5 3.5l13 13" />}
        </svg>
      </button>
      {mounted && (
        <div
          id={id}
          className="pop notify-pop"
          role="dialog"
          aria-label="Notifications"
          data-closing={closing ? "" : undefined}
        >
          <NotifyToggle />
          <div className="notify-pop-foot">
            <Link to="/settings?section=notifications" className="btn btn--sm btn--ghost">
              Sounds
            </Link>
            <button type="button" className="sr-only" onClick={close} data-dismiss={open ? "" : undefined}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Notifications are off for this site · How to allow": the condition once, under the
 *  bar, with the steps behind the one button. */
export function NotifyBlocked({ permission }: { permission: string }) {
  const [how, setHow] = useState(false);
  if (permission !== "denied" && permission !== "unsupported") return null;
  if (permission === "unsupported")
    return <p className="page-note notify-hint">Notifications are not available in this browser.</p>;
  return (
    <div className="notify-hint">
      <Notice
        action={
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-expanded={how}
            onClick={() => setHow((v) => !v)}
          >
            How to allow
          </button>
        }
      >
        Notifications are off for this site
      </Notice>
      {how && (
        <p className="notify-how">
          Open the site's settings from the icon left of the address, set Notifications to Allow, then reload this page.
        </p>
      )}
    </div>
  );
}
