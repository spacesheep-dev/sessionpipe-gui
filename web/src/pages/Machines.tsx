// SPDX-License-Identifier: Apache-2.0
// Machines: one grouped section per sending machine, macOS Get Info style. Its header row
// is the status glyph, the name and "online · last event 1 m"; then key/value rows: the
// sessions, the harness versions, the control pairing (with New session…, which opens the
// compose sheet for that machine), its folders (each with "New session in this folder" on
// right-click), the devices that can answer. A machine is online if an event
// arrived in the last minute or its control daemon is online. Requests waiting for a
// person (pairings, devices) come first. Each section's menu holds its real actions.
import type { MachineSummary } from "@shared/api";
import { useEffect, useState } from "react";
import { Ago, CopyIconButton, HarnessGlyph } from "../components/bits";
import { type MenuList, MoreButton, useContextMenu } from "../components/ContextMenu";
import { PageBar } from "../components/PageBar";
import { tildify } from "../control/folders";
import { useRpId } from "../control/hooks";
import { openNewSession } from "../control/newSessionState";
import { PendingDevices, sentence } from "../control/PendingDevices";
import { PendingPairings } from "../control/PendingPairings";
import { insecureHint, passkeysAvailable, storedPasskeys } from "../control/webauthn";
import { useMachines, useStore } from "../data/hooks";
import { harnessMark } from "../lib/format";
import { copyText } from "../lib/menus";
import { Link, navigate } from "../lib/router";
import { useSimple } from "../lib/settings";
import { ms, useNow } from "../lib/time";
import "../control/pairing.css";

const isOnline = (m: MachineSummary, now: number) => now - ms(m.lastAt) < 60_000 || !!m.control?.online;

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
  const online = machines.filter((m) => isOnline(m, now)).length;

  return (
    <div className="page page--doc page--grouped machines">
      <PageBar
        title="Machines"
        meta={machines.length ? `${online} of ${machines.length} online` : undefined}
        actions={
          <Link to="/connect" className="btn">
            Connect…
          </Link>
        }
      />
      <PendingPairings />
      <PendingDevices />
      {machines.length === 0 ? (
        <div className="state">
          <span className="state-title">No machine has sent anything yet</span>
          <span className="state-text">Add this receiver as a sink on a machine and its sessions show up here.</span>
          <Link to="/connect" className="btn">
            Connect a machine
          </Link>
        </div>
      ) : (
        machines.map((m) => <MachineBlock key={m.name} m={m} online={isOnline(m, now)} lanUrl={lanUrl} />)
      )}
    </div>
  );
}

