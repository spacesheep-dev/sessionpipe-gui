// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. Session search answered in the page: the same SearchClient the
// server answers (search/types.ts), as a brute-force reader over whatever sessions its
// opener hands it, with the server's shapes (one row per session, 1–3 marked hits in
// transcript order, browse, hints, facets, a transcript with every hit). Two openers: mock
// mode (mock/search.ts, over the mock World and an invented history) and a page that
// carries its own board (account/search.ts, over its store: the phone on a spacesheep
// account, where there is no server to index anything).
import type {
  Labels,
  ParsedSearch,
  SearchDocField,
  SearchFacet,
  SearchFacets,
  SearchHint,
  SearchIndexStatus,
  SearchMark,
  SearchTranscript,
  SearchTranscriptMessage,
  SessionMatch,
  SessionSearchHit,
  SessionSearchPage,
  SessionSummary,
  StoredEvent,
} from "@shared/api";
import { sessionKey } from "@shared/api";
import {
  isBrowse,
  isEmptySearch,
  parseSearch,
  resolveSearchDate,
  withoutExclusion,
  withoutFilters,
  withoutQuotes,
} from "@shared/searchQuery";
import type { SearchClient } from "./types";

const DAY = 24 * 60 * 60_000;

export interface Doc {
  field: SearchDocField;
  tool?: string;
  text: string;
  at: number;
  seq?: number;
  agent?: { id: string; type?: string };
}
export interface Sess {
  harness: string;
  id: string;
  source: "history" | "sessionpipe";
  title: string;
  machine: string;
  repo?: string;
  cwd?: string;
  account?: string;
  docs: Doc[];
  summary?: SessionSummary;
  path?: string;
}

/** What search reads of one event: its prompt, its reply, the tool it ended. */
export function eventDocs(e: Pick<StoredEvent, "type" | "time" | "data" | "session">): Doc[] {
  const out: Doc[] = [];
  const at = Date.parse(e.time);
  const d = e.data as Record<string, unknown>;
  if (typeof d.user === "string" && d.user) out.push({ field: "prompt", text: d.user, at, seq: e.session.seq });
  if (typeof d.assistant === "string" && d.assistant)
    out.push({ field: "reply", text: d.assistant, at, seq: e.session.seq });
  if (e.type === "tool.ended" && typeof d.tool === "string") {
    const input = d.input as Record<string, unknown> | undefined;
    const arg = input && (input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url);
    out.push({
      field: "tool",
      tool: d.tool,
      text: `${d.tool}${typeof arg === "string" ? ` ${arg}` : ""}`.slice(0, 200),
      at,
      seq: e.session.seq,
    });
  }
  return out;
}

// ---------- matching ----------

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every [start, end) a clause covers in `text`, or [] when it is not there. */
function find(text: string, c: ParsedSearch["clauses"][number]): SearchMark[] {
  const t = fold(text);
  const needle = fold(c.text).trim();
  if (!needle) return [];
  const re =
    c.kind === "phrase"
      ? new RegExp(esc(needle).replace(/\s+/g, "\\s+"), "g")
      : c.kind === "prefix"
        ? new RegExp(`(?<![\\p{L}\\p{N}])${esc(needle)}[\\p{L}\\p{N}_]*`, "gu")
        : new RegExp(`(?<![\\p{L}\\p{N}])${esc(needle)}(?:s|es)?(?![\\p{L}\\p{N}])`, "gu");
  const out: SearchMark[] = [];
  for (const m of t.matchAll(re)) {
    out.push([m.index, m.index + m[0].length]);
    if (out.length > 50) break;
  }
  return out;
}

/** A window of at most `max` characters around the first mark, cut at words, `…` at cuts. */
function window(text: string, marks: SearchMark[], max = 160): { text: string; marks: SearchMark[] } {
  const flat = text.replace(/\s+/g, " ");
  // Folding whitespace moves offsets; recompute marks on the flat text for simplicity.
  const shift = (i: number) => text.slice(0, i).replace(/\s+/g, " ").length;
  const ms: SearchMark[] = marks.map(([a, b]) => [shift(a), shift(b)]);
  if (flat.length <= max) return { text: flat, marks: ms };
  const first = ms[0]?.[0] ?? 0;
  let start = Math.max(0, first - Math.floor(max / 3));
  let end = Math.min(flat.length, start + max);
  start = Math.max(0, end - max);
  if (start > 0) {
    const sp = flat.indexOf(" ", start);
    if (sp >= 0 && sp < first) start = sp + 1;
  }
  if (end < flat.length) {
    const sp = flat.lastIndexOf(" ", end);
    if (sp > (ms[0]?.[1] ?? start)) end = sp;
  }
  const pre = start > 0 ? "…" : "";
  const post = end < flat.length ? "…" : "";
  const body = flat.slice(start, end);
  return {
    text: `${pre}${body}${post}`,
    marks: ms
      .filter(([a, b]) => a >= start && b <= end)
      .map(([a, b]) => [a - start + pre.length, b - start + pre.length] as SearchMark),
  };
}

