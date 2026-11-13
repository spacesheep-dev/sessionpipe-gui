// SPDX-License-Identifier: Apache-2.0
// Connecting a spacesheep account, drawn (docs/rfcs/08, "The phone on an account"): the
// first run's other way in, and Settings' "Connect again". One idea a screen, as the rest
// of the first run (OnbParts.tsx): what this is, the number to compare with the page the
// hub opens in the browser, the wait with a way out, the hub's own question on this phone,
// and each way it can end with what to do next. The steps are accountConnect.ts's; the
// hub does the connecting (account/shell.ts ConnectCalls); the words are accountWords.ts's.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { endedWords } from "../account/screenWords";
import { type ConnectCalls, connectView, hubError, tauriConnect } from "../account/shell";
import { alreadyHere, type ConnectStep, connectStep, DEFAULT_ORIGIN, hostOf, spaced } from "./accountConnect";
import { NEW_WORDS as N, REUSED as R, ThisPhone, thisPhone } from "./accountWords";
import { invoke } from "./bridge";
import { Primary, Quiet, Screen, Secondary } from "./OnbParts";
import { type Phone, trustBrowser } from "./onboarding";

/** How long the page waits for the shell to show the account before it opens itself again. */
const SHOWN_WITHIN_MS = 8000;

/** A start that has not answered in this long is one that could not reach spacesheep. */
export const START_WITHIN_MS = 30_000;

const openOutside = (url: string) => void invoke("app_open_external", { url }).catch(() => {});

