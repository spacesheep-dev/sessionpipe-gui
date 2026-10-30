// SPDX-License-Identifier: Apache-2.0
// The inbox: every open attention across all sessions and machines, newest first, as
// Mail lays out a mailbox: rows in two groups, the prompts a control answer can reach
// (Allow / Deny, the same signed send as the session page, control/useSend.ts) and the
// ones waiting in a terminal. A row click opens its session beside the page (on the phone,
// as its page, pushed: lib/split.ts); rows leave as the stream clears them, but never from
// under the pointer: the list holds still while it is read (lib/motion.ts), a prompt that
// cleared stays faded until the hand leaves. "Notify me" and the sounds live behind one
// bell in the page bar; why the buttons are off (the machine is not paired, this page
// cannot use passkeys, notifications are off for the site or the app) is said once under
// the bar, not on every row.
import type { MachineControl } from "@shared/api";
import { type MutableRefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActionButton, Ago, EmptyState, HarnessGlyph, Redacted, StateDot } from "../components/bits";
import { type MenuList, openMenu, useContextMenu } from "../components/ContextMenu";
import { LabelChip, LabelDot, useLabelKeys } from "../components/LabelDot";
import { LensChip, LensNote } from "../components/LensChip";
import { NotifyBlocked, NotifyMenu, notifyBlocked, useAppNotify } from "../components/NotifyToggle";
import { PageBar } from "../components/PageBar";
import {
  answerItems,
  lensMenu,
  literalAsk,
  SwipePanes,
  useBackgroundMenu,
  useStickyTop,
  useSwipe,
} from "../components/SessionCard";
import { ComposeButton } from "../control/NewSession";
import { answerState, useSessionSend } from "../control/useSend";
import { type OpenAttention, useAppState, useFirstLoad, useLabels, useOpenAttentions, useStore } from "../data/hooks";
import { prefetchProps } from "../data/prefetch";
import { phoneLayout, usePhoneLayout } from "../lib/device";
import { ATTENTION_LABEL, attentionMessage, isPlanReview, oneLine, sessionTitle, toolLabel } from "../lib/format";
import { attentionKey, hide, isHidden, useHidden } from "../lib/hidden";
import { useListNav } from "../lib/keys";
import { type LabelFilter, labelItems, labelPasses } from "../lib/labels";
import { copyItem, sessionItems, sessionMenuSubtitle, sessionMenuTitle } from "../lib/menus";
import { type Held, useFlip, useHeldOrder, useListHold } from "../lib/motion";
import { setNotifyPref, useNotifyPref } from "../lib/notify";
import { navigate, sessionPath } from "../lib/router";
import { type Lens, useAppSettings, useLens } from "../lib/settings";
import { useShortcut } from "../lib/shortcuts";
import { openSplit } from "../lib/split";

const rowKey = (r: OpenAttention) => `${r.session.key}|${r.attention.attentionId}`;
const groupOf = (r: OpenAttention) => (r.answerable ? "answer" : "terminal");

