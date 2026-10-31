// SPDX-License-Identifier: Apache-2.0
// The phone's first run (NATIVE-SPEC §3.9): the app found no receiver. One idea per screen,
// one primary action, the brand mark and the lockup, the grouped-form grammar for the
// one list it has (the install steps). The decisions are onboarding.ts's; this file draws
// a step and runs the shell's commands for it: the camera (scanner.ts), `rx_add` (the
// shell asks in its own sheet) and `rx_select` (the shell reopens the window on the
// receiver). The Mac's welcome is Welcome.tsx.
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useReducer, useRef } from "react";
import { Mark } from "../components/Brand";
import { haptic } from "../lib/haptics";
import { invoke } from "./bridge";
import { INSTALL_COMMAND } from "./logic";
import { INITIAL, isScanning, parsePayload, step, trustBrowser, WORDS } from "./onboarding";
import { cameraPermission, cancelScan, hasScanner, openCameraSettings, requestCamera, scanQr } from "./scanner";
import type { ShellInfo } from "./shell";
import "./native.css";

interface Receiver {
  id: string;
}

const openOutside = (url: string) => void invoke("app_open_external", { url }).catch(() => {});

/** A line that names the computer: its name never breaks at its hyphen ("studio-" /
 *  "mac"), so the words stay one word. */
function withHost(text: string, host?: string): ReactNode {
  if (!host || !text.includes(host)) return text;
  const parts = text.split(host);
  return parts.map((part, i) => (
    <span key={i}>
      {part}
      {i < parts.length - 1 && <span className="onb-nowrap">{host}</span>}
    </span>
  ));
}

