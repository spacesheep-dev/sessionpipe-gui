// SPDX-License-Identifier: Apache-2.0
// Usage: which account has room left right now. One section per account in the Machines
// page's grammar, a reading column centred in the window: its harness and title in a bold
// header row (with "as of 3 h ago" when the report is old, and its ··· menu), a muted line
// of where it reported and its plan, then a row per window on hairlines: the window's
// name, a bar that empties as it is used (iOS Battery's), what is left, and when it
// resets. On a phone each account is an inset group, the windows stacked, the where-line
// its footer. Numbers come only from sessionpipe's limits.observed as the receiver keeps
// them (lib/limits.ts words them). Claude Code sends its numbers through a status line, so
// a Claude Code account known here that sent none says how to turn it on; the harnesses
// with no source get one sentence at the end, never a 0%. The `lists` keys walk the
// sections; Enter starts a session on the newest machine that can, `.` opens the menu.
import type { LimitWindow, MachineSummary } from "@shared/api";
import { useEffect, useMemo } from "react";
import { CommandWell, EmptyState, HarnessGlyph } from "../components/bits";
import { MoreButton, useContextMenu } from "../components/ContextMenu";
import { PageBar } from "../components/PageBar";
import { type Account, startMachines, usageItems, useReported } from "../components/UsageGlance";
import { openNewSession } from "../control/newSessionState";
import { useAppState, useLimits, useMachines, useStore } from "../data/hooks";
import { useListNav } from "../lib/keys";
import {
  andList,
  byPlace,
  entrySubtitle,
  entryTitle,
  footnote,
  isOut,
  nameOf,
  orderWindows,
  quietAccounts,
  readWindow,
  resetClock,
  STATUS_LINE_COMMAND,
  staleWords,
  windowLabel,
} from "../lib/limits";
import { useNow } from "../lib/time";
import "../styles/usage.css";

const anchor = (key: string) => encodeURIComponent(key);

/** Every account: the ones with numbers, and the Claude Code accounts known from a hello
 *  or a session that sent none; and the sentence for the harnesses with no source. */
function useAccounts(): { accounts: Account[]; count: number; note: string } {
  const { accounts: reported, names } = useReported();
  const limits = useLimits();
  const machines = useMachines();
  const { sessions } = useAppState();
  return useMemo(() => {
    const known = [
      ...machines.flatMap((m) =>
        (m.control?.accounts ?? []).map((a) => ({ harness: a.harness, accountId: a.id, machine: m.name })),
      ),
      ...[...sessions.values()].map((s) => ({ harness: s.harness, accountId: s.accountId, machine: s.machine })),
    ];
    const quiet: Account[] = quietAccounts(known, limits).map((q) => ({
      key: q.key,
      harness: q.harness,
      title: entryTitle({ harness: q.harness, accountId: q.accountId, machine: q.machines[0] ?? "" }, names),
      named: !!nameOf(names, q.harness, q.accountId),
      machine: q.machines[0] ?? "",
      machines: q.machines,
      quiet: q,
    }));
    const seen = [
      ...[...sessions.values()].map((s) => s.harness),
      ...machines.flatMap((m) => [...Object.keys(m.harnesses), ...(m.control?.harnesses ?? [])]),
    ];
    return {
      accounts: [...reported, ...quiet].sort(byPlace),
      count: reported.length,
      note: footnote(seen, limits),
    };
  }, [reported, names, limits, machines, sessions]);
}

/** The account a link (the sidebar's) points at: scrolled to, its header focused. */
function useHashTarget(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const go = () => {
      const id = location.hash.slice(1);
      if (!id) return;
      // After the shell has moved focus to the page for the route change.
      requestAnimationFrame(() => {
        const el = document.getElementById(id);
        if (!el) return;
        el.scrollIntoView({ block: "start" });
        el.querySelector<HTMLElement>("[data-nav-item]")?.focus({ preventScroll: true });
      });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [ready]);
}

