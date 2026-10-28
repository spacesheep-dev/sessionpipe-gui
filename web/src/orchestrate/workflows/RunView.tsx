// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. One run (UX-SPEC §4.3): the input, then every step of the
// plan as a row with its one glyph, its agent and machine (and its session's title once
// known), its right column (what it waits for, "running 40 s", its span) and at most one
// second line: the activity's status while it starts, the failure's words, or the line
// that says what the run waits for, "Waiting for a signer. Open this page on a device that
// can sign." (with Unlock now where this page could sign once its passkey is taken). A
// done step folds its reply under "Show the reply". The bar reads the run's state,
// offers Cancel while it is live, and Run again once it is over. Rows keep their place;
// the spinner is the only motion; elapsed ticks on the shared clock.
import type { ControlActivity, SessionKey, WorkflowRun } from "@shared/api";
import { splitKey } from "@shared/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ago, EmptyState, Since } from "../../components/bits";
import { confirmAction, type MenuList, MoreButton, useContextMenu } from "../../components/ContextMenu";
import { Markdown } from "../../components/Markdown";
import { BackButton, PageBar } from "../../components/PageBar";
import { sendCommand } from "../../control/command";
import { useControlActivity, useGrant, useRpId } from "../../control/hooks";
import { promptFailureWords } from "../../control/Starting";
import { canSign, unlock, useOwnKeys } from "../../control/signer";
import { harnessCommand, sentLine, startFailureWords } from "../../control/words";
import { useAppState, useMachines } from "../../data/hooks";
import { harnessMark, sessionTitle } from "../../lib/format";
import { useListNav } from "../../lib/keys";
import { copyText } from "../../lib/menus";
import { Link, navigate, sessionPath } from "../../lib/router";
import { actionById, useShortcut } from "../../lib/shortcuts";
import { openSplit } from "../../lib/split";
import { cancelRun, copyRunLink, deleteRun, runAgain, runPath, workflowPath } from "./actions";
import { Chevron, StatusGlyph } from "./glyphs";
import { markMine, useMine } from "./mine";
import { unsignable } from "./runner";
import { useWorkflowsState } from "./state";
import { machineNameOf, runLive, runMetaWords, stepHarness, stepName, stepRowWords } from "./words";

const PHONE = "(max-width: 839px)";

export function RunView({ id }: { id: string }) {
  const { runs, workflows, loaded } = useWorkflowsState();
  const run = runs.find((r) => r.id === id);
  if (!run) {
    if (!loaded)
      return (
        <div className="page page--doc page--grouped workflows" aria-busy="true">
          <PageBar title="Workflows" back={<BackButton onClick={() => navigate("/workflows")} label="Workflows" />} />
        </div>
      );
    return (
      <div className="page page--doc page--grouped workflows">
        <PageBar title="Not found" back={<BackButton onClick={() => navigate("/workflows")} label="Workflows" />} />
        <EmptyState
          title="This run doesn't exist"
          actions={
            <Link to="/workflows" className="btn">
              Workflows
            </Link>
          }
        >
          It may have been deleted.
        </EmptyState>
      </div>
    );
  }
  return <RunBody run={run} hasWorkflow={workflows.some((w) => w.id === run.workflowId)} />;
}

