// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Pure project grouping for the sidebar's Sessions section: derives each
// session's project from its git repo or working directory, disambiguates colliding short
// names cleanly, rolls up loudness so collapsed project groups carry the loudest status
// lamp, and orders groups calmly (needs you, live, finished, then recency and name).
import type { SessionSummary } from "@shared/api";
import { basename } from "./format";
import {
  type FrozenRow,
  type Loud,
  louder,
  loudOf,
  type RollUp,
  type SidebarBlock,
  sidebarBlock,
  sidebarOrder,
  type TreeNode,
} from "./tree";

export interface ProjectInfo {
  /** Stable grouping key: "repo:<owner/name>", "cwd:<path>" (lowercased for a Windows path), or "other". */
  key: string;
  /** Short display label (repo basename, cwd basename, or "Other"). */
  label: string;
  /** Secondary context (repo owner or tildified parent path) for tooltips and disambiguation. */
  subtitle?: string;
  /** Raw repo string when derived from `repo`. */
  rawRepo?: string;
  /** Immediate parent directory name when derived from `cwd`, used to disambiguate collisions. */
  parentSeg?: string;
}

export interface ProjectGroup {
  key: string;
  /** Disambiguated display label. */
  label: string;
  subtitle?: string;
  rawRepo?: string;
  /** Top-level session nodes in this project, in sidebar order. */
  roots: TreeNode[];
  /** Rolled-up loudness across all roots and drawn descendants in this project. */
  loud: Loud;
  /** Number of root sessions in this project. */
  count: number;
  /** Sidebar sort block (0 = needs you, 1 = live, 2 = finished). */
  block: SidebarBlock;
  /** Newest session in this project (for prefilling `+` New session). */
  latest: SessionSummary;
}

/** Shortens `/Users/<name>/…` and `/home/<name>/…` to `~/…` for quiet display. */
function tildifyPath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** Derives a session's project: repo first, then cwd basename, then "Other". */
export function projectOf(s: Pick<SessionSummary, "repo" | "cwd">): ProjectInfo {
  const rawRepo = s.repo?.trim();
  if (rawRepo) {
    // Strip URL scheme or SCP-style user@host:, trailing slashes, and trailing .git.
    const stripped = rawRepo
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .replace(/^[^@/\s]+@[^:/\s]+:/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    const parts = stripped.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const repo = parts[parts.length - 1]!;
      const owner = parts[parts.length - 2]!;
      const norm = `${owner}/${repo}`;
      return {
        key: `repo:${norm.toLowerCase()}`,
        label: repo,
        subtitle: owner,
        rawRepo,
      };
    }
    if (parts.length === 1) {
      const repo = parts[0]!;
      return {
        key: `repo:${repo.toLowerCase()}`,
        label: repo,
        rawRepo,
      };
    }
  }

  const rawCwd = s.cwd?.trim();
  if (rawCwd) {
    const isWin = /^[A-Za-z]:[\\/]/.test(rawCwd);
    const trimmed = rawCwd.replace(/[\\/]+$/, "");
    const clean = trimmed || (isWin ? `${rawCwd.slice(0, 2)}\\` : rawCwd.startsWith("/") ? "/" : rawCwd);
    if (clean === "/" || clean === "~") {
      return { key: `cwd:${clean}`, label: clean };
    }
    const label = basename(clean);
    // Windows folders are case-insensitive: `C:\Users\Me\Proj` and `c:\users\me\proj`, or
    // core's `~\Code\acme` and `~\code\acme`, are one project. POSIX paths keep their case.
    const winPath = isWin || clean.includes("\\");
    const slashed = clean.replace(/\\/g, "/");
    const normKey = winPath ? slashed.toLowerCase() : slashed;
    const lastSep = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
    const parentRaw = lastSep > 0 ? clean.slice(0, lastSep) : lastSep === 0 ? "/" : "";
    const subtitle = parentRaw ? tildifyPath(parentRaw.replace(/\\/g, "/")) : undefined;
    const parentSeg = parentRaw && parentRaw !== "/" && parentRaw !== "~" ? basename(parentRaw) : undefined;
    return {
      key: `cwd:${normKey}`,
      label,
      ...(subtitle ? { subtitle } : {}),
      ...(parentSeg ? { parentSeg } : {}),
    };
  }

  return { key: "other", label: "Other" };
}

