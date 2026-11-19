// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The board as a page first gets it: the store's snapshot and what
// control knows of each machine, as one. The receiver's UI API (index.ts) answers with it,
// and a page that carries its own board (the phone on an account, docs/rfcs/08) builds the
// same from its own store and control. Nothing here is Node's (store/browser.test.ts).
import type { MachineControl, MachineSummary, Snapshot } from "../../shared/api.js";

/** The store's snapshot with what control knows about each machine merged in, plus
 *  machines control paired that sent no event yet. */
export function snapshotWithControl(
  store: { snapshot(): Snapshot },
  control: { machines(): Map<string, MachineControl> },
): Snapshot {
  const snap = store.snapshot();
  const paired = control.machines();
  const seen = new Set<string>();
  for (const m of snap.machines) {
    seen.add(m.name);
    const c = paired.get(m.name);
    if (c) m.control = c;
  }
  for (const [name, c] of paired) {
    if (seen.has(name)) continue;
    const m: MachineSummary = {
      name,
      lastAt: c.lastPollAt ?? c.lastHelloAt ?? snap.at,
      harnesses: Object.fromEntries((c.harnesses ?? []).map((h) => [h, undefined])),
      sessions: 0,
      working: 0,
      needsYou: 0,
      control: c,
    };
    snap.machines.push(m);
  }
  snap.stats.machines = snap.machines.length;
  return snap;
}
