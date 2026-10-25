// SPDX-License-Identifier: Apache-2.0
// Owned by: onboarding. /setup: a first run in five steps, each green when this machine
// has done its part, with one action each, and an optional sixth (the GUI from anywhere
// through a trusted https proxy) that is never "needs you". The facts come from GET
// /api/ui/setup/status every two seconds (this machine only), so a step turns green by
// itself the moment the outbox gets its first event, the CA is trusted, the daemon polls, a
// phone connects, a message comes back delivered. A checklist (shared with /phone): one
// glyph per step (a ring in the ink on the step to do now, a check that draws itself in
// the moment a step is done), the step to do now open, each action with its one caption
// beside it, and "Open the board" at the end. Progress, not gaps: the harnesses that send
// no hooks yet are one muted line, and the wait for the first event is the step's last
// line, right under the command that ends it. The reading column is centred, as the
// session page's is.
import type { HarnessStatus, SessionSummary, SetupStatus } from "@shared/api";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Ago, CommandWell, HarnessGlyph, Listening, Spinner, Toggle } from "../components/bits";
import { PageBar } from "../components/PageBar";
import { Select } from "../components/Select";
import { ActivityRow } from "../control/Activity";
import { controlApi, httpsPath, resetInfoCache } from "../control/api";
import { sendCommand } from "../control/command";
import { useMessage } from "../control/hooks";
import { PairBody } from "../control/PairBody";
import { noteOriginTrust, passkeysAvailable } from "../control/webauthn";
import { sendErrorWords } from "../control/words";
import { useAppState, useStore } from "../data/hooks";
import { sessionTitle } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { markSetupSeen, refreshSetup, SetupError, setupApi, type TrustResult, useSetupStatus } from "../setup/api";
import {
  OPTIONAL_STEPS,
  onHttpsOrigin,
  publicUrl,
  REQUIRED_STEPS,
  STEP_ORDER,
  type StepKey,
  sameMachineName,
  stepsDone,
} from "../setup/steps";
import { type Mark, Step } from "./SetupStep";
import "./setup.css";

export const INSTALL = "npx sessionpipe install";
export const QUIT_CHROME = "Chrome keeps the old verdict until you quit and reopen it (⌘Q)";

