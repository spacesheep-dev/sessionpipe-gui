// SPDX-License-Identifier: Apache-2.0
// Connect: how a phone, another machine or demo mode gets onto this board, plus the
// receiver's own numbers, as one grouped form in a centred column. A phone on this network
// (the QR beside its addresses, each host:port with the key behind its Copy), another
// machine (the sink line in a one-line well with its tier menu beside it), then the rest
// as one-line summaries that open: passkeys (HTTPS and its one action), the sink token,
// the sources and this receiver. Every address, command and the token has a menu (copy,
// open). Also where the empty board sends people.
import { type Info, ROUTES, type Tier } from "@shared/api";
import { type ReactNode, useEffect, useId, useState } from "react";
import { ActionButton, CommandWell, CopyIconButton, Toggle } from "../components/bits";
import { confirmAction, type MenuList, useContextMenu } from "../components/ContextMenu";
import { PageBar } from "../components/PageBar";
import { Select } from "../components/Select";
import { resetInfoCache } from "../control/api";
import { useAppState, useStore } from "../data/hooks";
import { bytes } from "../lib/format";
import { copyText } from "../lib/menus";
import { Link } from "../lib/router";
import { useSimple } from "../lib/settings";
import { TIER_HINT, TIER_LABEL } from "../lib/tier";
import { dur } from "../lib/time";
import { refreshSetup, setupApi, useSetupStatus } from "../setup/api";
import { REQUIRED_STEPS, stepsDone } from "../setup/steps";
import { useThemes } from "../themes/host/registry";

/** How long the page waits for the setup status before it draws without it. */
const SETUP_WAIT_MS = 600;

/** A Tailscale address sits in 100.64.0.0/10. */
const isTailnet = (u: string) => /^https?:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(u);

/** The menu of a copyable line: Copy, and Open in a new window when it is a web address. */
function useCopyMenu(text: string | null | undefined, title: string, extra?: () => MenuList) {
  return useContextMenu(
    () =>
      text
        ? [
            { label: "Copy", run: () => copyText(text) },
            /^https?:\/\//.test(text) && {
              label: matchMedia("(max-width: 839px)").matches ? "Open" : "Open in new window",
              run: () => void window.open(text, "_blank", "noopener"),
            },
            ...(extra?.() ?? []),
          ]
        : null,
    { title: () => title },
  );
}

/** One address: its name in the secondary tier, then the address in mono: the scheme
 *  and the host:port, the key after it quiet (a phone shows only host:port, so the part
 *  that tells two addresses apart is never the part cut off). Copy takes it whole. */
