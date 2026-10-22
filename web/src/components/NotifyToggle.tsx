// SPDX-License-Identifier: Apache-2.0
// "Notify me": the one switch for system notifications (lib/notify.ts), in the inbox's
// page bar. Turning it on asks the browser once; a refusal there keeps it off. `compact`
// (the page bar) leaves the hint out: the page says a block once, under the bar.
import { setNotifyPref, useNotifyPref } from "../lib/notify";
import { Toggle } from "./bits";

export function NotifyToggle({ compact = false }: { compact?: boolean }) {
  const { on, permission } = useNotifyPref();
  const blocked = permission === "denied" || permission === "unsupported";
  const hint =
    permission === "unsupported"
      ? "not available in this browser"
      : permission === "denied"
        ? "blocked for this site in the browser's settings"
        : on
          ? "when a prompt needs you and this tab is in the background"
          : "a system notification when a prompt needs you";
  return (
    <div className="notify" data-notify={on ? "on" : "off"} title={compact ? hint : undefined}>
      <Toggle on={on} onChange={(v) => void setNotifyPref(v)} label="Notify me" disabled={blocked} />
      <span className="notify-text">Notify me</span>
      {!compact && <span className="notify-hint">{hint}</span>}
    </div>
  );
}
