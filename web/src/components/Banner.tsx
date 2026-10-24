// SPDX-License-Identifier: Apache-2.0
// The phone's notification banner (Toasts.tsx draws it on a phone only, so its code loads
// there alone, warmed at idle): iOS's banner, one at a time, two lines (what happened and
// where, then the session), no buttons. A tap on a prompt opens the Inbox, where the
// answers are; a tap on anything else opens its session. It slides back up after a few
// seconds (the Inbox and its badge keep the prompt), or at once when flicked up.
import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { copyItem } from "../lib/menus";
import { tokenMs } from "../lib/motion";
import { navigate } from "../lib/router";
import { openSplit } from "../lib/split";
import { dismissToast, type Toast } from "../lib/toasts";
import { useContextMenu } from "./ContextMenu";
import { LabelDot } from "./LabelDot";
import "../styles/banner.css";

/** How long a phone banner stays before it slides back up, a prompt's too: the Inbox
 *  and the tab's badge hold it from then on. A finger on it holds it. */
const BANNER_MS = 6000;
/** A flick up past this, or faster than FLICK, sends it away. */
const BANNER_FLICK_PX = 24;
const FLICK = 0.4;

/** The phone's banner: what happened and where on the first line, the session on the
 *  second (with the tool it asks for); the whole banner one target. It follows a finger
 *  up (and gives a little going down), and a long-press has the rest. */
export function Banner({ toast: t, closing }: { toast: Toast; closing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const prompt = !!t.attentionId;
  const open = () => {
    dismissToast(t.id);
    if (prompt) navigate("/inbox");
    else if (t.session) openSplit(t.session, { from: ref.current?.getBoundingClientRect() });
  };
  const drag = useRef<{ y: number; t: number; dy: number; v: number; moved: boolean } | null>(null);
  const held = useRef(false);
  // It leaves by itself; never while a finger is on it.
  useEffect(() => {
    if (closing) return;
    let h = 0;
    const arm = (ms: number) => {
      h = window.setTimeout(() => (held.current ? arm(1000) : dismissToast(t.id)), ms);
    };
    arm(BANNER_MS);
    return () => window.clearTimeout(h);
  }, [t.id, closing]);
  const menu = useContextMenu(
    () => [
      prompt ? { label: "Open the Inbox", run: open } : t.session && { label: "Open the session", run: open },
      prompt && t.session && { label: "Open the session", run: () => t.session && openSplit(t.session) },
      { sep: true },
      { label: "Copy", items: [copyItem("Title", t.title), copyItem("Message", t.body)] },
      { sep: true },
      { label: "Dismiss", run: () => dismissToast(t.id) },
    ],
    { title: () => t.title, subtitle: () => t.machine ?? "" },
  );
  const place = (dy: number, settle: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.style.animation = "none";
    el.style.transition = settle ? `transform ${tokenMs("--dur", 200)}ms cubic-bezier(0.22, 1, 0.36, 1)` : "none";
    el.style.transform = dy ? `translateY(${dy}px)` : "";
  };
  const down = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    held.current = true;
    drag.current = { y: e.clientY, t: e.timeStamp, dy: 0, v: 0, moved: false };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const raw = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(raw) < 6) return;
      d.moved = true;
      ref.current?.setPointerCapture?.(e.pointerId);
    }
    const dy = raw < 0 ? raw : raw * 0.25;
    const dt = Math.max(1, e.timeStamp - d.t);
    d.v = (dy - d.dy) / dt;
    d.dy = dy;
    d.t = e.timeStamp;
    place(dy, false);
  };
  const up = () => {
    held.current = false;
    const d = drag.current;
    if (!d?.moved) return;
    if (d.dy < -BANNER_FLICK_PX || d.v < -FLICK) {
      // The exit takes it from where the finger left it (its keyframes have no `from`).
      const el = ref.current;
      if (el) el.style.animation = "";
      dismissToast(t.id);
    } else place(0, true);
  };
  const machine = t.machine ? (
    <>
      {" "}
      {t.kind === "delivered" && t.verb === "Delivered" ? "to" : "on"}{" "}
      <span className="toast-machine">{t.machine}</span>
    </>
  ) : null;
  const detail = prompt ? t.tool : t.kind === "delivered" ? t.body : undefined;
  return (
    <div
      ref={ref}
      className={`toast toast--banner toast--${t.kind}`}
      data-toast={t.kind}
      data-session={t.session}
      data-attention={t.attentionId}
      role="status"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClickCapture={(e) => {
        // A drag is not a tap.
        if (drag.current?.moved) {
          e.preventDefault();
          e.stopPropagation();
        }
        drag.current = null;
      }}
      {...menu}
    >
      <button type="button" className="toast-main" onClick={open} disabled={!prompt && !t.session}>
        <span className="toast-head">
          {t.kind === "needs-you" && <span className="toast-dot" aria-hidden="true" />}
          {t.kind === "error" && <span className="toast-mark--error" aria-hidden="true" />}
          <span className="toast-what">
            {t.verb ?? t.label}
            {machine}
          </span>
        </span>
        <span className="toast-top">
          {t.session && <LabelDot session={t.session} />}
          <span className="toast-title">{t.title}</span>
          {detail && <span className="toast-detail">{detail}</span>}
        </span>
        <span className="sr-only">{prompt ? ". Opens the Inbox" : t.session ? ". Opens the session" : ""}</span>
      </button>
      <button type="button" className="sr-only" onClick={() => dismissToast(t.id)}>
        Dismiss
      </button>
    </div>
  );
}
