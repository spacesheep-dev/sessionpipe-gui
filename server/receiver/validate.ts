// SPDX-License-Identifier: Apache-2.0
// Envelope validation by hand (PROTOCOL.md §2–3). sessionpipe-core/schema would do it
// with zod, which is not a dependency here. One event at a time: a bad event is
// rejected with a reason, the batch goes on (HTTP.md §2).

import type { ProtocolEvent, Tier } from "../../shared/api.js";
import { isUlid, TYPE_TIER } from "./core-copy.js";

export const MAX_TIER: Tier = 3;

const TYPE_RE = /^(?:native|[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+)$/;
const HARNESS_RE = /^[a-z][a-z0-9-]{0,39}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** The lowest tier that carries each known type (spec §4). core 0.7.0 predates
 *  `turn.progress`; the spec puts it at tier 2 beside `turn.transcript`. core 0.10.0
 *  predates `limits.observed`, an account's usage limits, at tier 1. */
export const MIN_TIER: Record<string, Tier> = { ...TYPE_TIER, "turn.progress": 2, "limits.observed": 1 };

/** For a time that already matched RFC3339_RE and that Date.parse read (so month 01-12, day
 *  from 01, minute and second below 60): whether its day is one its month has and its hour is
 *  below 24, as the schema's `time` pattern requires. Date.parse rolls 2026-02-30 into March
 *  and reads T24:00 as the next day. Day 0 of the next month is this month's last day;
 *  setUTCFullYear, unlike Date.UTC, keeps years 0-99, so 0000-02-29 reads (a leap year).
 *  The other RFC 3339 readers (limitsCore's resets_at, a pool account's until, the demo's
 *  times) check with it too. */
export const isCalendarTime = (t: string): boolean => {
  const last = new Date(0);
  last.setUTCFullYear(Number(t.slice(0, 4)), Number(t.slice(5, 7)), 0);
  return Number(t.slice(8, 10)) <= last.getUTCDate() && Number(t.slice(11, 13)) < 24;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Why an event is rejected, or null when it is a valid v1 envelope. */
export function eventProblem(e: unknown): string | null {
  if (!isObject(e)) return "malformed";
  if (e.protocol !== 1) return "unsupported_protocol";
  if (typeof e.id !== "string" || !isUlid(e.id)) return "bad_id";
  if (typeof e.type !== "string" || !TYPE_RE.test(e.type)) return "bad_type";
  if (
    typeof e.time !== "string" ||
    !RFC3339_RE.test(e.time) ||
    !Number.isFinite(Date.parse(e.time)) ||
    !isCalendarTime(e.time)
  )
    return "bad_time";
  if (!Number.isInteger(e.tier) || (e.tier as number) < 0 || (e.tier as number) > 3) return "bad_tier";
  if (!isObject(e.harness) || typeof e.harness.name !== "string" || !HARNESS_RE.test(e.harness.name))
    return "bad_harness";
  if (!isObject(e.session) || typeof e.session.id !== "string" || !SESSION_ID_RE.test(e.session.id))
    return "bad_session";
  if (!Number.isSafeInteger(e.session.seq) || (e.session.seq as number) < 0) return "bad_seq";
  if (!isObject(e.privacy) || !Array.isArray(e.privacy.rulesets) || typeof e.privacy.pii !== "boolean")
    return "bad_privacy";
  if (!isObject(e.data)) return "bad_data";
  const min = MIN_TIER[e.type];
  if (min !== undefined && (e.tier as number) < min) return "tier_type";
  return null;
}

/** Whether `tier` is a number above the receiver's cap: a 403 for the batch (spec §2). */
export const aboveMaxTier = (e: unknown): boolean => isObject(e) && typeof e.tier === "number" && e.tier > MAX_TIER;

export type ValidEvent = ProtocolEvent;