export function Inbox() {
  const store = useStore();
  const all = useOpenAttentions();
  const labels = useLabels();
  const hidden = useHidden();
  const [label, setLabelFilter] = useState<LabelFilter>("");
  const rows = useMemo(
    () =>
      all.filter(
        (r) =>
          labelPasses(labels, r.session.key, label) &&
          !isHidden(hidden, attentionKey(r.session.key, r.attention.attentionId), r.attention.at),
      ),
    [all, labels, label, hidden],
  );
  const { machines } = useAppState();
  const firstLoad = useFirstLoad();
  // Answerable first, then the ones waiting in a terminal; held still while read.
  const sorted = useMemo(() => [...rows.filter((r) => r.answerable), ...rows.filter((r) => !r.answerable)], [rows]);
  const listRef = useRef<HTMLDivElement>(null);
  const hold = useListHold(listRef);
  const heldAll = useHeldOrder(sorted, rowKey, hold, groupOf);
  // A prompt the person hid leaves at once, held or not.
  const held = heldAll.filter(
    (h) =>
      !(
        h.gone && isHidden(hidden, attentionKey(h.item.session.key, h.item.attention.attentionId), h.item.attention.at)
      ),
  );
  useFlip(listRef);
  const answer = useMemo(() => held.filter((h) => h.group === "answer"), [held]);
  const terminal = useMemo(() => held.filter((h) => h.group === "terminal"), [held]);
  const ordered = useMemo(() => [...answer, ...terminal], [answer, terminal]);
  const hrefs = useMemo(() => ordered.map((h) => sessionPath(h.item.session.harness, h.item.session.id)), [ordered]);
  const keys = useMemo(() => ordered.map((h) => h.item.session.key), [ordered]);
  const clearRef = useRef<() => boolean>(() => false);
  clearRef.current = () => {
    if (!label) return false;
    setLabelFilter("");
    return true;
  };
  const { cursor } = useListNav(hrefs, true, keys, { peek: "inbox.peek", clear: () => clearRef.current(), store });
  // ⌥⌘1 … ⌥⌘7 label the session under the cursor, ⌥⌘0 clears it.
  useLabelKeys(() => (keys[cursor] ? [keys[cursor]!] : []));
  // The tier lens: attention messages and tool names travel at tier 1 (lib/tier.ts).
  const lens = useLens();
  const simple = useAppSettings().mode === "simple";
  const hiddenByLens = lens === 0 ? rows.filter((r) => r.attention.message || r.attention.tool).length : 0;
  const notify = useNotifyPref();
  const app = useAppNotify();
  const phone = usePhoneLayout();
  const page = useRef<HTMLDivElement>(null);
  useStickyTop(page);

  // Why Allow / Deny are off, reported by each answerable row and said once for all.
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const report = useCallback((id: string, reason: string | null) => {
    setReasons((prev) => {
      if ((prev[id] ?? null) === reason) return prev;
      const next = { ...prev };
      if (reason) next[id] = reason;
      else delete next[id];
      return next;
    });
  }, []);
  const said = [...new Set(answer.map((h) => reasons[h.key]).filter((x): x is string => !!x))];

  const bgMenu = useBackgroundMenu(
    () => [
      app
        ? {
            label: "Notify me",
            checked: app.enabled && app.status === "granted",
            disabled: app.status === "denied" ? "Off for sessionpipe in Settings" : undefined,
            run: () => void (app.enabled && app.status === "granted" ? app.turnOff() : app.turnOn()),
          }
        : {
            label: "Notify me",
            checked: notify.on,
            disabled:
              notify.permission === "denied"
                ? "Blocked for this site in the browser's settings"
                : notify.permission === "unsupported"
                  ? "Not available in this browser"
                  : undefined,
            run: () => void setNotifyPref(!notify.on),
          },
      { label: "Notification sounds…", run: () => navigate("/settings?section=notifications") },
      { sep: true },
      ...lensMenu(lens, simple),
    ],
    { title: () => "Inbox" },
  );

  const meta = [
    answer.length > 0 && `${answer.length} ${answer.length === 1 ? "needs" : "need"} an answer`,
    terminal.length > 0 && `${terminal.length} waiting in a terminal`,
  ]
    .filter(Boolean)
    .join(" · ");

  const group = (title: string, list: Held<OpenAttention>[], offset: number) =>
    list.length > 0 && (
      <section className="group inbox-group" aria-label={title}>
        <h2 className="group-head">
          {title}
          <span key={list.length} className="group-count num">
            {list.length}
          </span>
        </h2>
        <ol className="inbox-rows">
          {list.map((h, i) => (
            <InboxRow
              key={h.key}
              row={h.item}
              gone={h.gone}
              control={h.item.session.machine ? machines.get(h.item.session.machine)?.control : undefined}
              cursor={offset + i === cursor ? cursor : undefined}
              lens={lens}
              report={report}
            />
          ))}
        </ol>
      </section>
    );

  const blocked = notifyBlocked(app, notify.permission);

  return (
    <div className="page inbox" ref={page} {...bgMenu}>
      <PageBar
        title="Inbox"
        className="inbox-head"
        meta={meta || undefined}
        tools={<LabelChip value={label} onChange={setLabelFilter} />}
        actions={
          <>
            <LensChip />
            <NotifyMenu />
            <ComposeButton className="compose-btn--phone" />
          </>
        }
      />
      {(blocked || said.length > 0 || hiddenByLens > 0) && (
        <div className="inbox-notes">
          <NotifyBlocked permission={notify.permission} app={app} />
          {said.map((r) => (
            <p key={r} className="page-note inbox-reason">
              Allow and Deny are off: {r}.
            </p>
          ))}
          <LensNote lens={lens} hidden={hiddenByLens} />
        </div>
      )}
      {firstLoad === "loading" ? (
        <div className="skeleton" role="status" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      ) : firstLoad ? (
        <EmptyState
          center
          title={firstLoad === "slow" ? "Still connecting to the receiver…" : "No connection to the receiver"}
          actions={
            <button type="button" className="btn btn--sm" onClick={() => store.reconnect()}>
              Retry now
            </button>
          }
        >
          Prompts show up here as soon as the {firstLoad === "slow" ? "first update arrives" : "stream is back"}.
        </EmptyState>
      ) : held.length === 0 && label ? (
        <EmptyState
          center
          title="Nothing with this label needs you"
          actions={
            <button type="button" className="btn" onClick={() => setLabelFilter("")}>
              Show all labels
            </button>
          }
        >
          Prompts from sessions with other labels are hidden.
        </EmptyState>
      ) : held.length === 0 ? (
        <EmptyState center className="inbox-empty" title="Nothing needs you">
          {phone
            ? "Prompts and permissions from every machine land here."
            : "Prompts and permissions from any machine land here. Allow and Deny from this page, or from your phone."}
        </EmptyState>
      ) : null}
      {/* Always there once loaded, so a first prompt is a new row to useFlip (its entrance). */}
      <div className="inbox-list" ref={listRef} hidden={held.length === 0 || undefined}>
        {group("Needs an answer", answer, 0)}
        {group("Waiting in a terminal", terminal, answer.length)}
      </div>
    </div>
  );
}

