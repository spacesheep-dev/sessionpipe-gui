// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A carried message's lifecycle, as the receiver reads it
// (CONTROL.md §10): queued → taken → progress (the reply growing) → delivered, or
// expired / unsupported / failed / refused, each in words. Under the composer the list
// shows what still matters (history.ts): a settled row can be dismissed, leaves by
// itself after a while, and the rest is one "show" away.
import type { ControlActivity } from "@shared/api";
import { useState } from "react";
import { Ago } from "../components/bits";
import { Markdown } from "../components/Markdown";
import { oneLine } from "../lib/format";
import { useNow } from "../lib/time";
import { AttachmentThumbs, promptParts } from "./Attachments";
import { dismissActivity, useHiddenActivity, visibleActivity } from "./history";
import { isFinal, KIND_LABEL, outcomeWords, shownState } from "./words";

export function ActivityRow({
  a,
  machine,
  online,
  wide = false,
  onDismiss,
}: {
  a: ControlActivity;
  machine?: string;
  online?: boolean;
  /** Show the whole reply instead of the last lines. */
  wide?: boolean;
  /** Offered on a settled row: take it off the list on this device. */
  onDismiss?: (id: string) => void;
}) {
  const state = shownState(a);
  const live = !isFinal(a);
  // A prompt's attachments block (shared/attachments.ts) is drawn as thumbnails, not read as text.
  const prompt = a.text ? promptParts(a.text) : null;
  return (
    <li className={`ctl-act ctl-act--${state}`} data-outcome={state} data-message={a.id}>
      <div className="ctl-act-head">
        <span className="ctl-act-kind">{KIND_LABEL[a.kind]}</span>
        {prompt && (prompt.body || prompt.items.length === 0) && (
          <span className="ctl-act-text" title={prompt.body}>
            {oneLine(prompt.body, 120)}
          </span>
        )}
        <Ago iso={a.ackedAt ?? a.takenAt ?? a.at} />
        {onDismiss && !live && (
          <button type="button" className="ctl-act-x" onClick={() => onDismiss(a.id)} aria-label="Dismiss">
            ×
          </button>
        )}
      </div>
      {prompt && prompt.items.length > 0 && <AttachmentThumbs items={prompt.items} small />}
      <p className={`ctl-act-state ${live ? "is-live" : ""}`} aria-live="polite">
        {live && <span className="ctl-act-pulse" aria-hidden="true" />}
        {outcomeWords(a, { machine, online })}
      </p>
      {a.reply ? (
        <blockquote className={`ctl-act-reply ${wide ? "" : "ctl-act-reply--tail"} ${live ? "is-live" : ""}`}>
          <Markdown text={a.reply} />
          {state === "progress" && <span className="caret" aria-hidden="true" />}
        </blockquote>
      ) : null}
    </li>
  );
}

/** The messages under a session's composer, newest first: what is in flight, a recent
 *  delivery, a recent failure with its ×; older or dismissed rows behind "show". */
export function ActivityList({
  items,
  machine,
  online,
  limit = 3,
}: {
  items: ControlActivity[];
  machine?: string;
  online?: boolean;
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  const dismissed = useHiddenActivity();
  // A settled row leaves by the clock; a ten-second tick is plenty for minutes.
  const now = useNow(items.some((a) => isFinal(a) && !dismissed.includes(a.id)) ? "coarse" : "off");
  if (items.length === 0) return null;
  const { shown, hidden } = all ? { shown: items, hidden: 0 } : visibleActivity(items, dismissed, now);
  const rows = all ? shown : shown.slice(0, limit);
  const more = hidden + shown.length - rows.length;
  return (
    <ol className="ctl-acts" aria-label="Messages sent">
      {rows.map((a) => (
        <ActivityRow key={a.id} a={a} machine={machine} online={online} onDismiss={dismissActivity} />
      ))}
      {(more > 0 || all) && (
        <li className="ctl-acts-more">
          <button type="button" className="ctl-link" onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? "Show fewer" : `${more} earlier message${more === 1 ? "" : "s"} · show`}
          </button>
        </li>
      )}
    </ol>
  );
}
