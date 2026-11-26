// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Polls the local Antigravity CLI (`agy -p "/usage" --output-format json`)
// when installed and feeds its quota windows into LimitsCore. Silent when `agy` is absent,
// signed out, or offline: never creates fake sessions and never throws on a missing binary.
import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LimitWindow } from "../../shared/api.js";
import type { LimitsCore } from "../ui/limitsCore.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const FIVE_HOURS = 300;
const WEEK = 10_080;
/** Epoch sentinels (e.g. 1970-01-01T00:00:00Z for an untouched bucket) are not real resets. */
const EPOCH_FLOOR_MS = 86_400_000;

export interface AntigravityUsageOptions {
  /** Machine name recorded on the entry; defaults to this computer's hostname without `.local`. */
  machine: string;
  /** Poll cadence in ms; default 5 minutes. */
  intervalMs?: number;
  /** Command timeout in ms; default 15 seconds. */
  timeoutMs?: number;
  /** Explicit path to the `agy` binary (tests). */
  bin?: string;
  /** Custom runner for `agy -p "/usage" --output-format json` (tests). */
  run?: (bin: string, timeoutMs: number) => Promise<string>;
  /** Custom clock (tests). */
  now?: () => number;
  /** Suppress stderr logs. */
  quiet?: boolean;
}

export interface AntigravityUsageSource {
  stop(): void;
  /** Run one poll now (deduplicated if one is already in flight). Returns true when windows landed. */
  refresh(): Promise<boolean>;
}

export interface ParsedAgyUsage {
  windows: LimitWindow[];
  account?: string;
  plan?: string;
}

const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Locate the `agy` binary on PATH or in standard installer directories. */
export function findAgyBin(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  const dirs: string[] = [];
  if (env.PATH) dirs.push(...env.PATH.split(path.delimiter).filter(Boolean));
  dirs.push(
    path.join(home, ".local", "bin"),
    path.join(home, ".antigravity", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  );
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const full = path.join(dir, name);
    if (isExecutable(full)) return full;
  }
  return null;
}

const normalizeId = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

const windowMinutesFor = (window: unknown, id: string): number | undefined => {
  if (window === "5h" || window === "five_hour" || /_5h$|_five_hour$/.test(id)) return FIVE_HOURS;
  if (window === "weekly" || window === "7d" || window === "seven_day" || /_(weekly|7d|seven_day)$/.test(id))
    return WEEK;
  return undefined;
};

const bucketOrder = (minutes: number | undefined): number => {
  if (minutes === FIVE_HOURS) return 0;
  if (minutes === WEEK) return 1;
  return 2;
};

/** Parse stdout from `agy -p "/usage" --output-format json` into LimitWindows. */
export function parseAgyUsage(stdout: string): ParsedAgyUsage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  if (typeof root.status === "string" && root.status.toUpperCase() !== "SUCCESS") return null;
  const cmd = root.command && typeof root.command === "object" ? (root.command as Record<string, unknown>) : null;
  const data = cmd?.data && typeof cmd.data === "object" ? (cmd.data as Record<string, unknown>) : root;
  const groups = Array.isArray(data.groups) ? data.groups : [];
  if (!groups.length) return null;

  const windows: LimitWindow[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const buckets = Array.isArray((g as Record<string, unknown>).buckets)
      ? ((g as Record<string, unknown>).buckets as unknown[])
      : [];
    const parsedGroup: LimitWindow[] = [];
    for (const b of buckets) {
      if (!b || typeof b !== "object") continue;
      const o = b as Record<string, unknown>;
      if (
        typeof o.id !== "string" ||
        typeof o.remaining_fraction !== "number" ||
        !Number.isFinite(o.remaining_fraction)
      )
        continue;
      const id = normalizeId(o.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const frac = Math.max(0, Math.min(1, o.remaining_fraction));
      const usedPercent = Math.max(0, Math.min(100, Math.round((1 - frac) * 1000) / 10));
      const windowMinutes = windowMinutesFor(o.window, id);
      let resetsAt: string | undefined;
      if (typeof o.reset_time === "string") {
        const t = Date.parse(o.reset_time);
        if (Number.isFinite(t) && t > EPOCH_FLOOR_MS) resetsAt = new Date(t).toISOString();
      }
      parsedGroup.push({
        id,
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowMinutes ? { windowMinutes } : {}),
      });
    }
    parsedGroup.sort((a, b) => bucketOrder(a.windowMinutes) - bucketOrder(b.windowMinutes));
    windows.push(...parsedGroup);
  }
  if (!windows.length) return null;

  const account =
    typeof data.email === "string" && data.email.trim()
      ? data.email.trim()
      : typeof data.account === "string" && data.account.trim()
        ? data.account.trim()
        : undefined;
  const plan =
    typeof data.plan === "string" && data.plan.trim()
      ? data.plan.trim()
      : typeof data.tier === "string" && data.tier.trim()
        ? data.tier.trim()
        : undefined;

  return { windows, ...(account ? { account } : {}), ...(plan ? { plan } : {}) };
}

function defaultRun(bin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-p", "/usage", "--output-format", "json"],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

export function startAntigravityUsageSource(limits: LimitsCore, opts: AntigravityUsageOptions): AntigravityUsageSource {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = opts.run ?? defaultRun;
  const now = opts.now ?? (() => Date.now());
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<boolean> | null = null;
  let loggedError = false;

  const poll = async (): Promise<boolean> => {
    if (stopped) return false;
    const bin = opts.bin ?? findAgyBin();
    if (!bin) return false;
    try {
      const stdout = await run(bin, timeoutMs);
      if (stopped) return false;
      const parsed = parseAgyUsage(stdout);
      if (!parsed) return false;
      loggedError = false;
      const observedAt = new Date(now()).toISOString();
      limits.observeDirect({
        harness: "antigravity",
        account: parsed.account,
        machine: opts.machine,
        windows: parsed.windows,
        plan: parsed.plan,
        observedAt,
      });
      return true;
    } catch (e) {
      if (!loggedError && !opts.quiet) {
        loggedError = true;
        process.stderr.write(`[antigravity] usage poll skipped: ${(e as Error).message}\n`);
      }
      return false;
    }
  };

  const refresh = (): Promise<boolean> => {
    if (inflight) return inflight;
    inflight = poll().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void refresh().finally(schedule);
    }, intervalMs);
    timer.unref();
  };

  // Run an initial non-blocking check right away so the Usage page has fresh numbers on boot.
  void refresh().finally(schedule);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    refresh,
  };
}
