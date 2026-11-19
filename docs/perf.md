# Performance: measurements and budgets

Measured on 2026-10-15 on the owner's real data: 177 sessions, 11 027 events, 182 MB of
JSONL (one session of 5 819 events is a 150 MB file), an M-series Mac, Node 23, headless
Chromium 1248 through Playwright. "Before" is the tree as of that morning; "after" is the
same tree with the changes listed at the end. The harness lives outside the repo (a
scratch directory); what stays in the repo is `server/store/store.memory.test.ts` (10 000
generated events, a heap budget per event) and `test/e2e/perf.spec.ts` (`@perf`, runs with
`SPGUI_PERF=1`: the board after two minutes of streaming, heap under budget).

## Server

| Measure | Target | Before | After |
|---|---|---|---|
| Boot, `new Store()` on the real data | ≤ 2 s warm | 850 ms | 790–870 ms |
| CLI boot to first `/api/ui/info` | ≤ 2 s | 1.73 s | 1.03 s |
| RSS right after boot | ≤ 100 MB | **521 MB** (peak; 287 MB for the next two minutes) | 185 MB at boot, 95–100 MB after ~35 s |
| Heap used, peak during boot | | 240 MB (every full event parsed and held) | 54 MB |
| Heap used after boot + GC | | 38.0 MB (3 618 B/event) | 34.1 MB (3 235 B/event) |
| of which 2 KB `data` previews | | 14.3 MB (7 055 strings) | 14.4 MB |
| of which strings under 64 chars | | 8.3 MB (206 k strings) | 4.2 MB (99 k; interned) |
| Idle CPU (no clients) | < 1 % | 0.15 % | 0.22 % |
| CPU with two browsers streaming 4 events/s | | | 0.3 % |
| Tailing the real outbox, 7.9 h, +1 397 live events | ≤ +20 MB after an hour | not measured | heap 37.9 → 41.8 MB (+3.9 MB); RSS 99–121 MB |
| Generated fixture: 10 000 events, 41 MB on disk | | | 21.2 MB heap, 2 220 B/event, boot 170 ms (budget 4 096 B/event) |

Why the before was 521 MB: `files.scan()` read each file into one Buffer (`arrayBuffers`
hit 143 MB for the 150 MB session) and parsed every line into a full event held in an array
until the whole scan finished; V8 then kept the committed pages for about two minutes.
Now each file is read in 256 KB chunks, each line is slimmed as it is parsed, and only the
index is kept. An explicit full GC at the end of boot was tried and makes no difference to
RSS (V8's memory reducer returns the pages ~30 s later either way), so there is none.

SSE frames on this data: a `SessionSummary` averages 854 B (p50 721, max 1 766) and a slim
event 1.7 KB (max 5.1 KB). Every event also produced a `machine` frame whose only change
was `lastAt`; those are now coalesced to one frame per second per machine, which halves
the frames (and the client commits) per event. Sending the summary only when changed was
measured and not done: the summary changes on every event (counts, `lastAt`).

## Browser (JS heap after a forced GC; 2 events/s posted through the receiver)

| Page | Before: heap 3 min | After: heap 3 min | Before: streaming CPU · commits/s | After | Before: idle CPU · commits/s | After |
|---|---|---|---|---|---|---|
| Board | 3.4 → 5.9 MB | 3.5 → 5.8 MB | 1.9 % · 8.2 | 1.4 % · 7.2 | 0.27 % · 1.23 | 0.3–0.8 % · 1.2 |
| Board, 30 minutes (3 613 events) | | 4.0 → 9.1 MB, flat at 8.9–9.1 MB from minute 17 (trend 0.007 MB/min) | | 5.4 % (other runs overlapped) · 7.7 | | 0.81 % · 1.3 |
| Board, burst at 50 events/s, 1 min | | 4.1 → 10 MB | | 18–30 % · ~55 (one commit per event) | | |
| Session (5.8k-event session) | 3.9 → 7.2 MB | 4.1 → 8.1 MB | 2.4 % · 9.1 | 3.8 % · 8.4 (see note) | 1.07 % · 1.6 | 0.78 % · 3.1 with another poster running |
| Feed (1 500 rows) | 3.1 → 9.0 MB | 3.2 → 9.6 MB | 4.4 % · 5.7 | 3.2 % · 4.9 | 1.27 % · 1.23 | 0.34 % · 0.3 |
| Feed, final tree (tier lens, new row content) | | 3.5 → 13.8 MB, 16.6 k nodes | | 10.3 % · 9.1 | | 0.01–0.15 % with nothing arriving |
| `/t/canvas`, Map on | 3.5 → 5.0 MB | 3.6 → 5.4 MB | 1.0 % · 4.2 | 1.1 % · 4.3 | 0.40 % · 1.1 | 0.48 % · 0.5 |
| Split panel, 6 tabs | not measured; **99.9 % CPU, ~1 000–1 250 commits/s** with even one tab (pre-existing render loop) | 6.2 → 9.2 MB | | 8.8 % · 8.4 | | 4 % · 5 with another poster running |

Scrolling was 60 fps on every page before and after (57 fps with the six-tab panel).
Long tasks over 50 ms: only the first paint (111 ms Board, 69 ms Session) before; none
during streaming after, except at 50 events/s (max 416 ms when the burst stopped and a GC
was forced). The `@perf` spec on the demo-mode e2e server: heap 2.6 → 5.9 MB after 238
posted events on top of the demo generator, within its 60 MB budget.

Notes on the table. The two tickers were the measurable idle cost: `useNow()` re-rendered
every `Since`, every `TurnBlock` and the whole Feed each second; now a reading ticks each
second only while it shows seconds, every ten seconds after, and not at all when nothing
it renders moves, and the Feed's day labels change at midnight. The Session page's
"after" streaming CPU is higher than "before" because other work landed in `SessionView`
and the Feed rows in the same hours (Markdown, the tier lens, settings); the before/after
pairs of one morning are not a clean A/B for those two pages. The Board's burst figure is
one React commit per event; batching messages per animation frame would only pay above
~60 events/s and was not done.

## Bundle

`dist/web` gzipped JS: 124.5 KB at the start of the day (112.5 + 12.0), 152.3 KB at the end
(139.0 + 12.0 + 1.3 for a lazy settings chunk). The 80 KB target was already missed;
React + ReactDOM alone are ~45 KB. The growth is the day's features (inbox, toasts, sounds,
settings, review, plugins); the changes below add under 1 KB.

