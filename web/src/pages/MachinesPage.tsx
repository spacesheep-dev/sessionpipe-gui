// SPDX-License-Identifier: Apache-2.0
// Machines: one grouped section per sending machine, macOS Get Info style, in a centred
// reading column. Its header row is the name and "online · last event 1 m" (a quiet
// machine alone carries a hollow ring: online is the normal case and needs no mark); then
// key/value rows: the sessions ("9 sessions · 3 working"), the harness versions, the
// control pairing ("Paired · safe mode", the daemon's details on hover), the sessionpipe
// version, its folders (each with "New session in this folder" on right-click), the
// devices that can answer. New session and Add a phone live in the machine's ⋯ and
// right-click menus, with one Add a phone… in the bar. A machine is online if an event
// arrived in the last minute or its control daemon is online. Requests waiting for a
// person (pairings, devices) come first; on an address that cannot sign, one line says so
// above the machines.
import type { MachineSummary } from "@shared/api";
import { useEffect, useState } from "react";
import { Ago, CommandWell, EmptyState, HarnessGlyph } from "../components/bits";
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
import { ago, ms, useNow } from "../lib/time";
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
  // Whether this address can sign decides a line on the page, so the machines wait for the
  // rp id (one local read, a frame or two) rather than grow a row each under the reader.
  const rp = useRpId();
  // Over plain LAN http (or off the rp id) nothing can be signed here: said once, above the
  // machines it applies to, not repeated in each.
  const secure = passkeysAvailable(rp);
  const paired = machines.some((m) => !!m.control);

  return (
    <div className="page page--doc page--grouped machines">
      <PageBar
        title="Machines"
        meta={machines.length ? `${online} of ${machines.length} online` : undefined}
        actions={
          <>
            <Link to="/phone" className="btn">
              Add a phone…
            </Link>
            <Link to="/connect" className="btn">
              Connect…
            </Link>
          </>
        }
      />
      <PendingPairings />
      <PendingDevices />
      {rp === null ? null : machines.length === 0 ? (
        <EmptyState
          center
          title="This Mac is the only machine"
          actions={
            <Link to="/connect" className="btn btn--primary">
              Pair another…
            </Link>
          }
        >
          Sessions from another computer show up here once it sends to this receiver.
        </EmptyState>
      ) : (
        <>
          {paired && !secure && <p className="machines-note">{sentence(insecureHint()).replace(/\.?$/, ".")}</p>}
          {machines.map((m) => (
            <MachineBlock key={m.name} m={m} online={isOnline(m, now)} lanUrl={lanUrl} rp={rp} secure={secure} />
          ))}
          {machines.length === 1 && (
            <p className="machines-more">
              {machines[0]!.name} is the only machine.{" "}
              <Link to="/connect" className="link">
                Pair another…
              </Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}

function MachineBlock({
  m,
  online,
  lanUrl,
  rp,
  secure,
}: {
  m: MachineSummary;
  online: boolean;
  lanUrl: string;
  rp: string;
  secure: boolean;
}) {
  const c = m.control;
  // The passkeys this browser made for the rp id: one of them trusted here is "this one".
  const mine = new Set(storedPasskeys(rp).map((k) => k.id));
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
            {m.sessions} {m.sessions === 1 ? "session" : "sessions"}
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
            <span className="form-kv" title={controlDetail(c, simple)}>
              <span className="paired">Paired</span>
              {!c.online && <span className="machine-sub"> · daemon offline</span>}
              {c.mode && <span className="machine-sub"> · {c.mode === "safe" ? "safe mode" : "auto mode"}</span>}
            </span>
          ) : (
            <span className="form-kv">
              <span className="unpaired">Not paired</span>
            </span>
          )}
        </li>
        {c?.version && !simple && (
          <li className="form-row form-row--kv">
            <span className="form-key">sessionpipe</span>
            <span className="form-kv num">
              {c.version}
              {!c.start && <span className="machine-sub"> · starts no sessions</span>}
            </span>
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
          </li>
        )}
        {!c && (
          <li className="form-row form-row--stack">
            <span className="form-row-text">
              <span className="form-label">Pair it</span>
              <span className="form-caption">On {m.name}, in a terminal; then approve the six digits here.</span>
            </span>
            <div className="machine-ctl-row">
              <CommandWell command={pairCmd} prompt={false} label="Copy pair command" />
            </div>
          </li>
        )}
      </ul>
    </section>
  );
}

/** The daemon's own details, for the Control row's tooltip: "daemon online · polled 4 s
 *  ago". */
function controlDetail(c: NonNullable<MachineSummary["control"]>, simple: boolean): string {
  const now = Date.now();
  return [
    c.online ? "daemon online" : "daemon offline",
    c.lastPollAt ? `polled ${ago(c.lastPollAt, now)}` : "",
    simple && c.version ? `sessionpipe ${c.version}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
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