function InboxRow({
  row,
  gone = false,
  control,
  cursor,
  lens = null,
  report,
}: {
  row: OpenAttention;
  /** Cleared while the list held still: faded and inert until the hand leaves. */
  gone?: boolean;
  control?: MachineControl;
  cursor?: number;
  lens?: Lens;
  report: (id: string, reason: string | null) => void;
}) {
  const store = useStore();
  const { session: s, attention: raw } = row;
  // Below tier 1 the message and the tool stay on the sending machine.
  const a = lens === 0 ? { ...raw, message: undefined, tool: undefined } : raw;
  const ref = useRef<HTMLLIElement>(null);
  const open = (background = false) => openSplit(s.key, { from: ref.current?.getBoundingClientRect(), background });
  const answerMenu = useRef<MenuList>([]);
  const menu = useContextMenu(
    () => [
      ...(row.answerable ? answerMenu.current : []),
      { sep: true },
      ...sessionItems(s, {
        store,
        surface: "list",
        extra: [
          copyItem("Copy message", raw.message),
          // Off this device's inbox until the prompt changes; "Hidden · Undo".
          !row.answerable && {
            label: "Hide this prompt",
            run: () => hide(attentionKey(s.key, raw.attentionId), raw.at, { title: sessionTitle(s), session: s.key }),
          },
        ],
      }),
    ],
    { title: () => sessionMenuTitle(s), subtitle: () => sessionMenuSubtitle(s) },
  );
  const kind = ATTENTION_LABEL[a.kind] ?? a.kind;
  const msg = attentionMessage(a);
  // A phone's swipes: trailing hides this prompt here (Undo), leading labels its session.
  // Allow and Deny are never a swipe: they are signed, and final.
  useSwipe(ref, {
    lead: () => openMenu(labelItems(store, [s.key]), ref.current!, { source: "touch", title: "Label" }),
    trail: () => hide(attentionKey(s.key, raw.attentionId), raw.at, { title: sessionTitle(s), session: s.key }),
  });
  return (
    <li
      ref={ref}
      className={`inbox-row ${row.answerable ? "inbox-row--answerable" : "inbox-row--terminal"}`}
      data-attention={a.attentionId}
      data-session={s.key}
      data-flip={rowKey(row)}
      data-gone={gone ? "" : undefined}
      data-cursor={cursor !== undefined ? String(cursor) : undefined}
      aria-current={cursor !== undefined ? "true" : undefined}
      {...menu}
    >
      <SwipePanes lead="Label" trail="Hide" />
      <button
        type="button"
        className="inbox-main"
        data-nav-item=""
        onClick={(e) => open(e.metaKey || e.ctrlKey)}
        title={phoneLayout() ? "Open the session" : "Open the session beside this page"}
        {...prefetchProps(store, s)}
      >
        <span className="inbox-lead">
          <StateDot state={row.answerable ? "needs_you" : s.state} decorative />
          <LabelDot session={s.key} />
        </span>
        <span className="inbox-title">{sessionTitle(s)}</span>
        <span className="inbox-age">
          <Ago iso={a.at} />
        </span>
        <span className="inbox-what">
          <span className={`inbox-kind ${a.tool ? "sr-only" : ""}`}>{kind}</span>
          {a.tool && <code className="inbox-tool">{toolLabel(a.tool)}</code>}
          {msg ? (
            <span className={`inbox-msg ${a.kind === "permission" && literalAsk(a.tool) ? "mono" : ""}`}>
              <Redacted text={oneLine(msg, 200)} />
            </span>
          ) : !a.tool ? (
            <span className="inbox-msg">{row.answerable ? "a permission request" : "waiting for you"}</span>
          ) : null}
        </span>
        <span className="inbox-where">
          <HarnessGlyph name={s.harness} size="sm" />
          {s.machine && <span className="inbox-machine">{s.machine}</span>}
        </span>
      </button>
      {/* A prompt in a terminal has nothing to press here; its section says where it waits. */}
      {row.answerable && (
        <Answer row={row} control={control} focused={cursor !== undefined} into={answerMenu} report={report} />
      )}
    </li>
  );
}

