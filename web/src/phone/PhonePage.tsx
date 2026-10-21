// SPDX-License-Identifier: Apache-2.0
// Owned by: phone-web. /phone: one page that gets a phone onto the board and sending from
// it, in three steps, read on the laptop and on the phone itself (the same url, two sides,
// phone/state.ts tells them apart). 1 · See it: the LAN QR with the key. 2 · Send: a passkey
// needs an https address the phone trusts, so one lane is recommended (Tailscale when it is
// on this machine, else the same Wi-Fi with the local CA) and the rest fold under "Other
// ways". 3 · Trust: the phone makes its passkey and asks; the laptop approves the six digits
// (control/PendingDevices.tsx, the same request the inbox shows). The facts come from GET
// /api/ui/phone every two seconds, so a step turns green by itself.
import type { PhoneInfo } from "@shared/api";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Ago } from "../components/bits";
import { controlApi, type DeviceRequest, originPath, resetInfoCache, wrongOriginHref } from "../control/api";
import { useRpId } from "../control/hooks";
import { PendingDevices } from "../control/PendingDevices";
import { useDeviceRequest } from "../control/useDeviceRequest";
import { guessDeviceName, passkeysAvailable } from "../control/webauthn";
import { refusalWords } from "../control/words";
import { useAppState, useStore } from "../data/hooks";
import { Link } from "../lib/router";
import { useSetupStatus } from "../setup/api";
import { phoneApi, pollPhoneDevice, usePhoneInfo } from "./api";
import { Qr } from "./Qr";
import {
  currentStep,
  digitsOf,
  type Lane,
  type PhoneOs,
  phoneOs,
  phoneStep2,
  phonesConnected,
  pickLane,
  sendingUrl,
  side as sideOf,
  tailscaleState,
  trustUrl,
} from "./state";
import "../pages/setup.css";
import "../control/control.css";
import "./phone.css";

type Mark = "done" | "needs" | "todo";

export function PhonePage() {
  const { info, missing, error, apply } = usePhoneInfo();
  const setup = useSetupStatus();
  const viewers = useAppState().viewers;
  const ua = navigator.userAgent;
  const side = sideOf(setup.local, ua);
  const os = phoneOs(ua);
  const phones = phonesConnected(viewers);

  if (missing)
    return (
      <div className="page phone-page">
        <h1>Your phone</h1>
        <p className="pair-note" role="status">
          This server has no phone page yet. The <Link to="/setup">Setup page</Link> walks a phone through it.
        </p>
      </div>
    );
  if (!info)
    return (
      <div className="page phone-page">
        <h1>Your phone</h1>
        <p className="page-note">{error ? `Last check failed: ${error}. Trying again.` : "Reading this machine…"}</p>
      </div>
    );

  const https = sendingUrl(info);
  const loc = { protocol: location.protocol, hostname: location.hostname };
  const step2 = side === "phone" ? phoneStep2(loc, info.rpId, https) : null;
  const onHttps = side === "phone" ? step2 === "secure" : !!https;
  const trusted = info.trusted.length > 0;
  const now = currentStep({ phones: side === "phone" ? 1 : phones, https: onHttps, trusted });
  const mark = (n: 1 | 2 | 3): Mark => (now === 0 || n < now ? "done" : n === now ? "needs" : "todo");

  return (
    <div className="page phone-page" data-side={side} data-lane={pickLane(info)}>
      <header className="setup-head">
        <h1>Your phone</h1>
        <p className="setup-lead">
          {side === "laptop"
            ? "See the board on your phone, then send from it. Three steps; this page checks every two seconds."
            : "The board is already here. Two more steps and this phone can answer and send."}
        </p>
      </header>
      {error && <p className="page-note is-err">Last check failed: {error}. Trying again.</p>}
      <ol className="steps">
        <SeeStep info={info} side={side} phones={phones} mark={mark(1)} />
        <SendStep info={info} side={side} os={os} step2={step2} onInfo={apply} mark={mark(2)} />
        <TrustStep info={info} side={side} secure={onHttps} mark={mark(3)} />
      </ol>
    </div>
  );
}

