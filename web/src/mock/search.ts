// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. Session search in the page, for mock mode (`?mock=1`): the same
// SearchClient the server answers, over the mock World's sessions (as "sessionpipe") plus
// a few dozen invented history sessions from this Mac's own logs. A brute-force reader
// with the server's shapes (one row per session, 1–3 marked hits in transcript order,
// browse, hints, facets, a transcript with every hit), so the page, ⌘K and the history
// view run with no server. `&searchFirstRun=1` plays a first run; `&searchEmpty=1` an
// index with nothing in it. Every word here is made up.
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
import type { SearchClient } from "../search/types";
import type { World } from "./world";

const HERE = "misha-air";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Doc {
  field: SearchDocField;
  tool?: string;
  text: string;
  at: number;
  seq?: number;
  agent?: { id: string; type?: string };
}
interface Sess {
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

// ---------- the invented history ----------

type Turn = [SearchDocField, string, string?];
interface Plot {
  harness: string;
  title: string;
  cwd: string;
  repo?: string;
  ago: number;
  span: number;
  turns: Turn[];
}

const P = (
  harness: string,
  title: string,
  cwd: string,
  repo: string | undefined,
  ago: number,
  span: number,
  turns: Turn[],
): Plot => ({
  harness,
  title,
  cwd,
  repo,
  ago,
  span,
  turns,
});

const PLOTS: Plot[] = [
  P(
    "claude-code",
    "Fix invoice webhook retry on 409",
    "/Users/demo/code/billing",
    "acme/billing",
    26 * HOUR,
    28 * MIN,
    [
      [
        "prompt",
        "The invoice webhook retries forever when Stripe returns 409. Can you find where the retry loop lives and stop it from retrying on a conflict?",
      ],
      ["tool", "src/webhooks/retry.ts", "Read"],
      [
        "reply",
        "The retry loop is in `src/webhooks/retry.ts`: `retryWithBackoff` never checks for a 409 conflict, so it backs off and tries again until the queue drops it. A 409 from Stripe means the event was already processed, so the right move is to mark it delivered and stop.",
      ],
      ["tool", "src/webhooks/retry.ts", "Edit"],
      ["tool", "pnpm vitest webhooks/409.test.ts", "Bash"],
      [
        "reply",
        "Added a 409 branch to `retryWithBackoff`: the webhook is marked delivered and the job ends. The new test covers a 409 on the first attempt and after two 503s. All 41 webhook tests pass.",
      ],
      ["prompt", "Does the same thing happen for the refund webhook?"],
      ["tool", "refund webhook 409", "Grep"],
      [
        "reply",
        "Yes, `refunds/handler.ts` calls the same `retryWithBackoff`, so the fix covers it. I added one more test for the refund path to be sure.",
      ],
    ],
  ),
  P(
    "codex",
    "add a test for the stripe webhook 409 retry",
    "/Users/demo/code/billing",
    "acme/billing",
    25 * HOUR,
    1 * MIN,
    [
      ["prompt", "add a test for the stripe webhook 409 retry"],
      ["tool", "src/webhooks/retry.test.ts", "apply_patch"],
      [
        "reply",
        "Added retry.test.ts covering a 409 from Stripe: the webhook is marked delivered on the first conflict and never retried. It runs in 40 ms.",
      ],
    ],
  ),
  P("claude-code", "Rate limiter for the public API", "/Users/demo/code/gateway", "acme/gateway", 3 * DAY, 2 * HOUR, [
    [
      "prompt",
      "We need a rate limiter for the public API: 100 requests a minute per key, a burst of 20, and a Retry-After header. Redis is already there.",
    ],
    [
      "reply",
      "I'd use a sliding-window rate limiter in Redis with one sorted set per key. The token bucket is simpler but its bursts are harder to explain to customers. Here is the plan: a `RateLimiter` class, a middleware, and a header writer.",
    ],
    ["tool", "src/middleware/rateLimit.ts", "Write"],
    ["tool", "pnpm test middleware", "Bash"],
    [
      "reply",
      "The rate limiter is in: `src/middleware/rateLimit.ts`. A request over the limit gets a 429 with `Retry-After` in seconds. The burst is the first 20 of each window.",
    ],
    ["prompt", "Can the limit be set per plan instead of one global number?"],
    [
      "reply",
      "Yes: the limiter now reads `plan.rateLimit` from the key's record, falling back to 100. Enterprise keys get 1000.",
    ],
  ]),
  P(
    "claude-code",
    "Migrate sessions table to uuid",
    "/Users/demo/code/design-system",
    "acme/design-system",
    6 * DAY,
    90 * MIN,
    [
      ["prompt", "Write a migration that moves the sessions table from integer ids to uuid without downtime."],
      [
        "reply",
        "A migration in three steps keeps it online: add a `uuid` column with a default, backfill in batches of 5,000, then swap the primary key in one short transaction.",
      ],
      ["tool", "migrations/0042_sessions_uuid.sql", "Write"],
      ["tool", "pnpm db:migrate --dry-run", "Bash"],
      ["reply", "The dry run took 1.8 s on the staging snapshot. The lock in the last step is held for 40 ms."],
    ],
  ),
  P(
    "codex",
    "Why does the staging deploy take 14 minutes?",
    "/Users/demo/code/infra",
    "acme/infra",
    8 * DAY,
    40 * MIN,
    [
      ["prompt", "Why does the staging deploy take 14 minutes? Production takes 4."],
      ["tool", "kubectl rollout history deploy/api -n staging", "shell"],
      [
        "reply",
        "Staging pulls every image fresh because its nodes use `imagePullPolicy: Always` and a cold cache. The dry run of the deploy spends 9 minutes on image pulls alone.",
      ],
      ["prompt", "Fix it without touching production."],
      ["tool", "k8s/staging/api.yaml", "apply_patch"],
      [
        "reply",
        "Set `imagePullPolicy: IfNotPresent` for staging only and pinned the base image digest. The next staging deploy took 3 min 50 s.",
      ],
    ],
  ),
  P(
    "antigravity",
    "Focus ring disappears on the Button in Safari",
    "/Users/demo/code/design-system",
    "acme/design-system",
    2 * DAY,
    25 * MIN,
    [
      ["prompt", "The Button's focus ring disappears in Safari when it is inside a dialog. Find out why."],
      [
        "reply",
        "Safari only shows `:focus-visible` after a keyboard event inside the document, and the dialog moves focus with `element.focus()` on open. The focus ring is drawn, then removed by the `outline: none` reset on `.dialog *`.",
      ],
      ["tool", "src/components/Button.css", "edit_file"],
      [
        "reply",
        "Scoped the reset to `.dialog :not(:focus-visible)`. The focus ring now shows in Safari 18 and Chrome.",
      ],
    ],
  ),
  P(
    "gemini-cli",
    "Summarise the flaky checkout test failures",
    "/Users/demo/code/shop",
    "acme/shop",
    4 * DAY,
    15 * MIN,
    [
      ["prompt", "Summarise why the checkout test is flaky in CI over the last 30 runs."],
      ["tool", "gh run list --workflow checkout.yml --limit 30", "run_shell_command"],
      [
        "reply",
        "11 of the 30 runs failed, all on `checkout.spec.ts:88`: the test clicks Pay before the payment iframe has loaded. A wait for the iframe's `ready` message fixes it.",
      ],
    ],
  ),
  P(
    "claude-code",
    "Search: review the BM25 cache",
    "/Users/demo/code/search-api",
    "acme/search-api",
    10 * HOUR,
    3 * HOUR,
    [
      [
        "prompt",
        "Review the BM25 cache in `src/rank/cache.ts`: correctness of the invalidation, the hot-path performance, and what the tests miss.",
      ],
      ["tool", "src/rank/cache.ts", "Read"],
      [
        "reply",
        "The cache keys on the query string only, so a reindex leaves stale scores for up to its TTL. Keying on `(query, generation)` fixes the invalidation. The hot path allocates a new array per posting; a reused scratch buffer cuts p95 from 31 ms to 9 ms.",
      ],
      ["tool", "pnpm bench rank", "Bash"],
      [
        "reply",
        "With the scratch buffer and the generation key: p50 3.1 ms, p95 8.8 ms on the 100k-document corpus. The tests never reindex between queries; I added one that does.",
      ],
    ],
  ),
  P(
    "codex",
    "Explain the retry budget in the job queue",
    "/Users/demo/code/billing",
    "acme/billing",
    12 * DAY,
    10 * MIN,
    [
      ["prompt", "Explain how the retry budget works in the job queue."],
      [
        "reply",
        "Each job type has a retry budget of 10 % of its successful runs over the last hour. A retry spends budget; when it is gone, failures go straight to the dead-letter queue instead of retrying.",
      ],
    ],
  ),
  P(
    "claude-code",
    "Dark mode tokens for the charts",
    "/Users/demo/code/design-system",
    "acme/design-system",
    15 * DAY,
    50 * MIN,
    [
      [
        "prompt",
        "The chart colours are unreadable in dark mode. Make a dark set of tokens with the same contrast as the light ones.",
      ],
      [
        "reply",
        "I derived the dark tokens in OKLCH by keeping hue and chroma and lifting lightness to hold a 4.5:1 contrast against `--bg`. Seven series colours, all checked.",
      ],
      ["tool", "tokens/charts.dark.json", "Write"],
    ],
  ),
  P("claude-code", "Terraform drift in staging", "/Users/demo/code/infra", "acme/infra", 25 * DAY, 35 * MIN, [
    ["prompt", "terraform plan shows drift in staging on the load balancer. What changed?"],
    ["tool", "terraform plan -target=module.lb", "Bash"],
    [
      "reply",
      "Someone raised the idle timeout to 120 s in the console. The plan wants it back at 60. I'd put 120 in the module, since the websocket clients need it.",
    ],
  ]),
  P("codex", "Port the CSV export to streams", "/Users/demo/code/reports", "acme/reports", 40 * DAY, 2 * HOUR, [
    ["prompt", "The CSV export runs out of memory on big accounts. Port it to streams."],
    ["tool", "src/export/csv.ts", "apply_patch"],
    [
      "reply",
      "The export now pipes rows from a database cursor through a CSV transform straight to the response. Memory stays under 60 MB for a 2 GB export.",
    ],
  ]),
  P("antigravity", "Onboarding checklist copy", "/Users/demo/code/web", "acme/web", 60 * DAY, 20 * MIN, [
    ["prompt", "Rewrite the onboarding checklist copy so each step is one short sentence."],
    [
      "reply",
      "Five steps, each one sentence, each starting with a verb: Connect your repo. Invite a teammate. Run your first check. Read the report. Turn on alerts.",
    ],
  ]),
  P("claude-code", "Upgrade to React 19", "/Users/demo/code/web", "acme/web", 90 * DAY, 4 * HOUR, [
    ["prompt", "Upgrade the web app to React 19 and fix whatever breaks."],
    ["tool", "pnpm add react@19 react-dom@19", "Bash"],
    [
      "reply",
      "Three things broke: `defaultProps` on function components, a string ref in the legacy table, and `ReactDOM.render` in the test setup. All fixed; the suite is green.",
    ],
  ]),
  P("gemini-cli", "What does the deploy -staging flag do?", "/Users/demo/code/infra", "acme/infra", 5 * DAY, 2 * MIN, [
    ["prompt", "What does the deploy script do with the --dry-run flag on staging?"],
    [
      "reply",
      "With `--dry-run` the deploy script renders the manifests and runs `kubectl diff` against staging, but applies nothing.",
    ],
  ]),
  P("claude-code", "Speed up the board's first paint", "/Users/demo/code/web", "acme/web", 2 * HOUR, 70 * MIN, [
    ["prompt", "The board takes 900 ms to first paint on a cold load. Find the biggest win."],
    ["tool", "pnpm build --report", "Bash"],
    [
      "reply",
      "Two thirds of the entry bundle is the chart library, which only the Reports page uses. Moving it behind a lazy route cuts the entry from 410 KB to 140 KB gzipped, and first paint to 310 ms.",
    ],
  ]),
];

const uuidLike = (n: number, h: string) => {
  const x = (k: number) => ((Math.imul(n + 7, 2654435761) >>> 0) ^ (k * 40503)).toString(16).padStart(8, "0");
  return h === "antigravity"
    ? `${x(1)}-${x(2).slice(0, 4)}-4${x(3).slice(0, 3)}-a${x(4).slice(0, 3)}-${x(5)}${x(6).slice(0, 4)}`
    : `${x(1)}-${x(2).slice(0, 4)}-4${x(3).slice(0, 3)}-8${x(4).slice(0, 3)}-${x(5)}${x(6).slice(0, 4)}`;
};

function history(now: number): Sess[] {
  return PLOTS.map((p, i) => {
    const id = uuidLike(i, p.harness);
    const start = now - p.ago - p.span;
    const docs: Doc[] = p.turns.map(([field, text, tool], j) => ({
      field,
      text: field === "tool" && tool ? `${tool} ${text}` : text,
      tool: field === "tool" ? tool : undefined,
      at: start + Math.round((p.span * j) / Math.max(1, p.turns.length - 1)),
    }));
    const home = p.harness === "claude-code" ? "~/.claude" : p.harness === "codex" ? "~/.codex" : "~/.gemini";
    return {
      harness: p.harness,
      id,
      source: "history" as const,
      title: p.title,
      machine: HERE,
      repo: p.repo,
      cwd: p.cwd,
      docs,
      path: `${home.replace("~", "/Users/demo")}/${p.harness === "codex" ? "sessions/2026/10" : "projects/-Users-demo-code"}/${id}.jsonl`,
    };
  });
}

function fromWorld(world: World): Sess[] {
  const snap = world.snapshot();
  if (snap.kind !== "snapshot") return [];
  const events = world.feed({ limit: 500 }).events;
  const out = new Map<string, Sess>();
  for (const s of snap.snapshot.sessions) {
    if (s.parentId) continue;
    out.set(s.key, {
      harness: s.harness,
      id: s.id,
      source: "sessionpipe",
      title: s.title ?? "",
      machine: s.machine ?? HERE,
      repo: s.repo,
      cwd: s.cwd,
      docs: [],
      summary: s,
    });
  }
  for (const e of [...events].reverse()) {
    const s = out.get(sessionKey(e.harness.name, e.session.id));
    if (!s) continue;
    const at = Date.parse(e.time);
    const d = e.data as Record<string, unknown>;
    if (typeof d.user === "string" && d.user) s.docs.push({ field: "prompt", text: d.user, at, seq: e.session.seq });
    if (typeof d.assistant === "string" && d.assistant)
      s.docs.push({ field: "reply", text: d.assistant, at, seq: e.session.seq });
    if (e.type === "tool.ended" && typeof d.tool === "string") {
      const input = d.input as Record<string, unknown> | undefined;
      const arg = input && (input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url);
      s.docs.push({
        field: "tool",
        tool: d.tool,
        text: `${d.tool}${typeof arg === "string" ? ` ${arg}` : ""}`.slice(0, 200),
        at,
        seq: e.session.seq,
      });
    }
  }
  return [...out.values()].filter((s) => s.docs.length > 0);
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

const lastAt = (s: Sess) => Math.max(...s.docs.map((d) => d.at), s.summary ? Date.parse(s.summary.lastAt) : 0);
const firstAt = (s: Sess) => Math.min(...s.docs.map((d) => d.at));

// ---------- the client ----------

export function mockSearch(world: World, labels: () => Labels): SearchClient {
  const params = new URLSearchParams(location.search);
  const empty = params.get("searchEmpty") === "1";
  const now = Date.now();
  const hist = empty ? [] : history(now);
  let historyOn = !empty;
  const listeners = new Set<(s: SearchIndexStatus) => void>();
  const firstRunStart = params.get("searchFirstRun") === "1" ? Date.now() : 0;
  const FIRST_RUN_MS = 60_000;

  const all = (): Sess[] => {
    const live = empty ? [] : fromWorld(world);
    // History wins for a key in both (D6), the store's summary rides along.
    const byKey = new Map<string, Sess>();
    for (const s of live) byKey.set(sessionKey(s.harness, s.id), s);
    const pool = historyOn ? hist : [];
    for (const s of pool) {
      const k = sessionKey(s.harness, s.id);
      const known = byKey.get(k);
      byKey.set(k, known ? { ...s, summary: known.summary, machine: known.machine } : s);
    }
    let list = [...byKey.values()];
    if (firstRunStart) {
      const p = Math.min(1, (Date.now() - firstRunStart) / FIRST_RUN_MS);
      const keep = Math.ceil(hist.length * p);
      const histKeys = new Set(
        [...hist]
          .sort((a, b) => lastAt(b) - lastAt(a))
          .slice(0, keep)
          .map((s) => s.id),
      );
      list = list.filter((s) => s.source !== "history" || histKeys.has(s.id));
    }
    return list;
  };

  const status = (): SearchIndexStatus => {
    const list = all();
    const p = firstRunStart ? Math.min(1, (Date.now() - firstRunStart) / FIRST_RUN_MS) : 1;
    const sources: SearchIndexStatus["sources"] = [];
    const count = (h: string, src: "history" | "sessionpipe") =>
      list.filter((s) => s.harness === h && (src === "sessionpipe" ? !!s.summary : s.source === "history")).length;
    if (historyOn) {
      for (const [h, homes] of [
        ["claude-code", ["~/.claude", "~/.claude-work"]],
        ["codex", ["~/.codex/sessions"]],
        ["antigravity", ["~/.gemini/antigravity"]],
        ["gemini-cli", ["~/.gemini/tmp"]],
      ] as const) {
        const n = count(h, "history");
        if (n) sources.push({ harness: h, source: "history", homes: [...homes], sessions: n });
      }
    }
    const piped = list.filter((s) => s.summary).length;
    if (piped)
      sources.push({
        harness: "sessionpipe",
        source: "sessionpipe",
        homes: [],
        sessions: piped,
      });
    return {
      state: !historyOn ? "off" : p < 1 ? "first-run" : "ready",
      sessions: list.length,
      messages: list.reduce((n, s) => n + s.docs.length, 0),
      progress: p < 1 ? p : undefined,
      bytes: 212_000_000 * (historyOn ? 1 : 0.2),
      updatedAt: new Date(Date.now() - 4000).toISOString(),
      history: historyOn,
      sources,
      local: true,
    };
  };

  if (firstRunStart) {
    const t = setInterval(() => {
      const s = status();
      const { local: _l, ...frame } = s;
      for (const l of listeners) l(frame);
      if (s.state !== "first-run") clearInterval(t);
    }, 1000);
  }

  const delay = <T>(v: () => T, ms: number, signal?: AbortSignal): Promise<T> =>
    new Promise((res, rej) => {
      const t = setTimeout(() => {
        try {
          res(v());
        } catch (e) {
          rej(e);
        }
      }, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        rej(new DOMException("aborted", "AbortError"));
      });
    });

  const allowed = (s: Sess, p: ParsedSearch, tz: number): boolean => {
    const lab = labels();
    const test = (key: keyof ParsedSearch["filters"], v: string): boolean => {
      switch (key) {
        case "agent":
          return s.harness === v;
        case "machine":
          return (v === "this" ? HERE : v) === s.machine.toLowerCase();
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
    for (const s of all()) {
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
        thisMachine: s.machine === HERE,
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
    if (status().state === "first-run") return { kind: "indexing" };
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
            index: status(),
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
          const s = all().find((x) => x.harness === harness && x.id === id);
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
          const list = all();
          const lab = labels();
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
    status: () => delay(status, 30),
    reindex: () => delay(status, 60),
    settings: (s) =>
      delay(() => {
        historyOn = s.history;
        const st = status();
        const { local: _l, ...frame } = st;
        for (const l of listeners) l(frame);
        return st;
      }, 120),
    reveal: () => delay(() => undefined, 40),
    onStatus: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}