export function Usage() {
  const { accounts, count, note } = useAccounts();
  const machines = useMachines();
  // "resets in" counts down, and a window turns to "Reset" at its time, with no new report.
  const now = useNow("coarse");
  const hrefs = useMemo(() => accounts.map((a) => `/usage#${anchor(a.key)}`), [accounts]);
  const { cursor } = useListNav(hrefs, true, undefined, {
    // Enter: the menu's first item, a session on the newest machine that can start one.
    open: (i) => {
      const a = accounts[i];
      const machine = a ? startMachines(a, machines)[0] : undefined;
      if (!a || !machine) return false;
      openNewSession({ harness: a.harness, machine });
      return true;
    },
  });
  useHashTarget(accounts.length > 0);
  return (
    <div className="page page--doc page--grouped usage">
      <PageBar title="Usage" meta={count ? `${count} ${count === 1 ? "account" : "accounts"}` : undefined} />
      {accounts.length === 0 ? (
        <EmptyState center title="No limits yet">
          <p>Codex reports them after a turn. Claude Code needs its status line, on each machine it runs on:</p>
          <CommandWell command={STATUS_LINE_COMMAND} prompt={false} label="Copy setup command" />
        </EmptyState>
      ) : (
        accounts.map((a, i) => (
          <AccountSection key={a.key} a={a} index={i} cursor={cursor === i} now={now} machines={machines} />
        ))
      )}
      {note && <p className="usage-note">{note}</p>}
    </div>
  );
}

function AccountSection({
  a,
  index,
  cursor,
  now,
  machines,
}: {
  a: Account;
  index: number;
  cursor: boolean;
  now: number;
  machines: readonly MachineSummary[];
}) {
  const store = useStore();
  const build = () =>
    usageItems(a, {
      machines,
      from: "page",
      // The entry comes back with its next report; nothing to confirm.
      forget: () => void store.transport.forgetLimits(a.key).catch(() => {}),
    });
  const menu = useContextMenu(build, { title: () => a.title });
  const e = a.entry;
  const stale = e ? staleWords(e, now) : "";
  const where = e ? entrySubtitle(e) : `Claude Code${a.machines.length ? ` on ${andList(a.machines)}` : ""}`;
  return (
    <section
      className="form-group usage-acct"
      id={anchor(a.key)}
      aria-label={a.title}
      data-account={a.key}
      data-cursor={cursor ? String(index) : undefined}
      aria-current={cursor ? "true" : undefined}
      {...menu}
    >
      <header className="usage-head" data-nav-item="">
        <HarnessGlyph name={a.harness} size="md" />
        <h2 className="usage-title">{a.title}</h2>
        {stale && <span className="usage-age">{stale}</span>}
        <MoreButton build={build} label={`Actions for ${a.title}`} title={() => a.title} />
      </header>
      {(where || stale) && (
        <p className={`usage-where ${where ? "" : "usage-where--age"}`}>
          {where}
          {stale && (
            <span className="usage-where-age">
              {where ? ", " : ""}
              {stale}
            </span>
          )}
        </p>
      )}
      {e ? (
        <ul className="form-list usage-windows">
          {orderWindows(e.windows).map((w) => (
            <WindowRow key={w.id} w={w} now={now} />
          ))}
        </ul>
      ) : (
        <ul className="form-list">
          <li className="form-row form-row--stack usage-quiet">
            <span className="form-row-text">
              <span className="form-label">No numbers yet</span>
              <span className="form-caption">
                Claude Code shares its limits only with a status line, on Pro and Max plans.{" "}
                {a.machines.length
                  ? `On ${andList(a.machines)}, in a terminal:`
                  : "On the machine it runs on, in a terminal:"}
              </span>
            </span>
            <CommandWell command={STATUS_LINE_COMMAND} prompt={false} label="Copy setup command" />
            <span className="form-caption">
              The status line hides most of Claude Code's footer hints and never replaces one you set. Numbers arrive
              after that session's next reply.
            </span>
          </li>
        </ul>
      )}
    </section>
  );
}

/** A window: its name, a bar of what is left, the figure, when it resets. A window past
 *  its reset has no bar (an empty one would read as none left) and says when it reset. */
function WindowRow({ w, now }: { w: LimitWindow; now: number }) {
  const r = readWindow(w, now);
  const clock = resetClock(w.resetsAt) || undefined;
  return (
    <li className={`usage-win ${r.kind === "reset" ? "usage-win--reset" : ""}`} data-window={w.id}>
      <span className="usage-label">{windowLabel(w)}</span>
      {r.fill !== null && (
        <span className="usage-bar" aria-hidden="true">
          <span style={{ width: `${r.fill * 100}%` }} />
        </span>
      )}
      {r.kind === "reset" ? (
        <span className="usage-when num" title={clock}>
          {r.when}
        </span>
      ) : (
        <>
          <span className={`usage-value num ${isOut(r) ? "usage-out" : ""}`}>{r.value}</span>
          {r.when && (
            <span className="usage-when num" title={clock}>
              {r.when}
            </span>
          )}
        </>
      )}
    </li>
  );
}
