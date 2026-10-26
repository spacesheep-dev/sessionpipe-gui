// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. A parsed query's filters → what the engine takes (SEARCH-SPEC
// §3.3): an `allow` predicate (agent machine repo label since until), the `in:` fields and
// the `source:` indexes. Values of one key are ORed (`agent:claude agent:codex`), keys are
// ANDed, a negated filter drops what it names. A value that does not read (a bad date, an
// unknown `in:` or `source:`) is ignored and reported beside `parsed.unknown`.
import {
  LABEL_COLORS,
  LABEL_DEFAULT_NAMES,
  type LabelColor,
  type Labels,
  type ParsedSearch,
  type SearchDocField,
  type SearchFilterKey,
  type SearchSource,
} from "../../shared/api.js";
import { resolveSearchDate } from "../../shared/searchQuery.js";
import type { IndexedSession } from "./types.js";

export interface FilterContext {
  /** What sessionpipe calls this machine (history sessions ran here). */
  hostname: string;
  labels: Labels;
  now: number;
  /** The viewer's getTimezoneOffset(), minutes. */
  tz: number;
  /** The indexes that can be read at all (history absent when the setting is off). */
  available: readonly SearchSource[];
}

export interface CompiledFilters {
  allow?: (s: IndexedSession) => boolean;
  fields?: (SearchDocField | "title")[];
  sources: SearchSource[];
  /** Filter keys with a value that did not read (`since:someday`). */
  bad: SearchFilterKey[];
}

/** Lowercase, without a `.local` / `.lan` / `.home` suffix: how machine names compare. */
export function machineKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.(local|lan|home)\.?$/, "");
}

type Test = (s: IndexedSession) => boolean;

const FIELDS: readonly (SearchDocField | "title")[] = ["prompt", "reply", "tool", "title"];
const SOURCES: readonly SearchSource[] = ["history", "sessionpipe"];

/** The session's machine as the filters see it: history ran here. */
function machineOf(s: IndexedSession, hostname: string): string {
  if (s.machine) return s.machine;
  return s.sources.includes("history") ? hostname : "";
}

function repoTest(v: string): Test {
  const want = v.toLowerCase();
  return (s) => {
    if (s.repo) {
      const r = s.repo.toLowerCase();
      if (r.startsWith(want)) return true;
      const short = r.slice(r.lastIndexOf("/") + 1);
      if (short.startsWith(want)) return true;
    }
    if (s.cwd) {
      for (const seg of s.cwd.toLowerCase().split(/[\\/]+/)) if (seg?.startsWith(want)) return true;
    }
    return false;
  };
}

function labelColors(v: string, labels: Labels): Set<LabelColor> {
  const want = v.toLowerCase().replace(/_/g, " ").trim();
  const out = new Set<LabelColor>();
  for (const c of LABEL_COLORS) {
    const name = (labels.names[c] ?? LABEL_DEFAULT_NAMES[c]).toLowerCase();
    if (c === want || name === want) out.add(c);
  }
  return out;
}

export function compileFilters(p: ParsedSearch, ctx: FilterContext): CompiledFilters {
  const bad: SearchFilterKey[] = [];
  const tests: Test[] = [];
  const host = machineKey(ctx.hostname);
  const flag = (k: SearchFilterKey) => {
    if (!bad.includes(k)) bad.push(k);
  };

  const testFor = (key: SearchFilterKey, v: string): Test | undefined => {
    switch (key) {
      case "agent":
        return (s) => s.harness === v;
      case "machine": {
        const want = v === "this" ? host : machineKey(v);
        return (s) => machineKey(machineOf(s, ctx.hostname)) === want;
      }
      case "repo":
        return repoTest(v);
      case "label": {
        const colors = labelColors(v, ctx.labels);
        return (s) => {
          const c = ctx.labels.sessions[s.key];
          return c !== undefined && colors.has(c);
        };
      }
      case "since": {
        const t = resolveSearchDate(v, "start", ctx.now, ctx.tz);
        if (t === undefined) return undefined;
        return (s) => s.lastAt >= t;
      }
      case "until": {
        const t = resolveSearchDate(v, "end", ctx.now, ctx.tz);
        if (t === undefined) return undefined;
        return (s) => (s.firstAt || s.lastAt) <= t;
      }
      default:
        return undefined;
    }
  };

  const predicateKeys: SearchFilterKey[] = ["agent", "machine", "repo", "label", "since", "until"];
  for (const key of predicateKeys) {
    const pos = p.filters[key] ?? [];
    const neg = p.notFilters[key] ?? [];
    const posTests = pos.map((v) => testFor(key, v));
    const negTests = neg.map((v) => testFor(key, v));
    if (posTests.some((t) => !t) || negTests.some((t) => !t)) flag(key);
    const okPos = posTests.filter((t): t is Test => t !== undefined);
    const okNeg = negTests.filter((t): t is Test => t !== undefined);
    // Dates narrow (every one must hold); the others name alternatives (any one).
    if (okPos.length) {
      if (key === "since" || key === "until") for (const t of okPos) tests.push(t);
      else if (okPos.length === 1) tests.push(okPos[0]!);
      else tests.push((s) => okPos.some((t) => t(s)));
    }
    for (const t of okNeg) tests.push((s) => !t(s));
  }

  // in: → fields (values ORed; a negated one leaves the others).
  let fields: (SearchDocField | "title")[] | undefined;
  const inPos = p.filters.in ?? [];
  const inNeg = p.notFilters.in ?? [];
  for (const v of [...inPos, ...inNeg]) if (!(FIELDS as readonly string[]).includes(v)) flag("in");
  const posF = FIELDS.filter((f) => inPos.includes(f));
  const negF = FIELDS.filter((f) => inNeg.includes(f));
  if (posF.length || negF.length) {
    const base = posF.length ? posF : [...FIELDS];
    fields = base.filter((f) => !negF.includes(f));
    if (!fields.length) fields = undefined;
  }

  // source: → which indexes (and only those that can be read).
  const srcPos = p.filters.source ?? [];
  const srcNeg = p.notFilters.source ?? [];
  for (const v of [...srcPos, ...srcNeg]) if (!(SOURCES as readonly string[]).includes(v)) flag("source");
  let sources = ctx.available.filter((s) =>
    srcPos.some((v) => SOURCES.includes(v as SearchSource)) ? srcPos.includes(s) : true,
  );
  sources = sources.filter((s) => !srcNeg.includes(s));

  const allow: Test | undefined =
    tests.length === 0 ? undefined : tests.length === 1 ? tests[0] : (s) => tests.every((t) => t(s));
  return { allow, fields, sources, bad };
}

/** True when the query sets any filter that narrows the sessions (the "filters" hint). */
export function hasFilters(p: ParsedSearch): boolean {
  return Object.keys(p.filters).length > 0 || Object.keys(p.notFilters).length > 0;
}
