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
// the bar, not on every row. A device not approved gets no buttons at all, and one notice
// with the way to approve it (off a spacesheep account, where each computer approves it,
// the rows of a computer that doesn't trust it say so, each with the way). A prompt with
// an answer out, from here or anywhere, keeps its row with the receipt in the pair's place
// until it clears, and counts no more. Allow and Deny stand only beside a request the row
// shows whole, wrapped; a plan or a longer request is two lines and "Open". A question
// from the agent waits with the terminal's.
import type { MachineControl } from "@shared/api";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useBehind, useCatchingUp } from "../account/current";
import { ActionButton, Ago, EmptyState, HarnessGlyph, Notice, Redacted, StateDot, WithName } from "../components/bits";
import { type MenuList, openMenu, useContextMenu } from "../components/ContextMenu";
import { FilterMenu, labelFilterMenu, labelFilterName } from "../components/FilterMenu";
import { LabelChip, LabelDot, useLabelKeys } from "../components/LabelDot";
import { LensChip, LensNote } from "../components/LensChip";
import { NoConnection } from "../components/NoConnection";
import { NotifyBlocked, NotifyMenu, notifyBlocked, useAppNotify } from "../components/NotifyToggle";
import { BarStatus, PageBar } from "../components/PageBar";
import {
  AskedLine,
  answerItems,
  lensMenu,
  literalAsk,
  SwipePanes,
  useBackgroundMenu,
  useStickyTop,
  useSwipe,
} from "../components/SessionCard";
import { useAnswersOut } from "../control/hooks";
import { ComposeButton } from "../control/NewSession";
import { setupLabel } from "../control/signer";
import { answerState, useSessionSend } from "../control/useSend";
import { type OpenAttention, useAppState, useFirstLoad, useLabels, useOpenAttentions, useStore } from "../data/hooks";
import { prefetchProps } from "../data/prefetch";
import { usePhoneLayout } from "../lib/device";
import {
  ATTENTION_LABEL,
  askFitsRow,
  attentionMessage,
  isPlanReview,
  isQuestion,
  oneLine,
  sessionTitle,
  toolLabel,
} from "../lib/format";
import { attentionKey, hide, isHidden, useHidden } from "../lib/hidden";
import { inPanel, panelAnswers, useListNav } from "../lib/keys";
import { anyLabel, type LabelFilter, labelItems, labelPasses } from "../lib/labels";
import { copyItem, sessionItems, sessionMenuSubtitle, sessionMenuTitle } from "../lib/menus";
import { type Held, useFlip, useHeldOrder, useListHold } from "../lib/motion";
import { setNotifyPref, useNotifyPref } from "../lib/notify";
import { pageBarBottom, useResizeAnchor } from "../lib/resizeAnchor";
import { Link, openSettings, sessionPath } from "../lib/router";
import { type Lens, useAppSettings, useLens } from "../lib/settings";
import { useShortcut } from "../lib/shortcuts";
import { howOf, type OpenHow, openSession, useSplitKey } from "../lib/split";
import { NEW_WORDS, ThisPhone } from "../native/accountWords";

const rowKey = (r: OpenAttention) => `${r.session.key}|${r.attention.attentionId}`;
/** Why a row's Allow / Deny are off for a standing reason, answerState's tag for it,
 *  whether its way on is Approve this iPhone, and whether it is a sentence of its own. */
type Off = { reason: string; tag: string; approve: boolean; sentence: boolean; machine?: string };
/** A standing reason as the page says it: a sentence of its own (answerState's `sentence`:
 *  "This iPhone can send from 3:09 AM.", "studio-mac hasn't added this iPhone yet.") as it
 *  is, with its full stop; a phrase after what it turns off. */
const offLine = (o: Off): string =>
  o.sentence ? `${o.reason.replace(/\.$/, "")}.` : `Allow and Deny are off: ${o.reason}.`;
/** The id of the page line that says a standing reason, which the rows' buttons are
 *  described by: the same words, the same id. */
