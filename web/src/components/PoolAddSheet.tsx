// SPDX-License-Identifier: Apache-2.0
// The Add account sheet (UX-SPEC §4): "Add a Claude account to lab-mac", in the New session
// sheet's frame (a dialog under the title bar on a desktop, a full-height sheet on a
// phone). Two groups: the command to run on that machine (`sessionpipe pool add
// --import`, with Copy), and the sign-in the daemon runs: "Sign in to Claude…" sends
// `login.begin`; its delivered ack carries a URL and a pending login id (lib/pool.ts
// loginFromDetail), shown as "Open claude.ai" and a well; the pasted `code#state` goes
// back as `login.complete` with a fresh confirm; delivered, the sheet closes and the new
// row arrives with the hello. Every failure line is §4.2's. The GUI never sees a token:
// the daemon holds the sign-in, the page carries a code. Sign-in first when the pool has
// accounts; the command first when it is empty, or once the daemon said it cannot sign in
// from here. Mounted by the Usage page (PoolAddHost) while open.
import type { MachineSummary } from "@shared/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMessage } from "../control/hooks";
import { closePoolAdd, type PoolAddTarget, usePoolAdd } from "../control/poolAddState";
import { signerLabel } from "../control/signer";
import { usePoolSend } from "../control/usePoolSend";
import { refusalWords } from "../control/words";
import { useMachines } from "../data/hooks";
import { useFocusTrap } from "../lib/focus";
import { usePresence } from "../lib/motion";
import {
  CODE_INCOMPLETE,
  type CommandNote,
  IMPORT_COMMAND,
  LOGIN_COMMAND,
  loginFailure,
  loginFromDetail,
  signInLead,
} from "../lib/pool";
import { useShortcut } from "../lib/shortcuts";
import { CommandWell } from "./bits";
import { useMedia } from "./Shell";
import "../control/newSessionSheet.css";

export function PoolAddHost() {
  const { open, target, seq } = usePoolAdd();
  const { mounted, closing } = usePresence(open);
  if (!mounted) return null;
  return <PoolAddSheet key={seq} target={target} closing={closing} />;
}

type Link = { url: string; pendingId: string };

