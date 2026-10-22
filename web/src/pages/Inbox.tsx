// SPDX-License-Identifier: Apache-2.0
// The inbox: every open attention across all sessions and machines, newest first, as
// Mail lays out a mailbox: rows in two groups, the prompts a control answer can reach
// (Allow / Deny, the same signed send as the session page, control/useSend.ts) and the
// ones waiting in a terminal. A row click opens its session beside the page; rows leave
// as the stream clears them. "Notify me" and the sounds sit in the page bar; why the
// buttons are off (the machine is not paired, this page cannot use passkeys) is said
// once under the bar, not on every row.
import type { MachineControl } from "@shared/api";
import { type MutableRefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Ago, HarnessGlyph, Redacted, StateDot } from "../components/bits";
import { type MenuList, useContextMenu } from "../components/ContextMenu";
import { LabelChip, LabelDot, useLabelKeys } from "../components/LabelDot";
import { LensChip, LensNote } from "../components/LensChip";
import { NotifyToggle } from "../components/NotifyToggle";
import { PageBar } from "../components/PageBar";
import { answerItems, lensMenu, useBackgroundMenu, useStickyTop } from "../components/SessionCard";
import { answerState, useSessionSend } from "../control/useSend";
import { type OpenAttention, useAppState, useLabels, useOpenAttentions, useStore } from "../data/hooks";
import { ATTENTION_LABEL, attentionMessage, oneLine, sessionTitle } from "../lib/format";
import { useListNav } from "../lib/keys";
import { type LabelFilter, labelPasses } from "../lib/labels";
import { copyItem, sessionItems, sessionMenuSubtitle, sessionMenuTitle } from "../lib/menus";
import { setNotifyPref, useNotifyPref } from "../lib/notify";
import { Link, navigate, sessionPath } from "../lib/router";
import { type Lens, useAppSettings, useLens } from "../lib/settings";
import { useShortcut } from "../lib/shortcuts";
import { openSplit } from "../lib/split";

const rowKey = (r: OpenAttention) => `${r.session.key}|${r.attention.attentionId}`;

export function Inbox() {
  const all = useOpenAttentions();
  const labels = useLabels();
  const [label, setLabelFilter] = useState<LabelFilter>("");
  const rows = useMemo(() => all.filter((r) => labelPasses(labels, r.session.key, label)), [all, labels, label]);
  const { machines, snapshotAt, connection } = useAppState();
  const answer = useMemo(() => rows.filter((r) => r.answerable), [rows]);
  const terminal = useMemo(() => rows.filter((r) => !r.answerable), [rows]);
  const ordered = useMemo(() => [...answer, ...terminal], [answer, terminal]);
  const hrefs = useMemo(() => ordered.map((r) => sessionPath(r.session.harness, r.session.id)), [ordered]);
  const keys = useMemo(() => ordered.map((r) => r.session.key), [ordered]);
  const { cursor } = useListNav(hrefs, true, keys);
  // ⌥⌘1 … ⌥⌘7 label the session under the cursor, ⌥⌘0 clears it.
  useLabelKeys(() => (keys[cursor] ? [keys[cursor]!] : []));
  // The tier lens: attention messages and tool names travel at tier 1 (lib/tier.ts).
  const lens = useLens();
  const simple = useAppSettings().mode === "simple";
  const hiddenByLens = lens === 0 ? rows.filter((r) => r.attention.message || r.attention.tool).length : 0;
  const notify = useNotifyPref();
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
  const said = [...new Set(answer.map((r) => reasons[rowKey(r)]).filter((x): x is string => !!x))];

  const bgMenu = useBackgroundMenu(
    () => [
      {
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

  const group = (title: string, list: OpenAttention[], offset: number) =>
    list.length > 0 && (
      <section className="group inbox-group" aria-label={title}>
        <h2 className="group-head">
          {title}
          <span className="group-count num">{list.length}</span>
        </h2>
        <ol className="inbox-rows">
          {list.map((r, i) => (
            <InboxRow
              key={rowKey(r)}
              row={r}
              control={r.session.machine ? machines.get(r.session.machine)?.control : undefined}
              cursor={offset + i === cursor ? cursor : undefined}
              lens={lens}
              report={report}
            />
          ))}
        </ol>
      </section>
    );

  const blocked =
    notify.permission === "denied"
      ? "Notifications are blocked for this site in the browser's settings."
      : notify.permission === "unsupported"
        ? "Notifications are not available in this browser."
        : null;

  return (
    <div className="page inbox" ref={page} {...bgMenu}>
      <PageBar
        title="Inbox"
        className="inbox-head"
        meta={meta || undefined}
        tools={<LabelChip value={label} onChange={setLabelFilter} />}
        actions={
          <>
            <NotifyToggle compact />
            <Link to="/settings?section=notifications" className="btn btn--ghost btn--sm inbox-link">
              Sounds
            </Link>
            <LensChip />
          </>
        }
      />
      {(blocked || said.length > 0 || hiddenByLens > 0) && (
        <div className="inbox-notes">
          {blocked && <p className="page-note notify-hint">{blocked}</p>}
          {said.map((r) => (
            <p key={r} className="page-note inbox-reason">
              Allow and Deny are off: {r}.
            </p>
          ))}
          <LensNote lens={lens} hidden={hiddenByLens} />
        </div>
      )}
      {!snapshotAt ? (
        connection === "live" || connection === "connecting" ? (
          <div className="skeleton" role="status" aria-label="Loading">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton-row" />
            ))}
          </div>
        ) : (
          <div className="state">
            <p className="state-title">No connection to the receiver</p>
            <p className="state-text">Prompts show up here as soon as the stream is back.</p>
          </div>
        )
      ) : rows.length === 0 && label ? (
        <div className="state">
          <p className="state-title">Nothing with this label needs you</p>
          <p className="state-text">Prompts from sessions with other labels are hidden.</p>
          <button type="button" className="btn" onClick={() => setLabelFilter("")}>
            Show all labels
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="state inbox-empty">
          <p className="state-title">Nothing needs you</p>
          <p className="state-text">Prompts, questions and errors from every session land here.</p>
        </div>
      ) : (
        <div className="inbox-list">
          {group("Needs an answer", answer, 0)}
          {group("Waiting in a terminal", terminal, answer.length)}
        </div>
      )}
    </div>
  );
}

