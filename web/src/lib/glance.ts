// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Which lines the sidebar's glance draws once machines pool accounts
// (UX-SPEC §7.3): a machine with the switch on takes one line, its current account's, and
// the accounts it pools take none of their own, wherever else they are pooled or seen. The
// pooled lines come first, by machine name, as the Usage page orders its sections; the
// rest keep the page's order. Pure, so the choice is unit-tested.
import type { LimitsEntry, MachinePool, MachinePoolAccount, MachineSummary } from "@shared/api";
import { pooling } from "./pool";

/** A pooled machine's line: the pool, its current account (the first in the order with
 *  room; none when every account is out) and that account's numbers, when it has any. */
export interface PoolLine {
  kind: "pool";
  /** The Usage page's section id, `pool:<machine>`. */
  key: string;
  machine: string;
  pool: MachinePool;
  current?: MachinePoolAccount;
  entry?: LimitsEntry;
}

const hasRoom = (a: MachinePoolAccount): boolean => a.enabled && a.status === "ready";

/** The glance's lines: one per machine whose pool is on and lists an account, then the
 *  reported accounts that no such pool lists. */
export function glanceLines<T extends { entry?: Pick<LimitsEntry, "harness" | "accountId"> }>(
  accounts: readonly T[],
  machines: readonly Pick<MachineSummary, "name" | "control">[],
  limits: readonly LimitsEntry[],
): (T | PoolLine)[] {
  const pooled = new Set<string>();
  const drawn = new Set<string>();
  const lines: PoolLine[] = [];
  for (const m of [...machines].sort((a, b) => a.name.localeCompare(b.name))) {
    const pool = m.control?.pool;
    if (!pooling(m) || !pool || pool.accounts.length === 0) continue;
    for (const a of pool.accounts) pooled.add(`${pool.harness} ${a.id}`);
    const current = pool.accounts.find((a) => a.current && hasRoom(a));
    // Two machines serving with the same account are one line, the first machine's by
    // name (UX-SPEC §7.3): the account appears once, not "Misha · in use" twice.
    if (current) {
      const k = `${pool.harness} ${current.id}`;
      if (drawn.has(k)) continue;
      drawn.add(k);
    }
    const entry = current ? limits.find((e) => e.harness === pool.harness && e.accountId === current.id) : undefined;
    lines.push({
      kind: "pool",
      key: `pool:${m.name}`,
      machine: m.name,
      pool,
      ...(current ? { current } : {}),
      ...(entry ? { entry } : {}),
    });
  }
  const rest = accounts.filter((a) => !a.entry?.accountId || !pooled.has(`${a.entry.harness} ${a.entry.accountId}`));
  return [...lines, ...rest];
}
