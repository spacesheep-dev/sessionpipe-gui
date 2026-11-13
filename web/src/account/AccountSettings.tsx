// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Settings › App on a spacesheep account: whose account this phone shows,
// on which host, since when and how it stands; this phone's own key (a row that leads to
// "Approve this iPhone"); connecting again when the key was refused; and Disconnect, with
// what it removes said before it is pressed. The hub asks before a disconnect in its own
// alert; the page only says what came of it.
import { ROUTES } from "@shared/api";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Group, Row } from "../components/SettingsWindow";
import { apiFetch } from "../lib/net";
import { Link } from "../lib/router";
import { day, NEW_WORDS as N, REUSED as R, thisPhone } from "../native/accountWords";
import { ConnectAccount } from "../native/ConnectAccount";
import type { AccountView } from "./backend";
import { accountBackend } from "./current";
import { usePhone } from "./device";
import { accountState, phoneLine } from "./screenWords";
import "./account.css";

/** How the account stands, as the backend says it, for a component. */
export function useAccountView(): AccountView | null {
  const b = accountBackend();
  const [v, setV] = useState<AccountView | null>(() => b?.view() ?? null);
  useEffect(() => {
    if (!b) return;
    setV(b.view());
    return b.subscribe(() => setV(b.view()));
  }, [b]);
  return v;
}

export function Mark({ kind, children }: { kind: "ok" | "wait" | "warn"; children: string }) {
  return (
    <span className={`acct-state acct-state--${kind}`} data-state={kind}>
      {children}
    </span>
  );
}

export default function AccountSettings() {
  const v = useAccountView();
  const phone = usePhone();
  const [since, setSince] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
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
        <Row label={N.machinesApprove(thisPhone())} hint={key ? <Mark kind={key.mark}>{key.words}</Mark> : undefined}>
          <Link to="/add-device" className="btn btn--sm" data-approve>
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
      {connecting &&
        createPortal(
          <div className="acct-over" role="dialog" aria-modal="true" aria-label={N.connectAgain}>
            <ConnectAccount
              origin={v.origin}
              platform={thisPhone() === "this phone" ? "android" : "ios"}
              begin="starting"
              onLeave={() => setConnecting(false)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
