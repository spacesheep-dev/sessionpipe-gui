// SPDX-License-Identifier: Apache-2.0
// Envelope validation by hand (PROTOCOL.md §2–3). sessionpipe-core/schema would do it
// with zod, which is not a dependency here. One event at a time: a bad event is
// rejected with a reason, the batch goes on (HTTP.md §2).
import { isUlid, TYPE_TIER } from "sessionpipe-core";
import type { ProtocolEvent, Tier } from "../../shared/api.js";

export const MAX_TIER: Tier = 3;

const TYPE_RE = /^(?:native|[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+)$/;
const HARNESS_RE = /^[a-z][a-z0-9-]{0,39}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** The lowest tier that carries each known type (spec §4). core 0.7.0 predates
 *  `turn.progress`; the spec puts it at tier 2 beside `turn.transcript`. core 0.10.0
 *  predates `limits.observed`, an account's usage limits, at tier 1. */
export const MIN_TIER: Record<string, Tier> = { ...TYPE_TIER, "turn.progress": 2, "limits.observed": 1 };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Why an event is rejected, or null when it is a valid v1 envelope. */
export function eventProblem(e: unknown): string | null {
  if (!isObject(e)) return "malformed";
  if (e.protocol !== 1) return "unsupported_protocol";
  if (typeof e.id !== "string" || !isUlid(e.id)) return "bad_id";
  if (typeof e.type !== "string" || !TYPE_RE.test(e.type)) return "bad_type";
  if (typeof e.time !== "string" || !RFC3339_RE.test(e.time) || !Number.isFinite(Date.parse(e.time))) return "bad_time";
  if (!Number.isInteger(e.tier) || (e.tier as number) < 0 || (e.tier as number) > 3) return "bad_tier";
  if (!isObject(e.harness) || typeof e.harness.name !== "string" || !HARNESS_RE.test(e.harness.name))
    return "bad_harness";
  if (!isObject(e.session) || typeof e.session.id !== "string" || !SESSION_ID_RE.test(e.session.id))
    return "bad_session";
  if (!Number.isInteger(e.session.seq) || (e.session.seq as number) < 0) return "bad_seq";
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
