// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Settings › App › Signing, in the native app (nativeUi lazy-loads
// it with the receiver's id): this Mac's device key for that receiver (CONTROL.md §2), by
// its short id, whether today's grant is held, and Forget, which deletes the key and its
// grant from this Mac's keychain. The machines that trust it keep its public half, which
// is harmless once the private half is gone; `sessionpipe control keys remove <id>` at
// each machine takes it off their list too.
import { useEffect, useState } from "react";
import { ActionButton } from "../components/bits";
import { Group, Row } from "../components/SettingsWindow";
import { lastInfo, type TrustedKey } from "./api";
import { useRpId } from "./hooks";
// Loaded only inside the app (Settings › App), so it may import the native adapter itself.
import {
  errorWords,
  forget as forgetKey,
  keyTypesOf,
  type NativeStatus,
  refresh,
  shellReceiver,
  status,
} from "./nativeSigner";

/** A key id as people compare it with `sessionpipe control keys`: its first 16 characters. */
export const shortKeyId = (id: string): string => (id.length > 16 ? `${id.slice(0, 16)}…` : id);

const until = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function DeviceKeySettings({ receiverId }: { receiverId: string }) {
  const here = receiverId === shellReceiver();
  // The rp id of this window's receiver; another receiver's is Rust's to look up.
  const pageRp = useRpId();
  const rp = here ? pageRp : null;
  const [s, setS] = useState<NativeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (here && !rp) return;
    let on = true;
    status(rp, receiverId)
      .then((st) => on && setS(st))
      .catch((e) => on && setError(errorWords(e) ?? String(e)));
    return () => {
      on = false;
    };
  }, [receiverId, rp, here, tick]);

  const forget = async () => {
    setBusy(true);
    setError(null);
    try {
      await forgetKey(rp, receiverId);
      if (rp) await refresh(rp);
      setConfirming(false);
      setTick((t) => t + 1);
    } catch (e) {
      setError(errorWords(e) ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const key: TrustedKey | undefined = s?.key;
  // Hidden where this window's receiver takes passkeys only (its core can't verify a device
  // key yet): the app then sends nothing itself. A key made earlier can still be forgotten.
  if (here && !key && !keyTypesOf(lastInfo()).includes("device")) return null;
  const value = !s
    ? error
      ? "Unavailable"
      : "Reading…"
    : !s.available
      ? (s.reason ?? "Not available on this device")
      : key
        ? null
        : "None yet";
  return (
    <div data-device-key={key?.id ?? ""}>
      <Group
        label="Signing"
        note={
          error ? (
            <span role="alert">{error}</span>
          ) : key ? (
            <>
              Machines that trust it keep only its public half. To take it off a machine's list too, run{" "}
              <code>sessionpipe control keys remove {key.id.slice(0, 16)}</code> there.
            </>
          ) : undefined
        }
      >
        <Row
          label="This Mac's key"
          hint={
            key
              ? s?.grantExp
                ? `Unlocked for sending until ${until(s.grantExp)}`
                : "The next send asks for Touch ID, once for the day"
              : "Made the first time this Mac is added to a machine"
          }
        >
          {value ?? (
            <span className="num" title={key?.id}>
              {key ? shortKeyId(key.id) : ""}
            </span>
          )}
        </Row>
        {key && (
          <Row
            label={confirming ? "Forget this Mac's key?" : "Forget this Mac's key"}
            hint="Sending from the app stops until you add this Mac again."
          >
            {confirming ? (
              <>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  Cancel
                </button>{" "}
                <ActionButton
                  className="btn btn--sm"
                  onClick={() => void forget()}
                  pending={busy}
                  pendingLabel="Forgetting…"
                >
                  Forget
                </ActionButton>
              </>
            ) : (
              <button type="button" className="btn btn--sm" onClick={() => setConfirming(true)}>
                Forget…
              </button>
            )}
          </Row>
        )}
      </Group>
    </div>
  );
}
