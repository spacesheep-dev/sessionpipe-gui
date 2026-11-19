// SPDX-License-Identifier: Apache-2.0
// Machines: one grouped section per sending machine, macOS Get Info style, in a centred
// reading column. Its header row is the name and "online · last event 1 m"; then key/value
// rows: the sessions ("9 sessions · 3 working"), the harness versions, the control pairing
// ("Paired · safe mode", the daemon's details on hover), the sessionpipe version, its
// folders (each with "New session in this folder" on right-click), the devices that can
// answer. New session and Add a phone live in the machine's ⋯ and right-click menus, with
// one Add a phone… in the bar. A paired machine is online by its daemon's heartbeat alone,
// one without a daemon by an event in the last minute (lib/offline.ts machineOnline, as
// the board's offline line and the composer read it). Requests waiting for a person
// (pairings, devices) come first; on an address that cannot sign, one line says so above
// the machines.
//
// On a spacesheep account (the phone): one row above the computers says where this phone
// stands with them and opens Approve this iPhone; each computer is its name and ⋯, then
// iOS right-detail rows (Status, Sessions), a sentence only where something is so (an old
// sessionpipe, a computer that has not approved the phone, inherit mode), and the rest
// behind Details. Its words are accountWords.new.ts's MACHINES.
import { accountLabel, type HarnessAccount, type MachinePool, type MachineSummary, ROUTES } from "@shared/api";
import { useEffect, useState } from "react";
import type { ApproveView } from "../account/approve";
import { usePhone } from "../account/device";
import { Mark } from "../account/Mark";
import { machineNote, phoneRow } from "../account/screenWords";
import { useSendStates } from "../account/sendable";
import { Ago, CommandWell, EmptyState, HarnessGlyph, StateDot } from "../components/bits";
import { type MenuList, MoreButton, useContextMenu } from "../components/ContextMenu";
import { PageBar } from "../components/PageBar";
import { machineHome, tildify } from "../control/folders";
import { useRpId } from "../control/hooks";
import { openNewSession } from "../control/newSessionState";
import { PendingDevices, sentence } from "../control/PendingDevices";
import { PendingPairings } from "../control/PendingPairings";
import { canSign, deviceKey, machineTakes, setupLabel, signerKind, signHint, useOwnKeys } from "../control/signer";
import { useMachines, useStore } from "../data/hooks";
import { accountMode, apiFetch } from "../lib/net";
import "../lib/acp";
import { harnessMark } from "../lib/format";
import { copyText } from "../lib/menus";
import { receiverOrigin } from "../lib/net";
import { lastHeard, machineOnline } from "../lib/offline";
import { Link, navigate } from "../lib/router";
import { useSimple } from "../lib/settings";
import { ago, useNow } from "../lib/time";
import { MACHINES as M, ThisPhone } from "../native/accountWords";
import "../control/pairing.css";

/** The one pool word on this page (UX-SPEC §7.4): a login the machine's pool lists, while
 *  the switch is on. An account only in the pool is not a login here and is not drawn. */
const pooled = (pool: MachinePool | undefined, a: HarnessAccount): boolean =>
  !!pool?.on && pool.harness === a.harness && pool.accounts.some((p) => p.id === a.id);

