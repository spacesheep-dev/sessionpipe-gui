// SPDX-License-Identifier: Apache-2.0
// Connect: how a phone, another machine or demo mode gets onto this board, plus the
// receiver's own numbers. Also where the empty board sends people.
import { type Info, ROUTES } from "@shared/api";
import { useEffect, useState } from "react";
import { CopyButton, Toggle } from "../components/bits";
import { useAppState, useStore } from "../data/hooks";
import { bytes } from "../lib/format";
import { Link } from "../lib/router";
import { useSimple } from "../lib/settings";
import { TIER_HINT, TIER_LABEL } from "../lib/tier";
import { dur } from "../lib/time";
import { useSetupStatus } from "../setup/api";
import { useThemes } from "../themes/host/registry";

export function Connect() {
  const store = useStore();
  const { stats } = useAppState();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<"rotate" | "demo" | null>(null);
  const [qrBroken, setQrBroken] = useState(false);
  const themes = useThemes().themes;
  const setup = useSetupStatus();
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

  const rotate = async () => {
    if (!confirm("Rotate the sink token? Every machine sending here must be given the new one.")) return;
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
      !window.confirm(
        "Demo mode adds synthetic sessions on two pretend machines until you turn it off; they are removed when it goes off. Turn it on?",
      )
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

  return (
    <div className="page connect">
      {setup.local !== false && (
        <p className="page-note connect-setup">
          First time here? <Link to="/setup">Setup →</Link>
          <span>
            five steps: your sessions, the secure address, pairing, your phone, a first message; a sixth, optional, for
            the road.
          </span>
        </p>
      )}
      {error && <p className="page-note is-err">{error}</p>}

      <section className="sect sect--phone">
        <header className="sect-head">
          <h2>A phone on this network</h2>
          <p>Scan, or open the address. The key in it signs the phone in.</p>
        </header>
        <div className="phone">
          <div className="qr">
            {qr && !qrBroken ? (
              <img
                src={qr}
                alt="QR code with the LAN address and the UI key"
                width={200}
                height={200}
                onError={() => setQrBroken(true)}
              />
            ) : (
              <div className="qr-none" role="img" aria-label="QR code unavailable">
                <span>QR</span>
                <small>{qrBroken ? "not served" : "needs the server"}</small>
              </div>
            )}
          </div>
          <ul className="urls">
            {lan.length === 0 && info && (
              <li className="urls-none">No LAN address found; this machine may be offline.</li>
            )}
            {lan.map((u) => (
              <li key={u}>
                <code className="url">{phoneUrl(u)}</code>
                <CopyButton text={phoneUrl(u)} small />
              </li>
            ))}
            {info && (
              <li className="urls-local">
                <code className="url">{info.urls.local}</code>
                <CopyButton text={info.urls.local} small />
              </li>
            )}
          </ul>
        </div>
        {info?.remote && (
          <div className="connect-remote" data-connect-remote>
            <h3>From anywhere</h3>
            <ul className="urls">
              <li>
                <code className="url">{phoneUrl(info.remote.url)}</code>
                <CopyButton text={phoneUrl(info.remote.url)} small />
              </li>
            </ul>
            <div className="cmd">
              <pre className="cmd-text">
                <code>
                  {reveal ? info.remote.sinkCommand : withMaskedToken(info.remote.sinkCommand, info.sinkToken)}
                </code>
              </pre>
              <CopyButton text={info.remote.sinkCommand} label="Copy sink line" small />
            </div>
            <div className="cmd">
              <pre className="cmd-text">
                <code>
                  {reveal ? info.remote.connectCommand : withMaskedToken(info.remote.connectCommand, info.sinkToken)}
                </code>
              </pre>
              <CopyButton text={info.remote.connectCommand} label="Copy pair line" small />
            </div>
            <p className="sect-note">
              Through the https proxy on the receiver machine, <code>{info.remote.host}</code>, from any network.
              Passkeys are made for rp id <code>{info.control.rpId}</code>: a device that signed on the{" "}
              <code>.local</code> name makes a new one here on first use.
            </p>
          </div>
        )}
      </section>

      <section className="sect sect--passkeys">
        <header className="sect-head">
          <h2>Passkeys on your phone</h2>
          <p>
            Control signs with a passkey, and a passkey needs https on a DNS name. TLS mode gives this port a
            certificate from the receiver's own local CA, trusted once per phone.
          </p>
        </header>
        {info?.tls?.on ? (
          <dl className="passkeys">
            <div>
              <dt>TLS mode</dt>
              <dd>
                on · rp id <code>{info.control.rpId}</code>
              </dd>
            </div>
            <div>
              <dt>secure address</dt>
              <dd className="passkeys-url">
                <code className="url">{phoneUrl(info.tls.httpsUrl)}</code>
                <CopyButton text={phoneUrl(info.tls.httpsUrl)} small />
              </dd>
            </div>
            <div>
              <dt>CA fingerprint</dt>
              <dd>
                <code className="passkeys-fp">{info.tls.caFingerprint}</code>
              </dd>
            </div>
            <div>
              <dt>trust steps</dt>
              <dd>
                <a href={trustHref(info)} className="passkeys-trust">
                  Trust steps for iPhone, Android, Mac and Linux
                </a>
                {" · "}
                <span className="passkeys-note">the QR code above opens them first; the CA is at </span>
                <code>{info.tls.caUrl}</code>
              </dd>
            </div>
          </dl>
        ) : (
          <div className="cmd">
            <pre className="passkeys-cmd">
              <code>sessionpipe-gui --tls</code>
            </pre>
            <CopyButton text="sessionpipe-gui --tls" label="Copy" small />
            <p className="sect-note passkeys-off">
              off · start the receiver with this once; it is remembered (<code>--no-tls</code> turns it off).
              {info?.tls === undefined && info ? " This server has no TLS mode." : ""}
            </p>
          </div>
        )}
        <p className="sect-note">
          Passkeys then work only on the https address, on the phone and on this machine; the daemon still pairs over
          plain http (<code>sessionpipe control pair {info?.urls.local ?? "http://localhost:7373"}</code>, it reads the
          rp id from the well-known file) and the sink line for other machines stays plain http to the LAN address.
        </p>
      </section>

      <section className="sect">
        <header className="sect-head">
          <h2>Another machine</h2>
          <p>
            After <code>npx sessionpipe install</code> there, add this receiver as a sink.
          </p>
        </header>
        <div className="cmd">
          <pre className="cmd-text">
            <code>
              {info
                ? reveal
                  ? info.sinkCommand
                  : info.sinkCommand.replace(info.sinkToken, mask(info.sinkToken))
                : "…"}
            </code>
          </pre>
          {info && <CopyButton text={info.sinkCommand} label="Copy command" />}
        </div>
        <p className="tiers">
          <span>
            <code>--tier</code> is how much leaves that machine:
          </span>
          {([0, 1, 2, 3] as const).map((t) => (
            <span key={t} className="tier" title={TIER_HINT[t]}>
              <span className="num">{t}</span> {TIER_LABEL[t]}
            </span>
          ))}
        </p>
      </section>

      {simple && (
        <button
          type="button"
          className="btn btn--sm btn--ghost connect-advanced"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          data-connect-advanced
        >
          <span className="group-caret" aria-hidden="true">
            {advanced ? "▾" : "▸"}
          </span>
          Advanced · token, sources, this receiver
        </button>
      )}
      <div className="connect-fold" hidden={simple && !advanced}>
        <section className="sect">
          <header className="sect-head">
            <h2>Sink token</h2>
            <p>
              Sent as a bearer with every batch.{loopback ? "" : " Shown and rotated on the receiver machine only."}
            </p>
          </header>
          <div className="token">
            <code className="token-text">{info ? (reveal ? info.sinkToken : mask(info.sinkToken)) : "…"}</code>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setReveal((r) => !r)}
              disabled={!info || (!loopback && !info.sinkToken)}
            >
              {reveal ? "Hide" : "Reveal"}
            </button>
            {info && <CopyButton text={info.sinkToken} small />}
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => void rotate()}
              disabled={!loopback || busy === "rotate"}
              title={
                loopback ? "Mint a new token; the old one stops working" : "Only from the machine running the receiver"
              }
            >
              {busy === "rotate" ? "Rotating…" : "Rotate"}
            </button>
          </div>
          {!loopback && (
            <p className="sect-note">
              To rotate, open <code>{info?.urls.local ?? "http://localhost:7373"}</code> on the receiver machine.
            </p>
          )}
        </section>

        <section className="sect">
          <header className="sect-head">
            <h2>Sources</h2>
          </header>
          <dl className="sources">
            <div>
              <dt>HTTP receiver</dt>
              <dd>
                listening · <code>/api/sessionpipe/v1/events</code>
                {info?.wellKnown && typeof info.wellKnown.max_tier === "number" && (
                  <> · max tier {String(info.wellKnown.max_tier)}</>
                )}
              </dd>
            </div>
            <div>
              <dt>This machine's outbox</dt>
              <dd>
                {info?.sources.outbox ? (
                  <>
                    {info.sources.outbox.enabled ? "tailed" : "found, not tailed"} · {info.sources.outbox.sessions}{" "}
                    sessions{info.sources.outbox.events !== undefined ? ` · ${info.sources.outbox.events} events` : ""}{" "}
                    · <code>{info.sources.outbox.path}</code>
                  </>
                ) : (
                  <>
                    none found · run <code>npx sessionpipe install</code> here
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>Demo</dt>
              <dd className="demo">
                <Toggle
                  on={!!info?.sources.demo}
                  onChange={(v) => void demo(v)}
                  label="Demo mode"
                  disabled={!info || busy === "demo"}
                />
                <span>{info?.sources.demo ? "on · synthetic sessions are flowing" : "off"}</span>
              </dd>
            </div>
            {info?.control && (
              <div>
                <dt>Control</dt>
                <dd>
                  {info.control.enabled ? `on · rp id ${info.control.rpId} · ${info.control.machines} paired` : "off"}
                </dd>
              </div>
            )}
          </dl>
        </section>

        <section className="sect">
          <header className="sect-head">
            <h2>This receiver</h2>
          </header>
          <dl className="stats">
            <div>
              <dt>events / min</dt>
              <dd className="num">{stats?.eventsLastMinute ?? "–"}</dd>
            </div>
            <div>
              <dt>latency p50</dt>
              <dd className="num">{stats?.latencyP50Ms !== undefined ? `${stats.latencyP50Ms} ms` : "–"}</dd>
            </div>
            <div>
              <dt>stored</dt>
              <dd className="num">
                {stats ? `${stats.events.toLocaleString()} events` : "–"}
                <small>{stats ? bytes(stats.storageBytes) : ""}</small>
              </dd>
            </div>
            <div>
              <dt>sessions</dt>
              <dd className="num">
                {stats?.sessions ?? "–"}
                <small>{stats ? `${stats.machines} ${stats.machines === 1 ? "machine" : "machines"}` : ""}</small>
              </dd>
            </div>
            <div>
              <dt>uptime</dt>
              <dd className="num">{stats ? dur(stats.uptimeS * 1000) : "–"}</dd>
            </div>
            <div>
              <dt>version</dt>
              <dd className="num">{info ? `${info.name} ${info.version}` : "–"}</dd>
            </div>
          </dl>
          {info && <p className="sect-note mono">{info.storage.dir}</p>}
        </section>
      </div>

      <section className="sect">
        <header className="sect-head">
          <h2>Views</h2>
          <p>
            {themes.length === 0
              ? "No view plugins installed."
              : `${themes.length} installed: ${themes.map((t) => t.name || t.id).join(", ")}.`}{" "}
            <Link to="/themes">Manage views</Link>
          </p>
        </header>
      </section>
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