export function PoolAddSheet({ target, closing }: { target: PoolAddTarget; closing: boolean }) {
  const phone = useMedia("(max-width: 839px)");
  const machines = useMachines();
  const m =
    machines.find((x) => x.name === target.machine) ??
    ({ name: target.machine, harnesses: {} } as unknown as MachineSummary);
  const pool = m.control?.pool;
  const send = usePoolSend(m);
  const ref = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => closePoolAdd(), []);

  const [beginId, setBeginId] = useState<string | null>(null);
  const [completeId, setCompleteId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [link, setLink] = useState<Link | null>(null);
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<CommandNote | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const begin = useMessage(beginId);
  const complete = useMessage(completeId);

  // login.begin's answer: the link, or why not.
  useEffect(() => {
    if (!begin?.outcome || begin.outcome === "taken" || begin.outcome === "progress") return;
    if (begin.outcome === "delivered") {
      const got = loginFromDetail(begin.detail);
      if (got.url && got.pendingId) {
        setLink({ url: got.url, pendingId: got.pendingId });
        setFailure(null);
      } else setFailure({ text: `${m.name} sent no sign-in link. Use the command below.`, err: true, sticky: true });
      return;
    }
    if (begin.outcome === "unsupported") setUnsupported(true);
    setFailure(loginFailure(begin, m.name, refusalWords));
  }, [begin, m.name]);
  // login.complete's answer: done (the hello brings the row), or why not.
  useEffect(() => {
    if (!complete?.outcome || complete.outcome === "taken" || complete.outcome === "progress") return;
    if (complete.outcome === "delivered") {
      close();
      return;
    }
    if (complete.outcome === "unsupported") setUnsupported(true);
    setFailure(loginFailure(complete, m.name, refusalWords));
    setCompleteId(null);
  }, [complete, m.name, close]);

  const startSignIn = async () => {
    setFailure(null);
    setLink(null);
    setCode("");
    setCompleteId(null);
    setSending(true);
    const a = await send.send({ action: "login.begin" });
    setSending(false);
    if (a) setBeginId(a.id);
  };
  const finish = async () => {
    if (!link) return;
    const c = code.trim();
    if (!c.includes("#")) {
      setFailure({ text: CODE_INCOMPLETE, err: true });
      codeRef.current?.focus();
      return;
    }
    setFailure(null);
    setSending(true);
    const a = await send.send({ action: "login.complete", account: link.pendingId, code: c });
    setSending(false);
    if (a) setCompleteId(a.id);
  };

  const waiting =
    sending || (!!beginId && !link && !begin?.outcome) || (!!completeId && !complete?.outcome) || send.tap;
  const pendingLine = send.tap
    ? `Confirm with ${signerLabel()}`
    : waiting
      ? (send.note?.text ?? `Sending to ${m.name}…`)
      : send.note && !send.note.err
        ? send.note.text
        : "";
  const error = failure ?? (send.note?.err ? send.note : null);

  useFocusTrap(ref, !closing, {
    onClose: close,
    initial: link ? "[data-pool-code]" : "[data-pool-signin], [data-pool-cancel]",
  });
  // Esc closes the sheet from wherever focus is (a disabled Done lets it go).
  useShortcut("back", () => close(), { priority: 10, enabled: !closing });
  useEffect(() => {
    if (link) codeRef.current?.focus({ preventScroll: true });
  }, [link]);

  const commandFirst = !pool || pool.accounts.length === 0 || unsupported;
  const title = `Add a Claude account to ${m.name}`;
  const command = (
    <section className="pa-group" aria-labelledby="pa-cmd" data-pool-command="">
      <h3 className="pa-head" id="pa-cmd">
        On {m.name}, in a terminal
      </h3>
      <CommandWell command={IMPORT_COMMAND} prompt={false} label="Copy setup command" />
      <p className="pa-caption">
        Imports every Claude Code login already on {m.name}. For another account there, <code>{LOGIN_COMMAND}</code>.
      </p>
    </section>
  );
  const signIn = (
    <section className="pa-group" aria-labelledby="pa-signin" data-pool-signin-group="">
      <h3 className="pa-head" id="pa-signin">
        Sign in to Claude
      </h3>
      {!link ? (
        <>
          <p className="pa-lead">{signInLead(m.name, target.again)}</p>
          <div className="pa-actions pa-actions--ready">
            {pendingLine && (
              <p className="pa-status" role="status">
                {pendingLine}
              </p>
            )}
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void startSignIn()}
              disabled={!!send.blocked || waiting || unsupported}
              data-tip={send.blocked ?? undefined}
              data-pool-signin=""
            >
              Sign in to Claude…
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="pa-step">
            <span className="pa-step-n num">1</span>
            <span className="pa-step-text">Open the link and sign in.</span>
            <a className="btn" href={link.url} target="_blank" rel="noopener" data-pool-open="">
              Open claude.ai ↗
            </a>
            <CommandWell command={link.url} prompt={false} label="Copy link" />
          </div>
          <div className="pa-step">
            <span className="pa-step-n num">2</span>
            <span className="pa-step-text">Paste the code the page shows.</span>
            <input
              ref={codeRef}
              className="pa-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onFocus={(e) => phone && e.currentTarget.scrollIntoView({ block: "center" })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.includes("#")) void finish();
              }}
              placeholder="code#state"
              aria-label="The code the page shows"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={512}
              data-pool-code=""
            />
          </div>
          <div className="pa-actions">
            {pendingLine && (
              <p className="pa-status" role="status">
                {pendingLine}
              </p>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => void startSignIn()}
              disabled={waiting}
              data-pool-restart=""
            >
              Start over
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void finish()}
              disabled={!code.includes("#") || waiting}
              data-pool-done=""
            >
              Done
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="page-note is-err pa-note" role="alert" data-pool-error="">
          {error.text}
        </p>
      )}
    </section>
  );

  if (phone)
    return (
      <div
        className="ns-sheet ns-sheet--phone"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pa-title"
        ref={ref}
        data-closing={closing ? "" : undefined}
        data-pool-sheet=""
      >
        <header className="ns-bar">
          <button type="button" className="ns-bar-btn" onClick={close} data-pool-cancel="">
            Cancel
          </button>
          <h2 className="ns-bar-title" id="pa-title">
            {title}
          </h2>
          <span />
          <span className="ns-grab" aria-hidden="true" />
        </header>
        <div className="ns-scroll">
          <div className="ns-group">{commandFirst ? command : signIn}</div>
          <div className="ns-group">{commandFirst ? signIn : command}</div>
        </div>
      </div>
    );

  return (
    <>
      <button
        type="button"
        className="menu-scrim menu-scrim--dialog ns-scrim"
        aria-label="Close"
        onClick={close}
        data-closing={closing ? "" : undefined}
        data-dismiss
      />
      <div
        className="ns-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pa-title"
        ref={ref}
        data-closing={closing ? "" : undefined}
        data-pool-sheet=""
      >
        <h2 className="ns-title" id="pa-title">
          {title}
        </h2>
        {commandFirst ? command : signIn}
        {commandFirst ? signIn : command}
        <footer className="pa-foot">
          <button type="button" className="btn" onClick={close} data-pool-cancel="">
            {link ? "Close" : "Cancel"}
          </button>
        </footer>
      </div>
    </>
  );
}
