// SPDX-License-Identifier: Apache-2.0
// Owned by: phone-web. /phone: one page that gets a phone onto the board and sending from
// it, in three steps, read on the laptop and on the phone itself (the same url, two sides,
// phone/state.ts tells them apart). 1 · See it: the LAN QR with the key. 2 · Send: a passkey
// needs an https address the phone trusts, so one lane is recommended (Tailscale when it is
// on this machine, else the same Wi-Fi with the local CA), the other one a segment away. 3 ·
// Trust: the phone makes its passkey and asks; the laptop approves the six digits
// (control/PendingDevices.tsx, the same request the inbox shows). The facts come from GET
// /api/ui/phone every two seconds, so a step turns done by itself. The checklist is the
// setup page's (pages/Setup.tsx Step).
import type { PhoneInfo } from "@shared/api";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Ago, CopyIconButton, Segmented } from "../components/bits";
import { useContextMenu } from "../components/ContextMenu";
import { PageBar } from "../components/PageBar";
import { controlApi, type DeviceRequest, originPath, resetInfoCache, wrongOriginHref } from "../control/api";
import { useRpId } from "../control/hooks";
import { PendingDevices } from "../control/PendingDevices";
import { useDeviceRequest } from "../control/useDeviceRequest";
import { guessDeviceName, passkeysAvailable } from "../control/webauthn";
import { refusalWords } from "../control/words";
import { useAppState, useStore } from "../data/hooks";
import { copyText } from "../lib/menus";
import { Link } from "../lib/router";
import { type Mark, Step } from "../pages/Setup";
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
import "../control/pairing.css";
import "./phone.css";

export function PhonePage() {
  const { info, missing, error, apply } = usePhoneInfo();
  const setup = useSetupStatus();
  const viewers = useAppState().viewers;
  const ua = navigator.userAgent;
  const side = sideOf(setup.local, ua);
  const os = phoneOs(ua);
  const phones = phonesConnected(viewers);
  // Every step is open but a finished first one; a person may fold any of them.
  const [opened, setOpened] = useState<Partial<Record<1 | 2 | 3, boolean>>>({});

  if (missing || !info)
    return (
      <div className="page page--doc page--grouped phone-page">
        <PageBar title="Your phone" />
        {missing ? (
          <div className="state" role="status">
            <span className="state-title">This server has no phone page yet</span>
            <span className="state-text">
              The <Link to="/setup">Setup page</Link> walks a phone through it.
            </span>
          </div>
        ) : error ? (
          <p className="page-note is-err">Last check failed: {error}. Trying again.</p>
        ) : (
          <div className="skeleton" role="status" aria-label="Reading this machine">
            <div className="skeleton-row" />
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </div>
        )}
      </div>
    );

  const https = sendingUrl(info);
  const loc = { protocol: location.protocol, hostname: location.hostname };
  const step2 = side === "phone" ? phoneStep2(loc, info.rpId, https) : null;
  const onHttps = side === "phone" ? step2 === "secure" : !!https;
  const trusted = info.trusted.length > 0;
  const now = currentStep({ phones: side === "phone" ? 1 : phones, https: onHttps, trusted });
  const mark = (n: 1 | 2 | 3): Mark => (now === 0 || n < now ? "done" : n === now ? "needs" : "todo");
  const doneCount = ([1, 2, 3] as const).filter((n) => mark(n) === "done").length;
  const fold = (n: 1 | 2 | 3) => {
    const dflt = n !== 1 || (side === "laptop" && phones === 0);
    return {
      open: opened[n] ?? dflt,
      onToggle: () => setOpened((o) => ({ ...o, [n]: !(o[n] ?? dflt) })),
    };
  };

  return (
    <div className="page page--doc page--grouped phone-page" data-side={side} data-lane={pickLane(info)}>
      <PageBar title="Your phone" meta={`${doneCount} of 3 done`} />
      {error && <p className="page-note is-err">Last check failed: {error}. Trying again.</p>}
      <ol className="steps">
        <SeeStep info={info} side={side} phones={phones} mark={mark(1)} {...fold(1)} />
        <SendStep info={info} side={side} os={os} step2={step2} onInfo={apply} mark={mark(2)} {...fold(2)} />
        <TrustStep info={info} side={side} secure={onHttps} mark={mark(3)} {...fold(3)} />
      </ol>
    </div>
  );
}

type Fold = { open: boolean; onToggle: () => void };

/** An address as a row: its name, the url in mono with an ellipsis, a copy icon; the
 *  row's menu copies it or opens it in a new window. */