## What changed

- `server/store/files.ts`: `readLines` (256 KB chunks, one reused buffer) and `scanEach`;
  `scan()` kept on top of it for callers that want whole files.
- `server/store/store.ts`: boot indexes the slim copy as each line is read and never holds
  full events; `keepDays` option (CLI `--keep-days N`, default 14, 0 = keep whole): events
  older than that keep 280-char previews of their big `data` strings instead of 2 KB
  (`preview` still records the original lengths, the full event is on disk; on the owner's
  data, all newer than 14 days, this trims nothing). `machine` frames that only move
  `lastAt` are coalesced to one per second.
- `server/store/slim.ts`: `trimPreview` (shared with `server/ui/preview.ts`) and interning
  of the short strings every event repeats (type, harness, machine, cwd, repo, model…).
- `server/ui/process.ts`: `GET /api/ui/stats/process`, loopback only — `process.memoryUsage`,
  uptime, store counts; a POST runs a full GC first. For a `watch curl` while it runs.
- `web/src/lib/time.ts`: `useNow("fine" | "coarse" | "off")`, `tickFor`, `useToday`.
- `web/src/components/bits.tsx`, `Shell.tsx`, `SessionView.tsx`, `pages/Feed.tsx`: tickers
  pick their tick by age; idle turn blocks and the connection pill stop ticking; the Feed
  keys its day labels on the day.
- `web/src/components/SessionCard.tsx`: `React.memo` with a props comparison, so an event
  re-renders the one card whose summary changed.
- `web/src/components/SessionView.tsx`: a live, followed session keeps at most 500 rows in
  memory (older ones are one "Older turns" click away); the view subscribes to its own
  session and the machines map, not the whole app state.
- `web/src/lib/split.ts`: `useSplit()` memoizes the parsed URL state. Before, a fresh
  `tabs` array every render had two panel effects setting state in a loop: ~1 000 commits
  and 100 % of a core per second whenever the panel was open.
- Tests: `server/store/store.memory.test.ts` (bytes/event budget, preview trimming, machine
  frame coalescing); `test/e2e/perf.spec.ts` (`@perf`, `SPGUI_PERF=1`).

## Still to do

- The canvas theme: no leak found in 3 minutes (listeners and nodes flat, rAF only on
  demand, one 1 s ticker cleared on destroy); not changed.
- Selector-based subscriptions across the web app: the Shell and the control strip still
  subscribe to the whole state, so every message costs one commit page-wide (~3 % CPU on
  the Session page at 4 events/s from other sessions' events). The `useSession` selector
  added here is the pattern; the measured gain was within noise until the rest follows.
- Feed rows: the final tree's Feed is ~3× the streaming CPU of the morning's (10 % vs 3 %
  at 2 events/s) and 16.6 k DOM nodes for 1 500 rows; the new row content and the per-event
  `atTier` map over all rows are the places to look, and `React.memo` on a row component
  keyed on the event object would let the 1 499 unchanged rows skip.
- Batching stream messages per animation frame for bursts above ~60 events/s.
- `sessionpipe-core`'s `Outbox.read` recomputes `Buffer.byteLength` of the growing prefix on
  every line (quadratic per batch); harmless for a live tail, slow for a first drain.
- The `recent` ring (1 500 slim events, ≤ ~2.5 MB) is only read by themes; it could be
  capped by bytes if a theme ever needs less.
