// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Settings › App on a spacesheep account: whose account this phone shows,
// on which host, since when and how it stands; this phone's own key (a row that leads to
// "Approve this iPhone"); connecting again when the key was refused; and Disconnect, with
// what it removes said before it is pressed. The hub asks before a disconnect in its own
// alert; the page only says what came of it.
import { ROUTES } from "@shared/api";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Group, Row } from "../components/SettingsWindow";
import { useFocusTrap } from "../lib/focus";
import { apiFetch } from "../lib/net";
import { Link } from "../lib/router";
import { day, NEW_WORDS as N, REUSED as R, thisPhone } from "../native/accountWords";
import { ConnectAccount } from "../native/ConnectAccount";
import { useAccountView } from "./current";
import { usePhone } from "./device";
import { Mark } from "./Mark";
import { accountState, phoneLine } from "./screenWords";
import "./account.css";

export default function AccountSettings() {
  const v = useAccountView();
  const phone = usePhone();
  const [since, setSince] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Every hook stands above the return below: the view turns to "gone" while this group is
  // on the screen (a disconnect answered yes, an account removed elsewhere), and a render
  // that ran fewer hooks than the one before would throw and take the page with it.
  const asking = useRef(false);
  useEffect(() => {
    let on = true;
    apiFetch(ROUTES.ui.spacesheep, { headers: { accept: "application/json" } })
      .then((r) => r.json())
      .then((j: { link?: { connectedAt?: string } | null }) => on && setSince(day(j.link?.connectedAt ?? "")))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);
  if (!v || v.state === "gone") return null;
  const host = new URL(v.origin).host;
  const st = accountState(v);
  const key = phoneLine(phone.view);
  const disconnect = async () => {
    // One question at a time: a second tap while the app's alert is up asks nothing.
    if (asking.current) return;
    asking.current = true;
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(ROUTES.ui.spacesheep, { method: "DELETE" });
      if (!res.ok) {
        // A no in the app's own alert changes nothing and is no error.
        const j = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
        if (j.reason !== "cancelled") setErr(j.error || R.unreachableNow);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      asking.current = false;
      setBusy(false);
    }
  };
  return (
    <div data-account-settings={v.state}>
      <Group label={R.group} note={err ? <span role="alert">{err}</span> : N.removes(thisPhone())}>
        <Row label={v.email} hint={since ? N.since(host, since) : host}>
          {!st.again && <Mark kind={st.mark}>{st.words}</Mark>}
        </Row>
        {st.again && (
          // What is wrong, and the one thing that mends it, on one row.
          <Row label={<Mark kind={st.mark}>{st.words}</Mark>}>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setConnecting(true)} data-again>
              {N.connectAgain}
            </button>
          </Row>
        )}
        <Row label={N.approveThis(thisPhone())} hint={key ? <Mark kind={key.mark}>{key.words}</Mark> : undefined}>
          <Link
            to="/add-device"
            className="btn btn--sm"
            // Spoken with what it opens: "Open" alone names nothing in a list of links.
            aria-label={`${N.open}: ${N.approveThis(thisPhone())}`}
            data-approve
          >
            {N.open}
          </Link>
        </Row>
        <Row label={R.disconnect}>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            onClick={() => void disconnect()}
            data-disconnect
          >
            {R.disconnect}
          </button>
        </Row>
      </Group>
      {connecting && <ConnectOver origin={v.origin} onLeave={() => setConnecting(false)} />}
    </div>
  );
}

/** Connecting again from Settings: the first run's screens over the app, as a dialog.
 *  Focus goes in and stays in; Escape is the screen's own way out (Cancel, which stops the
 *  connect at the hub before it leaves) and closes nothing behind it; and the app behind
 *  is no part of it while it is up, so there is one main to land on. */
function ConnectOver({ origin, onLeave }: { origin: string; onLeave: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, { initial: ".onb-back" });
  useEffect(() => {
    const root = document.getElementById("root");
    const was = root?.hasAttribute("inert") ?? false;
    root?.setAttribute("inert", "");
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Before anything behind hears it (Settings would close itself, and leave the connect going).
      e.preventDefault();
      e.stopImmediatePropagation();
      ref.current?.querySelector<HTMLButtonElement>(".onb-back")?.click();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (!was) root?.removeAttribute("inert");
    };
  }, []);
  return createPortal(
    <div ref={ref} className="acct-over" role="dialog" aria-modal="true" aria-label={N.connectAgain}>
      <ConnectAccount
        origin={origin}
        platform={thisPhone() === "this phone" ? "android" : "ios"}
        begin="starting"
        onLeave={onLeave}
      />
    </div>,
    document.body,
  );
}
