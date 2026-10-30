// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The editor (UX-SPEC §4.2): the name and the input's label as
// rows, then the steps as a list with one open at a time, each open step the sheet's rows
// (Agent: machine › harness or session, from the snapshot's machines and their hellos;
// Folder; the prompt with its placeholder hint; the options the hello offers; Runs
// after as check items and chips), Add step, and the workflow's runs under it. Autosave:
// every change is PUT whole 600 ms after the last keystroke, the bar's meta saying Saved ·
// Saving… · Unsaved · Couldn't save: <why>; there is no Save button. A new workflow or a
// template's copy is a draft (state.ts) until its first save. Run saves first, asks for
// the input when the workflow names one, and opens the run.
import {
  type MachineSummary,
  type RunLevel,
  type SessionSummary,
  type StartPermission,
  validModel,
  WORKFLOW_TEXT_MAX,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from "@shared/api";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionButton, Ago, EmptyState, HarnessGlyph } from "../../components/bits";
import { type MenuList, MoreButton, useContextMenu } from "../../components/ContextMenu";
import { BackButton, PageBar } from "../../components/PageBar";
import { MultiSelect, Select, type SelectOption } from "../../components/Select";
import { folderChoices, machineHome, tildify, typedFolder } from "../../control/folders";
import { fixedPermission, permissionChoices } from "../../control/newSessionState";
import { PERMISSION_LABEL } from "../../control/words";
import { useAppState, useMachines } from "../../data/hooks";
import "../../lib/acp";
import { sessionTitle } from "../../lib/format";
import { Link, navigate, useSearchParam } from "../../lib/router";
import { actionById, useShortcut } from "../../lib/shortcuts";
import { useNow } from "../../lib/time";
import { pushUndo } from "../../lib/toasts";
import {
  cancelRun,
  copyWorkflowLink,
  deleteRun,
  deleteWorkflow,
  duplicateWorkflow,
  renameWorkflow,
  runPath,
  runWorkflow,
} from "./actions";
import { agentOptions, agentValue, parseAgentValue } from "./agentPicker";
import { workflowsApi } from "./api";
import { StatusGlyph } from "./glyphs";
import { draft, dropDraft, putDraft, putWorkflow, useWorkflowsState } from "./state";
import { templateById, workflowFromTemplate } from "./templates";
import {
  afterOf,
  afterWords,
  agentWords,
  machineNameOf,
  newStepId,
  newWorkflowId,
  runGlyph,
  runLive,
  runRowWords,
  saveProblem,
  serverSaveWords,
  startedLabel,
  stepName,
} from "./words";

const SAVE_AFTER_MS = 600;
const PHONE = "(max-width: 839px)";

type SaveState = "saved" | "saving" | "unsaved" | { error: string };

/** The page's one local key for an action the keymap may not declare yet: the keymap's
 *  handler runs when it does; this reads the key itself until then. */
const undeclared = (id: string): boolean => !actionById(id);

export function Editor({ id }: { id: string }) {
  const template = useSearchParam("template");
  const machines = useMachines();
  // "new": a fresh draft (a template's copy, or an empty workflow), then its own address.
  useEffect(() => {
    if (id !== "new") return;
    const first = machines.find((m) => m.control);
    const t = template ? templateById(template) : undefined;
    const now = new Date().toISOString();
    const w: Workflow = t
      ? workflowFromTemplate(t, first)
      : { id: newWorkflowId("workflow"), name: "New workflow", steps: [], createdAt: now, updatedAt: now };
    putDraft(w);
    navigate(`/workflows/${encodeURIComponent(w.id)}`, { replace: true });
  }, [id, template, machines]);
  if (id === "new") return <div className="page page--doc page--grouped workflows" aria-busy="true" />;
  return <EditorBody key={id} id={id} />;
}

function EditorBody({ id }: { id: string }) {
  const { workflows, runs, loaded } = useWorkflowsState();
  const saved = workflows.find((w) => w.id === id);
  const [doc, setDoc] = useState<Workflow | null>(() => saved ?? draft(id) ?? null);
  useEffect(() => {
    if (!doc && saved) setDoc(saved);
  }, [doc, saved]);
  if (!doc) {
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
          title="This workflow doesn't exist"
          actions={
            <Link to="/workflows" className="btn">
              Workflows
            </Link>
          }
        >
          It may have been deleted, or never saved.
        </EmptyState>
      </div>
    );
  }
  return <EditorForm doc={doc} setDoc={setDoc} everSaved={!!saved} runs={runs.filter((r) => r.workflowId === id)} />;
}