export function Machines() {
  const machines = useMachines();
  const store = useStore();
  const now = useNow();
  const [lanUrl, setLanUrl] = useState<string>(receiverOrigin);
  useEffect(() => {
    store.transport
      .info()
      .then((i) => setLanUrl(i.urls.lan[0] ?? i.urls.local))
      .catch(() => {});
  }, [store]);
  const online = machines.filter((m) => machineOnline(m, now)).length;
  // Whether this address can sign decides a line on the page, so the machines wait for the
  // rp id (one local read, a frame or two) rather than grow a row each under the reader.
  const rp = useRpId();
  // Over plain LAN http (or off the rp id) nothing can be signed here: said once, above the
  // machines it applies to, not repeated in each.
  const secure = canSign(rp);
  const paired = machines.some((m) => !!m.control);
  const account = accountMode();
  // Where this phone's key stands with the account's computers (null off an account).
  const { view } = usePhone();

  return (
    <div className="page page--doc page--grouped machines">
      <PageBar
        title="Machines"
        meta={machines.length ? `${online} of ${machines.length} online` : undefined}
        actions={
          // A machine or a phone is added to a spacesheep account on spacesheep, not here.
          account ? undefined : (
            <>
              <Link to="/phone" className="btn">
                Add a phone…
              </Link>
              <Link to="/connect" className="btn">
                Connect…
              </Link>
            </>
          )
        }
      />
      {!account && <PendingPairings />}
      {!account && <PendingDevices />}
      {rp === null ? null : machines.length === 0 ? (
        account ? (
          <EmptyState center title="No machines yet">
            Pair a computer with this account on {new URL(receiverOrigin()).host}. Its sessions show up here.
          </EmptyState>
        ) : (
          <EmptyState
            center
            title="This Mac is the only machine"
            actions={
              account ? undefined : (
                <Link to="/connect" className="btn btn--primary">
                  Pair another…
                </Link>
              )
            }
          >
            Sessions from another computer show up here once it sends to this receiver.
          </EmptyState>
        )
      ) : (
        <>
          {account ? (
            // On an account the line is this phone's own row, where its state would be.
            <PhoneRow row={phoneRow(view, paired && !secure ? cannotSign(rp) : null)} />
          ) : (
            paired && !secure && <p className="machines-note">{cannotSign(rp)}</p>
          )}
          {machines.map((m) =>
            account ? (
              <AccountMachine key={m.name} m={m} online={machineOnline(m, now)} view={view} rp={rp} secure={secure} />
            ) : (
              <MachineBlock key={m.name} m={m} online={machineOnline(m, now)} lanUrl={lanUrl} rp={rp} secure={secure} />
            ),
          )}
          {machines.length === 1 && !account && (
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
  // The keys this device holds for the rp id (this browser's passkeys, or the app's device
  // key): one of them trusted here is "this one".
  const mine = new Set(useOwnKeys(rp).map((k) => k.id));
  // Whether this device can send there: on an account the device door's word (approved,
  // the hour, this computer's own entry), else the key list (account/sendable.ts).
  const send = useSendStates(rp)(c);
  // Simple mode: online, paired or the pair line, the start form; the daemon's details wait in Advanced.
  const simple = useSimple();
  const pairCmd = `sessionpipe control pair ${lanUrl}`;
  const items = () => machineItems(m, rp, secure, pairCmd);
  const menu = useContextMenu(items, {
    title: () => m.name,
    subtitle: () => (online ? "online" : "quiet"),
  });
  // In the app: a daemon that predates device keys says so; one that takes them offers the
  // setup only while this device is not approved (on an account: asked or not, while no
  // computer trusts it; off one: while this one doesn't) (CONTROL.md §2).
  const setup = send.kind === "unapproved" || send.kind === "waiting" || (send.kind === "catching-up" && !send.account);
  const app =
    secure && c && signerKind() === "device" ? (!machineTakes(c, "device") ? "update" : setup ? "setup" : null) : null;
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
          {c?.remote && <> · paired on {new URL(c.remote.origin).host}</>}
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
          <HarnessList m={m} className="form-kv" />
        </li>
        <li className="form-row form-row--kv machine-control">
          <span className="form-key">Control</span>
          {c ? (
            <span className="form-kv" title={controlDetail(c, simple)}>
              <span className="paired">Paired</span>
              {!c.online && <span className="machine-sub"> · daemon offline</span>}
              {c.mode && <span className="machine-sub"> · {c.mode} mode</span>}
              {c.mode === "inherit" && <span className="machine-caution">{inheritLine(m.name)}</span>}
              {askLine(c, m.name, simple) && <span className="machine-caution">{askLine(c, m.name, simple)}</span>}
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
        {c && !simple && c.accounts && c.accounts.length > 0 && (
          <li className="form-row form-row--kv">
            <span className="form-key">Accounts</span>
            <span className="form-kv machine-accounts">
              {c.accounts.map((a) => (
                <span key={`${a.harness}:${a.id}`}>
                  {accountLabel(a)}
                  <span className="machine-sub">
                    {" "}
                    · {harnessMark(a.harness).label}
                    {a.email ? "" : ", API"}
                    {pooled(c.pool, a) ? ", pooled" : ""}
                  </span>
                </span>
              ))}
            </span>
          </li>
        )}
        {c && !simple && c.folders && c.folders.length > 0 && (
          <li className="form-row form-row--kv">
            <span className="form-key">Folders</span>
            <span className="form-kv machine-folders">
              {c.folders.map((f) => (
                <FolderName key={f} machine={m.name} path={f} home={machineHome(c)} />
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
              {app === "update" && <span className="machine-sub"> · update sessionpipe here to send from the app</span>}
              {app === "setup" && !c?.remote && (
                <>
                  {" · "}
                  <Link to="/add-device" className="link" data-setup>
                    {setupLabel()}
                  </Link>
                </>
              )}
              {app === "setup" && c?.remote && <RemoteAppSetup rpId={c.remote.rpId} origin={c.remote.origin} />}
            </span>
          </li>
        )}
        {!c && !accountMode() && (
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

/** On an account, the one row for this phone above the computers (screenWords.ts phoneRow):
 *  a sentence and its mark, the whole row the way to Approve this iPhone. */
function PhoneRow({ row }: { row: ReturnType<typeof phoneRow> }) {
  if (!row) return null;
  const words = row.mark ? (
    <Mark kind={row.mark}>{row.words}</Mark>
  ) : (
    <span className="machines-phone-ask">{row.words}</span>
  );
  return (
    <section className="form-group machines-phone" aria-label={ThisPhone()}>
      <ul className="form-list">
        <li>
          {row.link ? (
            <Link to="/add-device" className="form-row machine-line-link" data-this-phone={row.state}>
              {words}
              <span className="machines-chev" aria-hidden="true" />
            </Link>
          ) : (
            <div className="form-row" data-this-phone={row.state}>
              {words}
            </div>
          )}
        </li>
      </ul>
    </section>
  );
}

/** A computer of a spacesheep account: its name and ⋯, then Status and Sessions as iOS
 *  right-detail rows that never change shape, a sentence only where something is so, and
 *  the rest behind Details, closed on each visit. Devices are spacesheep's (This iPhone
 *  above opens them); nothing here names a key. */
function AccountMachine({
  m,
  online,
  view,
  rp,
  secure,
}: {
  m: MachineSummary;
  online: boolean;
  view: ApproveView | null;
  rp: string;
  secure: boolean;
}) {
  const c = m.control;
  const simple = useSimple();
  const items = () => machineItems(m, rp, secure, "");
  const menu = useContextMenu(items, {
    title: () => m.name,
    subtitle: () => (online ? M.online : M.offline),
  });
  const note = c ? machineNote(view, c.machineId) : null;
  // The count and its most urgent part only: what needs you, else what is working.
  const busy = m.needsYou > 0 ? M.needsYou(m.needsYou) : m.working > 0 ? M.working(m.working) : "";
  const sessions = m.sessions === 0 ? M.noSessions : busy ? `${m.sessions} · ${busy}` : `${m.sessions}`;
  const version = c?.version?.replace(/^sessionpipe\s+/, "");
  // Details only where it holds something (Simple hides the daemon's own rows).
  const details = !!c && (!!c.mode || c.ask !== undefined || c.queued > 0 || !simple);
  return (
    <section className="form-group machine machine--account" aria-label={m.name} {...menu}>
      <header className="machine-head">
        <h2 className="machine-name">{m.name}</h2>
        <MoreButton build={items} label={`Actions for ${m.name}`} title={() => m.name} />
      </header>
      <ul className="form-list machine-facts">
        <li className="form-row form-row--kv" data-status={!c ? "unpaired" : online ? "online" : "offline"}>
          <span className="form-key">{M.status}</span>
          <span className="form-kv">
            {!c ? (
              <span className="unpaired">Not paired</span>
            ) : online ? (
              M.online
            ) : (
              <>
                <StateDot state="stale" decorative />
                {M.offline}
              </>
            )}
          </span>
        </li>
        <li className="form-row form-row--kv">
          <span className="form-key">Sessions</span>
          <span className="form-kv num">{sessions}</span>
        </li>
        {note && (
          <li className={note.link ? "machine-line" : "form-row machine-line"}>
            {note.link ? (
              <Link to="/add-device" className="form-row machine-line-link" data-not-here>
                <Mark kind={note.mark}>{note.words}</Mark>
                <span className="machines-chev" aria-hidden="true" />
              </Link>
            ) : (
              <Mark kind={note.mark}>{note.words}</Mark>
            )}
          </li>
        )}
        {c?.mode === "inherit" && (
          // What inherit means is a safety line: always in sight, never behind Details.
          <li className="form-row machine-line">
            <span className="machine-caution">{inheritLine(m.name)}</span>
          </li>
        )}
        {c && details && (
          <li className="machine-more">
            <details>
              <summary className="form-row">
                <span className="form-label">{M.details}</span>
                <span className="machines-chev" aria-hidden="true" />
              </summary>
              <ul className="machine-more-list">
                {c.mode && (
                  <li className="form-row form-row--kv">
                    <span className="form-key">{M.mode}</span>
                    <span className="form-kv">{M.modes[c.mode]}</span>
                  </li>
                )}
                {c.ask !== undefined && (
                  <li className="form-row form-row--kv">
                    <span className="form-key">{M.agents}</span>
                    <span className="form-kv">{c.ask ? M.askOn : M.askOff}</span>
                  </li>
                )}
                {c.queued > 0 && (
                  <li className="form-row form-row--kv">
                    <span className="form-key">{M.queued}</span>
                    <span className="form-kv num">{c.queued}</span>
                  </li>
                )}
                {version && !simple && (
                  <li className="form-row form-row--kv">
                    <span className="form-key">sessionpipe</span>
                    <span className="form-kv num">{version}</span>
                  </li>
                )}
                <li className="form-row form-row--stack" hidden={simple}>
                  <span className="form-key">Harnesses</span>
                  <HarnessList m={m} />
                </li>
                {!simple && c.folders && c.folders.length > 0 && (
                  <li className="form-row form-row--stack">
                    <span className="form-key">Folders</span>
                    <span className="machine-folders">
                      {c.folders.map((f) => (
                        <FolderName key={f} machine={m.name} path={f} home={machineHome(c)} />
                      ))}
                    </span>
                  </li>
                )}
              </ul>
            </details>
          </li>
        )}
      </ul>
    </section>
  );
}

/** A machine's ⋯ and right-click menu. */
function machineItems(m: MachineSummary, rp: string, secure: boolean, pairCmd: string): MenuList {
  const c = m.control;
  return [
    c && {
      label: `New session on ${m.name}…`,
      run: () => openNewSession({ machine: m.name }),
      // Nothing here can be signed: why, in the signer's words. Anything else the sheet says.
      disabled: secure ? undefined : sentence(signHint(rp)),
    },
    c && !accountMode() && { label: "Add a phone…", run: () => navigate("/phone") },
    { sep: true },
    // That command pairs a machine with a receiver; an account's are paired on spacesheep.
    !c && !accountMode() && { label: "Copy pair command", run: () => copyText(pairCmd) },
    { label: "Copy machine name", run: () => copyText(m.name) },
  ];
}

/** The harnesses its sessions came from, then the ones its daemon can start that sent none
 *  yet (sessionpipe 0.10: every ACP agent installed there). */
function HarnessList({ m, className = "" }: { m: MachineSummary; className?: string }) {
  const harnesses = [
    ...Object.entries(m.harnesses),
    ...(m.control?.harnesses ?? []).filter((h) => !(h in m.harnesses)).map((h) => [h, undefined] as const),
  ];
  return (
    <span className={className ? `${className} machine-harnesses` : "machine-harnesses"}>
      {harnesses.length === 0 && <span className="machine-sub">None reported yet</span>}
      {harnesses.map(([h, v]) => (
        <span key={h} className="machine-harness">
          <HarnessGlyph name={h} size="sm" />
          <span>{harnessMark(h).label}</span>
          {v && <span className="machine-ver num">{v}</span>}
        </span>
      ))}
    </span>
  );
}

/** What inherit mode (sessionpipe 0.10) means, in the one line said under the mode. */
const inheritLine = (machine: string): string =>
  `Sessions run as your own do on ${machine}: the agents' own settings decide, which can mean no permission checks.`;

/** Why nothing can be signed on this address, as a sentence. */
const cannotSign = (rp: string): string => sentence(signHint(rp)).replace(/\.?$/, ".");

/** What the hello says about agents asking each other (CONTROL.md §13 `ask`) and answers
 *  coming back into a session (§3.1 `handoff`), as one line under the pairing; a daemon
 *  that says neither is an older sessionpipe, said only in Advanced. */
function askLine(c: NonNullable<MachineSummary["control"]>, machine: string, simple: boolean): string | null {
  if (c.ask && c.handoff) return "Agents here can ask each other, and an answer can be brought back into a session.";
  if (c.ask) return "Agents here can ask each other.";
  if (c.ask === false)
    return `Asking between agents is off here (sessionpipe ask on).${c.handoff ? " An answer can still be brought back into a session." : ""}`;
  if (c.handoff) return "An answer can be brought back into a session.";
  return simple ? null : `Update sessionpipe on ${machine} for its agents to ask each other.`;
}

/** The daemon's own details, for the Control row's tooltip: "daemon online · polled 4 s
 *  ago" (a computer reached through spacesheep polls there: its last_seen). */
function controlDetail(c: NonNullable<MachineSummary["control"]>, simple: boolean): string {
  const now = Date.now();
  const heard = lastHeard(c);
  return [
    c.online ? "daemon online" : "daemon offline",
    heard ? `polled ${ago(heard, now)}` : "",
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

/** In the app, a machine paired on spacesheep that doesn't trust this app's key yet: the
 *  app's device key for that receiver's rp id goes to spacesheep (docs/rfcs/08 phase B),
 *  which shows the request on its Devices page with the number shown here; a passkey
 *  there approves it, once per machine. */
function RemoteAppSetup({ rpId, origin }: { rpId: string; origin: string }) {
  const [asked, setAsked] = useState<{ code?: string; devicesUrl?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const host = new URL(origin).host;
  const ask = async () => {
    setBusy(true);
    setErr(null);
    try {
      const key = await deviceKey(rpId);
      const res = await apiFetch(`${ROUTES.ui.spacesheep}/device`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ key }),
      });
      const j = (await res.json()) as { code?: string; devicesUrl?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setAsked({ code: j.code, devicesUrl: j.devicesUrl });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (asked)
    return (
      <>
        {" · "}
        <span data-remote-setup>
          Approve this app on {host}: it shows <strong className="num">{asked.code}</strong>
          {asked.devicesUrl && (
            <>
              {" · "}
              <a href={asked.devicesUrl} target="_blank" rel="noreferrer" className="link">
                open Devices there →
              </a>
            </>
          )}
        </span>
      </>
    );
  return (
    <>
      {" · "}
      <button type="button" className="link" disabled={busy} onClick={() => void ask()} data-remote-setup>
        {busy ? "Asking…" : `Approve this app on ${host}…`}
      </button>
      {err && <span className="machine-sub machine-err"> · {err}</span>}
    </>
  );
}