export function Setup() {
  const state = useSetupStatus(true);
  const s = state.status;
  const [tried, setTried] = useState(false);
  const done = s ? stepsDone(s, tried) : null;
  const marks = useMemo<Record<StepKey, Mark>>(() => {
    const out = {} as Record<StepKey, Mark>;
    let first = true;
    for (const k of STEP_ORDER) {
      if (done?.[k]) out[k] = "done";
      else if (OPTIONAL_STEPS.has(k)) out[k] = "todo";
      else {
        out[k] = first ? "needs" : "todo";
        first = false;
      }
    }
    return out;
  }, [done]);
  const allDone = !!done && REQUIRED_STEPS.every((k) => done[k]);
  const doneCount = done ? REQUIRED_STEPS.filter((k) => done[k]).length : 0;
  // Only the step to do now is open; a person may open or close any of them.
  const [opened, setOpened] = useState<Partial<Record<StepKey, boolean>>>({});
  const fold = (k: StepKey) => ({
    open: opened[k] ?? marks[k] === "needs",
    onToggle: () => setOpened((o) => ({ ...o, [k]: !(o[k] ?? marks[k] === "needs") })),
  });

  const skip = () => {
    markSetupSeen();
    navigate("/");
  };

  return (
    <div className="page page--doc page--grouped setup">
      <PageBar
        title="Set up sessionpipe gui"
        meta={done ? `${doneCount} of ${REQUIRED_STEPS.length} done` : undefined}
        actions={
          s && !allDone ? (
            <button
              type="button"
              className="btn btn--ghost setup-skip-btn"
              onClick={skip}
              data-setup-skip
              title="The sidebar keeps a Setup entry until the steps are done"
            >
              Skip
            </button>
          ) : undefined
        }
      />
      {state.local === false && (
        <p className="page-note" role="status">
          Setup runs on the machine that runs sessionpipe-gui: open <code>http://localhost:7373/setup</code> there.
        </p>
      )}
      {state.local !== false && !s && (
        <div className="skeleton" role="status" aria-label="Reading this machine">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}
      {state.error && s && <p className="page-note is-err">Last check failed: {state.error}. Trying again.</p>}
      {s && done && (
        <ol className="steps">
          <SessionsStep s={s} mark={marks.sessions} {...fold("sessions")} />
          <SecureStep s={s} mark={marks.secure} {...fold("secure")} />
          <PairStep s={s} mark={marks.pair} secure={done.secure} {...fold("pair")} />
          <PhoneStep s={s} mark={marks.phone} {...fold("phone")} />
          <TryStep
            s={s}
            mark={marks.try}
            ready={done.secure && done.pair}
            onDelivered={() => setTried(true)}
            {...fold("try")}
          />
          <RemoteStep s={s} mark={marks.remote} {...fold("remote")} />
        </ol>
      )}
      {s && allDone && (
        <div className="setup-done" role="status" data-setup-done>
          <span className="setup-done-text">
            <span className="form-label">You're set</span>
            <span className="caption">Sessions show up as they run, and your phone can read and answer.</span>
          </span>
          <button type="button" className="btn btn--primary" onClick={skip}>
            Open the board
          </button>
        </div>
      )}
      {s && done && !allDone && (
        <div className="setup-end">
          <span className="caption">The board works already; the steps left can wait.</span>
          <button type="button" className="btn" onClick={skip}>
            Open the board
          </button>
        </div>
      )}
      {s && done && (
        <p className="caption setup-extras" data-setup-extras>
          Canvas and Office are already in; the ping-a-human plugin is one click on the{" "}
          <Link to="/themes" className="setup-extras-link">
            Views page
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="step-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A literal line to run: the app's one command well (one line, mono, Copy at its end). */
function Cmd({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <div className="step-cmd">
      <CommandWell command={text} label={label} />
    </div>
  );
}

const yesNo = (v: boolean | null | undefined) => (v === null || v === undefined ? "unknown" : v ? "yes" : "no");

type Fold = { open: boolean; onToggle: () => void };

// ---------- 1 · your sessions ----------

/** One installed harness of the registry and where it stands, as one short word: hooks
 *  on, hooks off (the install command writes them; the one state in orange), or no
 *  adapter yet. The counts are its tooltip. */
function HarnessRow({ h }: { h: HarnessStatus }) {
  const status = h.hooks === "on" ? "Hooks on" : h.hooks === "off" ? "Hooks off" : "Not supported yet";
  const detail =
    h.hooks === "on"
      ? `${h.sessions === 0 ? "No sessions yet" : `${h.sessions} ${h.sessions === 1 ? "session" : "sessions"}`}`
      : h.hooks === "off"
        ? "Run the install command again"
        : "sessionpipe support is pending";
  return (
    <li
      className={`form-row step-harness step-harness--${h.hooks}`}
      data-harness={h.name}
      data-hooks={h.hooks}
      title={detail}
    >
      <span className="form-row-text">
        <HarnessGlyph name={h.name} size="sm" withLabel />
      </span>
      <span className="form-value step-harness-status">
        {h.hooks === "on" && h.lastEventAt ? (
          <span className="step-harness-last">
            <Ago iso={h.lastEventAt} />
          </span>
        ) : null}
        {status}
      </span>
    </li>
  );
}

/** "Cursor, Copilot CLI and Kiro don't send hooks yet": the ones sessionpipe has no
 *  adapter for, in one muted line instead of a row each. */
const andList = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

function SessionsStep({ s, mark, open, onToggle }: { s: SetupStatus; mark: Mark } & Fold) {
  const sp = s.sessionpipe;
  const all = s.harnesses.filter((h) => h.installed);
  const installed = all.filter((h) => h.hooks !== "unsupported");
  const pending = all.filter((h) => h.hooks === "unsupported");
  return (
    <Step
      attrs={{ "data-step": "sessions" }}
      mark={mark}
      open={open}
      onToggle={onToggle}
      title="Your sessions"
      caption={
        mark === "done" ? (
          <>
            {s.events.total.toLocaleString()} events
            {sp.outbox.sessions ? ` from ${sp.outbox.sessions} sessions` : ""}
            {s.events.lastAt && (
              <>
                {" "}
                · last <Ago iso={s.events.lastAt} />
              </>
            )}
          </>
        ) : (
          "The hooks write each session on this machine to an outbox; the board reads it."
        )
      }
      why={
        <Facts
          rows={[
            ["sessionpipe", sp.installed ? `${sp.version ?? "installed"} · ${sp.path}` : "not found on the PATH"],
            ["outbox", `${sp.outbox.path} · ${sp.outbox.present ? "present" : "not there yet"}`],
            ["events", s.events.total.toLocaleString()],
            ["last event", s.events.lastAt ? <Ago iso={s.events.lastAt} /> : "none"],
            ...installed.map((h): [string, React.ReactNode] => [h.label, <code key={h.name}>{h.configPath}</code>]),
          ]}
        />
      }
    >
      {installed.length > 0 && (
        <ul className="form-list step-harnesses" aria-label="Harnesses on this machine">
          {installed.map((h) => (
            <HarnessRow key={h.name} h={h} />
          ))}
        </ul>
      )}
      {pending.length > 0 && (
        <p className="step-pending" data-pending-harnesses>
          {andList(pending.map((h) => h.label))} {pending.length === 1 ? "doesn't" : "don't"} send hooks yet.
        </p>
      )}
      {mark !== "done" && (
        <div className="step-action step-action--col">
          {!sp.installed && (
            <>
              <Cmd text={INSTALL} />
              <p className="step-note">
                Run it in a terminal here: it adds the hooks to Claude Code, Codex, Gemini CLI and Antigravity. A
                harness reads its hooks when a conversation starts, so start a fresh one.
              </p>
            </>
          )}
          {sp.installed && (
            <p className="step-note">
              sessionpipe {sp.version ?? ""} is installed. Start a fresh conversation in any folder and its first event
              lands here.
            </p>
          )}
          {sp.installed && <Cmd text="claude" />}
        </div>
      )}
      {mark !== "done" && (
        <Listening label="Waiting for the first event">
          {installed
            .filter((h) => h.hooks === "on")
            .map((h) => h.label)
            .join(", ") || undefined}
        </Listening>
      )}
    </Step>
  );
}

// ---------- 2 · secure address ----------

type SecureSub = "turnOn" | "trust" | "open" | "done";

/** Can this browser reach the https origin without a certificate error? A no-cors fetch
 *  fails outright when the certificate is not trusted, and that is all we need to know. */
function useHttpsProbe(url: string, enabled: boolean): { ok: boolean | null; again: () => void } {
  const [ok, setOk] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let on = true;
    const run = () =>
      fetch(`${url}/api/ui/info`, { mode: "no-cors", cache: "no-store" }).then(
        () => on && setOk(true),
        () => on && setOk(false),
      );
    void run();
    const t = setInterval(() => void run(), 5000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [url, enabled, tick]);
  return { ok, again: useCallback(() => setTick((n) => n + 1), []) };
}

function SecureStep({ s, mark, open, onToggle }: { s: SetupStatus; mark: Mark } & Fold) {
  const store = useStore();
  const mac = s.platform === "darwin";
  const here = onHttpsOrigin(s);
  const sub: SecureSub =
    mark === "done" ? "done" : !s.tls.on ? "turnOn" : mac && s.tls.caTrusted !== true ? "trust" : "open";
  const probe = useHttpsProbe(s.tls.httpsUrl, sub === "open");
  useEffect(() => {
    if (sub === "open") noteOriginTrust(probe.ok);
    else if (sub === "done" || s.tls.caTrusted === true) noteOriginTrust(true);
    else if (s.tls.caTrusted === false) noteOriginTrust(false);
  }, [sub, probe.ok, s.tls.caTrusted]);

  const [busy, setBusy] = useState<"on" | "trust" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<TrustResult | null>(null);

  const turnOn = async () => {
    setBusy("on");
    setError(null);
    try {
      const r = await setupApi.tlsOn();
      resetInfoCache();
      await store.transport.info().catch(() => undefined);
      if (r.restartRequired) setError(`Restart needed: ${r.command ?? "sessionpipe-gui --tls"}`);
      await refreshSetup();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const doTrust = async () => {
    setBusy("trust");
    setError(null);
    setTrust(null);
    try {
      const r = await setupApi.tlsTrust();
      setTrust(r);
      if (r.error && !r.trusted) setError(r.error);
      await refreshSetup();
      probe.again();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const openHref = httpsPath("/setup") ?? `${s.tls.httpsUrl}/setup?k=${encodeURIComponent(s.uiKey)}`;
  const rp = s.tls.rpId;

  return (
    <Step
      attrs={{ "data-step": "secure" }}
      mark={mark}
      open={open}
      onToggle={onToggle}
      title="Secure address"
      caption={
        sub === "done" ? (
          <>
            Passkeys work here, on <code>{location.host}</code>
          </>
        ) : sub === "turnOn" ? (
          "Passkeys sign your messages and need https on a name; the GUI makes its own certificate."
        ) : sub === "trust" ? (
          "Trust the GUI's certificate on this Mac."
        ) : (
          "Open the secure address in this browser."
        )
      }
      why={
        <>
          <Facts
            rows={[
              ["TLS mode", s.tls.on ? "on" : "off"],
              ["https address", s.tls.httpsUrl],
              ["rp id", rp],
              [
                "this page",
                `${location.origin}${window.isSecureContext ? " · secure context" : " · not a secure context"}`,
              ],
              ["CA trusted here", mac ? yesNo(s.tls.caTrusted) : "cannot tell on this platform"],
              [
                "CA fingerprint",
                s.tls.caFingerprint ? <code className="passkeys-fp">{s.tls.caFingerprint}</code> : "no certificate yet",
              ],
              [
                `${s.tls.hostname} resolves`,
                s.tls.mdns.resolves ? `yes${s.tls.mdns.address ? ` · ${s.tls.mdns.address}` : ""}` : "no (mDNS)",
              ],
              ["openssl", yesNo(s.tls.opensslPresent)],
            ]}
          />
          <p>
            Phones are step 4. <code>http://localhost</code> keeps working for everything but signing.
          </p>
        </>
      }
    >
      {sub === "done" && (
        <p className="step-note">
          rp id <code>{rp}</code>.
        </p>
      )}
      {sub === "turnOn" && (
        <div className="step-action">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void turnOn()}
            disabled={busy !== null || !s.tls.opensslPresent}
            data-action="tls-on"
          >
            {busy === "on" ? "Turning on…" : "Turn on"}
          </button>
          <span className="step-note">
            {s.tls.opensslPresent
              ? "Adds https on this same port, now; remembered as --tls."
              : "Needs the openssl command (brew install openssl), then try again."}
          </span>
        </div>
      )}
      {sub === "trust" && (
        <div className="step-action step-action--col">
          <div className="step-action">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void doTrust()}
              disabled={busy !== null}
              data-action="tls-trust"
            >
              {busy === "trust" ? "Waiting for macOS…" : "Trust on this Mac"}
            </button>
            <span className="step-note">
              {busy === "trust"
                ? "macOS asks for your login password to add the CA to your keychain."
                : here
                  ? "You reached the secure address, but this Mac does not trust its certificate yet."
                  : "Adds the GUI's CA to your login keychain, trusted for SSL."}
            </span>
          </div>
          {trust && !trust.trusted && (
            <p className="step-note step-note--err" role="alert">
              {trust.settingPresent
                ? "The certificate is in the keychain but macOS still refuses it."
                : "The trust setting did not take."}{" "}
              {trust.manual}
            </p>
          )}
          {trust?.trusted && !here && probe.ok === false && (
            <p className="step-note step-note--err" role="alert">
              {QUIT_CHROME}
            </p>
          )}
        </div>
      )}
      {sub === "open" && (
        <div className="step-action step-action--col">
          {!mac && (
            <p className="step-note">
              Trust the CA on this machine first: <code>ca.crt</code> under the state dir's <code>tls/</code> folder
              (Debian: <code>sudo update-ca-certificates</code>; Fedora: <code>sudo trust anchor ca.crt</code>).
            </p>
          )}
          <div className="step-action">
            <a className={`btn ${probe.ok === false ? "" : "btn--primary"}`} href={openHref} data-action="open-https">
              Open the secure address
            </a>
            <span className="step-note">
              {probe.ok === null
                ? "Checking whether this browser trusts it…"
                : probe.ok
                  ? `This browser trusts ${s.tls.hostname}.`
                  : QUIT_CHROME}
            </span>
            {probe.ok === false && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={probe.again}>
                Check again
              </button>
            )}
          </div>
          {!s.tls.mdns.resolves && (
            <p className="step-note step-note--err">
              This machine does not resolve its own name <code>{s.tls.hostname}</code>; on Linux install avahi-daemon.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="step-note step-note--err" role="alert">
          {error}
        </p>
      )}
    </Step>
  );
}

// ---------- 3 · pair this machine ----------

function PairStep({ s, mark, secure, open, onToggle }: { s: SetupStatus; mark: Mark; secure: boolean } & Fold) {
  const d = s.daemon;
  const name = d.name ?? s.tls.hostname.replace(/\.local$/, "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const folders = picked ?? new Set(d.suggestedFolders);
  const toggle = (f: string) => {
    const next = new Set(folders);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    setPicked(next);
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await setupApi.pair([...folders]);
      await refreshSetup();
    } catch (e) {
      if (e instanceof SetupError && e.body.reason === "not_installed")
        setError(`No sessionpipe CLI on this machine. Run ${String(e.body.command ?? INSTALL)} first (step 1).`);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await setupApi.pairCancel();
      if (d.pendingPairing) await controlApi.reject(d.pendingPairing.code).catch(() => undefined);
      await refreshSetup();
    } finally {
      setBusy(false);
    }
  };

  const why = (
    <Facts
      rows={[
        ["daemon", d.running ? `running${d.name ? ` as ${d.name}` : ""}` : "not running (no control socket)"],
        ["paired here", yesNo(d.pairedHere)],
        ["online", yesNo(d.online)],
        ["machine id", d.machineId ?? "—"],
        ["pairing child", d.pairing.active ? "running" : d.pairing.error ? `stopped: ${d.pairing.error}` : "none"],
      ]}
    />
  );

  let caption: ReactNode = "Answer and prompt this machine's sessions from the board, signed with your passkey.";
  let body: React.ReactNode = null;
  if (mark === "done") {
    caption = `${name} is listening.`;
  } else if (d.pendingPairing) {
    caption = "Compare the six digits with the terminal's, then approve.";
    body = (
      <div className="step-inline-pair">
        <PairBody key={d.pendingPairing.code} code={d.pendingPairing.code} compact />
        <div className="step-action">
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void cancel()} disabled={busy}>
            Cancel pairing
          </button>
        </div>
      </div>
    );
  } else if (d.pairing.active) {
    caption = "Starting the pairing…";
    body = (
      <div className="step-action">
        <span className="step-wait" role="status">
          <Spinner label="starting" /> Starting <code>sessionpipe control pair</code>…
        </span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => void cancel()} disabled={busy}>
          Cancel
        </button>
      </div>
    );
  } else if (d.pairedHere && !d.online) {
    caption = d.running
      ? "Paired; waiting for the daemon's next poll."
      : "Paired, but the control daemon is not running.";
    body = (
      <div className="step-action step-action--col">
        <p className="step-note">
          {d.running ? (
            <>
              It asks every 25 seconds… <Spinner label="waiting" />
            </>
          ) : (
            <>
              In a terminal: <code>sessionpipe control run</code>, or pair again to reinstall it as a service.
            </>
          )}
        </p>
        {!d.running && (
          <button type="button" className="btn" onClick={() => void start()} disabled={busy || !secure}>
            Pair again
          </button>
        )}
      </div>
    );
  } else if (!secure) {
    caption = "Finish step 2 first: approving uses a passkey.";
  } else if (!s.sessionpipe.installed) {
    caption = "Install sessionpipe first (step 1).";
    body = <Cmd text={INSTALL} />;
  } else {
    body = (
      <div className="step-action step-action--col">
        {d.suggestedFolders.length > 0 && (
          <fieldset className="step-folders">
            <legend>Folders your messages may start or run sessions in</legend>
            <ul className="form-list">
              {d.suggestedFolders.map((f) => (
                <li key={f} className="form-row step-folder">
                  <label>
                    <input type="checkbox" checked={folders.has(f)} onChange={() => toggle(f)} />
                    <span className="mono">{f}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <div className="step-action">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void start()}
            disabled={busy}
            data-action="pair"
          >
            {busy ? "Starting…" : "Pair this Mac"}
          </button>
          <span className="step-note">
            Runs <code>sessionpipe control pair</code>; the six digits appear here to approve with your passkey.
          </span>
        </div>
        {d.pairing.error && (
          <p className="step-note step-note--err" role="alert">
            Last attempt: {d.pairing.error}
          </p>
        )}
      </div>
    );
  }

  return (
    <Step
      attrs={{ "data-step": "pair" }}
      mark={mark}
      open={open}
      onToggle={onToggle}
      title="Pair this machine"
      caption={caption}
      why={why}
    >
      {body}
      {error && (
        <p className="step-note step-note--err" role="alert">
          {error}
        </p>
      )}
    </Step>
  );
}

// ---------- 4 · your phone ----------

function PhoneStep({ s, mark, open, onToggle }: { s: SetupStatus; mark: Mark } & Fold) {
  const store = useStore();
  const qr = store.transport.qrUrl();
  const [broken, setBroken] = useState(false);
  return (
    <Step
      attrs={{ "data-step": "phone" }}
      mark={mark}
      open={open}
      onToggle={onToggle}
      title="Your phone"
      caption={
        mark === "done"
          ? `${s.viewers.phones === 1 ? "A phone is" : `${s.viewers.phones} phones are`} on the stream over https.`
          : "The same board on your phone, over the same Wi-Fi."
      }
      why={
        <>
          <Facts
            rows={[
              ["phones on the stream", String(s.viewers.phones)],
              [
                "TLS mode",
                s.tls.on
                  ? "on: the QR opens the trust page first"
                  : "off: the QR opens the board over plain http (viewing only)",
              ],
            ]}
          />
          <p>
            Android: Settings → Security → Install a certificate → CA certificate. Android builds vary on{" "}
            <code>.local</code> names; a hosts entry or the router's DNS can stand in.
          </p>
        </>
      }
    >
      <div className="step-phone">
        <div className="qr">
          {qr && !broken ? (
            <img src={qr} alt="QR code for your phone" width={160} height={160} onError={() => setBroken(true)} />
          ) : (
            <div className="qr-none" role="img" aria-label="QR code unavailable">
              <span>QR</span>
            </div>
          )}
        </div>
        <div className="step-phone-text">
          <p className="step-note">
            Scan it with the phone's camera on the same Wi-Fi: the board opens, signed in.
            {!s.tls.on && " Over plain http the phone can look but not sign."}
          </p>
          <p className="step-note">
            To send from the phone too, open{" "}
            <Link to="/phone" className="step-a" data-phone-link>
              Your phone
            </Link>
            : it gets an https address the phone trusts and its own passkey.
          </p>
        </div>
      </div>
    </Step>
  );
}

// ---------- 5 · try it ----------

function TryStep({
  s,
  mark,
  ready,
  onDelivered,
  open,
  onToggle,
}: {
  s: SetupStatus;
  mark: Mark;
  ready: boolean;
  onDelivered: () => void;
} & Fold) {
  const store = useStore();
  const { sessions } = useAppState();
  const live = useMemo(
    () =>
      [...sessions.values()]
        .filter((x) => sameMachineName(x.machine, s) && x.state !== "done" && !x.parentId)
        .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)),
    [sessions, s],
  );
  const [key, setKey] = useState("");
  const sessionId = useId();
  const messageId = useId();
  const chosen: SessionSummary | undefined = live.find((x) => x.key === key) ?? live[0];
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [tap, setTap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoOn, setDemoOn] = useState<boolean | null>(null);
  const msg = useMessage(sentId);
  useEffect(() => {
    if (msg?.outcome === "delivered") onDelivered();
  }, [msg?.outcome, onDelivered]);
  useEffect(() => {
    if (demoOn !== null) return;
    store.transport
      .info()
      .then((i) => setDemoOn(i.sources.demo))
      .catch(() => setDemoOn(false));
  }, [store, demoOn]);

  const rp = s.tls.rpId;
  const canSign = ready && passkeysAvailable(rp) && !!s.daemon.machineId;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen || !canSign || !s.daemon.machineId || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const a = await sendCommand(
        rp,
        s.daemon.machineId,
        { kind: "prompt", session: chosen.key, text: text.trim() },
        { onTap: () => setTap(true) },
      );
      setSentId(a.id);
      setText("");
    } catch (err) {
      setError(sendErrorWords(err));
    } finally {
      setTap(false);
      setBusy(false);
    }
  };
  const demo = async (on: boolean) => {
    setDemoBusy(true);
    try {
      const r = await store.transport.demo(on);
      setDemoOn(r.on);
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <Step
      attrs={{ "data-step": "try" }}
      mark={mark}
      open={open}
      onToggle={onToggle}
      title="Try it"
      caption={
        mark === "done"
          ? "A message reached a session and came back delivered."
          : !ready
            ? "Finish steps 2 and 3 first."
            : "Send one message to a live session here and watch the reply come back."
      }
      why={
        <Facts
          rows={[
            ["delivered so far", String(s.tried.delivered)],
            ["live sessions here", String(live.length)],
            ["can sign here", yesNo(canSign)],
          ]}
        />
      }
    >
      {mark !== "done" && ready && live.length === 0 && (
        <ul className="form-list">
          <li className="form-row">
            <span className="form-row-text">
              <span className="form-label">Demo mode</span>
              <span className="form-caption">
                No live session here right now: start one (<code>claude</code> in a folder), or look around with
                synthetic ones.
              </span>
            </span>
            <Toggle
              on={!!demoOn}
              onChange={(v) => void demo(v)}
              label="Demo mode"
              disabled={demoBusy || demoOn === null}
            />
          </li>
        </ul>
      )}
      {ready && live.length > 0 && (
        <form className="try-form" onSubmit={(e) => void send(e)} aria-label="Try a message">
          <div className="try-field">
            <label htmlFor={sessionId}>Session</label>
            <Select<string>
              id={sessionId}
              value={chosen?.key ?? ""}
              onChange={setKey}
              disabled={busy}
              options={live.map((x) => ({ value: x.key, label: sessionTitle(x), hint: x.state }))}
            />
          </div>
          <div className="try-field">
            <label htmlFor={messageId}>Message</label>
            <textarea
              id={messageId}
              className="field"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Say hello: what are you working on?"
              rows={2}
              disabled={busy || !canSign}
              maxLength={20_000}
            />
          </div>
          <div className="step-action">
            <button type="submit" className="btn btn--primary" disabled={busy || !canSign || !text.trim()}>
              {busy ? "Sending…" : "Send"}
            </button>
            <span className="step-note">
              {tap
                ? "Confirm with your passkey: it vouches for this browser for a day."
                : !canSign
                  ? "Passkeys cannot sign on this origin."
                  : s.daemon.online
                    ? `${chosen?.machine ?? "The machine"} is listening.`
                    : "The daemon is offline; the message waits."}
            </span>
          </div>
          {error && (
            <p className="step-note step-note--err" role="alert">
              {error}
            </p>
          )}
          {msg && (
            <ol className="try-acts" aria-label="Sent">
              <ActivityRow a={msg} machine={chosen?.machine} online={s.daemon.online} wide />
            </ol>
          )}
        </form>
      )}
    </Step>
  );
}

// ---------- 6 · from anywhere (optional) ----------

/** The port a proxy on this machine forwards to: the one TLS mode names, else this page's. */
function listenPort(s: SetupStatus): string {
  try {
    const p = new URL(s.tls.httpsUrl).port;
    if (p) return p;
  } catch {
    // fall through
  }
  return location.port || "7373";
}

function RemoteStep({ s, mark, open, onToggle }: { s: SetupStatus; mark: Mark } & Fold) {
  const store = useStore();
  const r = s.remote;
  const ts = r?.tailscale;
  const url = publicUrl(s);
  const port = listenPort(s);
  const [busy, setBusy] = useState<"on" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (what: "on" | "off", run: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await run();
      // The rp id changed under the running server: every cached fact about it is stale.
      resetInfoCache();
      await store.transport.info().catch(() => undefined);
      await refreshSetup();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const use = (u: string) => act("on", () => setupApi.remoteOn(u));
  const stop = () => act("off", () => setupApi.remoteOff());

  const dnsUrl = ts?.dnsName ? `https://${ts.dnsName}` : null;
  const serveCmd = `tailscale serve --bg ${port}`;
  const proxyNote = (
    <p className="step-note">
      Any other https proxy on this machine works too: point it at port <code>{port}</code>, let it forward{" "}
      <code>X-Forwarded-For</code>, then <code>sessionpipe-gui --public-url https://&lt;its name&gt;</code>.
    </p>
  );

  let caption: ReactNode = "An https address phones already trust, from outside your Wi-Fi.";
  let body: React.ReactNode;
  if (mark === "done" && url) {
    caption = url;
    body = (
      <div className="step-action step-action--col">
        <Cmd text={url} />
        <p className="step-note">
          {r?.viewers === 0 || r?.viewers === undefined
            ? "No device has come through it yet."
            : `${r.viewers} ${r.viewers === 1 ? "device" : "devices"} came through it.`}{" "}
          Passkeys are made for <code>{s.tls.rpId}</code> now.
        </p>
        {ts?.serving === false && (
          <p className="step-note step-note--err">
            <code>tailscale serve</code> is not forwarding to port {port} yet: <code>{serveCmd}</code> on this machine.
          </p>
        )}
        <div className="step-action">
          <button
            type="button"
            className="btn"
            onClick={() => void stop()}
            disabled={busy !== null}
            data-action="remote-off"
          >
            {busy === "off" ? "Stopping…" : "Stop using it"}
          </button>
          <span className="step-note">The rp id goes back to {s.tls.on ? s.tls.hostname : "localhost"}.</span>
        </div>
      </div>
    );
  } else if (!r || !ts) {
    body = (
      <div className="step-action step-action--col">
        <p className="step-note">
          This server does not report Tailscale yet; start it with <code>--public-url</code> once it does.
        </p>
        {proxyNote}
      </div>
    );
  } else if (!ts.installed) {
    body = (
      <div className="step-action step-action--col">
        <p className="step-note">
          Tailscale is not installed here: get it at{" "}
          <a href="https://tailscale.com/download" className="step-a" target="_blank" rel="noreferrer">
            tailscale.com/download
          </a>
          , sign in, and this step continues by itself.
        </p>
        {proxyNote}
      </div>
    );
  } else if (!ts.running) {
    body = (
      <div className="step-action step-action--col">
        <p className="step-note">Tailscale is installed but not connected: open it and sign in.</p>
        {proxyNote}
      </div>
    );
  } else if (!dnsUrl) {
    body = (
      <div className="step-action step-action--col">
        <p className="step-note">
          Tailscale is connected but has no MagicDNS name for this machine yet: turn on MagicDNS and HTTPS certificates
          in the tailnet's DNS settings.
        </p>
        {proxyNote}
      </div>
    );
  } else {
    body = (
      <div className="step-action step-action--col">
        <p className="step-note">Once, in a terminal on this machine (Tailscale remembers it):</p>
        <Cmd text={serveCmd} />
        <div className="step-action">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void use(dnsUrl)}
            disabled={busy !== null}
            data-action="remote-on"
          >
            {busy === "on" ? "Switching…" : `Use ${dnsUrl}`}
          </button>
          <span className="step-note">
            {ts.serving === false ? "Run the command first. " : ""}Passkeys are made again for this name on first use.
          </span>
        </div>
      </div>
    );
  }

  return (
    <Step
      attrs={{ "data-step": "remote" }}
      mark={mark}
      open={open}
      onToggle={onToggle}
      optional
      title="From anywhere"
      caption={caption}
      why={
        <Facts
          rows={[
            ["public url", url ?? "none"],
            ["rp id", s.tls.rpId],
            [
              "tailscale",
              !ts
                ? "not reported by this server"
                : !ts.installed
                  ? "not installed"
                  : !ts.running
                    ? "installed, not connected"
                    : `connected${ts.ips?.length ? ` · ${ts.ips.join(", ")}` : ""}`,
            ],
            ["dns name", ts?.dnsName ?? "—"],
            ["serving this port", ts ? yesNo(ts.serving) : "unknown"],
            ["viewers through it", String(r?.viewers ?? 0)],
          ]}
        />
      }
    >
      {body}
      {error && (
        <p className="step-note step-note--err" role="alert">
          {error}
        </p>
      )}
    </Step>
  );
}