function UrlRow({ label, url, className = "" }: { label: string; url: string; className?: string }) {
  const menu = useCopyMenu(url, label);
  const m = /^(https?:\/\/)([^/?#]+)(.*)$/.exec(url);
  return (
    <li className={`form-row url-row ${className}`} {...menu}>
      <span className="url-label">{label}</span>
      <code className="url url-value" title={url}>
        {m ? (
          <>
            <span className="url-scheme">{m[1]}</span>
            <span className="url-host">{m[2]}</span>
            {m[3] ? <span className="url-key">{m[3]}</span> : null}
          </>
        ) : (
          url
        )}
      </code>
      <CopyIconButton text={url} label="Copy" />
    </li>
  );
}

/** A command on one line in the shared well (bits.tsx CommandWell's face), for a line
 *  that shows one thing and copies another (the sink line with its token masked). */
function CmdWell({
  shown,
  copy,
  label,
  title,
  className = "cmd-text",
}: {
  shown: ReactNode;
  copy: string | null;
  label: string;
  title: string;
  className?: string;
}) {
  const menu = useCopyMenu(copy, title);
  return (
    <div className="cmdwell cmd" {...menu}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls sideways, so a keyboard must reach it (axe scrollable-region-focusable) */}
      <code className={`cmdwell-text ${className}`} tabIndex={0}>
        {shown}
      </code>
      {copy && <CopyIconButton text={copy} label={label} />}
    </div>
  );
}

/** A group folded to one line: its name and a summary of its state; it opens in place.
 *  Closed, its rows stay in the page (hidden), so nothing it holds is lost. */
function Fold({
  title,
  summary,
  className = "",
  children,
}: {
  title: string;
  summary: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <section className={`form-group fold ${className}`} aria-labelledby={`${id}-h`} data-open={open || undefined}>
      <h2 className="fold-h" id={`${id}-h`}>
        <button
          type="button"
          className="fold-head"
          aria-expanded={open}
          aria-controls={`${id}-b`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="fold-title">{title}</span>
          <span className="fold-sum">{summary}</span>
          <span className="fold-chev" aria-hidden="true" />
        </button>
      </h2>
      <div className="fold-body" id={`${id}-b`} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

export function Connect() {
  const store = useStore();
  const { stats } = useAppState();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<"rotate" | "demo" | "tls" | null>(null);
  const [qrBroken, setQrBroken] = useState(false);
  const [tier, setTier] = useState<Tier | null>(null);
  const themes = useThemes().themes;
  const setup = useSetupStatus();
  const done = setup.status ? stepsDone(setup.status, false) : null;
  const setupDone = !!done && REQUIRED_STEPS.every((k) => done[k]);
  // Whether this page is open on the receiver's machine: the setup status says (it is
  // usually in already, the shell asked at boot). Unknown is neither side: the page waits
  // for it (at most SETUP_WAIT_MS), so the passkey rows never change shape under the reader.
  const here = setup.local;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setWaited(true), SETUP_WAIT_MS);
    return () => window.clearTimeout(t);
  }, []);
  const settled = here !== null || !!setup.error || waited;
  // Simple mode folds the token, the sources and the receiver's numbers behind "Advanced".
  const simple = useSimple();
  const [advanced, setAdvanced] = useState(false);

  const load = () =>
    store.transport
      .info()
      .then((i) => {
        setInfo(i);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const qr = store.transport.qrUrl();
  const lan = info?.urls.lan ?? [];
  const phoneUrl = (u: string) => (info?.uiKey ? `${u}/?k=${info.uiKey}` : u);

  // The sink line with the tier this person picked (the receiver's own by default).
  const sinkTier = Number(/--tier (\d)/.exec(info?.sinkCommand ?? "")?.[1] ?? 3) as Tier;
  const chosenTier = tier ?? sinkTier;
  const withTier = (cmd: string) => cmd.replace(/--tier \d/, `--tier ${chosenTier}`);
  const sinkLine = info ? withTier(info.sinkCommand) : null;

  const rotate = async () => {
    const ok = await confirmAction({
      title: "Rotate the sink token?",
      body: "Every machine sending here must be given the new one.",
      action: "Rotate",
      danger: true,
    });
    if (!ok) return;
    setBusy("rotate");
    try {
      const r = await store.transport.rotateToken();
      setInfo((i) =>
        i ? { ...i, sinkToken: r.sinkToken, sinkCommand: i.sinkCommand.replace(i.sinkToken, r.sinkToken) } : i,
      );
      setReveal(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const demo = async (on: boolean) => {
    if (
      on &&
      !(await confirmAction({
        title: "Turn on demo mode?",
        body: "Synthetic sessions on two pretend machines, until you turn it off; then they are removed.",
        action: "Turn on",
      }))
    )
      return;
    setBusy("demo");
    try {
      const r = await store.transport.demo(on);
      setInfo((i) => (i ? { ...i, sources: { ...i.sources, demo: r.on } } : i));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const tlsOn = async () => {
    setBusy("tls");
    setError(null);
    try {
      const r = await setupApi.tlsOn();
      resetInfoCache();
      if (r.restartRequired) setError(`Restart needed: ${r.command ?? "sessionpipe-gui --tls"}`);
      await refreshSetup();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const masked = (cmd: string) => (reveal || !info ? cmd : withMaskedToken(cmd, info.sinkToken));
  const tokenMenu = useContextMenu(
    () =>
      info
        ? [
            { label: "Copy", run: () => copyText(info.sinkToken) },
            {
              label: reveal ? "Hide" : "Reveal",
              run: () => setReveal((r) => !r),
              disabled: !loopback && !info.sinkToken ? "Only on the machine running the receiver" : undefined,
            },
            { sep: true },
            {
              label: "Rotate…",
              danger: true,
              run: () => void rotate(),
              disabled: loopback ? undefined : "Only on the machine running the receiver",
            },
          ]
        : null,
    { title: () => "Sink token" },
  );

  // Until the receiver's info and the setup status are in, only the bar: the groups arrive
  // whole in one frame (~70 ms later), never a half page that grows under the reader.
  if ((!info && !error) || !settled)
    return (
      <div className="page page--doc page--grouped connect" aria-busy="true">
        <PageBar title="Connect" />
      </div>
    );

  return (
    <div className="page page--doc page--grouped connect">
      <PageBar
        title="Connect"
        actions={
          here === true && setup.status && !setupDone ? (
            <Link to="/setup" className="btn connect-setup">
              Set up…
            </Link>
          ) : undefined
        }
      />
      {error && <p className="page-note is-err">{error}</p>}

      <section className="form-group sect--phone" aria-labelledby="connect-phone">
        <div className="form-head">
          <h2 className="section-label" id="connect-phone">
            Phone on this network
          </h2>
        </div>
        <div className="connect-phone">
          <div className="qr">
            {qr && !qrBroken ? (
              <img
                src={qr}
                alt="QR code with the LAN address and the UI key"
                width={160}
                height={160}
                onError={() => setQrBroken(true)}
              />
            ) : (
              <div className="qr-none" role="img" aria-label="QR code unavailable">
                <span>QR</span>
                <small>{qrBroken ? "not served" : "needs the server"}</small>
              </div>
            )}
          </div>
          <div className="connect-phone-text">
            <ul className="form-list urls">
              {lan.length === 0 && info && (
                <li className="form-row urls-none">No LAN address found; this machine may be offline.</li>
              )}
              {lan.map((u) => (
                <UrlRow key={u} label={isTailnet(u) ? "Tailscale" : "Wi-Fi"} url={phoneUrl(u)} />
              ))}
              {info && <UrlRow label="This machine" url={info.urls.local} className="urls-local" />}
            </ul>
            <p className="caption">
              Scan, or open an address on the phone. Copy takes the key with it, which signs the phone in.
            </p>
          </div>
        </div>
        {info?.remote && (
          <div className="connect-remote" data-connect-remote>
            <div className="form-head">
              <h3 className="section-label">From anywhere</h3>
            </div>
            <ul className="form-list urls">
              <UrlRow label="Public" url={phoneUrl(info.remote.url)} />
            </ul>
            <CmdWell
              shown={masked(info.remote.sinkCommand)}
              copy={info.remote.sinkCommand}
              label="Copy sink line"
              title="Sink line"
              className="remote-cmd"
            />
            <CmdWell
              shown={masked(info.remote.connectCommand)}
              copy={info.remote.connectCommand}
              label="Copy pair line"
              title="Pair line"
              className="remote-cmd"
            />
            <p className="caption">
              Through the https proxy on this machine, <code>{info.remote.host}</code>. Passkeys are made for{" "}
              <code>{info.control.rpId}</code>.
            </p>
          </div>
        )}
      </section>

      <section className="form-group sect--machine" aria-labelledby="connect-machine">
        <div className="form-head">
          <h2 className="section-label" id="connect-machine">
            Another machine
          </h2>
        </div>
        <div className="connect-sink">
          <CmdWell shown={sinkLine ? masked(sinkLine) : "…"} copy={sinkLine} label="Copy command" title="Sink line" />
          {info && (
            <Select<string>
              size="sm"
              align="end"
              className="connect-tier"
              aria-label="Tier"
              value={String(chosenTier)}
              onChange={(v) => setTier(Number(v) as Tier)}
              options={([0, 1, 2, 3] as const).map((t) => ({
                value: String(t),
                label: `Tier ${t} · ${TIER_LABEL[t]}`,
                hint: t === sinkTier ? "receiver's" : undefined,
              }))}
            />
          )}
        </div>
        <p className="caption">
          Run it there after <code>npx sessionpipe install</code>. Tier {chosenTier}:{" "}
          {TIER_HINT[chosenTier].replace(/^\+ /, "adds ")}
        </p>
      </section>

      <Fold
        className="sect--passkeys"
        title="Passkeys"
        summary={
          info?.tls?.on
            ? `On · rp id ${info.control.rpId}`
            : info?.tls === undefined && info
              ? "Off · this server runs without TLS mode"
              : "Off · passkeys need https on this address"
        }
      >
        {info?.tls?.on ? (
          <ul className="form-list passkeys">
            <li className="form-row">
              <span className="form-row-text">
                <span className="form-label">HTTPS</span>
                <span className="form-caption">
                  On · rp id <code>{info.control.rpId}</code>
                </span>
              </span>
              <span className="form-value">
                <a href={trustHref(info)} className="btn passkeys-trust">
                  Trust steps…
                </a>
              </span>
            </li>
            <UrlRow label="Secure address" url={phoneUrl(info.tls.httpsUrl)} className="passkeys-url" />
            <li className="form-row form-row--kv">
              <span className="form-key">CA fingerprint</span>
              <code className="form-kv passkeys-fp">{info.tls.caFingerprint}</code>
            </li>
          </ul>
        ) : (
          <ul className="form-list passkeys">
            <li className="form-row">
              <span className="form-row-text">
                <span className="form-label">HTTPS</span>
                <span className="form-caption passkeys-off">
                  {info?.tls === undefined && info
                    ? "Off. Start the receiver in TLS mode to give it a certificate; until then passkeys sign only at localhost."
                    : "Off. A passkey needs https on a name; turning it on gives this port its own certificate."}
                </span>
              </span>
              {here === true && info?.tls !== undefined ? (
                <span className="form-value">
                  <ActionButton
                    className="btn btn--primary"
                    pendingLabel="Turning on…"
                    pending={busy === "tls"}
                    onClick={tlsOn}
                  >
                    Turn on
                  </ActionButton>
                </span>
              ) : null}
            </li>
            {(here === false || info?.tls === undefined) && (
              <li className="form-row form-row--stack">
                <span className="form-caption">On the receiver machine, once; it is remembered:</span>
                <CommandWell command="sessionpipe-gui --tls" label="Copy" />
              </li>
            )}
          </ul>
        )}
        <p className="caption">
          The daemon still pairs over plain http (
          <code>sessionpipe control pair {info?.urls.local ?? "http://localhost:7373"}</code>), and the sink line stays
          plain http to the LAN address.
        </p>
      </Fold>

      {simple && (
        <button
          type="button"
          className="btn btn--ghost connect-advanced"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          data-connect-advanced
        >
          <span className="connect-advanced-chev" aria-hidden="true" />
          Advanced: token, sources, this receiver
        </button>
      )}
      <div className="connect-fold" hidden={simple && !advanced}>
        <Fold title="Sink token" summary={info ? `${mask(info.sinkToken)} · sent with every batch` : "…"}>
          <ul className="form-list">
            <li className="form-row token-row" {...tokenMenu}>
              <code className="token-text">{info ? (reveal ? info.sinkToken : mask(info.sinkToken)) : "…"}</code>
              <span className="form-value token-actions">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setReveal((r) => !r)}
                  disabled={!info || (!loopback && !info.sinkToken)}
                  aria-label={reveal ? "Hide" : "Reveal"}
                  aria-pressed={reveal}
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    aria-hidden="true"
                  >
                    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
                    <circle cx="8" cy="8" r="2" />
                    {reveal && <path d="M2.5 13.5 13.5 2.5" strokeLinecap="round" />}
                  </svg>
                </button>
                {info && <CopyIconButton text={info.sinkToken} label="Copy token" />}
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  onClick={() => void rotate()}
                  disabled={!loopback || busy === "rotate"}
                  aria-label="Rotate token…"
                  data-tip={loopback ? "Rotate: mint a new token" : "Only on the machine running the receiver"}
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M13 8a5 5 0 1 1-1.5-3.6" />
                    <path d="M13 2.5v3h-3" />
                  </svg>
                </button>
              </span>
            </li>
          </ul>
          <p className="caption">
            Sent as a bearer with every batch; rotating stops the old one at once.
            {loopback ? "" : ` Shown and rotated on the receiver machine only (${info?.urls.local ?? "localhost"}).`}
          </p>
        </Fold>

        <Fold
          title="Sources"
          summary={
            info
              ? [
                  "HTTP receiver",
                  info.sources.outbox?.enabled ? "outbox tailed" : "",
                  info.sources.demo ? "demo on" : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "…"
          }
        >
          <dl className="form-list sources">
            <div className="form-row form-row--kv">
              <dt className="form-key">HTTP receiver</dt>
              <dd className="form-kv">
                Listening · <code>/api/sessionpipe/v1/events</code>
                {info?.wellKnown && typeof info.wellKnown.max_tier === "number" && (
                  <> · max tier {String(info.wellKnown.max_tier)}</>
                )}
              </dd>
            </div>
            <div className="form-row form-row--kv">
              <dt className="form-key">This machine's outbox</dt>
              <dd className="form-kv">
                {info?.sources.outbox ? (
                  <>
                    {info.sources.outbox.enabled ? "Tailed" : "Found, not tailed"} · {info.sources.outbox.sessions}{" "}
                    sessions{info.sources.outbox.events !== undefined ? ` · ${info.sources.outbox.events} events` : ""}{" "}
                    · <code>{info.sources.outbox.path}</code>
                  </>
                ) : (
                  <>
                    None found; run <code>npx sessionpipe install</code> here
                  </>
                )}
              </dd>
            </div>
            <div className="form-row form-row--kv">
              <dt className="form-key">Demo</dt>
              <dd className="form-kv demo">
                <span>{info?.sources.demo ? "on · synthetic sessions are flowing" : "off"}</span>
                <Toggle
                  on={!!info?.sources.demo}
                  onChange={(v) => void demo(v)}
                  label="Demo mode"
                  disabled={!info || busy === "demo"}
                />
              </dd>
            </div>
            {info?.control && (
              <div className="form-row form-row--kv">
                <dt className="form-key">Control</dt>
                <dd className="form-kv">
                  {info.control.enabled ? `On · rp id ${info.control.rpId} · ${info.control.machines} paired` : "Off"}
                </dd>
              </div>
            )}
          </dl>
        </Fold>

        <Fold
          title="This receiver"
          summary={
            stats
              ? `${stats.eventsLastMinute} a minute · ${bytes(stats.storageBytes)} · up ${dur(stats.uptimeS * 1000)}`
              : "…"
          }
        >
          <dl className="form-list stats">
            <Stat k="Events per minute" v={stats?.eventsLastMinute ?? "–"} />
            <Stat k="Latency p50" v={stats?.latencyP50Ms !== undefined ? `${stats.latencyP50Ms} ms` : "–"} />
            <Stat
              k="Stored"
              v={stats ? `${stats.events.toLocaleString()} events` : "–"}
              sub={stats ? bytes(stats.storageBytes) : ""}
            />
            <Stat
              k="Sessions"
              v={stats?.sessions ?? "–"}
              sub={stats ? `${stats.machines} ${stats.machines === 1 ? "machine" : "machines"}` : ""}
            />
            <Stat k="Uptime" v={stats ? dur(stats.uptimeS * 1000) : "–"} />
            <Stat k="Version" v={info ? `${info.name} ${info.version}` : "–"} />
          </dl>
          {info && <p className="caption connect-dir">{info.storage.dir}</p>}
        </Fold>
      </div>

      <section className="form-group" aria-labelledby="connect-views">
        <div className="form-head">
          <h2 className="section-label" id="connect-views">
            Views
          </h2>
        </div>
        <ul className="form-list">
          <li className="form-row">
            <span className="form-row-text">
              <span className="form-label">
                {themes.length === 0 ? "No view plugins installed" : `${themes.length} installed`}
              </span>
              {themes.length > 0 && (
                <span className="form-caption">{themes.map((t) => t.name || t.id).join(", ")}</span>
              )}
            </span>
            <Link to="/themes" className="btn btn--sm">
              Manage views…
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: ReactNode; sub?: string }) {
  return (
    <div className="form-row form-row--kv">
      <dt className="form-key">{k}</dt>
      <dd className="form-kv num">
        {v}
        {sub ? <span className="machine-sub"> · {sub}</span> : null}
      </dd>
    </div>
  );
}

/** The trust page on the plain-http LAN address, with the key, so a phone can follow it too. */
const trustHref = (info: Info): string => {
  const base = info.urls.lan[0] ?? info.urls.local;
  return info.uiKey ? `${base}${ROUTES.trust}?k=${encodeURIComponent(info.uiKey)}` : `${base}${ROUTES.trust}`;
};

const mask = (t: string) => (t.length <= 8 ? "••••" : `${t.slice(0, 4)}…${t.slice(-3)}`);
/** A command line with the sink token masked, as the LAN sink line shows it before Reveal. */
const withMaskedToken = (cmd: string, token: string) => (token ? cmd.replace(token, mask(token)) : cmd);