function MachineBlock({ m, online, lanUrl }: { m: MachineSummary; online: boolean; lanUrl: string }) {
  const c = m.control;
  const rp = useRpId();
  // The passkeys this browser made for the rp id: one of them trusted here is "this one".
  const mine = new Set(rp ? storedPasskeys(rp).map((k) => k.id) : []);
  // Over plain LAN http (or off the rp id) nothing can be signed here: say why, once.
  const secure = passkeysAvailable(rp);
  // Simple mode: online, paired or the pair line, the start form; the daemon's details wait in Advanced.
  const simple = useSimple();
  const pairCmd = `sessionpipe control pair ${lanUrl}`;
  const items = (): MenuList => [
    c && {
      label: `New session on ${m.name}…`,
      run: () => openNewSession({ machine: m.name }),
      disabled: secure ? undefined : "Passkeys cannot sign on this address",
    },
    c && { label: "Add a phone…", run: () => navigate("/phone") },
    { sep: true },
    !c && { label: "Copy pair command", run: () => copyText(pairCmd) },
    { label: "Copy machine name", run: () => copyText(m.name) },
  ];
  const menu = useContextMenu(items, {
    title: () => m.name,
    subtitle: () => (online ? "online" : "quiet"),
  });
  const devices =
    c && c.keys.length > 0
      ? c.keys.map((k) => `${k.name ?? k.id.slice(0, 8)}${mine.has(k.id) ? " (this one)" : ""}`).join(", ")
      : "None yet";
  return (
    <section className={`form-group machine ${online ? "machine--on" : ""}`} aria-label={m.name} {...menu}>
      <header className="machine-head">
        <span className={`online ${online ? "online--on" : ""}`} role="img" aria-label={online ? "online" : "quiet"} />
        <h2 className="machine-name">{m.name}</h2>
        <span className="machine-last">
          {online ? "online" : "quiet"} · last event <Ago iso={m.lastAt} />
        </span>
        <MoreButton build={items} label={`Actions for ${m.name}`} title={() => m.name} />
      </header>
      <ul className="form-list machine-facts">
        <li className="form-row form-row--kv">
          <span className="form-key">Sessions</span>
          <span className="form-kv num">
            {m.sessions}
            {m.working > 0 && <span className="machine-sub"> · {m.working} working</span>}
            {m.needsYou > 0 && (
              <span className="machine-sub">
                {" "}
                · {m.needsYou} {m.needsYou === 1 ? "needs" : "need"} you
              </span>
            )}
          </span>
        </li>
        <li className="form-row form-row--kv" hidden={simple}>
          <span className="form-key">Harnesses</span>
          <span className="form-kv machine-harnesses">
            {Object.keys(m.harnesses).length === 0 && <span className="machine-sub">None reported yet</span>}
            {Object.entries(m.harnesses).map(([h, v]) => (
              <span key={h} className="machine-harness">
                <HarnessGlyph name={h} size="sm" />
                <span>{harnessMark(h).label}</span>
                {v && <span className="machine-ver num">{v}</span>}
              </span>
            ))}
          </span>
        </li>
        <li className="form-row form-row--kv machine-control">
          <span className="form-key">Control</span>
          {c ? (
            <span className="form-kv">
              <span className="paired">Paired</span>
              <span className="machine-sub">
                {" "}
                · {c.online ? "daemon online" : "daemon offline"}
                {!simple && c.lastPollAt && (
                  <>
                    {" "}
                    · polled <Ago iso={c.lastPollAt} />
                  </>
                )}
                {!simple && c.mode && <> · {c.mode} mode</>}
                {!simple && c.version && <> · v{c.version}</>}
              </span>
            </span>
          ) : (
            <span className="form-kv">
              <span className="unpaired">Not paired</span>
            </span>
          )}
          {c && secure && (
            <span className="form-value">
              <button
                type="button"
                className="btn btn--sm machine-btn"
                onClick={() => openNewSession({ machine: m.name })}
                data-new-session-for={m.name}
              >
                New session…
              </button>
            </span>
          )}
        </li>
        {c && !secure && (
          <li className="form-row form-row--stack">
            <span className="form-caption">{sentence(insecureHint()).replace(/\.?$/, ".")}</span>
          </li>
        )}
        {c && !simple && c.folders && c.folders.length > 0 && (
          <li className="form-row form-row--kv">
            <span className="form-key">Folders</span>
            <span className="form-kv machine-folders">
              {c.folders.map((f) => (
                <FolderName key={f} machine={m.name} path={f} home={c.home} />
              ))}
            </span>
          </li>
        )}
        {c && (
          <li className="form-row form-row--kv machine-devices">
            <span className="form-key">Devices</span>
            <span className="form-kv">
              {devices}
              {c.queued > 0 && <span className="machine-sub"> · {c.queued} queued</span>}
            </span>
            <span className="form-value">
              <Link to="/phone" className="btn btn--sm machine-btn">
                Add a phone…
              </Link>
            </span>
          </li>
        )}
        {!c && (
          <li className="form-row form-row--stack">
            <span className="form-row-text">
              <span className="form-label">Pair it</span>
              <span className="form-caption">On {m.name}, in a terminal; then approve the six digits here.</span>
            </span>
            <div className="well-row machine-ctl-row">
              <code>{pairCmd}</code>
              <CopyIconButton text={pairCmd} label="Copy pair command" />
            </div>
          </li>
        )}
      </ul>
    </section>
  );
}

/** One allowed folder, shown with `~`; right-click starts a session there. */
function FolderName({ machine, path, home }: { machine: string; path: string; home?: string }) {
  const menu = useContextMenu(
    () => [
      { label: "New session in this folder", run: () => openNewSession({ machine, cwd: path }) },
      { sep: true },
      { label: "Copy path", run: () => copyText(path) },
    ],
    { title: () => tildify(path, home) },
  );
  return (
    <span className="mono machine-folder" title={path} {...menu}>
      {tildify(path, home)}
    </span>
  );
}
