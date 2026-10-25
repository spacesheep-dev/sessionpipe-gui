// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. GET /api/ui/search/facets: the values present in the index, with
// counts, for the chips and the completion list. Each `value` is exactly what its filter
// takes (`agent:<value>`); `label` is the display name when it differs. One pass over the
// indexed sessions, cached by the service per (index generations, store and label versions).
import path from "node:path";
import {
  LABEL_COLORS,
  LABEL_DEFAULT_NAMES,
  type Labels,
  type SearchFacet,
  type SearchFacets,
} from "../../shared/api.js";
import type { IndexedSession } from "./types.js";

/** The product names the chips show (the web's harnessMark says the same). */
export const HARNESS_LABELS: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity",
  cursor: "Cursor",
  "copilot-cli": "Copilot CLI",
  droid: "Droid",
  kiro: "Kiro",
  opencode: "OpenCode",
};

/** At most this many values per facet (the completion shows 8; the chip menus scroll). */
export const FACET_MAX = 100;

/** The value `repo:` matches for a session: the repo's short name, else its folder's name. */
export function repoValue(s: { repo?: string; cwd?: string }): { value: string; label?: string } | undefined {
  if (s.repo) {
    const short = s.repo.slice(s.repo.lastIndexOf("/") + 1);
    if (short) return short === s.repo ? { value: short } : { value: short, label: s.repo };
  }
  if (s.cwd) {
    const base = path.basename(s.cwd.replace(/[\\/]+$/, ""));
    if (base) return { value: base };
  }
  return undefined;
}

function top(m: Map<string, { count: number; label?: string }>): SearchFacet[] {
  return [...m.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, FACET_MAX)
    .map(([value, v]) =>
      v.label && v.label !== value ? { value, count: v.count, label: v.label } : { value, count: v.count },
    );
}

export function computeFacets(sessions: Iterable<IndexedSession>, labels: Labels, hostname: string): SearchFacets {
  const agents = new Map<string, { count: number; label?: string }>();
  const machines = new Map<string, { count: number; label?: string }>();
  const repos = new Map<string, { count: number; label?: string }>();
  const colors = new Map<string, { count: number; label?: string }>();
  const bump = (m: Map<string, { count: number; label?: string }>, value: string, label?: string) => {
    const cur = m.get(value);
    if (cur) cur.count++;
    else m.set(value, { count: 1, label });
  };
  for (const s of sessions) {
    bump(agents, s.harness, HARNESS_LABELS[s.harness]);
    const machine = s.machine || (s.sources.includes("history") ? hostname : "");
    if (machine) bump(machines, machine);
    const r = repoValue(s);
    if (r) {
      // One short name may stand for two repos (`acme/api`, `beta/api`): keep the first label.
      bump(repos, r.value, r.label);
    }
    const c = labels.sessions[s.key];
    if (c) bump(colors, c, labels.names[c] ?? LABEL_DEFAULT_NAMES[c]);
  }
  // Labels in the palette's order, not by count: they are a fixed set of seven.
  const labelFacets: SearchFacet[] = [];
  for (const c of LABEL_COLORS) {
    const v = colors.get(c);
    if (v) labelFacets.push({ value: c, count: v.count, label: v.label });
  }
  return { agents: top(agents), machines: top(machines), repos: top(repos), labels: labelFacets };
}