/** Allow / Deny for one answerable prompt, through the same signed send as the session
 *  page; disabled when nothing can go (control/useSend.ts answerState), the reason said
 *  once under the page bar. The row's menu gets the same two as items. A press answers in
 *  the same frame: the pressed one turns into "Allowing…" (its spinner, its width held)
 *  and the other steps back, through the passkey, the send and the wait for the machine
 *  (said under it), until the machine clears the prompt and the row leaves. A refused
 *  send gives both back. */
function Answer({
  row,
  control,
  focused = false,
  into,
  report,
}: {
  row: OpenAttention;
  control?: MachineControl;
  /** The row under the list cursor: `a` / `d` answer it (lib/shortcuts.ts). */
  focused?: boolean;
  into: MutableRefObject<MenuList>;
  report: (id: string, reason: string | null) => void;
}) {
  const { session: s, attention: a } = row;
  const send = useSessionSend(s, control, s.openAttentions);
  const st = answerState(s, a, control, send);
  const { reason, off, status, tag } = st;
  // A plan review's pair asks the plan's question (lib/format.ts isPlanReview).
  const plan = isPlanReview(a);
  /** The answer pressed, from the press until the prompt leaves (or the send fails). */
  const [chosen, setChosen] = useState<boolean | null>(null);
  const answer = (allow: boolean) => {
    if (chosen !== null) return;
    setChosen(allow);
    void send.onSend({ kind: "permission.answer", attentionId: a.attentionId, allow }).catch(() => setChosen(null));
  };
  // Pending from the press until the machine clears the prompt: "sent" is the receiver
  // holding it, not the agent taking it.
  const going = chosen !== null && status !== "closed";
  // The inbox row wins over a session open beside the page (priority 2 > the panel's 0).
  const canKey = focused && !off && chosen === null && status !== "closed";
  useShortcut("inbox.allow", () => answer(true), { enabled: canKey, priority: 2 });
  useShortcut("inbox.deny", () => answer(false), { enabled: canKey, priority: 2 });
  // Off for a standing reason (not paired, no passkeys here, raised before pairing): the
  // page says it once. A moment's state (sent, a passkey prompt, closed) stays on the row.
  const standing = off && !status ? reason : null;
  const id = rowKey(row);
  useEffect(() => {
    report(id, standing);
  }, [id, standing, report]);
  useEffect(() => () => report(id, null), [id, report]);
  useLayoutEffect(() => {
    into.current = status === "closed" ? [] : answerItems(a.tool, st, answer);
  });
  const note = send.error ? (
    <span className="inbox-note inbox-note--err">{send.error}</span>
  ) : reason && !standing ? (
    <span className="inbox-note">{reason}</span>
  ) : null;
  return (
    <span
      className="inbox-answer"
      data-answer={tag}
      data-chosen={chosen === null ? undefined : chosen ? "allow" : "deny"}
    >
      {note}
      {status !== "closed" && (
        <>
          <ActionButton
            className="btn btn--sm btn--deny"
            disabled={(off && chosen === null) || chosen === true}
            pending={going && chosen === false}
            pendingLabel={plan ? "Sending…" : "Denying…"}
            onClick={() => answer(false)}
            aria-description={standing ?? undefined}
            aria-pressed={chosen === false || undefined}
          >
            {plan ? "Keep planning" : "Deny"}
          </ActionButton>
          <ActionButton
            className="btn btn--sm btn--allow"
            disabled={(off && chosen === null) || chosen === false}
            pending={going && chosen === true}
            pendingLabel={plan ? "Approving…" : "Allowing…"}
            onClick={() => answer(true)}
            aria-description={standing ?? undefined}
            aria-pressed={chosen === true || undefined}
          >
            {plan ? "Approve plan" : "Allow"}
          </ActionButton>
        </>
      )}
    </span>
  );
}
