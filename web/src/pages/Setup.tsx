// SPDX-License-Identifier: Apache-2.0
// Owned by: onboarding. /setup: a first run in five steps, each green when this machine
// has done its part, with one action each, and an optional sixth (the GUI from anywhere
// through a trusted https proxy) that is never "needs you". The facts come from GET
// /api/ui/setup/status every two seconds (this machine only), so a step turns green by
// itself the moment the outbox gets its first event, the CA is trusted, the daemon polls, a
// phone connects, a message comes back delivered. Everything an action does is explained
// next to it.
import type { HarnessStatus, SessionSummary, SetupStatus } from "@shared/api";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Ago, CopyButton, HarnessGlyph, Spinner, Toggle } from "../components/bits";
import { Select } from "../components/Select";
import { ActivityRow } from "../control/Activity";
import { controlApi, httpsPath, resetInfoCache } from "../control/api";
import { sendCommand } from "../control/command";
import { useMessage } from "../control/hooks";
import { PairBody } from "../control/Pair";
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
import "./setup.css";

export const INSTALL = "npx sessionpipe install";
export const QUIT_CHROME = "Chrome keeps the old verdict until you quit and reopen it (⌘Q)";

type Mark = "done" | "needs" | "todo";

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

  const skip = () => {
    markSetupSeen();
    navigate("/");
  };

  return (
    <div className="page setup">
      <header className="setup-head">
        <h1>Set up sessionpipe gui</h1>
        <p className="setup-lead">
          Five steps, each green once this machine has done its part, and an optional sixth for the road. The page
          checks every two seconds, so a step turns green by itself. Nothing leaves your network.
        </p>
      </header>
      {state.local === false && (
        <p className="pair-note" role="status">
          Setup runs on the machine that runs sessionpipe-gui: open <code>http://localhost:7373/setup</code> there. This
          device is a viewer; it gets step 4's treatment from that page.
        </p>
      )}
      {state.local !== false && !s && <p className="page-note">Reading this machine…</p>}
      {state.error && s && <p className="page-note is-err">Last check failed: {state.error}. Trying again.</p>}
      {s && done && (
        <ol className="steps">
          <SessionsStep s={s} mark={marks.sessions} />
          <SecureStep s={s} mark={marks.secure} />
          <PairStep s={s} mark={marks.pair} secure={done.secure} />
          <PhoneStep s={s} mark={marks.phone} />
          <TryStep s={s} mark={marks.try} ready={done.secure && done.pair} onDelivered={() => setTried(true)} />
          <RemoteStep s={s} mark={marks.remote} />
        </ol>
      )}
      {s && done && (
        <p className="page-note setup-extras" data-setup-extras>
          <span>
            <strong>Optional · Extras.</strong> Canvas and Office are already in; Spacesheep Vivid, Paper Serif and the
            ping-a-human Telegram plugin are one click each on the{" "}
            <Link to="/themes" className="setup-extras-link">
              Views page
            </Link>
            , or <code>sessionpipe-gui extras add all</code> in a terminal.
          </span>
        </p>
      )}
      {s &&
        (allDone ? (
          <div className="setup-done" role="status" data-setup-done>
            <span>
              <strong>You're set.</strong> Sessions show up as they run, your phone can read and answer, and this Mac's
              daemon takes your messages.
            </span>
            <button type="button" className="btn btn--primary" onClick={skip}>
              Open the board
            </button>
          </div>
        ) : (
          <p className="page-note setup-skip">
            Not now?{" "}
            <button type="button" className="setup-skip-btn" onClick={skip} data-setup-skip>
              Skip setup
            </button>
            <span>· the rail keeps a Setup entry until the steps are green.</span>
          </p>
        ))}
    </div>
  );
}

// ---------- the row ----------