function AddressRow({ label, url }: { label: string; url: string }) {
  const menu = useContextMenu(
    () => [
      { label: "Copy link", run: () => copyText(url) },
      {
        label: matchMedia("(max-width: 839px)").matches ? "Open" : "Open in new window",
        run: () => void window.open(url, "_blank", "noopener"),
      },
    ],
    { title: () => label, subtitle: () => url },
  );
  return (
    <li className="form-row ph-address" {...menu}>
      <span className="ph-address-label">{label}</span>
      <code className="url-value ph-url" title={url}>
        {url}
      </code>
      <CopyIconButton text={url} label={`Copy the ${label.toLowerCase()}`} />
    </li>
  );
}

// ---------- 1 · see it ----------

function SeeStep({
  info,
  side,
  phones,
  mark,
  open,
  onToggle,
}: {
  info: PhoneInfo;
  side: "laptop" | "phone";
  phones: number;
  mark: Mark;
} & Fold) {
  if (side === "phone")
    return (
      <Step
        attrs={{ "data-phone-step": 1 }}
        mark="done"
        needsLabel="now"
        open={false}
        onToggle={onToggle}
        title="See it on your phone"
        caption="You are reading it: this phone is on the board."
      />
    );
  return (
    <Step
      attrs={{ "data-phone-step": 1 }}
      mark={mark}
      needsLabel="now"
      open={open}
      onToggle={onToggle}
      title="See it on your phone"
      caption={
        phones > 0
          ? `${phones === 1 ? "A phone is" : `${phones} phones are`} connected.`
          : "Scan the code with the phone's camera, on the same Wi-Fi."
      }
    >
      <div className="ph-row">
        <Qr url={info.lan.url} src={info.lan.qr} alt="QR code with the Wi-Fi address and the UI key" size={160} />
        <div className="ph-col">
          <ul className="form-list ph-addresses">
            <AddressRow label="Wi-Fi address" url={info.lan.url} />
          </ul>
          <p className="caption">The key in the address signs the phone in.</p>
        </div>
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
  open,
  onToggle,
}: {
  info: PhoneInfo;
  side: "laptop" | "phone";
  os: PhoneOs;
  step2: "secure" | "wrong" | "plain" | null;
  onInfo: (info: PhoneInfo) => void;
  mark: Mark;
} & Fold) {
  const lane = pickLane(info);
  const [chosen, setChosen] = useState<Lane>(lane);
  const wrongHref = wrongOriginHref();
  const caption =
    step2 === "wrong"
      ? "This phone is on another address than the one that signs."
      : step2 === "secure"
        ? "This phone trusts this address; passkeys work here."
        : "Sending needs a passkey, and a passkey needs an https address the phone trusts.";
  return (
    <Step
      attrs={{ "data-phone-step": 2 }}
      mark={mark}
      needsLabel="now"
      open={open}
      onToggle={onToggle}
      title="Send from your phone"
      caption={caption}
    >
      {step2 === "wrong" && sendingUrl(info) ? (
        <p className="pair-note" data-wrong-origin>
          Sending works from <a href={wrongHref ?? sendingUrl(info) ?? "#"}>{sendingUrl(info)}</a>; open it there.
        </p>
      ) : step2 === "secure" ? (
        <p className="step-note" data-secure>
          This phone trusts <code>{location.host}</code>.
        </p>
      ) : (
        <>
          <div className="ph-lanes">
            <Segmented<Lane>
              value={chosen}
              onChange={setChosen}
              label="How the phone gets https"
              options={[
                { value: "tailscale", label: "Tailscale" },
                { value: "wifi", label: "Same Wi-Fi" },
              ]}
            />
          </div>
          {(["tailscale", "wifi"] as const).map((l) => (
            <section
              key={l}
              className="ph-lane"
              data-lane={l}
              aria-label={l === "tailscale" ? "Use Tailscale" : "Same Wi-Fi"}
              hidden={chosen !== l}
            >
              {l === "tailscale" ? (
                <TailscaleLane info={info} side={side} onInfo={onInfo} recommended={lane === "tailscale"} />
              ) : (
                <WifiLane info={info} side={side} os={os} step2={step2} recommended={lane === "wifi"} />
              )}
            </section>
          ))}
          <details className="ph-other">
            <summary>Other ways</summary>
            <p className="step-note">
              <strong>spacesheep.dev</strong> is a hosted receiver with its own https address: point a sink at it and
              open it on the phone; nothing to install or trust.
            </p>
          </details>
        </>
      )}
    </Step>
  );
}