export function ConnectAccount({
  origin,
  platform,
  calls = tauriConnect,
  begin = "intro",
  onLeave,
}: {
  /** Where to connect; absent: spacesheep.dev. */
  origin?: string;
  platform: Phone | null;
  calls?: ConnectCalls;
  /** `starting`: straight to the number (Settings' Connect again, where what it is was
   *  said). `resuming`: one was under way when the app opened; the hub says where it stands. */
  begin?: "intro" | "starting" | "resuming";
  /** Back to where the person came from, with nothing under way. */
  onLeave: () => void;
}) {
  const host = hostOf(origin ?? DEFAULT_ORIGIN);
  const [s, send] = useReducer((p: ConnectStep, e: Parameters<typeof connectStep>[1]) => connectStep(p, e, host), {
    kind: begin,
  } as ConnectStep);
  const browser = trustBrowser(platform);
  const Browser = browser.charAt(0).toUpperCase() + browser.slice(1);

  /** What the hub says now, read into the step. `resume`: only a connect that is still going
   *  (a finished one's outcome is not news to a screen that was not there for it). */
  const read = useCallback(
    async (resume = false) => {
      const st = await calls.status().catch(() => null);
      // The hub cannot say: a resume that waits on it ends as spacesheep out of reach.
      if (!st)
        return void (resume
          ? null
          : send({ type: "refused", error: { code: "unreachable", message: "" }, now: Date.now() }));
      const c = connectView(st.connect);
      // A finished one that left a key on spacesheep which is not kept here is news to
      // whoever opens the app: its note is shown, whichever way it ended.
      if (resume && !(c && (c.state === "pending" || c.state === "asking" || c.state === "approved" || !!c.note)))
        return;
      send({ type: "connect", connect: c, accounts: st.accounts.map((a) => a.id) });
    },
    [calls],
  );

  // The hub tells every change; and a connect under way when this opens is picked up.
  useEffect(() => {
    let off: (() => void) | null = null;
    let on = true;
    void calls
      .onAccount((st) =>
        send({ type: "connect", connect: connectView(st.connect), accounts: st.accounts.map((a) => a.id) }),
      )
      .then(
        (f) => {
          if (on) off = f;
          else f();
        },
        () => {},
      );
    // A connect that is still going is picked up; told to resume one, whatever the hub says now.
    void read(begin !== "resuming");
    return () => {
      on = false;
      off?.();
    };
  }, [calls, read, begin]);

  // Back in front (from the browser): asked at once, not at the hub's next word.
  const waiting = s.kind === "number" || s.kind === "asking";
  useEffect(() => {
    if (!waiting) return;
    const look = () => {
      if (document.visibilityState !== "hidden") void read();
    };
    document.addEventListener("visibilitychange", look);
    window.addEventListener("focus", look);
    return () => {
      document.removeEventListener("visibilitychange", look);
      window.removeEventListener("focus", look);
    };
  }, [waiting, read]);

  // Starting: the hub asks spacesheep for a number.
  const starting = s.kind === "starting";
  useEffect(() => {
    if (!starting) return;
    let on = true;
    void (async () => {
      // A start that never answers ends as one that could not reach spacesheep.
      const late = setTimeout(
        () => on && send({ type: "refused", error: { code: "unreachable", message: "" }, now: Date.now() }),
        START_WITHIN_MS,
      );
      try {
        const c = await calls.start(origin);
        clearTimeout(late);
        if (on) send({ type: "connect", connect: c });
      } catch (e) {
        clearTimeout(late);
        if (!on) return;
        // An account at that origin is here and fine: it is the one to show.
        if (hubError(e).code === "already_connected") {
          const st = await calls.status().catch(() => null);
          const id = st ? alreadyHere(st.accounts, origin) : null;
          if (id && on)
            return send({
              type: "connect",
              connect: { origin: origin ?? DEFAULT_ORIGIN, digits: "", expiresAt: "", state: "approved", receiver: id },
            });
        }
        send({ type: "refused", error: e, now: Date.now() });
      }
    })();
    return () => {
      on = false;
    };
  }, [starting, calls, origin]);

  // Kept: the shell is asked to show the account, and opens the window on it.
  const receiver = s.kind === "opening" ? s.receiver : null;
  useEffect(() => {
    if (!receiver) return;
    let on = true;
    calls.select(receiver).catch((e) => on && send({ type: "refused", error: e, now: Date.now() }));
    // A shell that kept the account and did not reopen the window: the page does.
    const t = setTimeout(() => on && location.replace("/"), SHOWN_WITHIN_MS);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [receiver, calls]);

  const busy = useRef(false);
  /** Stops what is under way (or clears how the last one ended) and goes back. */
  const leave = async () => {
    if (busy.current) return;
    busy.current = true;
    const was = s.kind;
    await calls.cancel().catch(() => false);
    // Stopped after spacesheep had made a key for this app: the hub says so (its note), and
    // the person is told here, with where to revoke it, before the screen is left.
    if (was !== "ended") {
      const st = await calls.status().catch(() => null);
      const c = st ? connectView(st.connect) : null;
      if (st && c?.note) {
        busy.current = false;
        send({ type: "connect", connect: c, accounts: st.accounts.map((a) => a.id) });
        return;
      }
    }
    busy.current = false;
    send({ type: "reset" });
    onLeave();
  };
  const again = async () => {
    await calls.cancel().catch(() => false);
    send({ type: "go" });
  };
  /** One hand-off to the browser at a time: a second tap while the first is out asks nothing. */
  const handing = useRef(false);
  const open = async () => {
    if (handing.current) return;
    handing.current = true;
    try {
      await calls.open();
      send({ type: "opened" });
    } catch {
      void read();
    } finally {
      handing.current = false;
    }
  };

  // A wait that names a time offers the try when that time has come.
  const waitUntil = s.kind === "ended" && s.why === "wait" ? (s.at ?? null) : null;
  const [due, setDue] = useState(false);
  useEffect(() => {
    setDue(false);
    if (waitUntil === null) return;
    const ms = waitUntil - Date.now();
    if (ms <= 0) return setDue(true);
    const t = setTimeout(() => setDue(true), Math.min(ms + 500, 2_147_000_000));
    return () => clearTimeout(t);
  }, [waitUntil]);

  const back = (label: string = R.back) => (
    <button type="button" className="btn btn--ghost onb-back" onClick={() => void leave()}>
      {label}
    </button>
  );
  const spinner = <span className="spinner onb-spinner" aria-hidden="true" />;

  if (s.kind === "intro")
    return (
      <Screen bar={back()} title={R.use} body={N.introBody} data-step="account-intro">
        <Primary onClick={() => send({ type: "go" })}>{R.go}</Primary>
      </Screen>
    );

  if (s.kind === "starting" || s.kind === "opening" || s.kind === "resuming")
    return (
      <Screen
        // A start or a resume can be left; once the account is kept the window is being replaced.
        {...(s.kind === "opening" ? {} : { bar: back(R.cancel) })}
        title={R.connecting(s.kind === "opening" ? s.host : host)}
        host={s.kind === "opening" ? s.host : host}
        glyph={spinner}
        data-step={s.kind === "opening" ? "account-opening" : "account-starting"}
        live
      />
    );

  if (s.kind === "number")
    return (
      <Screen
        bar={back(R.cancel)}
        title={N.numberTitle}
        figure={
          <p className="onb-digits num" data-digits={s.digits}>
            <span className="sr-only">{s.digits.split("").join(" ")}</span>
            <span aria-hidden="true">{spaced(s.digits)}</span>
          </p>
        }
        body={s.opened ? N.numberWaiting : N.numberBody(Browser)}
        data-step="account-number"
        data-opened={s.opened || undefined}
        live
      >
        {s.opened ? (
          <>
            <span className="onb-waiting" role="status">
              <span className="spinner" aria-hidden="true" />
            </span>
            <Quiet onClick={() => void open()}>{R.again}</Quiet>
          </>
        ) : (
          <Primary onClick={() => void open()}>{R.open(browser)}</Primary>
        )}
      </Screen>
    );

  if (s.kind === "asking")
    return (
      <Screen
        bar={back(R.cancel)}
        glyph={spinner}
        title={N.askingTitle}
        body={N.askingBody(thisPhone())}
        data-step="account-asking"
        live
      />
    );

  // Ended: why, and the next step.
  const w = endedWords(s);
  return (
    <Screen bar={back()} title={w.title} body={w.body} host={s.host} data-step="account-ended" data-why={s.why} live>
      {(s.why !== "wait" || due) && <Primary onClick={() => void again()}>{R.retry}</Primary>}
      {s.revokeUrl && <Secondary onClick={() => openOutside(s.revokeUrl!)}>{N.revoke}</Secondary>}
    </Screen>
  );
}

/** After a disconnect: what the hub says of the key, and where to revoke it. */
export function Disconnected({ note, revokeUrl, onDone }: { note: string; revokeUrl?: string; onDone: () => void }) {
  return (
    <Screen title={N.disconnectedTitle} body={note} data-step="account-disconnected">
      <Primary onClick={onDone}>{R.done}</Primary>
      {revokeUrl && <Secondary onClick={() => openOutside(revokeUrl)}>{N.revoke}</Secondary>}
    </Screen>
  );
}

export { ThisPhone };
