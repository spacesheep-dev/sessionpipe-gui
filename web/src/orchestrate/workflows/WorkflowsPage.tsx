// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The Workflows page (DESIGN §3.2, UX-SPEC §4): the list of
// saved workflows, the runs under way and the three templates, as 1-line rows under
// hairlines in the Machines page's column; the editor (Editor.tsx) and the run view
// (RunView.tsx) are the same page at /workflows/:id and /workflows/runs/:id. The page
// reads the workflows and the runs from state.ts (GET once, then the stream); the signer
// (useRunner.ts) lives in the Shell, so a run moves whichever page is open.
import type { Workflow, WorkflowRun } from "@shared/api";
import { useEffect, useMemo } from "react";
import { Ago, Since } from "../../components/bits";
import { type MenuList, useContextMenu } from "../../components/ContextMenu";
import { PageBar } from "../../components/PageBar";
import { useMachines } from "../../data/hooks";
import { harnessMark } from "../../lib/format";
import { useListNav } from "../../lib/keys";
import { Link, navigate } from "../../lib/router";
import { useNow } from "../../lib/time";
import {
  cancelRun,
  copyWorkflowLink,
  deleteRun,
  deleteWorkflow,
  duplicateWorkflow,
  newWorkflowPath,
  renameWorkflow,
  runPath,
  runWorkflow,
  workflowPath,
} from "./actions";
import { WorkflowDialogs } from "./dialogs";
import { Editor } from "./Editor";
import { StatusGlyph, WorkflowGlyph } from "./glyphs";
import { RunView } from "./RunView";
import { reload, useWorkflowsState } from "./state";
import { TEMPLATES } from "./templates";
import type { WorkflowsRouteProps } from "./Workflows";
import { machineNameOf, runGlyph, runLive, runningStep, runRowWords, stepHarness } from "./words";
import "./workflows.css";

export function WorkflowsRoute(p: WorkflowsRouteProps) {
  // The page reads everything once as it opens; the Shell's runner keeps it following.
  useEffect(() => {
    void reload();
  }, []);
  return (
    <>
      {p.view === "list" ? <WorkflowList /> : p.view === "workflow" ? <Editor id={p.id} /> : <RunView id={p.id} />}
      <WorkflowDialogs />
    </>
  );
}

// ----- the list -----