function InboxRow({
  row,
  control,
  cursor,
  lens = null,
  report,
}: {
  row: OpenAttention;
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
        extra: [copyItem("Copy message", raw.message)],
      }),
    ],
    { title: () => sessionMenuTitle(s), subtitle: () => sessionMenuSubtitle(s) },
  );
  const kind = ATTENTION_LABEL[a.kind] ?? a.kind;
  return (
    <li
      ref={ref}
      className={`inbox-row ${row.answerable ? "inbox-row--answerable" : "inbox-row--terminal"}`}
      data-attention={a.attentionId}
      data-session={s.key}
      data-cursor={cursor !== undefined ? String(cursor) : undefined}
      aria-current={cursor !== undefined ? "true" : undefined}
      {...menu}
    >
      <button
        type="button"
        className="inbox-main"
        data-nav-item=""
        onClick={(e) => open(e.metaKey || e.ctrlKey)}
        title="Open the session beside this page"
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
          {a.tool && <code className="inbox-tool">{a.tool}</code>}
          {a.message ? (
            <span className={`inbox-msg ${a.tool && a.kind === "permission" ? "mono" : ""}`}>
              <Redacted text={oneLine(attentionMessage(a) ?? a.message, 200)} />
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
      {row.answerable ? (
        <Answer row={row} control={control} focused={cursor !== undefined} into={answerMenu} report={report} />
      ) : (
        <span className="inbox-answer inbox-answer--terminal">In the terminal</span>
      )}
    </li>
  );
}

/** Allow / Deny for one answerable prompt, through the same signed send as the session
 *  page; disabled when nothing can go (control/useSend.ts answerState), the reason said
 *  once under the page bar. The row's menu gets the same two as items. */
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
  const answer = (allow: boolean) =>
    void send.onSend({ kind: "permission.answer", attentionId: a.attentionId, allow }).catch(() => {});
  // The inbox row wins over a session open beside the page (priority 2 > the panel's 0).
  const canKey = focused && !off && status !== "closed";
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
    <span className="inbox-answer" data-answer={tag}>
      {note}
      {status !== "closed" && (
        <>
          <button
            type="button"
            className="btn btn--sm btn--deny"
            disabled={off}
            onClick={() => answer(false)}
            aria-description={standing ?? undefined}
          >
            Deny
          </button>
          <button
            type="button"
            className="btn btn--sm btn--allow"
            disabled={off}
            onClick={() => answer(true)}
            aria-description={standing ?? undefined}
          >
            Allow
          </button>
        </>
      )}
    </span>
  );
}
