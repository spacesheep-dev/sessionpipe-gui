// SPDX-License-Identifier: Apache-2.0
// Owned by: receiver. The two names envelope validation (receiver/validate.ts) takes from
// sessionpipe-core, copied: the core's main entry also brings its outbox, sinks and
// service code (node:fs, node:crypto, node:child_process, node:sqlite), and validation runs
// in a page too, where events come from a spacesheep account's relay. core-copy.test.ts
// fails when the pinned core says otherwise, so a core bump updates them here.

/** The lowest tier that carries each type, sessionpipe-core's TYPE_TIER (spec §4). */
export const TYPE_TIER = {
  "session.started": 0,
  "session.heartbeat": 0,
  "session.ended": 0,
  "session.backfill": 0,
  "session.forgotten": 0,
  "turn.started": 0,
  "turn.ended": 0,
  "turn.transcript": 2,
  "turn.progress": 2,
  "tool.started": 1,
  "tool.ended": 1,
  "files.changed": 1,
  "attention.needed": 0,
  "attention.cleared": 0,
  "subagent.started": 1,
  "subagent.ended": 1,
  "context.compacted": 1,
  "limits.observed": 1,
  "delegation.started": 0,
  "delegation.ended": 0,
  native: 3,
} as const satisfies Record<string, 0 | 1 | 2 | 3>;

/** sessionpipe-core's isUlid: 26 characters of Crockford's base32. */
export const isUlid = (s: string): boolean => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