function usePhone(): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = matchMedia(PHONE);
    const up = () => setOn(mq.matches);
    mq.addEventListener("change", up);
    return () => mq.removeEventListener("change", up);
  }, []);
  return on;
}

function EditorForm({
  doc,
  setDoc,
  everSaved,
  runs,
}: {
  doc: Workflow;
  setDoc: (w: Workflow) => void;
  everSaved: boolean;
  runs: WorkflowRun[];
}) {
  const phone = usePhone();
  const machines = useMachines();
  const { sessions } = useAppState();
  const now = useNow("coarse");
  const paired = useMemo(() => machines.filter((m) => m.control), [machines]);
  const machineName = useMemo(() => machineNameOf(machines), [machines]);
  const rootRef = useRef<HTMLDivElement>(null);

  // ----- the document and its save -----
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(everSaved ? "saved" : "unsaved");
  const [savedOnce, setSavedOnce] = useState(everSaved);
  const docRef = useRef(doc);
  docRef.current = doc;
  const edit = useCallback(
    (fn: (w: Workflow) => Workflow) => {
      const next = fn(docRef.current);
      docRef.current = next;
      setDoc(next);
      if (!savedOnce) putDraft(next);
      setDirty(true);
      setSaveState("unsaved");
    },
    [setDoc, savedOnce],
  );
  const problem = doc.steps.length ? saveProblem(doc) : null;
  const save = useCallback(async (): Promise<boolean> => {
    const w = docRef.current;
    setDirty(false);
    if (w.steps.length === 0) return false;
    const why = saveProblem(w);
    if (why) {
      setSaveState({ error: why });
      return false;
    }
    setSaveState("saving");
    try {
      const answer = await workflowsApi.save(w);
      putWorkflow(answer);
      dropDraft(w.id);
      setSavedOnce(true);
      // Only the server's times come back in: an edit made meanwhile stays.
      const cur = docRef.current;
      const merged = { ...cur, createdAt: answer.createdAt, updatedAt: answer.updatedAt };
      docRef.current = merged;
      setDoc(merged);
      setSaveState((s) => (s === "saving" ? "saved" : s));
      return true;
    } catch (e) {
      setSaveState({ error: serverSaveWords(e) });
      return false;
    }
  }, [setDoc]);
  useEffect(() => {
    if (!dirty) return;
    const t = window.setTimeout(() => void save(), SAVE_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [dirty, doc, save]);

  // ----- the steps: one open -----
  const [open, setOpen] = useState<number | null>(() => (everSaved ? null : doc.steps.length ? 0 : null));
  const addStep = (after: number | null) => {
    const w = docRef.current;
    const i = after === null ? w.steps.length : after + 1;
    const from = w.steps[after ?? w.steps.length - 1];
    const first = paired[0]?.control;
    const step: WorkflowStep = {
      id: newStepId(
        "step",
        w.steps.map((s) => s.id),
      ),
      machineId: from?.machineId ?? first?.machineId ?? "",
      agent: from ? { ...from.agent } : { harness: first?.harnesses?.[0] ?? "claude-code" },
      ...(from?.cwd ? { cwd: from.cwd } : {}),
      text: "",
    };
    edit((d) => ({ ...d, steps: [...d.steps.slice(0, i), step, ...d.steps.slice(i)] }));
    setOpen(i);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>("[data-wf-step-name]")?.focus());
  };
  const setStep = (i: number, fn: (s: WorkflowStep) => WorkflowStep) =>
    edit((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? fn(s) : s)) }));
  /** `after` may only name earlier steps: a move or a removal drops what no longer is. */
  const sane = (steps: WorkflowStep[]): WorkflowStep[] =>
    steps.map((s, i) => {
      if (!s.after) return s;
      const after = s.after.filter((id) => {
        const j = steps.findIndex((x) => x.id === id);
        return j >= 0 && j < i;
      });
      return after.length === s.after.length ? s : after.length ? { ...s, after } : { ...s, after: [] };
    });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= doc.steps.length) return;
    edit((w) => {
      const steps = [...w.steps];
      [steps[i], steps[j]] = [steps[j]!, steps[i]!];
      return { ...w, steps: sane(steps) };
    });
    if (open === i) setOpen(j);
  };
  const remove = (i: number) => {
    const w = docRef.current;
    const gone = w.steps[i]!;
    const before = w.steps;
    edit((d) => ({ ...d, steps: sane(d.steps.filter((_, j) => j !== i)) }));
    if (open === i) setOpen(null);
    else if (open !== null && open > i) setOpen(open - 1);
    pushUndo({
      id: `wf-step|${gone.id}`,
      title: "Step removed",
      undo: () => {
        edit((d) => ({ ...d, steps: before }));
        setOpen(i);
      },
    });
  };
  const duplicate = (i: number) => {
    const w = docRef.current;
    const s = w.steps[i]!;
    const copy: WorkflowStep = {
      ...s,
      id: newStepId(
        s.name ?? s.id,
        w.steps.map((x) => x.id),
      ),
      agent: { ...s.agent },
    };
    delete copy.after;
    edit((d) => ({ ...d, steps: [...d.steps.slice(0, i + 1), copy, ...d.steps.slice(i + 1)] }));
    setOpen(i + 1);
  };

  // ----- run -----
  const [starting, setStarting] = useState(false);
  const runBlocker = !doc.steps.length
    ? "Add a step first."
    : !paired.length
      ? "No machine is paired."
      : problem
        ? `Couldn't save: ${problem}.`
        : null;
  const run = async () => {
    if (runBlocker || starting) return;
    // Pending only while the save is out: the input dialog that follows is the person's.
    setStarting(true);
    try {
      if (dirty || !savedOnce || saveState !== "saved") {
        const ok = await save();
        if (!ok) return;
      }
    } finally {
      setStarting(false);
    }
    await runWorkflow(docRef.current);
  };

  // ----- keys: ⌘↩ Run, ⌥↑/⌥↓ move the open step, Esc closes the open step then goes back -----
  useShortcut("workflow.run", () => void run());
  useShortcut("workflow.stepUp", () => (open === null ? false : move(open, -1)));
  useShortcut("workflow.stepDown", () => (open === null ? false : move(open, 1)));
  useShortcut(
    "back",
    (e) => {
      if (open === null) return false;
      if (e.target instanceof HTMLElement && e.target.closest("[role=listbox], .sel--open")) return false;
      setOpen(null);
    },
    { priority: 2 },
  );
  // The page's keys, read on its root (the keymap's handler runs instead once declared).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "Enter" && undeclared("workflow.run")) {
        e.preventDefault();
        void run();
      } else if (e.altKey && e.key === "ArrowUp" && open !== null && undeclared("workflow.stepUp")) {
        e.preventDefault();
        move(open, -1);
      } else if (e.altKey && e.key === "ArrowDown" && open !== null && undeclared("workflow.stepDown")) {
        e.preventDefault();
        move(open, 1);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  });

  // ----- the bar -----
  const meta = (() => {
    if (typeof saveState === "object") return { text: `Couldn't save: ${saveState.error}.`, tone: "err" as const };
    if (!paired.length) return { text: "Pair a machine to run this." };
    if (saveState === "saving") return { text: "Saving…" };
    if (saveState === "unsaved") return { text: "Unsaved" };
    return { text: "Saved" };
  })();
  const more = (): MenuList => [
    { label: "Run…", keys: "⌘↩", disabled: runBlocker ?? undefined, run: () => void run() },
    { label: "Duplicate", run: () => duplicateWorkflow(docRef.current) },
    {
      label: "Rename…",
      run: async () => {
        await renameWorkflow(docRef.current);
        const d = draft(doc.id);
        if (d && d.name !== docRef.current.name) edit(() => d);
      },
    },
    { label: "Copy link", run: () => copyWorkflowLink(doc.id) },
    { sep: true },
    { label: "Delete…", danger: true, run: () => void deleteWorkflow(docRef.current, { leave: true }) },
  ];
  const runButton = (
    <ActionButton
      className={phone ? "btn btn--ghost wf-run-btn" : "btn btn--primary wf-run-btn"}
      onClick={run}
      disabled={!!runBlocker}
      pending={starting}
      pendingLabel="Starting…"
      data-tip={runBlocker ?? undefined}
      data-tip-side="bottom"
      title={runBlocker ?? undefined}
      data-wf-run
    >
      Run {!phone && <kbd className="wf-kbd">⌘↩</kbd>}
    </ActionButton>
  );

  // ----- the agent pop-up's options -----
  const icon = useCallback((h: string) => <HarnessGlyph name={h} size="sm" />, []);
  const sessionList = useMemo(() => [...sessions.values()], [sessions]);
  const title = useCallback(
    (key: string) => {
      const s = sessions.get(key);
      return s ? sessionTitle(s) : undefined;
    },
    [sessions],
  );

  return (
    <div className="page page--doc page--grouped workflows" ref={rootRef} data-wf-editor>
      <PageBar
        title={doc.name}
        large={false}
        back={<BackButton onClick={() => navigate("/workflows")} label="Workflows" />}
        meta={
          <span className={`wf-bar-meta ${meta.tone === "err" ? "is-err" : ""}`} role="status" aria-live="polite">
            {meta.text}
          </span>
        }
        actions={
          <>
            {runButton}
            <MoreButton build={more} label="More actions" title={() => doc.name} />
          </>
        }
      />
      <div className="wf-form">
        <div className="wf-field">
          <span className="wf-label" id="wf-name">
            Name
          </span>
          <span className="wf-value">
            <input
              className="wf-input"
              aria-labelledby="wf-name"
              value={doc.name}
              onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))}
              autoComplete="off"
              data-wf-name
            />
          </span>
        </div>
        <div className="wf-field">
          <span className="wf-label" id="wf-input">
            Input
          </span>
          <span className="wf-value">
            <input
              className="wf-input"
              aria-labelledby="wf-input"
              value={doc.input?.label ?? ""}
              placeholder="None"
              onChange={(e) => {
                const label = e.target.value;
                edit((d) => {
                  const next = { ...d };
                  if (label.trim()) next.input = { label };
                  else delete next.input;
                  return next;
                });
              }}
              autoComplete="off"
              data-wf-inputlabel
            />
          </span>
          <span className="wf-aside">{doc.input ? "asked for when you press Run" : "takes no input"}</span>
        </div>
      </div>
      <section className="wf-group" aria-label="Steps">
        <h2 className="wf-head">
          Steps <span className="group-count num">{doc.steps.length || ""}</span>
        </h2>
        <ol className="wf-steps">
          {doc.steps.map((s, i) => (
            <StepRow
              key={s.id}
              step={s}
              i={i}
              doc={doc}
              open={open === i}
              onOpen={() => setOpen(open === i ? null : i)}
              set={(fn) => setStep(i, fn)}
              move={(d) => move(i, d)}
              remove={() => remove(i)}
              duplicate={() => duplicate(i)}
              machines={paired}
              machineName={machineName}
              sessions={sessionList}
              title={title}
              icon={icon}
              now={now}
              phone={phone}
            />
          ))}
          <li>
            <button type="button" className="wf-add" onClick={() => addStep(open)} data-wf-add>
              Add step
            </button>
          </li>
        </ol>
      </section>
      {runs.length > 0 && (
        <section className="wf-group" aria-label="Runs">
          <h2 className="wf-head">
            Runs <span className="group-count num">{runs.length}</span>
          </h2>
          <ul className="wf-list">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} machineName={machineName} machines={machines} now={now} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ----- one step -----

function StepRow({
  step,
  i,
  doc,
  open,
  onOpen,
  set,
  move,
  remove,
  duplicate,
  machines,
  machineName,
  sessions,
  title,
  icon,
  now,
  phone,
}: {
  step: WorkflowStep;
  i: number;
  doc: Workflow;
  open: boolean;
  onOpen: () => void;
  set: (fn: (s: WorkflowStep) => WorkflowStep) => void;
  move: (d: -1 | 1) => void;
  remove: () => void;
  duplicate: () => void;
  machines: MachineSummary[];
  machineName: (id: string) => string | undefined;
  sessions: SessionSummary[];
  title: (key: string) => string | undefined;
  icon: (h: string) => SelectOption<string>["icon"];
  now: number;
  phone: boolean;
}) {
  const name = stepName(step, i);
  const items = (): MenuList => [
    { label: "Move up", keys: "⌥↑", disabled: i === 0, run: () => move(-1) },
    { label: "Move down", keys: "⌥↓", disabled: i === doc.steps.length - 1, run: () => move(1) },
    { label: "Duplicate step", run: duplicate },
    { sep: true },
    { label: "Remove step", danger: true, run: remove },
  ];
  const menu = useContextMenu(items, { title: () => `Step ${i + 1} · ${name}` });
  const machine = machines.find((m) => m.control?.machineId === step.machineId);
  const c = machine?.control;
  const paired = !!c;
  const where = machine?.name ?? (step.machineId ? "not paired" : "no machine");
  const line = [`${where} › ${agentWords(step, title)}`, afterWords(doc.steps, i)].filter(Boolean);

  // Agent
  const options = useMemo(
    () => agentOptions(machines, sessions, step, now, icon),
    [machines, sessions, step, now, icon],
  );
  const pickAgent = (v: string) => {
    const p = parseAgentValue(v);
    if (!p) return;
    set((s) => {
      const next: WorkflowStep = { ...s, machineId: p.machineId, agent: p.agent };
      if ("session" in p.agent) {
        delete next.cwd;
        delete next.permission;
        delete next.model;
      } else if (p.machineId !== s.machineId) {
        delete next.cwd;
        delete next.permission;
        delete next.model;
      }
      return next;
    });
  };

  // Folder (a new session only)
  const harness = "harness" in step.agent ? step.agent.harness : undefined;
  const choices = useMemo(
    () =>
      machine && c
        ? folderChoices({ sessions, machine: machine.name, folders: c.folders, home: machineHome(c) })
        : { recent: [], allowed: [] },
    [machine, c, sessions],
  );
  const folderOptions: SelectOption<string>[] = [
    ...choices.recent.map((f) => ({ value: f.path, label: f.display, hint: f.repo })),
    ...choices.allowed.map((f, k) => ({
      value: f.path,
      label: f.display,
      divider: k === 0 && choices.recent.length > 0,
    })),
  ];
  const typed = (t: string): SelectOption<string> | null => {
    if (!machine) return null;
    const r = typedFolder(t, { folders: c?.folders, home: machineHome(c), machine: machine.name });
    return r.ok ? { value: r.path, label: tildify(r.path, machineHome(c)) } : { value: t, label: t, hint: r.reason };
  };
  const folder = step.cwd ?? c?.folders?.[0] ?? "";
  const listsFolders = !!c?.folders?.length || folderOptions.length > 0;

  // Options
  const opts = harness ? c?.start?.[harness] : undefined;
  const levels = permissionChoices(opts);
  const showPermission = !!harness && levels.length >= 2;
  const showModel = !!harness && !!opts && (!!opts.anyModel || !!opts.models?.length);
  const fixed = harness && c ? fixedPermission(c, harness, PERMISSION_LABEL) : null;
  const permissionOptions: SelectOption<RunLevel>[] = levels.map((p) => ({
    value: p,
    label: p === "inherit" ? "As your own sessions on this machine" : PERMISSION_LABEL[p],
  }));
  const permissionValue: RunLevel | undefined = step.permission ?? opts?.permission;
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: "Default", hint: "the agent's own" },
    ...(opts?.models ?? []).map((x) => ({ value: x, label: x })),
  ];
  const typedModel = opts?.anyModel
    ? (t: string): SelectOption<string> =>
        validModel(t) ? { value: t, label: t } : { value: t, label: t, hint: "not a model id", disabled: true }
    : undefined;

  // Runs after
  const earlier = doc.steps.slice(0, i);
  const afterValue: string[] = step.after === undefined ? ["prev"] : step.after.length === 0 ? ["root"] : step.after;
  const afterOptions: SelectOption<string>[] = [
    ...(i > 0 ? [{ value: "prev", label: "the step before" }] : []),
    { value: "root", label: "nothing — starts first" },
    ...earlier.map((s, k) => ({ value: s.id, label: stepName(s, k), divider: k === 0 })),
  ];
  const pickAfter = (next: string[]) => {
    const added = next.find((v) => !afterValue.includes(v));
    set((s) => {
      const out = { ...s };
      if (added === "prev" || (next.length === 0 && i > 0)) delete out.after;
      else if (added === "root" || next.length === 0) out.after = [];
      else out.after = next.filter((v) => v !== "prev" && v !== "root");
      return out;
    });
  };
  const chips = afterOf(doc.steps, i).map((id) => {
    const k = doc.steps.findIndex((s) => s.id === id);
    return k >= 0 ? stepName(doc.steps[k]!, k) : id;
  });

  // The prompt, and the placeholders that insert themselves at the caret
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = textRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 480)}px`;
  }, [step.text, open]);
  const insert = (token: string) => {
    const ta = textRef.current;
    const at = ta ? ta.selectionStart : step.text.length;
    const end = ta ? ta.selectionEnd : at;
    set((s) => ({ ...s, text: s.text.slice(0, at) + token + s.text.slice(end) }));
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  const stepTokens: SelectOption<string>[] = earlier.map((s, k) => ({
    value: `{{step.${s.id}}}`,
    label: `{{step.${s.id}}}`,
    hint: stepName(s, k),
  }));

  const row = (key: string, label: string, control: ReactNode, extra?: ReactNode, text = false) => (
    <div className={`wf-field ${text ? "wf-field--text" : ""}`} data-wf-row={key}>
      <span className="wf-label" id={`wf-${step.id}-${key}`}>
        {label}
      </span>
      <span className="wf-value">{control}</span>
      {extra}
    </div>
  );
  const labelled = (key: string) => `wf-${step.id}-${key}`;

  return (
    <li className={`wf-step ${open ? "wf-step--open" : ""}`} data-step={step.id} {...menu}>
      <div className="wf-step-head">
        {open ? (
          <>
            <span className="wf-step-n num">{i + 1}</span>
            <input
              className="wf-step-name-input"
              aria-label={`Step ${i + 1} name`}
              value={step.name ?? ""}
              placeholder={`Step ${i + 1}`}
              onChange={(e) => set((s) => ({ ...s, name: e.target.value }))}
              autoComplete="off"
              data-wf-step-name
            />
          </>
        ) : (
          <button type="button" className="wf-step-btn" onClick={onOpen} aria-expanded={false} data-wf-step-open>
            <span className="wf-step-n num">{i + 1}</span>
            <span className={`wf-step-name ${!paired && step.machineId ? "is-err" : ""}`}>{name}</span>
            <span className="wf-step-line">
              {line.map((t, k) => (
                <span key={k} className={t.startsWith("not paired") ? "is-err" : undefined}>
                  {k > 0 ? " · " : ""}
                  {t}
                </span>
              ))}
            </span>
          </button>
        )}
        <MoreButton build={items} label={`Actions for step ${i + 1}`} title={() => `Step ${i + 1} · ${name}`} />
      </div>
      {open && (
        <div className="wf-step-rows">
          {row(
            "agent",
            "Agent",
            <Select<string>
              labelledBy={labelled("agent")}
              value={step.machineId ? agentValue(step.machineId, step.agent) : null}
              onChange={pickAgent}
              options={options}
              placeholder={machines.length ? "Choose…" : "No machine is paired"}
              disabled={!options.length}
              searchable={options.length > 8}
              filterPlaceholder="Search sessions or agents"
              className="wf-sel"
            />,
          )}
          {harness &&
            row(
              "folder",
              "Folder",
              listsFolders ? (
                <Select<string>
                  labelledBy={labelled("folder")}
                  value={folder || null}
                  onChange={(v) => set((s) => ({ ...s, cwd: v }))}
                  options={folderOptions}
                  placeholder="Choose…"
                  custom={typed}
                  filterPlaceholder="Search, or type a path"
                  className="wf-sel mono"
                />
              ) : (
                <input
                  className="wf-input mono"
                  aria-labelledby={labelled("folder")}
                  value={step.cwd ?? ""}
                  onChange={(e) =>
                    set((s) => (e.target.value ? { ...s, cwd: e.target.value } : (({ cwd: _c, ...rest }) => rest)(s)))
                  }
                  placeholder={c?.tilde ? "~/path/on/the/machine" : "/absolute/path/on/the/machine"}
                  spellCheck={false}
                  autoComplete="off"
                />
              ),
              machine && c && !c.folders?.length ? (
                <span className="wf-aside">{machine.name} didn't list its folders; it checks the path itself</span>
              ) : null,
            )}
          {row(
            "prompt",
            "Prompt",
            <span className="wf-textwrap" style={{ flex: "1 1 auto" }}>
              <textarea
                ref={textRef}
                className="wf-text"
                aria-labelledby={labelled("prompt")}
                value={step.text}
                maxLength={WORKFLOW_TEXT_MAX}
                rows={3}
                placeholder="What should it do?"
                onChange={(e) => set((s) => ({ ...s, text: e.target.value }))}
                data-wf-prompt
              />
              <span className="wf-hint">
                {doc.input && (
                  <button type="button" className="wf-hint-btn" onClick={() => insert("{{input}}")}>
                    {"{{input}}"}
                  </button>
                )}
                {doc.input && i > 0 && <span aria-hidden="true">·</span>}
                {i > 0 && afterOf(doc.steps, i).length > 0 && (
                  <button type="button" className="wf-hint-btn" onClick={() => insert("{{prev}}")}>
                    {"{{prev}}"}
                  </button>
                )}
                {stepTokens.length > 0 && (
                  <>
                    {(doc.input || i > 0) && <span aria-hidden="true">·</span>}
                    <Select<string>
                      aria-label="Insert a step's reply"
                      value={null}
                      onChange={insert}
                      options={stepTokens}
                      placeholder="{{step.<id>}}"
                      size="sm"
                      className="wf-sel"
                    />
                  </>
                )}
              </span>
            </span>,
            undefined,
            true,
          )}
          {harness &&
            (showPermission || fixed || showModel) &&
            row(
              "options",
              "Options",
              <span className="wf-opts">
                {showPermission ? (
                  <span className="wf-opt">
                    <span className="wf-opt-label" id={labelled("permission")}>
                      Permission
                    </span>
                    <Select<RunLevel>
                      labelledBy={labelled("permission")}
                      value={permissionValue}
                      onChange={(p) =>
                        set((s) => {
                          const next = { ...s };
                          if (p === "inherit" || p === opts?.permission) delete next.permission;
                          else next.permission = p as StartPermission;
                          return next;
                        })
                      }
                      options={permissionOptions}
                      size="sm"
                      className="wf-sel"
                    />
                  </span>
                ) : fixed ? (
                  <span className="wf-opt">
                    <span className="wf-opt-label">Permission</span>
                    <span className="wf-fixed">{fixed}</span>
                  </span>
                ) : null}
                {showModel && (
                  <span className="wf-opt">
                    <span className="wf-opt-label" id={labelled("model")}>
                      Model
                    </span>
                    <Select<string>
                      labelledBy={labelled("model")}
                      value={step.model ?? ""}
                      onChange={(m) =>
                        set((s) => {
                          const next = { ...s };
                          if (m) next.model = m;
                          else delete next.model;
                          return next;
                        })
                      }
                      options={modelOptions}
                      custom={typedModel}
                      searchable={!!typedModel || modelOptions.length > 8}
                      filterPlaceholder={typedModel ? "Search, or type a model id" : "Filter"}
                      size="sm"
                      className="wf-sel"
                    />
                  </span>
                )}
              </span>,
            )}
          {row(
            "after",
            "Runs after",
            <MultiSelect<string>
              labelledBy={labelled("after")}
              value={afterValue}
              onChange={pickAfter}
              options={afterOptions}
              size={phone ? "md" : "sm"}
              className="wf-sel"
              renderValue={() => (
                <span className="wf-chips">
                  {chips.length ? (
                    chips.map((n) => (
                      <span key={n} className="wf-chip">
                        {n}
                      </span>
                    ))
                  ) : (
                    <span className="wf-fixed">nothing — starts first</span>
                  )}
                </span>
              )}
            />,
          )}
          {!paired && step.machineId && (
            <p className="wf-second is-err" style={{ margin: "0 0 8px" }}>
              {machineName(step.machineId) ?? "Its machine"} isn't paired here any more. Pick another agent.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

// ----- a run under the workflow -----

function RunRow({
  run,
  machineName,
  machines,
  now,
}: {
  run: WorkflowRun;
  machineName: (id: string) => string | undefined;
  machines: MachineSummary[];
  now: number;
}) {
  const words = runRowWords(run, machineName);
  const items = (): MenuList => [
    { label: "Open", run: () => navigate(runPath(run.id)) },
    runLive(run) && { label: "Cancel…", run: () => cancelRun(run, machines, true) },
    { sep: true },
    { label: "Delete…", danger: true, run: () => void deleteRun(run) },
  ];
  const menu = useContextMenu(items, { title: () => run.name, subtitle: () => words.text });
  return (
    <li className="wf-item" data-run={run.id} {...menu}>
      <Link to={runPath(run.id)} className="wf-row" data-nav-item="">
        <span className="wf-lead">
          <StatusGlyph glyph={runGlyph(run)} label={words.text} />
        </span>
        <span className="wf-name">{startedLabel(run.startedAt, now)}</span>
        <span className={`wf-facts ${words.tone === "needs" ? "is-needs" : ""}`}>{words.text}</span>
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