// ---------- the row (the setup page's form, without its facts) ----------

function Step({
  n,
  mark,
  title,
  what,
  chip,
  children,
}: {
  n: number;
  mark: Mark;
  title: string;
  what: ReactNode;
  chip?: ReactNode;
  children?: ReactNode;
}) {
  const label = mark === "done" ? "done" : mark === "needs" ? "now" : "later";
  return (
    <li className={`step step--${mark}`} data-phone-step={n} data-mark={mark}>
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
          {chip}
        </h2>
        <p className="step-what">{what}</p>
        {children}
      </div>
    </li>
  );
}

/** A quiet state word in a heading: "connected", "running", "serving". */
const Chip = ({ children, on = false }: { children: ReactNode; on?: boolean }) => (
  <span className={`ph-chip ${on ? "ph-chip--on" : ""}`}>{children}</span>
);

// ---------- 1 · see it ----------

function SeeStep({
  info,
  side,
  phones,
  mark,
}: {
  info: PhoneInfo;
  side: "laptop" | "phone";
  phones: number;
  mark: Mark;
}) {
  if (side === "phone")
    return (
      <Step n={1} mark="done" title="See it on your phone" what="You are reading it: this phone is on the board." />
    );
  return (
    <Step
      n={1}
      mark={mark}
      title="See it on your phone"
      what="Scan with the phone's camera, on the same Wi-Fi. The key in the address signs it in."
      chip={phones > 0 ? <Chip on>{phones === 1 ? "connected" : `${phones} connected`}</Chip> : undefined}
    >
      <div className="ph-row">
        <Qr url={info.lan.url} src={info.lan.qr} alt="QR code with the Wi-Fi address and the UI key" />
        <p className="step-note ph-url">
          <code>{info.lan.url}</code>
        </p>
      </div>
    </Step>
  );
}

// ---------- 2 · send from it ----------

function SendStep({
  info,
  side,
  os,
  step2,
  onInfo,
  mark,
}: {
  info: PhoneInfo;
  side: "laptop" | "phone";
  os: PhoneOs;
  step2: "secure" | "wrong" | "plain" | null;
  onInfo: (info: PhoneInfo) => void;
  mark: Mark;
}) {
  const lane = pickLane(info);
  const other: Lane = lane === "tailscale" ? "wifi" : "tailscale";
  const laneBody = (l: Lane) =>
    l === "tailscale" ? (
      <TailscaleLane info={info} side={side} onInfo={onInfo} recommended={l === lane} />
    ) : (
      <WifiLane info={info} side={side} os={os} step2={step2} recommended={l === lane} />
    );
  const wrongHref = wrongOriginHref();
  return (
    <Step
      n={2}
      mark={mark}
      title="Send from your phone"
      what="Sending needs a passkey, and a passkey needs an https address your phone trusts."
    >
      {step2 === "wrong" && sendingUrl(info) ? (
        <p className="pair-note" data-wrong-origin>
          Sending works from <a href={wrongHref ?? sendingUrl(info) ?? "#"}>{sendingUrl(info)}</a>; open it there.
        </p>
      ) : step2 === "secure" ? (
        <p className="step-note" data-secure>
          This phone trusts <code>{location.host}</code>; passkeys work here.
        </p>
      ) : (
        <>
          <section
            className="ph-lane"
            data-lane={lane}
            aria-label={lane === "tailscale" ? "Use Tailscale" : "Same Wi-Fi"}
          >
            {laneBody(lane)}
          </section>
          <details className="ph-other">
            <summary>Other ways</summary>
            <div className="ph-other-body">
              <section
                className="ph-lane"
                data-lane={other}
                aria-label={other === "tailscale" ? "Use Tailscale" : "Same Wi-Fi"}
              >
                {laneBody(other)}
              </section>
              <p className="step-note">
                <strong>spacesheep.dev</strong> · a hosted receiver with its own https address: point a sink at it and
                open it on the phone; nothing to install or trust.
              </p>
            </div>
          </details>
        </>
      )}
    </Step>
  );
}

