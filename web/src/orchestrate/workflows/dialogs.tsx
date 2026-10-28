// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The two small dialogs of the Workflows page, in the confirm
// sheet's frame (components/ContextMenu.tsx `confirmAction`, styles/menu.css `.confirm`):
// Run's one field for the workflow's input (UX-SPEC §4.2), and Cancel's confirm with its
// one option, "Also stop Review on build-box" (§4.3). Promise-shaped like confirmAction;
// WorkflowDialogs is their host, mounted by the page. On a phone they are the same
// frame, centred: a field needs the keyboard, which a bottom sheet would sit under.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useFocusTrap } from "../../lib/focus";

interface InputRequest {
  kind: "input";
  title: string;
  label: string;
  initial: string;
  action: string;
  resolve: (v: string | null) => void;
}
interface CancelRequest {
  kind: "cancel";
  title: string;
  body: string;
  /** The option's line, when there is one; on by default. */
  option?: string;
  action: string;
  keep: string;
  resolve: (v: { option: boolean } | null) => void;
}
type Request = InputRequest | CancelRequest;

let req: Request | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const get = () => req;
const settle = (v: unknown) => {
  const r = req;
  if (!r) return;
  req = null;
  emit();
  (r.resolve as (v: unknown) => void)(v);
};

/** One field, named by the input's label; the text typed, or null when dismissed. */
export function askInput(o: {
  title: string;
  label: string;
  initial?: string;
  action?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    settle(null);
    req = {
      kind: "input",
      title: o.title,
      label: o.label,
      initial: o.initial ?? "",
      action: o.action ?? "Run",
      resolve,
    };
    emit();
  });
}

/** The cancel confirm: `{ option }` when confirmed, null when kept running. */
export function askCancel(o: {
  title: string;
  body: string;
  option?: string;
  action?: string;
  keep?: string;
}): Promise<{ option: boolean } | null> {
  return new Promise((resolve) => {
    settle(null);
    req = {
      kind: "cancel",
      title: o.title,
      body: o.body,
      option: o.option,
      action: o.action ?? "Cancel run",
      keep: o.keep ?? "Keep running",
      resolve,
    };
    emit();
  });
}

export function WorkflowDialogs() {
  const r = useSyncExternalStore(subscribe, get, get);
  if (!r) return null;
  return r.kind === "input" ? <InputView r={r} /> : <CancelView r={r} />;
}

function Frame({ r, children, initial }: { r: Request; children: ReactNode; initial: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, { onClose: () => settle(null), initial });
  const keys = (e: ReactKeyboardEvent) => {
    // The page's own keys stay out while the dialog has focus (Esc and Tab are the trap's).
    if (e.key !== "Tab" && e.key !== "Escape") e.stopPropagation();
  };
  return (
    <>
      <button
        type="button"
        className="menu-scrim menu-scrim--dialog"
        aria-label="Cancel"
        onClick={() => settle(null)}
      />
      <div
        className="confirm wf-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
        ref={ref}
        onKeyDown={keys}
        tabIndex={-1}
        data-dismiss
      >
        <h2 className="confirm-title" id="wf-dialog-title">
          {r.title}
        </h2>
        {children}
      </div>
    </>
  );
}

function InputView({ r }: { r: InputRequest }) {
  const [text, setText] = useState(r.initial);
  const ok = text.trim().length > 0;
  const go = () => {
    if (ok) settle(text.trim());
  };
  return (
    <Frame r={r} initial="input">
      <label className="wf-dialog-field">
        <span className="wf-dialog-label">{r.label}</span>
        <input
          className="field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            }
          }}
          autoComplete="off"
          onFocus={(e) => e.target.select()}
          data-wf-input
        />
      </label>
      <div className="confirm-actions">
        <button type="button" className="btn" data-cancel onClick={() => settle(null)}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" data-ok disabled={!ok} onClick={go}>
          {r.action}
        </button>
      </div>
    </Frame>
  );
}

function CancelView({ r }: { r: CancelRequest }) {
  const [option, setOption] = useState(true);
  const id = "wf-cancel-option";
  return (
    <Frame r={r} initial="[data-cancel]">
      <p className="confirm-body">{r.body}</p>
      {r.option && (
        <label className="wf-dialog-option" htmlFor={id}>
          <input id={id} type="checkbox" checked={option} onChange={(e) => setOption(e.target.checked)} />
          <span>{r.option}</span>
        </label>
      )}
      <div className="confirm-actions">
        <button type="button" className="btn" data-cancel onClick={() => settle(null)}>
          {r.keep}
        </button>
        <button
          type="button"
          className="btn btn--danger"
          data-ok
          onClick={() => settle({ option: !!r.option && option })}
        >
          {r.action}
        </button>
      </div>
    </Frame>
  );
}