const neverUnread = () => false;

/** Groups top-level tree nodes by project, disambiguating colliding labels and sorting
 *  calmly: needs-you groups first, then live, then finished; newest root startedAt desc,
 *  then alphabetical label. */
export function groupByProject(
  roots: readonly TreeNode[],
  roll: RollUp,
  o: { unread?: (s: SessionSummary) => boolean; frozen?: FrozenRow | null } = {},
): ProjectGroup[] {
  if (roots.length === 0) return [];
  const unread = o.unread ?? neverUnread;
  const frozen = o.frozen ?? null;

  const byKey = new Map<string, { info: ProjectInfo; nodes: TreeNode[] }>();
  for (const n of roots) {
    const info = projectOf(n.s);
    const existing = byKey.get(info.key);
    if (existing) existing.nodes.push(n);
    else byKey.set(info.key, { info, nodes: [n] });
  }

  // Count distinct project keys per lowercase label to detect collisions.
  const labelCounts = new Map<string, number>();
  for (const { info } of byKey.values()) {
    const low = info.label.toLowerCase();
    labelCounts.set(low, (labelCounts.get(low) ?? 0) + 1);
  }

  // First disambiguation pass: owner/repo or parentSeg/basename.
  const initialLabels = new Map<string, string>();
  for (const [key, { info }] of byKey) {
    const collides = (labelCounts.get(info.label.toLowerCase()) ?? 0) > 1;
    let label = info.label;
    if (collides) {
      if (info.key.startsWith("repo:") && info.subtitle) label = `${info.subtitle}/${info.label}`;
      else if (info.key.startsWith("cwd:") && info.parentSeg) label = `${info.parentSeg}/${info.label}`;
      else if (info.subtitle) label = `${info.subtitle}/${info.label}`;
    }
    initialLabels.set(key, label);
  }

  // Second pass if two distinct cwd paths still collide (e.g. ~/a/src/app vs ~/b/src/app).
  const disambigCounts = new Map<string, number>();
  for (const label of initialLabels.values()) {
    const low = label.toLowerCase();
    disambigCounts.set(low, (disambigCounts.get(low) ?? 0) + 1);
  }

  const blockOf = (n: TreeNode): SidebarBlock =>
    frozen && n.s.key === frozen.key ? frozen.block : sidebarBlock(n, roll);

  const groups: (ProjectGroup & { newestAt: number })[] = [];
  for (const [key, { info, nodes }] of byKey) {
    let label = initialLabels.get(key)!;
    if ((disambigCounts.get(label.toLowerCase()) ?? 0) > 1 && info.subtitle) {
      label = `${info.subtitle}/${info.label}`;
    }
    const ordered = sidebarOrder(nodes, roll, frozen);
    let block: SidebarBlock = 2;
    let loud: Loud = "none";
    let newestAt = 0;
    let latest = ordered[0]!.s;
    let latestTime = Date.parse(latest.lastAt || latest.startedAt) || 0;

    for (const n of ordered) {
      const b = blockOf(n);
      if (b < block) block = b;
      const own = loudOf(n.s, unread);
      const below = roll.get(n.s.key)?.loud ?? "none";
      loud = louder(loud, louder(own, below));
      const started = Date.parse(n.s.startedAt) || 0;
      if (started > newestAt) newestAt = started;
      const t = Date.parse(n.s.lastAt || n.s.startedAt) || 0;
      if (t > latestTime) {
        latestTime = t;
        latest = n.s;
      }
    }

    groups.push({
      key,
      label,
      ...(info.subtitle ? { subtitle: info.subtitle } : {}),
      ...(info.rawRepo ? { rawRepo: info.rawRepo } : {}),
      roots: ordered,
      loud,
      count: ordered.length,
      block,
      latest,
      newestAt,
    });
  }

  groups.sort((a, b) => {
    const bd = a.block - b.block;
    if (bd !== 0) return bd;
    const td = b.newestAt - a.newestAt;
    if (td !== 0) return td;
    const ld = a.label.localeCompare(b.label);
    if (ld !== 0) return ld;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return groups.map(({ newestAt: _n, ...g }) => g);
}
