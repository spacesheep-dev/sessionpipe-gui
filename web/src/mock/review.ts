// SPDX-License-Identifier: Apache-2.0
// The Review page's two readings over the mock world, from its feed and snapshot:
// enough for the page to work with no server. The real ones live in server/store/review.ts.
import type {
  Digest,
  DigestGroup,
  DigestQuery,
  DigestSession,
  FilesPage,
  FilesPath,
  FilesQuery,
  SessionSummary,
  StoredEvent,
} from "@shared/api";
import { sessionKey } from "@shared/api";
import type { World } from "./world";

const DAY_MS = 86_400_000;
const keyOf = (e: StoredEvent) => sessionKey(e.harness.name, e.session.id);

export function review(world: World) {
  const all = (): StoredEvent[] => world.feed({ limit: 500 }).events;
  const summaries = (): Map<string, SessionSummary> => {
    const snap = world.snapshot();
    const out = new Map<string, SessionSummary>();
    if (snap.kind === "snapshot") for (const s of snap.snapshot.sessions) out.set(s.key, s);
    return out;
  };
  const title = (s: SessionSummary | undefined, e: StoredEvent) =>
    s?.title ?? e.session.title ?? e.session.id.slice(0, 8);

  return {
    files(q: FilesQuery): FilesPage {
      const since = q.since ? Date.parse(q.since) : Date.now() - DAY_MS;
      const sums = summaries();
      const repos = new Map<string, { lastAt: string; sessions: Set<string>; paths: Map<string, FilesPath> }>();
      let total = 0;
      for (const e of all()) {
        if (e.type !== "files.changed" || !Array.isArray(e.data.paths) || Date.parse(e.time) < since) continue;
        const s = sums.get(keyOf(e));
        const repo = s?.repo ?? e.session.repo ?? "";
        if (q.repo && repo !== q.repo) continue;
        let r = repos.get(repo);
        if (!r) {
          r = { lastAt: e.time, sessions: new Set(), paths: new Map() };
          repos.set(repo, r);
        }
        r.sessions.add(keyOf(e));
        for (const p of e.data.paths as string[]) {
          let fp = r.paths.get(p);
          if (!fp) {
            fp = { path: p, count: 0, lastAt: e.time, sessions: [] };
            r.paths.set(p, fp);
            total++;
          }
          fp.count++;
          const fs = fp.sessions.find((x) => x.key === keyOf(e));
          if (fs) fs.count++;
          else fp.sessions.push({ key: keyOf(e), title: title(s, e), count: 1, lastAt: e.time });
        }
      }
      return {
        since: new Date(since).toISOString(),
        repos: [...repos].map(([repo, r]) => ({
          repo,
          lastAt: r.lastAt,
          sessions: r.sessions.size,
          paths: [...r.paths.values()],
        })),
        total,
      };
    },

    digest(q: DigestQuery): Digest {
      const tz = q.tz ?? 0;
      const day = q.day ?? new Date(Date.now() - tz * 60_000).toISOString().slice(0, 10);
      const [y, m, d] = day.split("-").map(Number);
      const from = Date.UTC(y!, m! - 1, d!) + tz * 60_000;
      const to = from + DAY_MS;
      const sums = summaries();
      const acc = new Map<string, DigestSession & { files: Set<string> }>();
      for (const e of all()) {
        const t = Date.parse(e.time);
        if (t < from || t >= to) continue;
        const key = keyOf(e);
        const s = sums.get(key);
        let a = acc.get(key);
        if (!a) {
          a = {
            key,
            title: title(s, e),
            harness: e.harness.name,
            machine: s?.machine ?? e.session.machine,
            repo: s?.repo ?? e.session.repo,
            startedAt: e.time,
            endedAt: e.time,
            activeMs: 0,
            events: 0,
            turns: 0,
            tools: 0,
            errors: 0,
            attentions: 0,
            compactions: 0,
            filesTouched: 0,
            files: new Set(),
          };
          acc.set(key, a);
        }
        a.events++;
        if (e.time < a.startedAt) a.startedAt = e.time;
        if (e.time > a.endedAt) a.endedAt = e.time;
        a.activeMs = Date.parse(a.endedAt) - Date.parse(a.startedAt);
        if (e.type === "turn.started") a.turns++;
        if (e.type === "tool.ended") {
          a.tools++;
          if (e.data.ok === false) a.errors++;
        }
        if (e.type === "attention.needed") a.attentions++;
        if (e.type === "context.compacted") a.compactions++;
        if (e.type === "files.changed" && Array.isArray(e.data.paths))
          for (const p of e.data.paths) a.files.add(String(p));
        a.filesTouched = a.files.size;
      }
      const sessions = [...acc.values()].sort((x, z) => x.startedAt.localeCompare(z.startedAt));
      const groupBy = (f: (s: DigestSession) => string): DigestGroup[] => {
        const out = new Map<string, DigestGroup>();
        for (const s of sessions) {
          const name = f(s);
          const g = out.get(name) ?? {
            name,
            sessions: 0,
            activeMs: 0,
            events: 0,
            turns: 0,
            tools: 0,
            errors: 0,
            attentions: 0,
            compactions: 0,
            filesTouched: 0,
          };
          g.sessions++;
          g.activeMs += s.activeMs;
          g.events += s.events;
          g.turns += s.turns;
          g.tools += s.tools;
          g.errors += s.errors;
          g.attentions += s.attentions;
          g.compactions += s.compactions;
          g.filesTouched += s.filesTouched;
          out.set(name, g);
        }
        return [...out.values()];
      };
      const totals = groupBy(() => "all")[0] ?? {
        name: "all",
        sessions: 0,
        activeMs: 0,
        events: 0,
        turns: 0,
        tools: 0,
        errors: 0,
        attentions: 0,
        compactions: 0,
        filesTouched: 0,
      };
      return {
        day,
        tz,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        sessions: sessions.map(({ files: _files, ...s }) => s),
        byMachine: groupBy((s) => s.machine ?? ""),
        byRepo: groupBy((s) => s.repo ?? ""),
        totals,
      };
    },
  };
}