function TailscaleLane({
  info,
  side,
  onInfo,
  recommended,
}: {
  info: PhoneInfo;
  side: "laptop" | "phone";
  onInfo: (info: PhoneInfo) => void;
  recommended: boolean;
}) {
  const store = useStore();
  const state = tailscaleState(info);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const use = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await phoneApi.tailscale();
      // The rp id changed under the running server: every cached fact about it is stale.
      resetInfoCache();
      await store.transport.info().catch(() => undefined);
      onInfo(next);
    } catch (e) {
      // 409 (not installed, not connected, no MagicDNS name) or 502 (the CLI refused): the server's words, verbatim.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const chip =
    state === "serving" ? (
      <Chip on>serving</Chip>
    ) : state === "running" ? (
      <Chip>running</Chip>
    ) : state === "off" ? (
      <Chip>not connected</Chip>
    ) : (
      <Chip>not installed</Chip>
    );
  const phoneLine = "On the phone: the Tailscale app, signed into the same account.";
  return (
    <>
      <h3 className="ph-lane-title">
        Use Tailscale {chip}
        {recommended && <span className="ph-reco">recommended</span>}
      </h3>
      {state === "serving" && info.publicUrl ? (
        <div className="ph-row">
          {side === "laptop" && <Qr url={info.publicUrl} alt="QR code with the Tailscale address" />}
          <div className="ph-col">
            <p className="step-note">
              <code>{info.publicUrl}</code>
            </p>
            <p className="step-note">{phoneLine}</p>
            {side === "phone" && (
              <p className="step-note">
                <a className="btn btn--primary" href={originPath(info.publicUrl, "/phone") ?? info.publicUrl}>
                  Open it here →
                </a>
              </p>
            )}
          </div>
        </div>
      ) : state === "running" ? (
        side === "laptop" ? (
          <div className="step-action">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void use()}
              data-action="tailscale"
            >
              {busy ? "Setting up…" : "Use Tailscale"}
            </button>
            <span className="step-note">
              {info.tailscale.name ? (
                <>
                  Serves this port at <code>https://{info.tailscale.name}</code>. {phoneLine}
                </>
              ) : (
                "Turn on MagicDNS and HTTPS certificates in the tailnet's DNS settings first."
              )}
            </span>
          </div>
        ) : (
          <p className="step-note">On the laptop, this page has a “Use Tailscale” button. {phoneLine}</p>
        )
      ) : state === "off" ? (
        <p className="step-note">Tailscale is installed on the laptop but not connected: open it and sign in.</p>
      ) : (
        <p className="step-note">
          Tailscale is not on the laptop: get it at{" "}
          <a className="step-a" href="https://tailscale.com/download" target="_blank" rel="noreferrer">
            tailscale.com/download
          </a>
          , sign in, and this lane continues by itself.
        </p>
      )}
      {error && (
        <p className="step-note step-note--err" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

const IPHONE_STEPS: { id: string; body: ReactNode }[] = [
  {
    id: "install",
    body: (
      <>
        Tap <strong>Download the certificate</strong> on the trust page, allow it, then Settings →{" "}
        <strong>Profile Downloaded</strong> → Install.
      </>
    ),
  },
  {
    id: "trust",
    body: (
      <>
        Settings → General → About → <strong>Certificate Trust Settings</strong>: turn on full trust for{" "}
        <em>sessionpipe-gui local CA</em>.
      </>
    ),
  },
];
const ANDROID_STEPS: { id: string; body: ReactNode }[] = [
  {
    id: "download",
    body: (
      <>
        Tap <strong>Download the certificate</strong> on the trust page.
      </>
    ),
  },
  {
    id: "install",
    body: (
      <>
        Settings → Security → <strong>Install from storage</strong> → <strong>CA certificate</strong>, pick the file.
      </>
    ),
  },
  {
    id: "local",
    body: (
      <>
        Android often cannot resolve a <code>.local</code> name: if the https address will not open, use the Tailscale
        lane, or add the name to the router's DNS.
      </>
    ),
  },
];

function WifiLane({
  info,
  side,
  os,
  step2,
  recommended,
}: {
  info: PhoneInfo;
  side: "laptop" | "phone";
  os: PhoneOs;
  step2: "secure" | "wrong" | "plain" | null;
  recommended: boolean;
}) {
  const trust = trustUrl(info.lan.url);
  const https = sendingUrl(info);
  const [check, setCheck] = useState<"idle" | "busy" | "no" | "yes">("idle");
  const [checkError, setCheckError] = useState<string | null>(null);
  const run = async () => {
    setCheck("busy");
    setCheckError(null);
    try {
      const r = await phoneApi.trustCheck();
      setCheck(r.https ? "yes" : "no");
    } catch (e) {
      setCheck("idle");
      setCheckError(e instanceof Error ? e.message : String(e));
    }
  };
  const list = (which: "iphone" | "android") => (
    <ol className="step-list" data-os={which}>
      <li>{side === "laptop" ? "Open the trust page: scan the code." : "Open the trust page (the link above)."}</li>
      {(which === "iphone" ? IPHONE_STEPS : ANDROID_STEPS).map((s) => (
        <li key={s.id}>{s.body}</li>
      ))}
      <li>
        Open <code>{https ?? "the https address"}</code>: the board, signed in, with passkeys working.
      </li>
    </ol>
  );
  const checkRow = side === "phone" && (
    <div className="step-action">
      <button
        type="button"
        className="btn btn--primary"
        disabled={check === "busy"}
        onClick={() => void run()}
        data-action="check"
      >
        {check === "busy" ? "Checking…" : "Check"}
      </button>
      <span className="step-note" role="status">
        {check === "yes" ? (
          <>
            This phone is on the https address; passkeys work here.{" "}
            {https && (
              <a className="step-a" href={originPath(https, "/phone") ?? https}>
                Continue →
              </a>
            )}
          </>
        ) : check === "no" ? (
          <>
            Not yet: this page is still over plain http.{" "}
            {https && (
              <>
                After the steps above, open{" "}
                <a className="step-a" href={originPath(https, "/phone") ?? https}>
                  {https}
                </a>
                .
              </>
            )}
          </>
        ) : checkError ? (
          <span className="step-note--err">{checkError}</span>
        ) : (
          "After the steps, tap Check."
        )}
      </span>
    </div>
  );
  return (
    <>
      <h3 className="ph-lane-title">
        Same Wi-Fi
        {recommended && <span className="ph-reco">recommended</span>}
      </h3>
      {!info.tls ? (
        <p className="step-note step-note--err">
          Turn on the secure address first (<Link to="/setup">Setup</Link>, step 2); over plain http the phone can look
          but not sign.
        </p>
      ) : side === "laptop" ? (
        <div className="ph-row">
          <Qr url={trust} alt="QR code with the trust page's address" />
          <div className="ph-col">
            <p className="step-note">
              The phone installs this laptop's certificate once. <code>{trust}</code>
            </p>
            <h4 className="ph-os">iPhone</h4>
            {list("iphone")}
            <h4 className="ph-os">Android</h4>
            {list("android")}
          </div>
        </div>
      ) : (
        <div className="ph-col">
          {step2 === "plain" && trust && (
            <p className="step-note">
              <a className="step-a" href={trust}>
                Open the trust page →
              </a>
            </p>
          )}
          {os === "android" ? list("android") : list("iphone")}
          {checkRow}
        </div>
      )}
    </>
  );
}

// ---------- 3 · trust the phone ----------

function TrustStep({
  info,
  side,
  secure,
  mark,
}: {
  info: PhoneInfo;
  side: "laptop" | "phone";
  secure: boolean;
  mark: Mark;
}) {
  const what =
    side === "laptop"
      ? "The phone will ask to be trusted; this laptop approves its six digits. No reload needed anywhere."
      : "This phone makes its own passkey and asks; your laptop approves the six digits.";
  return (
    <Step n={3} mark={mark} title="Trust the phone" what={what}>
      {side === "laptop" ? (
        <LaptopTrust info={info} />
      ) : secure ? (
        <PhoneTrust />
      ) : (
        <p className="step-note step-gate">After step 2.</p>
      )}
    </Step>
  );
}

function LaptopTrust({ info }: { info: PhoneInfo }) {
  const wrongHref = wrongOriginHref();
  const https = sendingUrl(info);
  return (
    <div className="ph-col">
      {wrongHref && https && (
        <p className="pair-note" data-wrong-origin>
          Approving signs with this laptop's passkey, which lives at <a href={wrongHref}>{https}</a>; open this page
          there.
        </p>
      )}
      <PendingDevices />
      {info.pending.length === 0 && (
        <p className="step-note" data-nothing-pending>
          Nothing is asking yet. On the phone, after step 2, tap <strong>Send from this phone</strong>.
        </p>
      )}
      {info.trusted.length > 0 && (
        <ul className="ph-trusted" aria-label="Trusted phones">
          {info.trusted.map((t) => (
            <li key={t.id}>
              <span className="pending-name">{t.name}</span>
              <span className="pending-meta">
                {" "}
                · trusted <Ago iso={t.addedAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PhoneTrust() {
  const rp = useRpId();
  const secure = passkeysAvailable(rp);
  const poll = useCallback(async (requestId: string) => pollPhoneDevice({ requestId } as DeviceRequest), []);
  const { phase, error, ask, reset } = useDeviceRequest(rp, { poll });
  const [paired, setPaired] = useState<number | null>(null);
  useEffect(() => {
    let on = true;
    controlApi
      .machines()
      .then((m) => on && setPaired(m.length))
      .catch(() => on && setPaired(null));
    return () => {
      on = false;
    };
  }, []);
  const d = "d" in phase ? phase.d : null;
  const [a, b] = digitsOf(d?.check ?? "");
  return (
    <div className="ph-col" data-phase={phase.k}>
      {phase.k === "waiting" ? (
        <div className="pair-check" role="status">
          <span className="pair-check-label">Waiting for your laptop · it shows the same digits</span>
          <div className="pair-digits num" role="img" aria-label={`check digits ${a} ${b}`} data-check={d?.check}>
            {a}
            <span className="pair-digits-gap" />
            {b}
          </div>
        </div>
      ) : phase.k === "added" ? (
        <div className="pair-note pair-note--ok" role="status" data-added>
          <strong>Trusted.</strong> This phone can now answer and send{d?.detail ? ` through ${d.detail}` : ""}.
          <br />
          <Link to="/">Open the board →</Link>
        </div>
      ) : phase.k === "failed" ? (
        <div className="pair-note pair-note--err" role="alert">
          <strong>Not trusted.</strong> The laptop said no
          {d?.code && d.code !== "refused" ? `: ${refusalWords(d.code)}` : ""}.
        </div>
      ) : phase.k === "expired" ? (
        <div className="pair-note pair-note--quiet" role="status">
          <strong>The request expired.</strong> Nobody approved it within ten minutes.
        </div>
      ) : phase.k === "rejected" ? (
        <div className="pair-note pair-note--quiet" role="status">
          <strong>Turned down.</strong> Nothing was trusted.
        </div>
      ) : phase.k === "busy" ? (
        <p className="page-note" role="status">
          {phase.what}
        </p>
      ) : null}
      {error && (
        <p className="pair-note pair-note--err" role="alert">
          {error}
        </p>
      )}
      {(phase.k === "idle" || phase.k === "failed" || phase.k === "expired" || phase.k === "rejected") && (
        <div className="step-action">
          <button
            type="button"
            className="btn btn--primary btn--lg"
            disabled={!secure || !rp || paired === 0}
            onClick={() => {
              reset();
              void ask(guessDeviceName());
            }}
            data-action="send-from-phone"
          >
            {phase.k === "idle" ? "Send from this phone" : "Ask again"}
          </button>
          {paired === 0 && <span className="step-note">No machine is paired with this receiver yet.</span>}
        </div>
      )}
    </div>
  );
}
