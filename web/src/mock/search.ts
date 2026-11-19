// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. Session search in the page, for mock mode (`?mock=1`): the same
// SearchClient the server answers, over the mock World's sessions (as "sessionpipe") plus
// a few dozen invented history sessions from this Mac's own logs. A brute-force reader
// with the server's shapes (one row per session, 1–3 marked hits in transcript order,
// browse, hints, facets, a transcript with every hit), so the page, ⌘K and the history
// view run with no server. `&searchFirstRun=1` plays a first run; `&searchEmpty=1` an
// index with nothing in it. Every word here is made up.
import type { Labels, SearchDocField, SearchIndexStatus } from "@shared/api";
import { sessionKey } from "@shared/api";
import { type Doc, eventDocs, lastAt, pageSearch, type Sess } from "../search/inPage";
import type { SearchClient } from "../search/types";
import type { World } from "./world";

const HERE = "demo-laptop";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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
    s.docs.push(...eventDocs(e));
  }
  return [...out.values()].filter((s) => s.docs.length > 0);
}

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
  return pageSearch({
    all,
    status,
    labels,
    here: HERE,
    listeners,
    setHistory: (on) => {
      historyOn = on;
    },
    lag: true,
  });
}