const reasonId = (r: string): string => {
  let h = 0;
  for (let i = 0; i < r.length; i++) h = (Math.imul(h, 31) + r.charCodeAt(i)) | 0;
  return `inbox-reason-${(h >>> 0).toString(36)}`;
};
const groupOf = (r: OpenAttention) => (r.answerable ? "answer" : "terminal");
/** The keys a row's Allow and Deny answer to, shown beside them in its menu. */
const INBOX_KEYS = { allow: "inbox.allow", deny: "inbox.deny" };

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
  const { machines, sessions, snapshotAt } = useAppState();
  const firstLoad = useFirstLoad();
  // An account reading its history: the prompts it has stay as they are until the history is in.
  const behind = useBehind();
  const catchingUp = useCatchingUp();
  // As on the Board: an empty board drawn before any of the history came is still loading.
  const filling = !!snapshotAt && behind && sessions.size === 0;
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
  const openKey = useSplitKey();
  // `a` and `d` with no row of the Inbox to take them (none under the cursor; the row under
  // it has its own, useRowKeys): taken and dropped, so they never answer a session open
  // beside it; with the focus in that panel they are the panel's.
  const drop = () => (inPanel() ? false : undefined);
  useShortcut("inbox.allow", drop, { enabled: !keys[cursor], priority: 1 });
  useShortcut("inbox.deny", drop, { enabled: !keys[cursor], priority: 1 });
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
  // A phone unfolded, folded or turned: the prompt being read stays where it was under the
  // bar (lib/resizeAnchor.ts).
  useResizeAnchor({
    rows: ".inbox-row[data-flip]",
    key: "data-flip",
    root: () => page.current,
    barBottom: pageBarBottom(() => page.current),
  });

  // Why Allow / Deny are off, reported by each answerable row and said once for all, each
  // in a notice of its own above Notifications: this device not approved, with the way to
  // approve it; a computer that has not added it, the same way on; anything else, alone.
  const [reasons, setReasons] = useState<Record<string, Off>>({});
  const report = useCallback((id: string, off: Off | null) => {
    setReasons((prev) => {
      const was = prev[id];
      if (
        was?.reason === off?.reason &&
        was?.tag === off?.tag &&
        was?.approve === off?.approve &&
        was?.sentence === off?.sentence &&
        was?.machine === off?.machine
      )
        return prev;
      const next = { ...prev };
      if (off) next[id] = off;
      else delete next[id];
      return next;
    });
  }, []);
  const offs = answer.map((h) => reasons[h.key]).filter((x): x is Off => !!x);
  const unapproved = offs.some((o) => o.tag === "unapproved");
  const said = [...new Map(offs.filter((o) => o.tag !== "unapproved").map((o) => [o.reason, o])).values()];

  const bgMenu = useBackgroundMenu(
    () => [
      app
        ? {
            label: "Notify me",
            checked: app.enabled && app.status === "granted",
            disabled: app.status === "denied" ? `Off for sessionpipe in ${app.where}` : undefined,
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
      { label: "Notification sounds…", run: () => openSettings("notifications") },
      { sep: true },
      ...lensMenu(lens, simple),
    ],
    { title: () => "Inbox" },
  );

  // A prompt with an answer out (or closed) keeps its row, and needs no answer any more.
  const asked = useMemo(() => answer.map((h) => h.item.attention), [answer]);
  const answered = useAnswersOut(asked);
  const needs = answer.filter((h) => !answered[h.item.attention.attentionId]).length;
  const meta = [
    needs > 0 && `${needs} ${needs === 1 ? "needs" : "need"} an answer`,
    terminal.length > 0 && `${terminal.length} waiting in a terminal`,
  ]
    .filter(Boolean)
    .join(" · ");

  // The count is what still needs it: a row with its answer out says so, and counts no more.
  const group = (title: string, list: Held<OpenAttention>[], offset: number, count = list.length) =>
    list.length > 0 && (
      <section className="group inbox-group" aria-label={title}>
        <h2 className="group-head">
          {title}
          {count > 0 && (
            <span key={count} className="group-count num">
              {count}
            </span>
          )}
        </h2>
        <ol className="inbox-rows">
          {list.map((h, i) => (
            <InboxRow
              key={h.key}
              row={h.item}
              gone={h.gone}
              control={h.item.session.machine ? machines.get(h.item.session.machine)?.control : undefined}
              cursor={offset + i === cursor ? cursor : undefined}
              open={h.item.session.key === openKey}
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
        meta={catchingUp ? <BarStatus>{NEW_WORDS.catchingUp}</BarStatus> : meta || undefined}
        connSaid={
          // Before the first snapshot the page itself says where the connection stands
          // (its loading rows, or the state below with its own Retry).
          firstLoad !== null
        }
        tools={
          phone ? (
            <LabelChip value={label} onChange={setLabelFilter} />
          ) : (
            (label || anyLabel(labels)) && (
              <FilterMenu
                on={!!label}
                summary={labelFilterName(labels, label)}
                hint="Filter by label"
                build={() => labelFilterMenu(labels, label, setLabelFilter)}
              />
            )
          )
        }
        actions={
          // In the order drawn: on a computer the lens beside the filter, then the bell;
          // the phone keeps its lens at the bar's trailing edge.
          <>
            {!phone && <LensChip />}
            <NotifyMenu />
            <ComposeButton className="compose-btn--phone" />
            {phone && <LensChip />}
          </>
        }
      />
      {(blocked || unapproved || said.length > 0 || hiddenByLens > 0) && (
        <div className="inbox-notes">
          {unapproved && (
            <Notice
              action={
                <Link to="/add-device" className="btn btn--sm btn--ghost">
                  {setupLabel()}
                </Link>
              }
            >
              {`${NEW_WORDS.answerNotYet(ThisPhone())}.`}
            </Notice>
          )}
          {said.map((o) => (
            <Notice
              key={o.reason}
              action={
                o.approve ? (
                  <Link to="/add-device" className="btn btn--sm btn--ghost">
                    {setupLabel()}
                  </Link>
                ) : undefined
              }
            >
              <span id={reasonId(o.reason)} className="inbox-reason">
                <WithName text={offLine(o)} name={o.machine} />
              </span>
            </Notice>
          ))}
          <NotifyBlocked permission={notify.permission} app={app} />
          <LensNote lens={lens} hidden={hiddenByLens} />
        </div>
      )}
      {firstLoad === "loading" || filling ? (
        <div
          className="skeleton"
          role="status"
          aria-label={behind ? NEW_WORDS.catchingUpSpoken : "Loading"}
          aria-hidden={catchingUp || undefined}
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      ) : firstLoad ? (
        <NoConnection slow={firstLoad === "slow"} />
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
        {group("Needs an answer", answer, 0, needs)}
        {group("Waiting in a terminal", terminal, answer.length)}
      </div>
    </div>
  );
}

/** `a` and `d` while the list cursor is on a row: they are that row's, answered by `answer`
 *  or, where it is null, taken and dropped, so they never fall through to the keys of
 *  another session open beside the page (lib/shortcuts.ts tries inbox.* before session.*).
 *  A row that is not answered here passes them to the panel only where the panel's key
 *  would answer this row's own prompt (`open`, its id, with its session open beside),
 *  shown whole there; never another prompt of that session. With focus inside the panel
 *  they are the panel's. */
function useRowKeys(focused: boolean, answer: ((allow: boolean) => void) | null, open: string | null = null): void {
  const run = (allow: boolean) => () => {
    if (inPanel()) return false;
    if (answer) return void answer(allow);
    if (open && panelAnswers(open, allow)) return false;
  };
  useShortcut("inbox.allow", run(true), { enabled: focused, priority: 2 });
  useShortcut("inbox.deny", run(false), { enabled: focused, priority: 2 });
}

function InboxRow({
  row,
  gone = false,
  control,
  cursor,
  open: beside = false,
  lens = null,
  report,
}: {
  row: OpenAttention;
  /** Cleared while the list held still: faded and inert until the hand leaves. */
  gone?: boolean;
  control?: MachineControl;
  cursor?: number;
  /** Its session is the panel's active tab. */
  open?: boolean;
  lens?: Lens;
  report: (id: string, off: Off | null) => void;
}) {
  const store = useStore();
  const { session: s, attention: raw } = row;
  // Below tier 1 the message and the tool stay on the sending machine.
  const a = lens === 0 ? { ...raw, message: undefined, tool: undefined } : raw;
  const ref = useRef<HTMLLIElement>(null);
  // A click opens the way Settings says (beside, a preview tab the next one replaces), ⇧-click
  // the other way, ⌘-click a kept background tab (lib/split.ts openSession).
  const open = (how: OpenHow) => openSession(s.key, how, { from: ref.current?.getBoundingClientRect() });
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
  const kind = ATTENTION_LABEL[isQuestion(a) ? "question" : a.kind] ?? a.kind;
  const msg = attentionMessage(a);
  // Allow and Deny only beside a request the row shows whole (lib/format.ts askFitsRow);
  // any other, a plan or a long command, offers Open, to the session that shows it whole.
  const whole = askFitsRow(a, s.harness);
  // A prompt in a terminal is answered there: `a` and `d` on its row do nothing here (Answer
  // has the answerable rows' keys), and the panel has no Allow for it to pass them to.
  useRowKeys(cursor !== undefined && !row.answerable, null);
  const titleId = useId();
  // With an answer out the orange glyph is the working ring, or a still hollow one while
  // the computer is offline (Answer says which).
  const [out, setOut] = useState<"going" | "held" | null>(null);
  // A phone's swipes: trailing hides this prompt here (Undo), leading labels its session.
  // Allow and Deny are never a swipe: they are signed, and final.
  useSwipe(ref, {
    lead: () => openMenu(labelItems(store, [s.key]), ref.current!, { source: "touch", title: "Label" }),
    trail: () => hide(attentionKey(s.key, raw.attentionId), raw.at, { title: sessionTitle(s), session: s.key }),
  });
  return (
    <li
      ref={ref}
      className={`inbox-row ${row.answerable ? `inbox-row--answerable${whole ? "" : " inbox-row--open"}` : "inbox-row--terminal"}`}
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
        onClick={(e) => open(howOf(e))}
        title="Open the session"
        {...prefetchProps(store, s)}
      >
        <span className="inbox-lead">
          {out === "held" ? (
            <span className="dot dot--held" style={{ width: 10, height: 10 }} aria-hidden="true" />
          ) : (
            <StateDot state={out === "going" ? "working" : row.answerable ? "needs_you" : s.state} decorative />
          )}
        </span>
        <span className="inbox-row-head">
          <span className="inbox-title" id={titleId}>
            {sessionTitle(s)}
          </span>
          <LabelDot session={s.key} />
        </span>
        <span className="inbox-age">
          <Ago iso={a.at} />
        </span>
        <span className="inbox-what">
          <span className={`inbox-kind ${a.tool ? "sr-only" : ""}`}>{kind}</span>
          {a.tool && <code className="inbox-tool">{toolLabel(a.tool)}</code>}
          {isQuestion(a) ? (
            <AskedLine s={s} a={a} className="inbox-msg" />
          ) : msg ? (
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
        {/* Its hook stopped waiting: why it is down here, and where it can still be answered. */}
        {row.late && (
          <span className="inbox-late" data-answer="late">
            <WithName text={NEW_WORDS.answerLateLine(s.machine ?? undefined)} name={s.machine} />
          </span>
        )}
      </button>
      {/* A prompt in a terminal has nothing to press here; its section says where it waits. */}
      {row.answerable && (
        <Answer
          row={row}
          whole={whole}
          onOpen={open}
          titleId={titleId}
          control={control}
          focused={cursor !== undefined}
          beside={beside}
          into={answerMenu}
          report={report}
          onOut={setOut}
        />
      )}
    </li>
  );
}

/** Allow / Deny for one answerable prompt, through the same signed send as the session
 *  page; disabled when nothing can go (control/useSend.ts answerState), the reason said
 *  once under the page bar. The row's menu gets the same two as items. A press answers in
 *  the same frame: the pressed one turns into "Allowing…" (its spinner, its width held)
 *  and the other steps back, through the passkey and the send. Once the answer is out
 *  (from here or anywhere) the receipt takes the pair's place, "Allowed · waiting for
 *  studio-mac", until the machine clears the prompt and the row leaves. A refused send, or
 *  an answer the machine refused, gives both back. Beside a request the row does not show
 *  whole, one Open in the pair's place, as the row's tap: no menu items, `a` and `d` do
 *  nothing, never off, and no reason under the page bar but the one a device not approved
 *  is told. */
function Answer({
  row,
  whole,
  onOpen,
  titleId,
  control,
  focused = false,
  beside = false,
  into,
  report,
  onOut,
}: {
  row: OpenAttention;
  /** The row shows the whole request (lib/format.ts askFitsRow): Allow and Deny, else Open. */
  whole: boolean;
  /** What a tap on the row does: the session beside the page, or pushed on a phone. */
  onOpen: (how: OpenHow) => void;
  /** The id of the row's title, which Open is described by. */
  titleId: string;
  control?: MachineControl;
  /** The row under the list cursor: it takes `a` and `d` (useRowKeys). */
  focused?: boolean;
  /** Its session is open beside the page: what the row does not answer, the panel does,
   *  where its key would answer this prompt (useRowKeys). */
  beside?: boolean;
  into: MutableRefObject<MenuList>;
  report: (id: string, off: Off | null) => void;
  /** An answer is out ("going"), to a computer that is offline ("held"), or none is. */
  onOut: (out: "going" | "held" | null) => void;
}) {
  const { session: s, attention: a } = row;
  // This row's prompt only: what became of an answer to another prompt of the session (a
  // refusal, `send.error`) is that prompt's row's to say.
  const send = useSessionSend(
    s,
    control,
    useMemo(() => [a], [a]),
  );
  // No clock of its own: the row leaves this group as its window runs out (useOpenAttentions).
  const st = answerState(s, a, control, send, Date.now());
  const { reason, off, status, tag, approve, sentence, receipt } = st;
  // A plan review's pair asks the plan's question (lib/format.ts isPlanReview).
  const plan = isPlanReview(a);
  /** The answer pressed here, from the press until it is out (or the send fails). */
  const [chosen, setChosen] = useState<boolean | null>(null);
  /** Pressed here: the receipt takes the focus the pressed button had. */
  const pressed = useRef(false);
  const answer = (allow: boolean) => {
    if (chosen !== null) return;
    pressed.current = true;
    setChosen(allow);
    void send.onSend({ kind: "permission.answer", attentionId: a.attentionId, allow }).catch(() => {
      pressed.current = false;
      setChosen(null);
    });
  };
  // Out, or closed: from here on the prompt's own state says it, and a refusal of the answer
  // that went brings both buttons back.
  useEffect(() => {
    if (status) setChosen(null);
  }, [status]);
  const decision = send.answers[a.attentionId]?.decision;
  const picked = chosen ?? (decision ? decision === "allow" : null);
  // Pending from the press until the answer is out.
  const going = chosen !== null && !status;
  const lead = status === "sent" ? (control?.online === false ? "held" : "going") : null;
  useEffect(() => onOut(lead), [lead, onOut]);
  useEffect(() => () => onOut(null), [onOut]);
  // The row's own answer on its way is nobody else's to send again.
  useRowKeys(
    focused,
    whole && !off && chosen === null ? answer : null,
    beside && chosen === null ? a.attentionId : null,
  );
  // Off for a standing reason (not paired, no passkeys here, not approved): the page says
  // it once, for the rows that show Allow and Deny. A moment's state (sent, a passkey
  // prompt, closed) stays on the row. Not approved, an Open row has no Open either, and
  // the page's notice is its way on: that one it reports too.
  const offFor = off && !status ? reason : null;
  // Off an account, this computer trusts no key of this device: its own rows say so, as the
  // composer does, with the way to approve it, and the page does not (another computer's
  // rows answer as ever).
  const untrusted = tag === "unapproved" && send.sendable.kind === "catching-up";
  const standing = (whole || tag === "unapproved") && !untrusted ? offFor : null;
  const id = rowKey(row);
  useEffect(() => {
    report(
      id,
      standing ? { reason: standing, tag, approve: !!approve, sentence: !!sentence, machine: s.machine } : null,
    );
  }, [id, standing, tag, approve, sentence, s.machine, report]);
  useEffect(() => () => report(id, null), [id, report]);
  useLayoutEffect(() => {
    into.current = whole ? answerItems(a.tool, st, answer, INBOX_KEYS) : [];
  });
  const noteId = useId();
  const note = send.error ? (
    <span className="inbox-note inbox-note--err" id={noteId}>
      {send.error}
    </span>
  ) : untrusted && reason ? (
    <span className="inbox-note" id={noteId}>
      <WithName text={`${reason}.`} name={s.machine} />{" "}
      <Link to="/add-device" className="inbox-note-way">
        {setupLabel()}
      </Link>
    </span>
  ) : reason && !offFor ? (
    <span className="inbox-note" id={noteId}>
      <WithName text={reason} name={s.machine} />
    </span>
  ) : null;
  // What the buttons are described by: the row's line, and the page's line for a standing reason.
  const describedBy =
    [note ? noteId : null, standing ? reasonId(standing) : null].filter(Boolean).join(" ") || undefined;
  return (
    <span
      className="inbox-answer"
      data-answer={tag}
      data-chosen={picked === null ? undefined : picked ? "allow" : "deny"}
    >
      {receipt ? (
        <span
          className="inbox-receipt"
          role="status"
          aria-live="polite"
          tabIndex={-1}
          ref={(el) => {
            // The pressed button went with the pair: its focus comes here.
            if (!el || !pressed.current) return;
            pressed.current = false;
            const at = document.activeElement;
            if (!at || at === document.body) el.focus({ preventScroll: true });
          }}
        >
          <span className="inbox-receipt-what">{receipt.what}</span>
          <WithName text={receipt.text.slice(receipt.what.length)} name={s.machine} />
        </span>
      ) : (
        note
      )}
      {/* Not approved: no pair at all (the page's notice, or off an account the row's line, has
          the way on); the row still opens. */}
      {!status && tag !== "unapproved" && !whole && (
        // Deny's face: it answers nothing, it opens the session where the request is whole.
        // Described by the row's title, so a list of them does not read as one Open after another.
        <button
          type="button"
          className="btn btn--sm inbox-open"
          aria-describedby={titleId}
          onClick={(e) => onOpen(howOf(e))}
        >
          {NEW_WORDS.inboxOpen}
        </button>
      )}
      {!status && tag !== "unapproved" && whole && (
        <>
          <ActionButton
            className="btn btn--sm btn--deny"
            disabled={(off && chosen === null) || chosen === true}
            pending={going && chosen === false}
            pendingLabel={plan ? "Sending…" : "Denying…"}
            onClick={() => answer(false)}
            aria-describedby={describedBy}
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
            aria-describedby={describedBy}
            aria-pressed={chosen === true || undefined}
          >
            {plan ? "Approve plan" : "Allow"}
          </ActionButton>
        </>
      )}
    </span>
  );
}
