// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A carried message's lifecycle, as the receiver reads it
// (CONTROL.md §10): queued → taken → progress (the reply growing) → delivered, or
// expired / unsupported / failed / refused, each in words. One row each, hairlines
// between; the spinner is the only motion while one is under way. A delivered message
// whose turn the chat above already shows folds to one line; one that went to a copy of
// the session (a fork) keeps its reply and links to the copy.
import { type ControlActivity, splitKey } from "@shared/api";
import { Ago } from "../components/bits";
import { Markdown } from "../components/Markdown";
import { oneLine } from "../lib/format";
import { Link, sessionPath } from "../lib/router";
import { AttachmentThumbs, promptParts } from "./Attachments";
import { isFinal, KIND_LABEL, outcomeWords, shownState } from "./words";

/** The copy of the session a prompt went to (CONTROL.md §6 `fork`: a session a live
 *  process holds is never resumed, it is copied), when the machine's ack named one. A
 *  start's ack names the session it made, which is no copy. */
export const forkOf = (a: ControlActivity): string | null =>
  a.kind === "prompt" && a.ackSession && a.ackSession !== a.session ? a.ackSession : null;

export function ActivityRow({
  a,
  machine,
  online,
  wide = false,
  folded = false,
}: {
  a: ControlActivity;
  machine?: string;
  online?: boolean;
  /** Show the whole reply instead of the last lines. */
  wide?: boolean;
  /** Delivered, and its turn is in the chat above: one line, no reply. */
  folded?: boolean;
}) {
  const state = shownState(a);
  const live = !isFinal(a);
  // A prompt's attachments block (shared/attachments.ts) is drawn as thumbnails, not read as text.
  const prompt = a.text ? promptParts(a.text) : null;
  const text = prompt && (prompt.body || prompt.items.length === 0) && (
    <span className="ctl-act-text" title={prompt.body}>
      {oneLine(prompt.body, 120)}
    </span>
  );
  const when = <Ago iso={a.ackedAt ?? a.takenAt ?? a.at} />;
  if (folded)
    return (
      <li className={`ctl-act ctl-act--${state} ctl-act--folded`} data-outcome={state} data-message={a.id} data-folded>
        <div className="ctl-act-head">
          <span className="ctl-act-kind">{KIND_LABEL[a.kind]}</span>
          {text}
          <span className="ctl-act-state">{outcomeWords(a, { machine, online })}</span>
          {when}
        </div>
      </li>
    );
  const fork = forkOf(a);
  const copy = fork ? splitKey(fork) : null;
  return (
    <li className={`ctl-act ctl-act--${state}`} data-outcome={state} data-message={a.id}>
      <div className="ctl-act-head">
        <span className="ctl-act-kind">{KIND_LABEL[a.kind]}</span>
        {text}
        {when}
      </div>
      {prompt && prompt.items.length > 0 && <AttachmentThumbs items={prompt.items} small />}
      <p className={`ctl-act-state ${live ? "is-live" : ""}`} aria-live="polite">
        {live && <span className="spinner" aria-hidden="true" />}
        {outcomeWords(a, { machine, online })}
        {copy && (
          <Link to={sessionPath(copy.harness, copy.id)} className="ctl-act-copy">
            copy of this session
          </Link>
        )}
      </p>
      {a.reply ? (
        <blockquote className={`ctl-act-reply ${wide ? "" : "ctl-act-reply--tail"} ${live ? "is-live" : ""}`}>
          <Markdown text={a.reply} />
        </blockquote>
      ) : null}
    </li>
  );
}

export function ActivityList({
  items,
  machine,
  online,
  limit = 3,
  folded,
}: {
  items: ControlActivity[];
  machine?: string;
  online?: boolean;
  limit?: number;
  /** The ids of the delivered messages whose turn the chat above shows. */
  folded?: ReadonlySet<string>;
}) {
  if (items.length === 0) return null;
  return (
    <ol className="ctl-acts" aria-label="Messages sent">
      {items.slice(0, limit).map((a) => (
        <ActivityRow key={a.id} a={a} machine={machine} online={online} folded={folded?.has(a.id)} />
      ))}
    </ol>
  );
}