function Step({
  k,
  n,
  mark,
  title,
  what,
  children,
  why,
  optional = false,
}: {
  k: StepKey;
  n: number;
  mark: Mark;
  title: string;
  what: string;
  children?: React.ReactNode;
  why?: React.ReactNode;
  /** Never "needs you": a quiet "optional" stands where that word would go. */
  optional?: boolean;
}) {
  const label = mark === "done" ? "done" : mark === "needs" ? "needs you" : optional ? "optional" : "later";
  return (
    <li className={`step step--${mark}`} data-step={k} data-mark={mark}>
      <span className={`step-mark step-mark--${mark}`} role="img" aria-label={label}>
        {mark === "done" ? (
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <path
              d="M4.5 10.5l3.5 3.5 7.5-8"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <span className="step-dot" aria-hidden="true" />
        )}
      </span>
      <div className="step-body">
        <h2 className="step-title">
          <span className="step-n num">{n}</span>
          {title}
          {mark === "needs" && <span className="step-needs">needs you</span>}
          {optional && mark !== "done" && <span className="step-optional">optional</span>}
        </h2>
        <p className="step-what">{what}</p>
        {children}
        {why && (
          <details className="step-why">
            <summary>{mark === "done" || optional ? "details" : "why isn't this green?"}</summary>
            <div className="step-why-body">{why}</div>
          </details>
        )}
      </div>
    </li>
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

const yesNo = (v: boolean | null | undefined) => (v === null || v === undefined ? "unknown" : v ? "yes" : "no");

// ---------- 1 · your sessions ----------

/** One installed harness of the registry and where it stands: hooks on (with this
 *  machine's sessions), hooks off (the install command writes them), or no adapter yet. */
function HarnessRow({ h }: { h: HarnessStatus }) {
  let status: React.ReactNode;
  if (h.hooks === "on")
    status = (
      <>
        hooks on · {h.sessions === 0 ? "no sessions yet" : `${h.sessions} ${h.sessions === 1 ? "session" : "sessions"}`}
        {h.lastEventAt && (
          <>
            {" "}
            · last <Ago iso={h.lastEventAt} />
          </>
        )}
      </>
    );
  else if (h.hooks === "off") status = "hooks off · run the install command";
  else status = "installed · sessionpipe support pending";
  return (
    <li
      className={`step-harness${h.hooks === "off" ? " step-harness--needs" : ""}`}
      data-harness={h.name}
      data-hooks={h.hooks}
    >
      <HarnessGlyph name={h.name} size="sm" withLabel />
      <span className="step-harness-status">{status}</span>
    </li>
  );
}

function SessionsStep({ s, mark }: { s: SetupStatus; mark: Mark }) {
  const sp = s.sessionpipe;
  const installed = s.harnesses.filter((h) => h.installed);
  return (
    <Step
      k="sessions"
      n={1}
      mark={mark}
      title="Your sessions"
      what="The sessionpipe hooks write every session on this machine to an outbox; the board tails it."
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
        <ul className="step-harnesses" aria-label="Harnesses on this machine">
          {installed.map((h) => (
            <HarnessRow key={h.name} h={h} />
          ))}
        </ul>
      )}
      {mark === "done" ? (
        <p className="step-note">
          {s.events.total.toLocaleString()} events
          {sp.outbox.sessions ? ` from ${sp.outbox.sessions} sessions in the outbox` : ""}
          {s.events.lastAt && (
            <>
              {" "}
              · last <Ago iso={s.events.lastAt} />
            </>
          )}
          .
        </p>
      ) : (
        <div className="step-action step-action--col">
          {!sp.installed && (
            <>
              <div className="cmd">
                <pre className="step-cmd">
                  <code>{INSTALL}</code>
                </pre>
                <CopyButton text={INSTALL} label="Copy" small />
              </div>
              <p className="step-note">
                Run it in a terminal on this machine: it adds the hooks to Claude Code, Codex, Gemini CLI and
                Antigravity and starts the outbox. Then start a fresh conversation anywhere: a harness reads its hooks
                when a conversation starts (Antigravity its <code>hooks.json</code>), so one already open stays silent.
              </p>
            </>
          )}
          {sp.installed && (
            <p className="step-note">
              sessionpipe {sp.version ?? ""} is installed. Start a fresh conversation (<code>claude</code> in any
              project folder) and its first event lands here; a harness marked <em>hooks off</em> needs the install
              command run again.
            </p>
          )}
          <p className="step-wait" role="status">
            <Spinner label="waiting" /> waiting for the first event…
          </p>
        </div>
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

function SecureStep({ s, mark }: { s: SetupStatus; mark: Mark }) {
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
      k="secure"
      n={2}
      mark={mark}
      title="Secure address"
      what="Passkeys sign your messages, and a passkey needs https on a name. The GUI makes its own local certificate authority for this port."
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
          Passkeys work here: <code>{location.origin}</code>, rp id <code>{rp}</code>.
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
              ? `Makes the certificates and adds https on this same port, now; remembered as --tls.`
              : "Needs the openssl command (brew install openssl / apt install openssl), then try again."}
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
                ? "macOS is asking for your login password: it adds the CA to your keychain with “Always Trust” for SSL."
                : here
                  ? "You reached the secure address, but this Mac does not trust the certificate yet (the browser may have let you through a warning; passkeys refuse that)."
                  : "Adds the GUI's CA to your login keychain and marks it trusted for SSL (macOS asks for your password)."}
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
              Trust the CA on this machine first: <code>{s.tls.hostname}</code>'s <code>ca.crt</code> is under the state
              dir's <code>tls/</code> folder. Debian/Ubuntu: <code>sudo update-ca-certificates</code>; Fedora:{" "}
              <code>sudo trust anchor ca.crt</code>; Chrome and Firefox import it under Settings → Certificates →
              Authorities.
            </p>
          )}
          <div className="step-action">
            <a
              className={`btn ${probe.ok === false ? "btn--ghost" : "btn--primary"}`}
              href={openHref}
              data-action="open-https"
            >
              Open the secure address
            </a>
            <span className="step-note">
              {probe.ok === null
                ? "Checking whether this browser trusts it…"
                : probe.ok
                  ? `This browser trusts ${s.tls.hostname}. The page continues there.`
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
              This machine does not resolve its own name <code>{s.tls.hostname}</code>. macOS does by itself; on Linux
              install avahi-daemon (or nss-mdns). Until then the https address works from other devices only.
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

function PairStep({ s, mark, secure }: { s: SetupStatus; mark: Mark; secure: boolean }) {
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

  let body: React.ReactNode;
  if (mark === "done") {
    body = <p className="step-note">{name} is listening.</p>;
  } else if (d.pendingPairing) {
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
    body = (
      <div className="step-action step-action--col">
        <p className="step-note">
          {d.running ? (
            <>
              Paired. Waiting for the daemon's next poll (it asks every 25 seconds)… <Spinner label="waiting" />
            </>
          ) : (
            <>
              Paired, but the control daemon is not running. In a terminal: <code>sessionpipe control run</code>, or
              pair again to reinstall it as a service.
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
    body = <p className="step-note step-gate">finish step 2 first — approving uses a passkey</p>;
  } else if (!s.sessionpipe.installed) {
    body = (
      <p className="step-note">
        Install sessionpipe first (step 1): <code>{INSTALL}</code>.
      </p>
    );
  } else {
    body = (
      <div className="step-action step-action--col">
        {d.suggestedFolders.length > 0 && (
          <fieldset className="step-folders">
            <legend>Folders your messages may start or run sessions in</legend>
            {d.suggestedFolders.map((f) => (
              <label key={f}>
                <input type="checkbox" checked={folders.has(f)} onChange={() => toggle(f)} />
                <span className="mono">{f}</span>
              </label>
            ))}
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
            Runs <code>sessionpipe control pair</code> for you; the six digits appear right here to approve with your
            passkey. The daemon is installed as a service so it keeps listening.
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
      k="pair"
      n={3}
      mark={mark}
      title="Pair this machine"
      what="Pairing lets you answer and prompt sessions on this machine from the board: its daemon takes signed messages from your passkey."
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

function PhoneStep({ s, mark }: { s: SetupStatus; mark: Mark }) {
  const store = useStore();
  const qr = store.transport.qrUrl();
  const [broken, setBroken] = useState(false);
  const name = s.daemon.name ?? s.tls.hostname.replace(/\.local$/, "");
  return (
    <Step
      k="phone"
      n={4}
      mark={mark}
      title="Your phone"
      what="The same board on your phone, over the same Wi-Fi; the QR code signs it in and walks it through trusting the certificate."
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
            Android: Settings → Security → More security settings → Install a certificate → CA certificate, then the
            https button. Android builds vary on <code>.local</code> names; a hosts entry or the router's DNS can stand
            in.
          </p>
        </>
      }
    >
      <div className="step-phone">
        <div className="qr">
          {qr && !broken ? (
            <img src={qr} alt="QR code for your phone" width={168} height={168} onError={() => setBroken(true)} />
          ) : (
            <div className="qr-none" role="img" aria-label="QR code unavailable">
              <span>QR</span>
            </div>
          )}
        </div>
        <div className="step-phone-text">
          {mark === "done" ? (
            <p className="step-note">
              {s.viewers.phones === 1 ? "A phone is" : `${s.viewers.phones} phones are`} on the stream over https.
            </p>
          ) : (
            <ol className="step-list">
              <li>Scan the code with the phone's camera (same Wi-Fi). It opens the trust page.</li>
              <li>
                Tap <strong>Download the certificate</strong>, allow it, then Settings →{" "}
                <strong>Profile Downloaded</strong> → Install.
              </li>
              <li>
                Settings → General → About → <strong>Certificate Trust Settings</strong>: turn on{" "}
                <em>sessionpipe-gui local CA</em>.
              </li>
              <li>Back on the trust page, tap the https address. The board opens, signed in.</li>
            </ol>
          )}
          {!s.tls.on && mark !== "done" && (
            <p className="step-note step-note--err">
              Turn on the secure address first (step 2); over plain http the phone can look but not sign.
            </p>
          )}
          <p className="step-note">
            To send from the phone it needs its own passkey: on the phone open <code>/add-device</code> (“Add this
            device”), then approve its six digits on <Link to="/machines">Machines</Link> here, from a device {name}{" "}
            already trusts.
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
}: {
  s: SetupStatus;
  mark: Mark;
  ready: boolean;
  onDelivered: () => void;
}) {
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
      k="try"
      n={5}
      mark={mark}
      title="Try it"
      what="Send one message to a live session on this machine and watch the reply come back; the first send of the day asks for your passkey once."
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
      {mark === "done" && <p className="step-note">A message reached a session and came back delivered.</p>}
      {mark !== "done" && !ready && <p className="step-note step-gate">finish steps 2 and 3 first</p>}
      {mark !== "done" && ready && live.length === 0 && (
        <div className="step-action step-action--col">
          <p className="step-note">
            No live session on this machine right now. Start one: <code>claude</code> in a project folder, and it
            appears here within a second.
          </p>
          <div className="step-action">
            <Toggle
              on={!!demoOn}
              onChange={(v) => void demo(v)}
              label="Demo mode"
              disabled={demoBusy || demoOn === null}
            />
            <span className="step-note">
              Demo mode fills the board with synthetic sessions to look around (they cannot be messaged).
            </span>
          </div>
        </div>
      )}
      {ready && live.length > 0 && (
        <form className="try-form" onSubmit={(e) => void send(e)} aria-label="Try a message">
          <label htmlFor={sessionId}>
            session
            <Select<string>
              id={sessionId}
              value={chosen?.key ?? ""}
              onChange={setKey}
              disabled={busy}
              options={live.map((x) => ({ value: x.key, label: sessionTitle(x), hint: x.state }))}
            />
          </label>
          <label>
            message
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Say hello: what are you working on?"
              rows={2}
              disabled={busy || !canSign}
              maxLength={20_000}
            />
          </label>
          <div className="step-action">
            <button type="submit" className="btn btn--primary" disabled={busy || !canSign || !text.trim()}>
              {busy ? "Sending…" : "Send"}
            </button>
            <span className="step-note">
              {tap
                ? "Confirm with your passkey: it vouches for this browser for a day."
                : !canSign
                  ? "passkeys cannot sign on this origin"
                  : s.daemon.online
                    ? `${chosen?.machine ?? "the machine"} is listening`
                    : "the daemon is offline; the message waits"}
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

function RemoteStep({ s, mark }: { s: SetupStatus; mark: Mark }) {
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
      Any other https proxy works too: run it on this machine, point it at port <code>{port}</code> and let it forward{" "}
      <code>X-Forwarded-For</code>; then <code>sessionpipe-gui --public-url https://&lt;its name&gt;</code>.
    </p>
  );

  let body: React.ReactNode;
  if (mark === "done" && url) {
    body = (
      <div className="step-action step-action--col">
        <div className="cmd">
          <pre className="step-cmd">
            <code>{url}</code>
          </pre>
          <CopyButton text={url} label="Copy" small />
        </div>
        <p className="step-note">
          {r?.viewers === 0 || r?.viewers === undefined
            ? "No device has come through it yet."
            : `${r.viewers} ${r.viewers === 1 ? "device" : "devices"} came through it.`}{" "}
          Passkeys are made for <code>{s.tls.rpId}</code> now; a browser that signed on the <code>.local</code> name
          makes a new one on first use.
        </p>
        {ts?.serving === false && (
          <p className="step-note step-note--err">
            <code>tailscale serve</code> is not forwarding to port {port} yet: <code>{serveCmd}</code> on this machine.
          </p>
        )}
        <p className="step-note">
          <button
            type="button"
            className="step-link"
            onClick={() => void stop()}
            disabled={busy !== null}
            data-action="remote-off"
          >
            {busy === "off" ? "Stopping…" : "Stop using it"}
          </button>
          <span> · the rp id goes back to {s.tls.on ? s.tls.hostname : "localhost"}.</span>
        </p>
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
          Tailscale is connected but has no MagicDNS name for this machine yet. Turn on MagicDNS and HTTPS certificates
          in the tailnet's DNS settings, then this step continues by itself.
        </p>
        {proxyNote}
      </div>
    );
  } else {
    body = (
      <div className="step-action step-action--col">
        <p className="step-note">In a terminal on this machine, once (Tailscale remembers it across restarts):</p>
        <div className="cmd">
          <pre className="step-cmd">
            <code>{serveCmd}</code>
          </pre>
          <CopyButton text={serveCmd} label="Copy" small />
        </div>
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
            {ts.serving === false ? "The serve is not forwarding here yet; run the command first. " : ""}
            Passkeys made for <code>{s.tls.hostname}</code> will be made again for this name on first use.
          </span>
        </div>
      </div>
    );
  }

  return (
    <Step
      k="remote"
      n={6}
      mark={mark}
      optional
      title="From anywhere"
      what="Outside your Wi-Fi the GUI needs an https address that phones already trust. Tailscale gives one with no port forwarding; any https proxy that forwards X-Forwarded-For works."
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