function WorkflowList() {
  const { workflows, runs, loaded, error } = useWorkflowsState();
  const machines = useMachines();
  const now = useNow("coarse");
  const machineName = useMemo(() => machineNameOf(machines), [machines]);
  const live = runs.filter(runLive);
  const hrefs = [
    ...live.map((r) => runPath(r.id)),
    ...workflows.map((w) => workflowPath(w.id)),
    ...TEMPLATES.map((t) => newWorkflowPath(t.id)),
  ];
  const { cursor } = useListNav(hrefs);
  const at = (i: number) => (cursor === i ? String(i) : undefined);
  const lastRunOf = (w: Workflow): WorkflowRun | undefined => runs.find((r) => r.workflowId === w.id);
  return (
    <div className="page page--doc page--grouped workflows">
      <PageBar
        title="Workflows"
        actions={
          <Link to={newWorkflowPath()} className="btn" data-wf-new>
            New workflow…
          </Link>
        }
      />
      {error && loaded && workflows.length === 0 && (
        <p className="page-note is-err">Couldn't read the workflows: {error}</p>
      )}
      {loaded && !error && workflows.length === 0 && (
        <p className="page-note">
          Chain steps across your agents and machines. Start from a template, or make your own.
        </p>
      )}
      {live.length > 0 && (
        <section className="wf-group" aria-label="Running">
          <h2 className="wf-head">
            Running <span className="group-count num">{live.length}</span>
          </h2>
          <ul className="wf-list">
            {live.map((r, i) => (
              <RunningRow key={r.id} run={r} machineName={machineName} cursor={at(i)} />
            ))}
          </ul>
        </section>
      )}
      {workflows.length > 0 && (
        <section className="wf-group" aria-label="Saved">
          <h2 className="wf-head">
            Saved <span className="group-count num">{workflows.length}</span>
          </h2>
          <ul className="wf-list">
            {workflows.map((w, i) => (
              <WorkflowRow
                key={w.id}
                w={w}
                last={lastRunOf(w)}
                machineName={machineName}
                now={now}
                cursor={at(live.length + i)}
              />
            ))}
          </ul>
        </section>
      )}
      <section className="wf-group" aria-label="Templates">
        <h2 className="wf-head">Templates</h2>
        <ul className="wf-list">
          {TEMPLATES.map((t, i) => (
            <TemplateRow
              key={t.id}
              id={t.id}
              name={t.name}
              line={t.line}
              cursor={at(live.length + workflows.length + i)}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function RunningRow({
  run,
  machineName,
  cursor,
}: {
  run: WorkflowRun;
  machineName: (id: string) => string | undefined;
  cursor: string | undefined;
}) {
  const machines = useMachines();
  const items = (): MenuList => [
    { label: "Open", action: "list.open", run: () => navigate(runPath(run.id)) },
    { label: "Cancel…", run: () => cancelRun(run, machines, true) },
    { sep: true },
    { label: "Delete…", danger: true, run: () => void deleteRun(run) },
  ];
  const words = runRowWords(run, machineName);
  const menu = useContextMenu(items, { title: () => run.name, subtitle: () => words.text });
  const current = runningStep(run);
  const sent = current ? run.steps[current.step.id] : undefined;
  const facts = current
    ? `${current.step.name ?? `Step ${current.i + 1}`} · ${harnessMark(stepHarness(current.step)).label}`
    : "";
  return (
    <li className="wf-item" data-cursor={cursor} data-run={run.id} {...menu}>
      <Link to={runPath(run.id)} className="wf-row" data-nav-item="">
        <span className="wf-lead">
          <StatusGlyph glyph={runGlyph(run)} label={words.text} />
        </span>
        <span className="wf-name">{run.name}</span>
        <span className="wf-facts">
          {facts}
          {facts ? " · " : ""}
          {run.status === "running" && sent?.status === "sent" ? (
            <>
              running <Since iso={sent.sentAt} />
            </>
          ) : (
            <span className={words.tone === "needs" ? "is-needs" : undefined}>{words.text}</span>
          )}
        </span>
        <span className="wf-right">
          <Ago iso={run.startedAt} />
        </span>
        <span className="wf-chev" aria-hidden="true">
          ›
        </span>
      </Link>
    </li>
  );
}

function WorkflowRow({
  w,
  last,
  machineName,
  now,
  cursor,
}: {
  w: Workflow;
  last: WorkflowRun | undefined;
  machineName: (id: string) => string | undefined;
  now: number;
  cursor: string | undefined;
}) {
  void now;
  const items = (): MenuList => [
    { label: "Open", action: "list.open", run: () => navigate(workflowPath(w.id)) },
    { label: "Run…", keys: "⌘↩", run: () => runWorkflow(w) },
    { sep: true },
    { label: "Duplicate", run: () => duplicateWorkflow(w) },
    { label: "Rename…", run: () => renameWorkflow(w) },
    { sep: true },
    { label: "Copy link", run: () => copyWorkflowLink(w.id) },
    { sep: true },
    { label: "Delete…", danger: true, run: () => void deleteWorkflow(w) },
  ];
  const menu = useContextMenu(items, { title: () => w.name });
  const where = [...new Set(w.steps.map((s) => machineName(s.machineId) ?? "not paired"))].join(", ");
  const n = w.steps.length;
  const lastWords = last ? `last run ${runRowWords(last, machineName).text}` : "never run";
  return (
    <li className="wf-item" data-cursor={cursor} data-workflow={w.id} {...menu}>
      <Link to={workflowPath(w.id)} className="wf-row" data-nav-item="">
        <span className="wf-lead">
          <WorkflowGlyph />
        </span>
        <span className="wf-name">{w.name}</span>
        <span className="wf-facts">
          {n} {n === 1 ? "step" : "steps"}
          {where ? ` · ${where}` : ""} · {lastWords}
        </span>
        <span className="wf-right">{last ? <Ago iso={last.startedAt} /> : null}</span>
        <span className="wf-chev" aria-hidden="true">
          ›
        </span>
      </Link>
    </li>
  );
}

function TemplateRow({
  id,
  name,
  line,
  cursor,
}: {
  id: string;
  name: string;
  line: string;
  cursor: string | undefined;
}) {
  const to = newWorkflowPath(id);
  const menu = useContextMenu(() => [{ label: "Use this template", action: "list.open", run: () => navigate(to) }], {
    title: () => name,
  });
  return (
    <li className="wf-item" data-cursor={cursor} data-template={id} {...menu}>
      <Link to={to} className="wf-row" data-nav-item="">
        <span className="wf-lead">
          <WorkflowGlyph />
        </span>
        <span className="wf-name">{name}</span>
        <span className="wf-facts">{line}</span>
        <span className="wf-chev" aria-hidden="true">
          ›
        </span>
      </Link>
    </li>
  );
}
