// SPDX-License-Identifier: Apache-2.0
// Owned by: demo. Synthetic sessions and a replay of any sessionpipe JSONL file, both
// fed through store.ingest(events, "demo") in batches of at most 50.
//
// startDemo: a deterministic simulation (sim.ts) of a small team's agents, played in
// real time scaled by `speed`. startReplay: a file's events, paced by their own gaps.
import type { ProtocolEvent } from "../../shared/api.js";
import type { Control } from "../control/index.js";
import type { Store } from "../store/store.js";
import { type DemoMachines, startDemoMachines } from "./machine.js";
import { inBatches, planReplay } from "./replay.js";
import { Simulation } from "./sim.js";

export interface DemoOptions {
  /** Number of pretend machines (1–4). */
  machines?: number;
  /** 1 = real time; 5 = five times faster. */
  speed?: number;
  /** The same seed gives the same demo. */
  seed?: number;
  /** The receiver's control side: the demo pairs its machines there (machine.ts). */
  control?: Control;
}

export interface Runner {
  stop(): void;
  /** Resolves when a replay has ingested its last event; absent on the demo, which never ends. */
  done?: Promise<void>;
}

/** The longest the demo sleeps between ticks, so a stop() is never far away. */
const MAX_TICK_MS = 1000;

export function startDemo(store: Store, opts: DemoOptions = {}): Runner {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  let paired: DemoMachines | null = null;
  const sim = new Simulation({
    machines: opts.machines,
    seed: opts.seed,
    speed,
    startAt: Date.now(),
    onStart: (s) => paired?.started(s),
  });
  if (opts.control) paired = startDemoMachines(opts.control, sim.v010Machine, (m) => sim.account(m, "claude-code"));
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const v = (Date.now() - sim.startAt) * speed;
    let events: ProtocolEvent[] = [];
    try {
      events = sim.advance(v);
      inBatches(events, (b) => store.ingest(b, "demo"));
    } catch (err) {
      console.error("sessionpipe-gui demo:", err);
    }
    const next = sim.nextDue();
    const wait = next === null ? MAX_TICK_MS : Math.min(MAX_TICK_MS, Math.max(1, Math.ceil((next - v) / speed)));
    timer = setTimeout(tick, wait);
  };
  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      paired?.stop();
    },
  };
}

export interface ReplayOptions {
  /** 0 = all at once; 1 = original timing; 10 = ten times faster. */
  speed?: number;
  /** Rewrite event times so the replay looks like it is happening now. */
  rebase?: boolean;
  /** Cap any silence between two events (ms, before `speed`), so a month-old file
   *  replays in minutes: with it, rebased times keep the capped spacing. */
  maxGapMs?: number;
}

export function startReplay(store: Store, file: string, opts: ReplayOptions = {}): Runner {
  const speed = opts.speed ?? 1;
  const plan = planReplay(file, { rebase: opts.rebase ?? true, maxGapMs: opts.maxGapMs });
  const { events, offsets } = plan;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  if (speed <= 0 || events.length === 0) {
    inBatches(events, (b) => store.ingest(b, "demo"));
    resolveDone();
    return { stop() {}, done };
  }

  const start = Date.now();
  let i = 0;
  const tick = () => {
    if (stopped) return;
    const elapsed = (Date.now() - start) * speed;
    const due: ProtocolEvent[] = [];
    while (i < events.length && (offsets[i] as number) <= elapsed) due.push(events[i++] as ProtocolEvent);
    try {
      inBatches(due, (b) => store.ingest(b, "demo"));
    } catch (err) {
      console.error("sessionpipe-gui replay:", err);
    }
    if (i >= events.length) {
      resolveDone();
      return;
    }
    const wait = Math.max(1, Math.ceil(((offsets[i] as number) - elapsed) / speed));
    timer = setTimeout(tick, Math.min(wait, MAX_TICK_MS));
  };
  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      resolveDone();
    },
    done,
  };
}