/** "Tailscale is running on the laptop · Recommended": the lane's one status line. */
const LaneStatus = ({ children, recommended }: { children: ReactNode; recommended: boolean }) => (
  <p className="caption ph-lane-status">
    {children}
    {recommended && <span className="ph-reco"> · Recommended</span>}
  </p>
);

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
  const chip = (
    <span className="ph-chip">
      {state === "serving"
        ? "serving"
        : state === "running"
          ? "running"
          : state === "off"
            ? "not connected"
            : "not installed"}
    </span>
  );
  const phoneLine = "On the phone: the Tailscale app, signed into the same account.";
  return (
    <>
      <LaneStatus recommended={recommended}>Tailscale on the laptop: {chip}</LaneStatus>
      {state === "serving" && info.publicUrl ? (
        <div className="ph-row">
          {side === "laptop" && <Qr url={info.publicUrl} alt="QR code with the Tailscale address" size={160} />}
          <div className="ph-col">
            <ul className="form-list ph-addresses">
              <AddressRow label="Tailscale address" url={info.publicUrl} />
            </ul>
            <p className="caption">{phoneLine}</p>
            {side === "phone" && (
              <a className="btn btn--primary btn--lg" href={originPath(info.publicUrl, "/phone") ?? info.publicUrl}>
                Open it here
              </a>
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
          Get it at{" "}
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
  // On the laptop, the steps for one phone at a time: iPhone unless the person picks Android.
  const [shown, setShown] = useState<"iphone" | "android">(os === "android" ? "android" : "iphone");
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
  const list = (which: "iphone" | "android", hidden = false) => (
    <ol className="step-list" data-os={which} hidden={hidden}>
      <li>{side === "laptop" ? "Open the trust page: scan the code." : "Open the trust page (the button above)."}</li>
      {(which === "iphone" ? IPHONE_STEPS : ANDROID_STEPS).map((s) => (
        <li key={s.id}>{s.body}</li>
      ))}
      <li>
        Open <code>{https ?? "the https address"}</code>: the board, signed in, with passkeys working.
      </li>
    </ol>
  );
  const checkRow = side === "phone" && (
    <div className="step-action ph-check">
      <button
        type="button"
        className="btn btn--primary btn--lg"
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
                Continue
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
      <LaneStatus recommended={recommended}>The phone installs this laptop's certificate once.</LaneStatus>
      {!info.tls ? (
        <p className="step-note step-note--err">
          Turn on the secure address first (<Link to="/setup">Setup</Link>, step 2); over plain http the phone can look
          but not sign.
        </p>
      ) : side === "laptop" ? (
        <div className="ph-row">
          <Qr url={trust} alt="QR code with the trust page's address" size={160} />
          <div className="ph-col">
            {trust && (
              <ul className="form-list ph-addresses">
                <AddressRow label="Trust page" url={trust} />
              </ul>
            )}
            <Segmented<"iphone" | "android">
              value={shown}
              onChange={setShown}
              label="Steps for"
              options={[
                { value: "iphone", label: "iPhone" },
                { value: "android", label: "Android" },
              ]}
            />
            {list("iphone", shown !== "iphone")}
            {list("android", shown !== "android")}
          </div>
        </div>
      ) : (
        <div className="ph-col">
          {step2 === "plain" && trust && (
            <a className="btn btn--lg ph-trust-btn" href={trust}>
              Open the trust page
            </a>
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
  open,
  onToggle,
}: {
  info: PhoneInfo;
  side: "laptop" | "phone";
  secure: boolean;
  mark: Mark;
} & Fold) {
  const caption =
    side === "phone"
      ? secure
        ? "This phone makes its own passkey and asks; your laptop approves the six digits."
        : "After step 2."
      : info.trusted.length > 0
        ? `${info.trusted.map((t) => t.name).join(", ")} ${info.trusted.length === 1 ? "is" : "are"} trusted.`
        : info.pending.length > 0
          ? "A phone asks to be trusted: compare its six digits, then approve."
          : "The phone will ask to be trusted; this laptop approves its six digits.";
  return (
    <Step
      attrs={{ "data-phone-step": 3 }}
      mark={mark}
      needsLabel="now"
      open={open}
      onToggle={onToggle}
      title="Trust the phone"
      caption={caption}
    >
      {side === "laptop" ? <LaptopTrust info={info} /> : secure ? <PhoneTrust /> : null}
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
        <section className="form-group">
          <div className="form-head">
            <h3 className="section-label">Trusted phones</h3>
          </div>
          <ul className="form-list ph-trusted" aria-label="Trusted phones">
            {info.trusted.map((t) => (
              <li key={t.id} className="form-row">
                <span className="form-label pending-name">{t.name}</span>
                <span className="form-value pending-meta">
                  Trusted <Ago iso={t.addedAt} />
                </span>
              </li>
            ))}
          </ul>
        </section>
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
          <span className="pair-check-label">Waiting for your laptop: it shows the same digits</span>
          <div className="pair-digits num" role="img" aria-label={`check digits ${a} ${b}`} data-check={d?.check}>
            {a}
            <span className="pair-digits-gap" />
            {b}
          </div>
        </div>
      ) : phase.k === "added" ? (
        <div className="pair-note pair-note--ok" role="status" data-added>
          <strong>Trusted.</strong> This phone can now answer and send{d?.detail ? ` through ${d.detail}` : ""}.{" "}
          <Link to="/">Open the board</Link>
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