function RunBody({ run, hasWorkflow }: { run: WorkflowRun; hasWorkflow: boolean }) {
  const machines = useMachines();
  const { sessions } = useAppState();
  const machineName = useMemo(() => machineNameOf(machines), [machines]);
  const phone = typeof matchMedia === "function" && matchMedia(PHONE).matches;
  const live = runLive(run);

  // This page's own signing: whether the signer line can offer Unlock now, or Sign here
  // (a run this browser did not start is never signed here unasked, mine.ts), and the
  // keys the step's machine would have to trust.
  const rp = useRpId();
  const secure = canSign(rp);
  const grant = useGrant(live ? rp : null);
  const needsUnlock = live && secure && grant.exp === null;
  const signsFor = useMine();
  const elsewhere = live && secure && !signsFor.has(run.id);
  const own = useOwnKeys(live && secure ? rp : null);
  const ownIds = useMemo(() => new Set(own.map((k) => k.id)), [own]);
  const signHere = async () => {
    markMine(run.id);
    if (grant.exp !== null || !rp) return;
    try {
      await unlock(rp);
    } catch {
      // dismissed: the line stays
    }
    grant.refresh();
  };

  // The activity of the steps' commands, for the status line under a step on its way.
  const ids = useMemo(
    () => new Set(Object.values(run.steps).flatMap((s) => (s.commandId ? [s.commandId] : []))),
    [run.steps],
  );
  const mine = useCallback((a: ControlActivity) => ids.has(a.id), [ids]);
  const activity = useControlActivity(mine);
  const byCommand = useMemo(() => new Map(activity.map((a) => [a.id, a])), [activity]);

  const meta = runMetaWords(run, machineName);
  useEffect(() => {
    document.title = `${run.name} · ${meta.text} · sessionpipe gui`;
  }, [run.name, meta.text, meta.live]);

  const back = () => navigate(hasWorkflow ? workflowPath(run.workflowId) : "/workflows");
  const cancel = () => cancelRun(run, machines, secure);
  useShortcut("workflow.cancel", () => (live ? void cancel() : false));
  // shift+c cancels, read on the page's root until the keymap declares `workflow.cancel`.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !live) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.key.toLowerCase() !== "c" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (actionById("workflow.cancel")) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      void cancel();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  });
  const more = (): MenuList => [
    { label: "Open the workflow", disabled: !hasWorkflow, run: () => navigate(workflowPath(run.workflowId)) },
    !live && { label: "Run again", disabled: !hasWorkflow, run: () => runAgain(run) },
    { label: "Copy link", run: () => copyRunLink(run.id) },
    { sep: true },
    {
      label: "Delete…",
      danger: true,
      run: () => void deleteRun(run, { leave: hasWorkflow ? workflowPath(run.workflowId) : "/workflows" }),
    },
  ];

  // The rows walk with the arrows; Enter opens the step's session where there is one.
  const hrefs = run.plan.map((s) => {
    const key = run.steps[s.id]?.session;
    return key ? sessionPath(splitKey(key).harness, splitKey(key).id) : runPath(run.id);
  });
  const keys = run.plan.map((s) => run.steps[s.id]?.session ?? "");
  const { cursor } = useListNav(hrefs, true, keys);

  return (
    <div className="page page--doc page--grouped workflows" ref={rootRef} data-wf-run-view>
      <PageBar
        title={run.name}
        large={false}
        back={<BackButton onClick={back} label={hasWorkflow ? run.name : "Workflows"} />}
        meta={
          <span className={`wf-bar-meta ${meta.tone === "needs" ? "is-needs" : ""}`} role="status" aria-live="polite">
            {meta.text}
            {meta.live ? (
              <>
                {" "}
                <Ago iso={run.startedAt} />
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            {live && (
              <button
                type="button"
                className={phone ? "btn btn--ghost" : "btn"}
                onClick={() => void cancel()}
                data-wf-cancel
              >
                Cancel
              </button>
            )}
            <MoreButton build={more} label="More actions" title={() => run.name} />
          </>
        }
      />
      {run.input !== undefined && (
        <div className="wf-kv">
          <span className="form-key">Input</span>
          <span className="form-kv">{run.input}</span>
        </div>
      )}
      <ol className="wf-run-steps" aria-label="Steps">
        {run.plan.map((step, i) => (
          <StepRow
            key={step.id}
            run={run}
            i={i}
            activity={run.steps[step.id]?.commandId ? byCommand.get(run.steps[step.id]!.commandId!) : undefined}
            machineName={machineName}
            machines={machines}
            sessions={sessions}
            needsUnlock={needsUnlock}
            elsewhere={elsewhere}
            onSignHere={signHere}
            ownIds={ownIds}
            rp={rp}
            onUnlocked={grant.refresh}
            secure={secure}
            cursor={cursor === i ? String(i) : undefined}
          />
        ))}
      </ol>
    </div>
  );
}

function StepRow({
  run,
  i,
  activity,
  machineName,
  machines,
  sessions,
  needsUnlock,
  elsewhere,
  onSignHere,
  ownIds,
  rp,
  onUnlocked,
  secure,
  cursor,
}: {
  run: WorkflowRun;
  i: number;
  activity: ControlActivity | undefined;
  machineName: (id: string) => string | undefined;
  machines: ReturnType<typeof useMachines>;
  sessions: ReadonlyMap<SessionKey, { harness: string; id: string } & Parameters<typeof sessionTitle>[0]>;
  needsUnlock: boolean;
  /** This page could sign, but the run was not started here: Sign here. */
  elsewhere: boolean;
  onSignHere: () => void;
  /** The ids of the keys this page signs with. */
  ownIds: ReadonlySet<string>;
  rp: string | null;
  onUnlocked: () => void;
  secure: boolean;
  cursor: string | undefined;
}) {
  const step = run.plan[i]!;
  const s = run.steps[step.id] ?? { status: "pending" as const };
  const machine = machines.find((m) => m.control?.machineId === step.machineId);
  const mname = machine?.name ?? "the machine";
  const harness = stepHarness(step);
  const agent = harnessMark(harness).label;
  const online = !!machine?.control?.online;
  const line = activity
    ? sentLine(activity, { machine: mname, online, command: harnessCommand(harness, agent) })?.text
    : null;
  const failure = activity
    ? activity.kind === "start"
      ? startFailureWords(activity, mname, agent)
      : promptFailureWords(activity, mname)
    : null;
  const control = machine?.control;
  const untrusted = secure && !!control && !control.keys.some((k) => ownIds.has(k.id));
  const cannot = control && secure ? unsignable(step, control, (h) => harnessMark(h).label) : null;
  const words = stepRowWords(run, i, {
    machineName,
    activity,
    sentLine: line,
    failureWords: failure,
    needsUnlock: needsUnlock && !elsewhere,
    elsewhere,
    untrusted,
    unsignable: cannot,
  });
  const key = s.session;
  const session = key ? sessions.get(key) : undefined;
  const title = session ? sessionTitle(session) : key ? undefined : "harness" in step.agent ? "new session" : undefined;
  const facts = [agent, machine?.name, title].filter(Boolean).join(" · ");
  const name = stepName(step, i);
  const [showReply, setShowReply] = useState(false);

  const stop = async () => {
    if (!key || !machine?.control || !rp) return;
    const ok = await confirmAction({
      title: `Stop ${agent}?`,
      body: "Its session keeps what it did so far.",
      action: "Stop",
    });
    if (!ok) return;
    await sendCommand(rp, machine.control.machineId, { kind: "cancel", session: key }).catch(() => {});
  };
  const items = (): MenuList => [
    key && {
      label: "Open the session",
      action: "list.open",
      run: () => navigate(sessionPath(splitKey(key).harness, splitKey(key).id)),
    },
    key && !phoneNow() && { label: "Open beside", action: "list.beside", run: () => openSplit(key) },
    s.status === "done" && s.reply && { label: "Copy the reply", run: () => copyText(s.reply!) },
    s.text && { label: "Copy the prompt", run: () => copyText(s.text!) },
    { sep: true },
    s.status === "sent" && key && !!machine?.control && secure && { label: `Stop ${agent}…`, run: stop },
  ];
  const menu = useContextMenu(items, { title: () => name, subtitle: () => words.right || words.second || "" });
  const inner = (
    <>
      <span className="wf-lead">
        <StatusGlyph glyph={words.glyph} label={s.status} />
      </span>
      <span className="wf-name">{name}</span>
      <span className="wf-facts">{facts}</span>
      <span className={`wf-right ${words.tone === "needs" && !words.second ? "is-needs" : ""}`}>
        {words.live ? (
          <>
            running <Since iso={s.sentAt ?? activity?.at} />
          </>
        ) : (
          words.right
        )}
      </span>
      {key ? (
        <span className="wf-chev" aria-hidden="true">
          ›
        </span>
      ) : null}
    </>
  );
  const unlockNow = async () => {
    if (!rp) return;
    try {
      await unlock(rp);
    } catch {
      // dismissed: the line stays
    }
    onUnlocked();
  };
  return (
    <li className="wf-run-step" data-step={step.id} data-status={s.status} data-cursor={cursor} {...menu}>
      {key ? (
        <Link
          to={sessionPath(splitKey(key).harness, splitKey(key).id)}
          className="wf-row"
          data-nav-item=""
          modClick={({ background }) => openSplit(key, { background })}
        >
          {inner}
        </Link>
      ) : (
        <div className="wf-row" data-nav-item="" tabIndex={-1}>
          {inner}
        </div>
      )}
      {words.second && (
        <p className={`wf-second ${words.tone === "needs" ? "is-needs" : words.tone === "err" ? "is-err" : ""}`}>
          {words.second}
          {words.tone === "needs" && !untrusted && !cannot && elsewhere ? (
            <>
              {" "}
              <button type="button" className="link-btn" onClick={() => void onSignHere()} data-wf-sign-here>
                Sign here
              </button>
            </>
          ) : (
            needsUnlock &&
            !elsewhere &&
            words.tone === "needs" &&
            !untrusted &&
            !cannot && (
              <>
                {" "}
                <button type="button" className="link-btn" onClick={() => void unlockNow()} data-wf-unlock>
                  Unlock now
                </button>
              </>
            )
          )}
        </p>
      )}
      {s.status === "done" && s.reply && (
        <details
          className="chat-tools"
          open={showReply}
          onToggle={(e) => setShowReply((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="chat-tools-sum">
            <Chevron />
            <span>{showReply ? "Hide the reply" : "Show the reply"}</span>
          </summary>
          <div className="chat-card">
            <Markdown text={s.reply} />
          </div>
        </details>
      )}
    </li>
  );
}

const phoneNow = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE).matches;