const WEIGHT: Record<SearchDocField, number> = { prompt: 2, reply: 1, tool: 0.7 };

const refOf = (s: Sess, i: number) => `m${i}-${s.id.slice(0, 4)}`;
const indexOfRef = (ref: string | undefined): number => {
  if (!ref) return -1;
  const m = /^m(\d+)-/.exec(ref);
  return m ? Number(m[1]) : -1;
};

export const lastAt = (s: Sess) => Math.max(...s.docs.map((d) => d.at), s.summary ? Date.parse(s.summary.lastAt) : 0);
const firstAt = (s: Sess) => Math.min(...s.docs.map((d) => d.at));
// ---------- the client ----------

/** What the reader is handed by its opener. */
export interface PageSearchSource {
  /** Every session there is to search, as it stands now. */
  all(): Sess[];
  status(): SearchIndexStatus;
  labels(): Labels;
  /** The machine `machine:this` means. */
  here: string;
  /** Who hears a `searchIndex` frame. */
  listeners: Set<(s: SearchIndexStatus) => void>;
  /** The history switch in the search settings, where there is a history. */
  setHistory?(on: boolean): void;
  /** Answer after a server's few milliseconds (mock mode), not at once. */
  lag?: boolean;
}

export function pageSearch(src: PageSearchSource): SearchClient {
  const delay = <T>(v: () => T, ms: number, signal?: AbortSignal): Promise<T> =>
    new Promise((res, rej) => {
      const t = setTimeout(
        () => {
          try {
            res(v());
          } catch (e) {
            rej(e);
          }
        },
        src.lag ? ms : 0,
      );
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        rej(new DOMException("aborted", "AbortError"));
      });
    });

  const allowed = (s: Sess, p: ParsedSearch, tz: number): boolean => {
    const lab = src.labels();
    const test = (key: keyof ParsedSearch["filters"], v: string): boolean => {
      switch (key) {
        case "agent":
          return s.harness === v;
        case "machine":
          return (v === "this" ? src.here : v) === s.machine.toLowerCase();
        case "repo": {
          const short = (s.repo ?? "").split("/").pop()?.toLowerCase() ?? "";
          return (
            short.startsWith(v) ||
            (s.cwd ?? "")
              .toLowerCase()
              .split("/")
              .some((seg) => seg.startsWith(v))
          );
        }
        case "label": {
          const c = lab.sessions[sessionKey(s.harness, s.id)];
          if (!c) return false;
          return c === v || (lab.names[c] ?? "").toLowerCase() === v.replace(/_/g, " ");
        }
        case "since": {
          const t = resolveSearchDate(v, "start", Date.now(), tz);
          return t === undefined || lastAt(s) >= t;
        }
        case "until": {
          const t = resolveSearchDate(v, "end", Date.now(), tz);
          return t === undefined || firstAt(s) <= t;
        }
        case "source":
          return v === "history" ? s.source === "history" : !!s.summary;
        default:
          return true;
      }
    };
    for (const [k, vs] of Object.entries(p.filters) as [keyof ParsedSearch["filters"], string[]][])
      if (k !== "in" && !vs.some((v) => test(k, v))) return false;
    for (const [k, vs] of Object.entries(p.notFilters) as [keyof ParsedSearch["filters"], string[]][])
      if (k !== "in" && vs.some((v) => test(k, v))) return false;
    return true;
  };

  const run = (q: string, sort: "best" | "newest", live: boolean, nHits: number, tz: number) => {
    const p = parseSearch(q, { live });
    const fields = p.filters.in;
    const pos = p.clauses.filter((c) => !c.not);
    const neg = p.clauses.filter((c) => c.not);
    const browse = isBrowse(p);
    const out: SessionMatch[] = [];
    if (isEmptySearch(p)) return { p, out };
    for (const s of src.all()) {
      if (!allowed(s, p, tz)) continue;
      const docOk = (d: Doc) => !fields || fields.includes(d.field);
      if (neg.some((c) => s.docs.some((d) => docOk(d) && find(d.text, c).length) || find(s.title, c).length)) continue;
      const titleMarks: SearchMark[] = [];
      let titleScore = 0;
      if (!fields || fields.includes("title"))
        for (const c of pos) {
          const m = find(s.title, c);
          if (m.length) {
            titleMarks.push(...m);
            titleScore += 4;
          }
        }
      const scored: { i: number; score: number; marks: SearchMark[]; all: boolean }[] = [];
      const seen = new Set<number>();
      s.docs.forEach((d, i) => {
        if (!docOk(d) || (fields?.length === 1 && fields[0] === "title")) return;
        let score = 0;
        const marks: SearchMark[] = [];
        let n = 0;
        for (const [ci, c] of pos.entries()) {
          const m = find(d.text, c);
          if (m.length) {
            n++;
            seen.add(ci);
            marks.push(...m);
            score += WEIGHT[d.field] * (1 + Math.log(m.length)) * (c.live ? 0.85 : 1);
          }
        }
        if (n) scored.push({ i, score, marks: marks.sort((a, b) => a[0] - b[0]), all: n === pos.length });
      });
      pos.forEach((c, ci) => {
        if (find(s.title, c).length) seen.add(ci);
      });
      if (!browse && seen.size < pos.length) continue;
      let hits: SessionSearchHit[];
      let more = 0;
      let score: number;
      if (browse) {
        const first = s.docs.findIndex((d) => d.field === "prompt");
        const d = s.docs[Math.max(0, first)]!;
        const w = window(d.text, []);
        hits = [
          {
            field: d.field,
            at: new Date(d.at).toISOString(),
            text: w.text,
            marks: [],
            ref: refOf(s, Math.max(0, first)),
            seq: d.seq,
          },
        ];
        score = 0;
      } else {
        const ranked = [...scored].sort((a, b) =>
          sort === "newest"
            ? s.docs[b.i]!.at - s.docs[a.i]!.at
            : b.score + (b.all ? 1 : 0) - (a.score + (a.all ? 1 : 0)),
        );
        const top = ranked.slice(0, nHits).sort((a, b) => a.i - b.i);
        more = Math.max(0, scored.length - top.length);
        hits = top.map((h) => {
          const d = s.docs[h.i]!;
          const w = window(d.text, h.marks);
          return {
            field: d.field,
            tool: d.tool,
            at: new Date(d.at).toISOString(),
            text: w.text,
            marks: w.marks,
            ref: refOf(s, h.i),
            seq: d.seq,
            agent: d.agent,
          };
        });
        const sc = ranked.map((r) => r.score);
        const rel = (sc[0] ?? 0) + 0.3 * (sc[1] ?? 0) + 0.1 * (sc[2] ?? 0) + titleScore;
        const anyAll = scored.some((x) => x.all);
        const age = (Date.now() - lastAt(s)) / DAY;
        score = rel * (anyAll || pos.length < 2 ? 1 : 0.6) * (0.7 + 0.3 * 2 ** (-age / 30));
      }
      const resume =
        s.harness === "claude-code" && s.cwd
          ? `cd '${s.cwd}' && claude --resume ${s.id}`
          : s.harness === "codex"
            ? `codex resume ${s.id}`
            : undefined;
      out.push({
        key: sessionKey(s.harness, s.id),
        harness: s.harness,
        id: s.id,
        source: s.summary && s.source === "history" ? "both" : s.source,
        title: s.summary?.title || s.title || "Untitled session",
        titleMarks: titleMarks.length ? titleMarks : undefined,
        machine: s.machine,
        thisMachine: s.machine === src.here,
        account: s.account,
        repo: s.repo,
        cwd: s.cwd,
        firstAt: new Date(firstAt(s)).toISOString(),
        lastAt: new Date(lastAt(s)).toISOString(),
        summary: s.summary,
        hits,
        moreHits: more,
        resume,
        transcriptPath: s.path,
        score,
      });
    }
    if (browse || sort === "newest") out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    else out.sort((a, b) => b.score - a.score);
    return { p, out };
  };

  const hintFor = (q: string, p: ParsedSearch, tz: number): SearchHint => {
    if (Object.keys(p.filters).length || Object.keys(p.notFilters).length)
      return { kind: "filters", query: withoutFilters(q) };
    if (p.clauses.some((c) => c.kind === "phrase" && !c.not)) return { kind: "phrase", query: withoutQuotes(q) };
    for (const c of p.clauses.filter((x) => x.not)) {
      const rq = withoutExclusion(q, c.text);
      if (run(rq, "best", true, 1, tz).out.length) return { kind: "exclude", query: rq, word: c.text };
    }
    if (src.status().state === "first-run") return { kind: "indexing" };
    return { kind: "none" };
  };

  const facet = (list: Sess[], f: (s: Sess) => string | undefined, label?: (v: string) => string | undefined) => {
    const m = new Map<string, number>();
    for (const s of list) {
      const v = f(s);
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]): SearchFacet => ({ value, count, label: label?.(value) }));
  };

  return {
    sessions: (q, signal) =>
      delay(
        () => {
          const t0 = performance.now();
          const qq = q.q.slice(0, 1000);
          const tz = q.tz ?? 0;
          const { p, out } = run(qq, q.sort ?? "best", !!q.live, q.hits ?? 3, tz);
          const offset = q.cursor ? (JSON.parse(atob(q.cursor)) as { o: number }).o : 0;
          const limit = q.limit ?? 20;
          const page = out.slice(offset, offset + limit);
          const res: SessionSearchPage = {
            q: q.q,
            sort: isBrowse(p) ? "newest" : (q.sort ?? "best"),
            parsed: p,
            sessions: page,
            total: Math.min(out.length, 200),
            more: out.length > 200,
            cursor: offset + limit < out.length ? btoa(JSON.stringify({ o: offset + limit })) : undefined,
            ms: Math.round((performance.now() - t0) * 10) / 10 + 3,
            index: src.status(),
            hint: out.length ? undefined : hintFor(qq, p, tz),
          };
          return res;
        },
        18 + Math.random() * 14,
        signal,
      ),
    transcript: (harness, id, q, signal) =>
      delay(
        () => {
          const s = src.all().find((x) => x.harness === harness && x.id === id);
          if (!s) throw Object.assign(new Error("not_found"), { status: 404 });
          const messages: SearchTranscriptMessage[] = s.docs.map((d, i) => ({
            ref: refOf(s, i),
            field: d.field,
            tool: d.tool,
            agent: d.agent,
            at: new Date(d.at).toISOString(),
            text: d.text,
            seq: d.seq,
          }));
          const p = parseSearch(q.q ?? "");
          const pos = p.clauses.filter((c) => !c.not);
          const hits = pos.length
            ? messages
                .map((m) => ({ ref: m.ref, marks: pos.flatMap((c) => find(m.text, c)).sort((a, b) => a[0] - b[0]) }))
                .filter((h) => h.marks.length > 0)
            : [];
          const limit = q.limit ?? 60;
          const at = indexOfRef(q.around ?? q.after ?? q.before);
          let start = 0;
          if (q.around) start = Math.max(0, at - Math.floor(limit / 2));
          else if (q.after) start = at + 1;
          else if (q.before) start = Math.max(0, at - limit);
          const end = q.before ? at : Math.min(messages.length, start + limit);
          const { hits: _h, ...rest } = run(`agent:${harness}`, "newest", false, 0, 0).out.find((m) => m.id === id) ?? {
            hits: [],
          };
          const session = { ...(rest as SessionMatch), hits: [] };
          const res: SearchTranscript = {
            session,
            messages: messages.slice(start, end),
            hits,
            before: start > 0 ? messages[start]!.ref : undefined,
            after: end < messages.length ? messages[end - 1]!.ref : undefined,
          };
          return res;
        },
        40,
        signal,
      ),
    facets: (signal) =>
      delay(
        (): SearchFacets => {
          const list = src.all();
          const lab = src.labels();
          const names: Record<string, string> = {
            "claude-code": "Claude Code",
            codex: "Codex",
            antigravity: "Antigravity",
            "gemini-cli": "Gemini CLI",
          };
          return {
            agents: facet(
              list,
              (s) => s.harness,
              (v) => names[v],
            ),
            machines: facet(list, (s) => s.machine),
            repos: facet(list, (s) => s.repo?.split("/").pop()),
            labels: facet(
              list,
              (s) => lab.sessions[sessionKey(s.harness, s.id)],
              (v) => lab.names[v as keyof Labels["names"]],
            ),
          };
        },
        30,
        signal,
      ),
    status: () => delay(src.status, 30),
    reindex: () => delay(src.status, 60),
    settings: (s) =>
      delay(() => {
        src.setHistory?.(s.history);
        const st = src.status();
        const { local: _l, ...frame } = st;
        for (const l of src.listeners) l(frame);
        return st;
      }, 120),
    reveal: () => delay(() => undefined, 40),
    onStatus: (l) => {
      src.listeners.add(l);
      return () => {
        src.listeners.delete(l);
      };
    },
  };
}
