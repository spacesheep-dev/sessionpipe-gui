// SPDX-License-Identifier: Apache-2.0
// The sidebar's glance at usage limits, after bb's footer: under a "Usage" heading (the
// way to the page), one line per account in the Usage page's order, at most four: its name,
// and at the right its tightest window's short name and what is left of it, with a 2 px bar
// of that under them. When none is left the reset takes the bar's place; a report older
// than 15 minutes says how old there instead. The line's tooltip has every window; a click
// opens the account on /usage. Drawn in the wide sidebar only, while there are numbers and
// this device has not hidden it (Settings › General). The accounts as both surfaces list
// them, and their menu, live here too.
import type { LimitsEntry, MachineSummary } from "@shared/api";
import { type MouseEvent, useMemo } from "react";
import { openNewSession } from "../control/newSessionState";
import { useLimits, useMachines } from "../data/hooks";
import {
  accountNames,
  byPlace,
  entryTitle,
  isOut,
  type QuietAccount,
  readWindow,
  STATUS_LINE_COMMAND,
  shortNames,
  staleWords,
  tightest,
  usageText,
  usageTip,
  windowShort,
} from "../lib/limits";
import { copyText } from "../lib/menus";
import { hrefFor, Link, navigate } from "../lib/router";
import { setSettings, useAppSettings } from "../lib/settings";
import { useNow } from "../lib/time";
import { HarnessGlyph } from "./bits";
import { type MenuList, useContextMenu } from "./ContextMenu";

/** One account as Usage lists it: its numbers, or (on the page only) a Claude Code
 *  account known here that sent none. */
export interface Account {
  key: string;
  harness: string;
  title: string;
  /** For the order: the newest report's machine, or the first the account was seen on. */
  machine: string;
  /** Where it reported, or was seen, newest first. */
  machines: string[];
  entry?: LimitsEntry;
  quiet?: QuietAccount;
}

/** The accounts with numbers, in the page's order, their names from the hellos. */
export function useReported(): { accounts: Account[]; names: Map<string, string>; short: Map<string, string> } {
  const limits = useLimits();
  const machines = useMachines();
  return useMemo(() => {
    const names = accountNames(machines.flatMap((m) => m.control?.accounts ?? []));
    const accounts = limits
      .map((e) => ({
        key: e.key,
        harness: e.harness,
        title: entryTitle(e, names),
        machine: e.machine,
        machines: e.machines,
        entry: e,
      }))
      .sort(byPlace);
    return { accounts, names, short: shortNames(limits, names) };
  }, [limits, machines]);
}

/** The paired machines a session of this account can start on: where it was seen, newest
 *  first, whose daemon starts the harness. */
export function startMachines(a: Account, machines: readonly MachineSummary[]): string[] {
  const starts = (m: MachineSummary | undefined) =>
    !!m?.control && (m.control.start ? a.harness in m.control.start : !!m.control.harnesses?.includes(a.harness));
  return a.machines.filter((name) => starts(machines.find((m) => m.name === name)));
}

/** /usage at one account, scrolled to it (the page listens for the hash). */
export function openUsage(key?: string): void {
  navigate(key ? `${hrefFor("/usage")}#${encodeURIComponent(key)}` : "/usage");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** An account's menu, on the page (its section, ···, a long press) and in the sidebar. */
export function usageItems(
  a: Account,
  o: { machines: readonly MachineSummary[]; from: "page" | "sidebar"; forget?: () => void },
): MenuList {
  const e = a.entry;
  return [
    ...startMachines(a, o.machines).map((machine) => ({
      label: `New session on ${machine}…`,
      run: () => openNewSession({ harness: a.harness, machine }),
    })),
    o.from === "sidebar" && { label: "Open Usage", action: "nav.usage", run: () => openUsage(a.key) },
    e && { label: "Copy usage", run: () => copyText(usageText(e, a.title, Date.now())) },
    a.quiet && { label: "Copy setup command", run: () => copyText(STATUS_LINE_COMMAND) },
    { sep: true },
    o.from === "page" && e && o.forget && { label: "Forget these numbers", run: o.forget },
    o.from === "sidebar" && {
      label: "Hide usage in the sidebar",
      run: () => setSettings({ usageInSidebar: false }),
    },
  ];
}

/** Lines past this go to "2 more". */
const LINES = 4;

export function UsageGlance({ here }: { here: boolean }) {
  const on = useAppSettings().usageInSidebar;
  const { accounts, short } = useReported();
  const machines = useMachines();
  // Resets count down and passed ones turn to "Reset" without a new report.
  const now = useNow("coarse");
  if (!on || accounts.length === 0) return null;
  const more = accounts.length - LINES;
  return (
    <section className="glance" aria-label="Usage">
      <Link to="/usage" className="glance-head" aria-current={here ? "page" : undefined}>
        Usage
      </Link>
      <ul className="glance-list">
        {accounts.slice(0, LINES).map((a) => (
          <GlanceLine key={a.key} a={a} name={short.get(a.key) ?? a.title} now={now} machines={machines} />
        ))}
      </ul>
      {more > 0 && (
        <Link to="/usage" className="glance-more">
          {more} more
        </Link>
      )}
    </section>
  );
}

function GlanceLine({
  a,
  name,
  now,
  machines,
}: {
  a: Account;
  name: string;
  now: number;
  machines: readonly MachineSummary[];
}) {
  const menu = useContextMenu(() => usageItems(a, { machines, from: "sidebar" }), { title: () => a.title });
  const e = a.entry!;
  const t = tightest(e, now);
  const r = t ? readWindow(t, now) : null;
  const out = !!r && isOut(r);
  const stale = staleWords(e, now);
  const onClick = (ev: MouseEvent<HTMLAnchorElement>) => {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    openUsage(a.key);
  };
  return (
    <li>
      <a
        href={`${hrefFor("/usage")}#${encodeURIComponent(a.key)}`}
        className="glance-line"
        onClick={onClick}
        data-tip={usageTip(e, a.title, now)}
        data-tip-side="right"
        data-tip-wrap=""
        data-glance={a.key}
        {...menu}
      >
        <span className="glance-top">
          <HarnessGlyph name={a.harness} size="sm" />
          <span className="glance-name">{name}</span>
          {t && r ? (
            <span className="glance-val num">
              <span className="glance-win">{windowShort(t)}</span>{" "}
              <span className={out ? "glance-out" : undefined}>{r.value}</span>
            </span>
          ) : (
            <span className="glance-val glance-win">Reset</span>
          )}
        </span>
        {out && r?.when ? (
          <span className="glance-sub num">{r.when}</span>
        ) : stale ? (
          <span className="glance-sub">{stale}</span>
        ) : r?.fill != null ? (
          <span className="glance-bar" aria-hidden="true">
            <span style={{ width: `${r.fill * 100}%` }} />
          </span>
        ) : null}
      </a>
    </li>
  );
}