export function Onboarding({ info }: { info: ShellInfo }) {
  const browser = trustBrowser(info.platform === "android" ? "android" : "ios");
  const [s, send] = useReducer(step, INITIAL);
  const field = useRef<HTMLInputElement>(null);
  const scanner = hasScanner();

  // The camera: asked for when Scan is tapped, never before; then one scan.
  useEffect(() => {
    if (s.kind !== "scan") return;
    let on = true;
    if (s.status === "asking") {
      void (async () => {
        let standing = await cameraPermission();
        if (standing === "prompt") standing = await requestCamera();
        if (on) send({ type: "camera", standing });
      })();
      return () => {
        on = false;
      };
    }
    void scanQr().then(
      (text) => {
        if (!on) return;
        // A good code lands with a tap; a stray one with a bump.
        if (text !== null) haptic(parsePayload(text, { scanned: true }).ok ? "success" : "error");
        send({ type: "scanned", text });
      },
      (error) => on && send({ type: "scan-failed", error }),
    );
    return () => {
      on = false;
    };
  }, [s.kind, s.kind === "scan" ? s.status : null]);

  // Back in the foreground (from Settings, or from the trust page in the browser): a
  // refused camera that was turned on meanwhile scans at once; the trust step moves to
  // its second beat.
  const watching = s.kind === "denied" || s.kind === "trust" ? s.kind : null;
  useEffect(() => {
    if (!watching) return;
    let on = true;
    const check = () => {
      if (document.visibilityState === "hidden") return;
      if (watching === "trust") {
        send({ type: "returned" });
        return;
      }
      void cameraPermission().then((standing) => {
        if (on && standing === "granted") send({ type: "scan" });
      });
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      on = false;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [watching]);

  // Connecting: the shell asks in its own sheet, then reopens the window on the receiver.
  const connectingUrl = s.kind === "connecting" ? s.url : null;
  useEffect(() => {
    if (!connectingUrl) return;
    let on = true;
    void (async () => {
      try {
        const rx = await invoke<Receiver | null>("rx_add", { url: connectingUrl });
        if (!rx) throw new Error("cancelled");
        await invoke("rx_select", { id: rx.id });
        if (on) send({ type: "connected" });
      } catch (error) {
        if (on) send({ type: "error", error });
      }
    })();
    return () => {
      on = false;
    };
  }, [connectingUrl]);

  useEffect(() => {
    if (s.kind === "address") requestAnimationFrame(() => field.current?.focus());
  }, [s.kind]);

  if (isScanning(s)) return <Viewfinder onCancel={cancelScan} />;

  const back = (
    <button type="button" className="btn btn--ghost onb-back" onClick={() => send({ type: "back" })}>
      {WORDS.back}
    </button>
  );

  if (s.kind === "scan")
    // The system's alert is up (or the shell is about to show it): the page keeps still.
    return <Screen bar={back} />;

  if (s.kind === "denied")
    return (
      <Screen bar={back} title={WORDS.denied.title} body={WORDS.denied.body} data-step="denied">
        <Primary onClick={openCameraSettings}>{WORDS.denied.settings}</Primary>
        <Secondary onClick={() => send({ type: "address" })}>{WORDS.addressInstead}</Secondary>
      </Screen>
    );

  if (s.kind === "no-camera")
    return (
      <Screen bar={back} title={WORDS.noCamera.title} body={WORDS.noCamera.body} data-step="no-camera">
        <Primary onClick={() => send({ type: "address" })}>{WORDS.addressInstead}</Primary>
      </Screen>
    );

  if (s.kind === "trust")
    return (
      <Screen
        bar={back}
        title={WORDS.trust.title(s.host)}
        body={WORDS.trust.body(s.host, browser)}
        host={s.host}
        data-step="trust"
        data-opened={s.opened || undefined}
      >
        {s.opened ? (
          <>
            <Primary onClick={() => send({ type: "connect" })}>{WORDS.trust.connect}</Primary>
            <Quiet onClick={() => openOutside(s.url)}>{WORDS.trust.again}</Quiet>
          </>
        ) : (
          <Primary onClick={() => openOutside(s.url)}>{WORDS.trust.open(browser)}</Primary>
        )}
      </Screen>
    );

  if (s.kind === "bad-code")
    return (
      <Screen bar={back} title={WORDS.badCode.title} body={s.message} data-step="bad-code">
        <Primary onClick={() => send({ type: "scan" })}>{WORDS.badCode.again}</Primary>
        <Secondary onClick={() => send({ type: "address" })}>{WORDS.address}</Secondary>
      </Screen>
    );

  if (s.kind === "connecting" || s.kind === "done")
    return (
      <Screen
        title={WORDS.connecting(s.host)}
        host={s.host}
        glyph={<span className="spinner onb-spinner" aria-hidden="true" />}
        data-step="connecting"
        live
      />
    );

  if (s.kind === "failed")
    return (
      <Screen bar={back} title={WORDS.failed.title(s.host)} body={s.message} host={s.host} data-step="failed" live>
        <Primary onClick={() => send({ type: "retry" })}>{WORDS.failed.retry}</Primary>
        {s.from === "scan" && <Secondary onClick={() => send({ type: "address" })}>{WORDS.address}</Secondary>}
      </Screen>
    );

  if (s.kind === "address")
    return (
      <Screen bar={back} title={WORDS.addressStep.title} body={WORDS.addressStep.caption} data-step="address">
        <form
          className="onb-form"
          onSubmit={(e) => {
            e.preventDefault();
            send({ type: "connect" });
          }}
        >
          <input
            ref={field}
            className="field onb-field"
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            placeholder={WORDS.addressStep.placeholder}
            aria-label={WORDS.addressStep.title}
            aria-invalid={s.error ? true : undefined}
            aria-describedby={s.error ? "onb-error" : undefined}
            value={s.value}
            onChange={(e) => send({ type: "typed", value: e.target.value })}
          />
          {s.error && (
            <p className="onb-error" id="onb-error" role="alert">
              {s.error}
            </p>
          )}
          <Primary type="submit" disabled={!s.value.trim()}>
            {WORDS.addressStep.connect}
          </Primary>
        </form>
      </Screen>
    );

  // The welcome.
  return (
    <div className="onb" data-step="welcome">
      <main className="onb-body" id="main">
        <div className="onb-hero">
          <div className="onb-lockup" role="img" aria-label={WORDS.name}>
            <Mark size={64} />
            <span className="brand-name onb-name" aria-hidden="true" />
          </div>
          <p className="onb-lede">{WORDS.lede}</p>
        </div>
        <div className="onb-actions">
          {scanner && <Primary onClick={() => send({ type: "scan" })}>{WORDS.scan}</Primary>}
          {scanner ? (
            <Secondary onClick={() => send({ type: "address" })}>{WORDS.address}</Secondary>
          ) : (
            <Primary onClick={() => send({ type: "address" })}>{WORDS.address}</Primary>
          )}
          <button
            type="button"
            className="onb-help"
            aria-expanded={s.help}
            aria-controls="onb-install"
            onClick={() => send({ type: "help", open: !s.help })}
          >
            {WORDS.noServer}
            <span className="onb-help-chevron" aria-hidden="true" />
          </button>
          {s.help && <InstallSteps />}
          <Quiet onClick={() => location.assign("/?mock=1")}>{WORDS.demo}</Quiet>
        </div>
      </main>
    </div>
  );
}

/** One screen: an optional bar (Back), a glyph over the title, one line under it, then
 *  its actions. */
function Screen({
  bar,
  glyph,
  title,
  body,
  host,
  live,
  children,
  ...rest
}: {
  bar?: ReactNode;
  glyph?: ReactNode;
  title?: string;
  body?: string;
  /** The computer's name, where the title or body says it. */
  host?: string;
  live?: boolean;
  children?: ReactNode;
  "data-step"?: string;
  "data-opened"?: boolean;
}) {
  return (
    <div className="onb" {...rest}>
      <header className="onb-bar">{bar}</header>
      <main className="onb-body onb-body--step" id="main" aria-live={live ? "polite" : undefined}>
        {title && (
          <div className="onb-head">
            {glyph}
            <h1 className="onb-title">{withHost(title, host)}</h1>
            {body && <p className="onb-text">{withHost(body, host)}</p>}
          </div>
        )}
        <div className="onb-actions">{children}</div>
      </main>
    </div>
  );
}

/** The one primary action of a screen: the ink fill, as every primary in the app. */
function Primary(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className="btn btn--primary btn--lg onb-primary" />;
}
function Secondary(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className="btn btn--lg onb-secondary" />;
}
function Quiet(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className="btn btn--ghost btn--lg onb-quiet" />;
}

/** The step card under "No sessionpipe on your computer yet?": three numbered rows in
 *  the grouped-form grammar, the install command in a well that wraps (nothing to copy
 *  from on a phone: it is typed on the computer). */
function InstallSteps() {
  return (
    <section className="form-group onb-install" id="onb-install" aria-label={WORDS.install.title}>
      <ol className="form-list onb-steps">
        {WORDS.install.steps.map((st, i) => (
          <li key={st.label} className={`form-row ${i === 0 ? "form-row--stack" : ""}`}>
            <span className="form-row-text onb-step-text">
              <span className="onb-step-n" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <span className="form-label">{st.label}</span>
                <span className="form-caption">
                  {i === 0 ? (
                    <>
                      Download it from{" "}
                      <a
                        href={WORDS.install.site}
                        className="onb-link"
                        onClick={(e) => {
                          e.preventDefault();
                          openOutside(WORDS.install.site);
                        }}
                      >
                        {WORDS.install.siteLabel}
                      </a>
                      , or with Node 20 in a terminal:
                    </>
                  ) : (
                    st.caption
                  )}
                </span>
              </span>
            </span>
            {i === 0 && (
              <div className="cmdwell onb-cmd">
                <code className="cmdwell-text">{INSTALL_COMMAND}</code>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The viewfinder over the live camera: a dimmed mask with a rounded square cut out, the
 *  brand's orange at its corners, the caption, Cancel at the top. The page's ground is
 *  transparent meanwhile (mobile.css, `html[data-scanning]`). */
function Viewfinder({ onCancel }: { onCancel: () => void }) {
  return (
    <div
      className="onb onb--scan"
      data-step="scan"
      role="dialog"
      aria-label={WORDS.scan}
      aria-describedby="onb-scan-caption"
    >
      <div className="onb-mask" aria-hidden="true">
        <div className="onb-cutout">
          <i className="onb-corner" />
          <i className="onb-corner" />
          <i className="onb-corner" />
          <i className="onb-corner" />
        </div>
      </div>
      <header className="onb-bar onb-bar--scan">
        <button type="button" className="btn btn--ghost onb-cancel" onClick={onCancel}>
          {WORDS.scanning.cancel}
        </button>
      </header>
      <p className="onb-caption" id="onb-scan-caption">
        {WORDS.scanning.caption}
      </p>
    </div>
  );
}
