// SPDX-License-Identifier: Apache-2.0
// Machines: one block per sending machine, online if an event arrived in the last minute
// or its control daemon is online; harness versions; control pairing status.
import type { MachineSummary } from "@shared/api";
import { useEffect, useState } from "react";
import { Ago, HarnessGlyph } from "../components/bits";
import { tlsInfo } from "../control/api";
import { useRpId } from "../control/hooks";
import { PendingDevices } from "../control/PendingDevices";
import { PendingPairings } from "../control/PendingPairings";
import { StartSession } from "../control/StartSession";
import { storedPasskeys } from "../control/webauthn";
import { useMachines, useStore } from "../data/hooks";
import { harnessMark } from "../lib/format";
import { Link } from "../lib/router";
import { useSimple } from "../lib/settings";
import { ms, useNow } from "../lib/time";

export function Machines() {
  const machines = useMachines();
  const store = useStore();
  const now = useNow();
  const [lanUrl, setLanUrl] = useState<string>(location.origin);
  useEffect(() => {
    store.transport
      .info()
      .then((i) => setLanUrl(i.urls.lan[0] ?? i.urls.local))
      .catch(() => {});
  }, [store]);

  if (machines.length === 0) {
    return (
      <div className="page">
        <PendingPairings />
        <PendingDevices />
        <p className="page-note">
          No machine has sent anything yet. <Link to="/connect">Connect one.</Link>
        </p>
      </div>
    );
  }
  return (
    <div className="page machines">
      <PendingPairings />
      <PendingDevices />
      {machines.map((m) => (
        <MachineBlock key={m.name} m={m} now={now} lanUrl={lanUrl} />
      ))}
    </div>
  );
}

function MachineBlock({ m, now, lanUrl }: { m: MachineSummary; now: number; lanUrl: string }) {
  const recent = now - ms(m.lastAt) < 60_000;
  const online = recent || !!m.control?.online;
  const c = m.control;
  const rp = useRpId();
  // The passkeys this browser made for the rp id: one of them trusted here is "this one".
  const mine = new Set(rp ? storedPasskeys(rp).map((k) => k.id) : []);
  const httpsUrl = tlsInfo()?.httpsUrl ?? lanUrl;
  // Simple mode: online, paired or the pair line, the start button; the daemon's details wait in Advanced.
  const simple = useSimple();
  return (
    <section className={`machine ${online ? "machine--on" : ""}`} aria-label={m.name}>
      <header className="machine-head">
        <span className={`online ${online ? "online--on" : ""}`} role="img" aria-label={online ? "online" : "quiet"} />
        <h2 className="machine-name">{m.name}</h2>
        <span className="machine-last">
          {online ? "online" : "quiet"} · last event <Ago iso={m.lastAt} />
        </span>
      </header>
      <dl className="machine-facts">
        <div>
          <dt>sessions</dt>
          <dd className="num">
            {m.sessions}
            {m.working > 0 && <span className="is-work"> · {m.working} working</span>}
            {m.needsYou > 0 && <span className="is-needs"> · {m.needsYou} need you</span>}
          </dd>
        </div>
        <div hidden={simple}>
          <dt>harnesses</dt>
          <dd className="machine-harnesses">
            {Object.entries(m.harnesses).map(([h, v]) => (
              <span key={h} className="machine-harness">
                <HarnessGlyph name={h} size="sm" />
                <span>{harnessMark(h).label}</span>
                {v && <span className="mono machine-ver">{v}</span>}
              </span>
            ))}
          </dd>
        </div>
        <div className="machine-control">
          <dt>control</dt>
          {c ? (
            <dd>
              <span className="paired">
                paired{simple ? ` · ${c.online ? "daemon online" : "daemon offline"}` : ""}
              </span>
              {simple ? null : (
                <>
                  <span className="machine-ctl-row">
                    {c.online ? "daemon online" : "daemon offline"}
                    {c.lastPollAt && (
                      <>
                        {" "}
                        · polled <Ago iso={c.lastPollAt} />
                      </>
                    )}
                    {c.mode && <> · mode {c.mode}</>}
                    {c.version && <> · v{c.version}</>}
                  </span>
                  {c.folders && c.folders.length > 0 && (
                    <span className="machine-ctl-row mono">{c.folders.join("  ")}</span>
                  )}
                </>
              )}
              <span className="machine-ctl-row machine-devices">
                Devices that can answer:{" "}
                {c.keys.length === 0
                  ? "none yet"
                  : c.keys.map((k) => `${k.name ?? k.id.slice(0, 8)}${mine.has(k.id) ? " (this one)" : ""}`).join(", ")}
                {c.queued > 0 && <> · {c.queued} queued</>}
                {" · "}
                <details className="machine-add-phone">
                  <summary>+ Add a phone</summary>
                  <span>
                    <Link to="/phone">Your phone</Link> walks it through: an https address it trusts (
                    <span className="mono">{httpsUrl}</span>), then <strong>Send from this phone</strong>; approve its
                    six digits here. Only a device the machine already trusts can vouch for one.
                  </span>
                </details>
              </span>
            </dd>
          ) : (
            <dd>
              <span className="unpaired">not paired</span>
              <span className="machine-ctl-row">
                On {m.name}: <code>sessionpipe control pair {lanUrl}</code>
              </span>
            </dd>
          )}
        </div>
        {c && <StartSession m={m} c={c} />}
      </dl>
    </section>
  );
}
