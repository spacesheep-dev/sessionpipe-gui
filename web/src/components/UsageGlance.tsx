// SPDX-License-Identifier: Apache-2.0
// The sidebar's glance at usage limits, after bb's footer: under a "Usage" heading (the
// way to the page), one line per account in the Usage page's order, at most four (fewer in
// a short window, so the navigation above never scrolls for it): its name, and at the
// right its tightest window's short name and what is left of it, with a 2 px bar of that
// under them. When none is left the reset takes the bar's place; a report older than 15
// minutes says how old there instead. The line's tooltip has every window; a click opens
// the account on /usage. Drawn in the wide sidebar only, while there are numbers and this
// device has not hidden it (Settings › General). A machine that switches between pooled
// accounts takes one line, its current account's, and those accounts take none of their own
// (lib/glance.ts). The accounts as both surfaces list them, and their menu, live here too.
import type { LimitsEntry, MachineSummary } from "@shared/api";
import { type MouseEvent, useMemo } from "react";
import { openNewSession } from "../control/newSessionState";
import { useLimits, useMachines } from "../data/hooks";
import { glanceLines, type PoolLine } from "../lib/glance";
import {
  accountNames,
  byPlace,
  entryTitle,
  isOut,
  nameOf,
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
import { firstBack, poolTip, sentenceName } from "../lib/pool";
import { hrefFor, Link, navigate } from "../lib/router";
import { setSettings, useAppSettings } from "../lib/settings";
import { useNow } from "../lib/time";
import { HarnessGlyph } from "./bits";
import { type MenuList, useContextMenu } from "./ContextMenu";
import { useMedia } from "./Shell";

/** One account as Usage lists it: its numbers, or (on the page only) a Claude Code
 *  account known here that sent none. */
export interface Account {
  key: string;
  harness: string;
  title: string;
  /** For the order: whether a hello names it (its title is an email or a host). */
  named: boolean;
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
        named: !!nameOf(names, e.harness, e.accountId),
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

/** Lines past four go to "2 more"; past two in a window under 760 px tall, and in one
 *  under 640 there is no block, so it gives way before the navigation would scroll
 *  (Advanced mode's links take 375 px, four lines 244, the rail's head and foot 93). */
function useLines(): number {
  const tall = useMedia("(min-height: 760px)");
  const short = !useMedia("(min-height: 640px)");
  return tall ? 4 : short ? 0 : 2;
}

export function UsageGlance({ here }: { here: boolean }) {
  const on = useAppSettings().usageInSidebar;
  const { accounts, short } = useReported();
  const machines = useMachines();
  const limits = useLimits();
  const all = useMemo(() => glanceLines(accounts, machines, limits), [accounts, machines, limits]);
  // Resets count down and passed ones turn to "Reset" without a new report.
  const now = useNow("coarse");
  const lines = useLines();
  if (!on || all.length === 0 || lines === 0) return null;
  const more = all.length - lines;
  return (
    <section className="glance" aria-label="Usage">
      <Link to="/usage" className="glance-head" aria-current={here ? "page" : undefined}>
        Usage
      </Link>
      <ul className="glance-list">
        {all
          .slice(0, lines)
          .map((a) =>
            "kind" in a ? (
              <PoolGlanceLine key={a.key} line={a} now={now} machines={machines} />
            ) : (
              <GlanceLine key={a.key} a={a} name={short.get(a.key) ?? a.title} now={now} machines={machines} />
            ),
          )}
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
              <span className={`glance-fig ${out ? "glance-out" : ""}`}>{r.value}</span>
            </span>
          ) : (
            <span className="glance-val">
              <span className="glance-fig glance-win">Reset</span>
            </span>
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

/** A pooled machine's line (UX-SPEC §7.3): the current account's name and tightest window
 *  as an account's line has them, muted "in use" with no numbers yet, None left with the
 *  first reset under it when no account has room. The tooltip names the other accounts;
 *  a click opens the machine's section on /usage. */
function PoolGlanceLine({ line, now, machines }: { line: PoolLine; now: number; machines: readonly MachineSummary[] }) {
  const { pool, machine, current, entry } = line;
  const name = current ? sentenceName(current, pool.accounts) : machine;
  const title = `${name}, Claude Code on ${machine}`;
  const starts = machines.find((m) => m.name === machine)?.control;
  const canStart =
    !!starts && (starts.start ? pool.harness in starts.start : !!starts.harnesses?.includes(pool.harness));
  const menu = useContextMenu(
    () => [
      // One Open, first: the machine's section is where this line leads.
      { label: `Open ${machine}'s accounts`, action: "nav.usage", run: () => openUsage(line.key) },
      { sep: true },
      canStart && {
        label: `New session on ${machine}…`,
        run: () => openNewSession({ harness: pool.harness, machine }),
      },
      entry && { label: "Copy usage", run: () => copyText(usageText(entry, title, Date.now())) },
      { sep: true },
      { label: "Hide usage in the sidebar", run: () => setSettings({ usageInSidebar: false }) },
    ],
    { title: () => title },
  );
  const t = entry ? tightest(entry, now) : null;
  const r = t ? readWindow(t, now) : null;
  const out = !!r && isOut(r);
  const stale = entry ? staleWords(entry, now) : "";
  const back = current ? null : firstBack(pool.accounts, now);
  const onClick = (ev: MouseEvent<HTMLAnchorElement>) => {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    openUsage(line.key);
  };
  return (
    <li>
      <a
        href={`${hrefFor("/usage")}#${encodeURIComponent(line.key)}`}
        className="glance-line"
        onClick={onClick}
        data-tip={poolTip(pool, machine, entry, now)}
        data-tip-side="right"
        data-tip-wrap=""
        data-glance={line.key}
        {...menu}
      >
        <span className="glance-top">
          <HarnessGlyph name={pool.harness} size="sm" />
          <span className="glance-name">{name}</span>
          {!current ? (
            <span className="glance-val">
              <span className="glance-fig glance-out">None left</span>
            </span>
          ) : t && r ? (
            <span className="glance-val num">
              <span className="glance-win">{windowShort(t)}</span>{" "}
              <span className={`glance-fig ${out ? "glance-out" : ""}`}>{r.value}</span>
            </span>
          ) : (
            <span className="glance-val">
              <span className="glance-fig glance-win">in use</span>
            </span>
          )}
        </span>
        {back ? (
          <span className="glance-sub num">{back}</span>
        ) : out && r?.when ? (
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
