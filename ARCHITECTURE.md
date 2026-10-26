# sessionpipe-gui · architecture

The GUI is **a sessionpipe receiver with a face**: one Node process, no database, a
live board in the browser. It speaks the whole protocol (`spec/HTTP.md`, `CONTROL.md`
in the sessionpipe repo) so it is also the easiest way to test every feature of the
client against a receiver you can see into.

```
 ┌──────────── this machine ────────────┐      ┌── other machines ──┐
 │ sessionpipe hooks → outbox/*.jsonl    │      │ sessionpipe sinks  │
 │        │ (tailed, zero config)        │      │  POST /events      │
 │        ▼                              │      └─────────┬──────────┘
 │  sessionpipe-gui :7373 ◄──────────────┼────────────────┘
 │   store (JSONL + in-memory index)     │
 │   receiver · control · UI API · SSE   │◄──── phones / laptops on the LAN
 │   static web app (dist/web)           │      http://<lan-ip>:7373/?k=<ui key>
 └───────────────────────────────────────┘
```

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Runtime | Node ≥ 20, ESM, TypeScript, `node:http` | Same floor as sessionpipe; nothing to install beyond `npx` |
| Deps | `sessionpipe-core` (types, `filterEvent`, `Outbox`, control verifier), `qrcode`. Nothing else at runtime | Keep it as light as the client |
| Web | React 18 + Vite, hand-written CSS with design tokens, no component library | Distinctive, fast, small |
| Live updates | SSE `GET /api/ui/stream`: a snapshot first, then deltas | Works through any proxy, reconnects by itself |
| Storage | `~/.local/state/sessionpipe-gui/events/<harness>/<session>.jsonl` (append-only, full events) + an index rebuilt at boot | No DB; `forget` deletes one file |
| Memory | Index holds summaries and *slim* events (tool `input`/`output` cut to a 2 KB preview, `output` kept as length + preview; 280 chars once an event is older than `--keep-days`, default 14); full data is read back from the file by byte offset on demand. Boot streams each file line by line and keeps only the slim copy, so a 150 MB session file never sits in memory | 100k events must fit |
| Sources | (1) HTTP receiver, bearer sink token. (2) Local outbox tailer, like `sessionpipe tail` (`Outbox.read` every 500 ms, tier 3, `source: "outbox"`). (3) Demo generator | Zero config on the dev machine, real protocol from everywhere else. Dedup on (harness, session.id, seq) resolves overlap |
| Auth | Events: `Bearer <sink token>` always. UI API + page: loopback free; otherwise cookie `spgui=<ui key>` set by `?k=`. Well-known: public. Machine calls: the machine's own token | One QR code gets a phone in; the token never has to be typed |
| Readings | State machine in `shared/api.ts` (`needs_you` › `working` › `stale` › `idle` › `done`) | Spec §1: the receiver's reading, shown as such |
| Control | Full receiver side (pair, hello, poll, ack, off, queue, redelivery, `taken` pause); UI signs with WebAuthn passkeys + a day key. `rp_id` is `localhost` by default, `<machine>.local` with `--tls` | Phones need HTTPS and a DNS name for passkeys |
| Remote | `--public-url https://<name>`: the GUI from anywhere through a trusted https reverse proxy on the same machine (Tailscale's `tailscale serve --bg 7373` is the one the setup page walks through). The url's host becomes the rp id; the router trusts `X-Forwarded-For` / `-Proto` / `-Host` only on connections from loopback, so a visitor through the proxy is never mistaken for this machine (UI key required, setup actions refused). Remembered in `config.json`; the setup page's optional step 6 sets it (`POST /api/ui/setup/remote`) and probes `tailscale status` for the MagicDNS name | No port forwarding, no CA to install, a certificate browsers already trust; one name for LAN and away |
| TLS | `--tls`: a local CA + server cert made with the `openssl` CLI under `<stateDir>/tls`; one `net.Server` peeks the first byte and hands TLS to an `https.Server`, the rest to the `http.Server`, same handler, same port. `/trust` (plain http) walks a phone through trusting the CA; the QR points there | Passkeys from a phone with nothing to install but one certificate; loopback and sinks stay plain http |
| Extensions | Three kinds, one installer (`server/extensions`, `sessionpipe-gui <kind> add\|link\|remove\|list`): **views** (themes: an ES module + `theme.json`, loaded by the page with `ThemeApi`, `docs/theme-authoring.md`), **plugins** (an ES module + `plugin.json`, imported into the receiver process with `PluginApi`, `shared/plugin-api.ts`, `docs/plugin-authoring.md`), **skins** (`skin.json`: colour tokens per scheme, bundled fonts, typography, shape, an optional stylesheet; no code; `shared/skin-api.ts`, `docs/skin-authoring.md`; the old color-theme JSON files are listed as token-only skins). The official ones live in `sessionpipe-gui-themes`; two skins ship built in (`shared/skins-builtin.ts`), sessionpipe the default and Paper, with Plain as the unlisted base; every official extension ships **bundled** in `dist/bundled/{views,skins,plugins}/` (copied from the themes repo at build time, or from the tracked `bundled/` copy; listed after the person's own installs so an install of the same id overrides, disabled rather than removed); a bundled plugin stays off until `config.json` `enabled` names it | Everything optional stays out of the main GUI and can be installed, linked for development, or removed. A plugin may notify and *suggest* an answer to a permission; it never signs one: the receiver holds no key. A skin is the kind that needs no trust |
| Search | Session search lives in the GUI, not in sessionpipe core: one index over what sessionpipe delivered (at its tier) plus this machine's own agent history (Claude Code, Codex incl. `.jsonl.zst`, Antigravity, Gemini CLI), under `<stateDir>/search/{history,events}/` (0700/0600). Our own engine in TypeScript (BM25F + recency, positional postings, a sorted dictionary for prefixes; `node:sqlite` has no FTS5). One writer, a niced child (`index --ipc`, in-process when forking fails); the server only reads and runs the live tail. One query language for the page, ⌘K, the CLI and the API (`shared/searchQuery.ts`); filters travel in `q`. History indexing is `config.json` `searchHistory` (default on; off deletes `history/`). `--search-home` / `SPGUI_SEARCH_HOME` point history at a synthetic home; `--demo` without one reads none. SEARCH-SPEC.md in the review folder | Offline, no new dependency, sessions from before sessionpipe count, and the terminal works with no browser |
| Conformance | Our own runner for `conformance/delivery/*.json` from a sessionpipe checkout (the upstream runner's receiver mode lands in M3) | We must score 100 % |

## Modules and owners

| Path | Owner | Exports (contract) |
|---|---|---|
| `shared/api.ts` | core (change by agreement) | Every wire type and route |
| `server/http/router.ts`, `net.ts` | core | `Router`, `Ctx`, `Reply`, `HttpError`, `isLoopback`, `lanAddresses` |
| `server/app.ts` | server-core | `createApp(opts): App` — the only composition root; `Info.control.origins`, the origins the rp id is valid for; one Tailscale probe shared by setup and phone |
| `server/config.ts` | server-core | state dir, sink token, UI key |
| `server/store/*` | server-core | `Store`: `ingest(events, source) → IngestResult`, `snapshot()`, `session(key)`, `sessionDetail(key, after, limit)`, `feed(query)`, `forget(key)`, `subscribe(listener)`, `stats()`, `close()` |
| `server/receiver/*` | server-core | `registerReceiver(router, deps)`: well-known, events, errors per HTTP.md §2 |
| `server/sources/outbox.ts` | server-core | `startOutboxSource(store, opts) → { stop }` |
| `server/ui/*` | server-core | `registerUi(router, deps)`: info, snapshot, stream (SSE), session, feed, forget, rotate token, demo toggle; `staticFiles(dir)` fallback; `LabelStore` + `registerLabels` (`labels.ts`: `<stateDir>/labels.json`, GET / PATCH `/api/ui/labels`, `labels` frames, a forgotten session loses its label); `Broadcast` (`stream.ts`: stream messages from elsewhere, the theme routes' `viewState`) |
| `server/cli.ts` | server-core | flags, banner with LAN URL + QR + `sink add` line, `--open`, `--tls`, `tls status/trust/reset`, `--public-url`; `search` / `index` hand off to `server/search/cli.ts`; `--search-home` |
| `server/search/service.ts`, `routes.ts`, `cli.ts`, `filters.ts`, `hints.ts`, `facets.ts`, `resume.ts` | search-service | `createSearch(deps) → SearchService` (reader + live tail, store overlays, the indexer child over IPC, status frames, history switch, reveal; `runSessionSearch` shared with the CLI), `registerSearch(router, svc, guard, isLocal)`, `runSearchCli` / `runIndexCli`; filters → the engine's `allow`, the no-result hint, facets, the quoted resume line |
| `server/search/engine/*` | search-engine | `openReader`, `runIndexer`, `indexerChildMain`, `removeIndex`: segments, merges, the LOCK, BM25F, snippets |
| `server/search/sources/*` | search-sources | `historyAdapters()`, `eventsAdapter()`, `eventsPath()`, `sourceEnv()`: each harness's log format → `SearchDoc` / `SessionFacts`, secrets redacted |
| `server/search/types.ts`, `oracle.ts` | search lead, search-perf | the contracts between the three; the brute-force reference reader |
| `server/setup/tailscale.ts` | onboarding | `tailscale status --json` / `serve status` probe for the "From anywhere" step, cached across the 2 s polls (`fresh` skips the cache); `serveTailscale`: `tailscale serve --bg <port>`, skipped when already served, `TailscaleError` with the CLI's last lines |
| `server/phone/*` | onboarding | `registerPhone(router, deps)`: `/api/ui/phone` (`PhoneInfo`: LAN QR, rp id, public url, the Tailscale probe, trusted keys, pending device requests), `POST /tailscale` (this machine: serve, then the public url), `GET /device/:id` (`PhoneDeviceState`, from control's device requests), `POST /trust-check` (`https` true when the request came over TLS) |
| `server/tls/*` | tls | `ensureCerts(dir, opts) → TlsMaterial`, `createDualListener({http, https})`, `registerTrust(router, deps)`: `/trust`, `/ca.crt` |
| `server/control/*` | control | `registerControl(router, deps)`: pair/hello/poll/ack/off, queues, keys, early verify, test door; `ControlState` the UI reads (`machines()`, `activity()`, `pendingDevices()`, `deviceRequest(id)`); the hello's `mode` (`inherit` too), `start`, `files`, `prompt_files`, `accounts` (email or name) on `MachineControl` and a start's `applied` (`parse.ts`); `tilde` when a start may name `~/…` (`tilde.ts`); the well-known's `control.inherit`; demo mode's machines (`demo`); the second look at a start against that hello (`precheck.ts`); the files a start carries (`files.ts`: `POST /api/ui/control/files`, `GET {control}/files/{sha256}` with the machine's token) |
| `server/conformance/*` | control | runner CLI + vitest that boots `createApp` in-process and runs every delivery fixture |
| `server/demo/*` | demo | `startDemo(store, opts) → { stop }`: realistic synthetic sessions through `store.ingest(…, "demo")`, with sessionpipe 0.10's fields (background work, a scheduled turn, an unattended run on an API account); with `opts.control`, its machines (`machine.ts`): a 0.10 one in `inherit` mode with an ACP agent and a name-only account, and a 0.9 one |
| `server/extensions/*` | platform | `ExtensionKind { kind, noun, manifestFile, dir, validate }`, `scanKind`, `addExtension/linkExtension/removeExtension/formatEntries`: the folder layout, scan and installer every kind shares |
| `server/themes/*` | platform | the view kind (`<stateDir>/themes/<id>/theme.json`): `ThemeRegistry`, `/api/ui/themes`, per-theme state (with an `etag`; `If-Match` → 412 `conflict`; every write a `viewState` frame through `onState`), `/themes/:id/*` static, `view add/link/remove/list` (`theme` alias) |
| `server/plugins/*` | platform | the plugin kind (`<stateDir>/plugins/<id>/plugin.json`): `PluginRegistry`, `PluginHost` (import at boot / reload, `PluginApi`, suggestions), settings at `<stateDir>/plugins-settings/<id>.json` (0600, secrets masked on the wire), `/api/ui/plugins`, `/api/ui/plugins/reload` and `PUT …/:id/settings` (loopback), `plugin add/link/remove/list` |
| `server/skins/*` | platform | the skin kind (`<stateDir>/skins/<id>/skin.json`): `SkinRegistry` (built-ins + packages + `<stateDir>/color-themes/*.json` as one list), `/api/ui/skins`, `/api/ui/skins/reload` (loopback), `/skins/:id/*` static (fonts immutable, json/css no-cache), `skin add/link/remove/list` |
| `web/src/lib/skins.ts`, `theme.ts` | platform | applies a skin to `<html>` (tokens per scheme, `--font-ui`/`--font-mono`, `--radius`, `--hairline`, `data-density`, `@font-face`, the stylesheet); the per-device choice under `sessionpipe-gui.skin` (migrated once from `sessionpipe-gui.colorTheme`) |
| `web/src/themes/host/*` | platform | loads a theme at `/t/:id` and builds its `ThemeApi` (`shared/theme-api.ts`): the snapshot with `labels`, `labels.set/rename/edit`, `menu.open/session/confirm` (the host's own menu and confirm), `storage.update` (If-Match, retried) and `storage.subscribe` (another device's write, from `viewState` frames) |
| `web/src/lib/labels.ts`, `components/LabelDot.tsx` | web | a label's name, `setLabel` / `renameLabel` (through `Store.patchLabels`: shown at once, put back on a refusal), the `Label` submenu every session menu carries (`labelMenu`, in `sessionItems`), the `label:` search value (`labelFromQuery`), the "Edit labels" request; `LabelDot` / `LabelSwatch` draw the one dot (`.label-dot`, `--label-*` tokens) |
| `web/src/plugins/*` | platform | the Plugins section of the Views page: the list from `/api/ui/plugins`, the settings form made from each manifest, Reload; suggestions reach the control strip through `AppState.suggestions` |
| `web/src/phone/*` | phone-web | `/phone`: one page, laptop side and phone side (`state.ts`, pure and tested), three steps from `GET /api/ui/phone` polled every 2 s; the lane it recommends (Tailscale here, else the same Wi-Fi with the local CA), the phone's own passkey request through `control/useDeviceRequest.ts`, the laptop's Approve through `control/PendingDevices.tsx` |
| `web/src/control/NewSession.tsx`, `newSessionState.ts`, `folders.ts`, `Starting.tsx` | control-web | New session: one compose sheet (a 640 px sheet under the title bar, a full-height sheet on a phone) mounted in the shell and opened by `openNewSession(target)` from every entry point (`c`, the compose glyph, the palette, `sessionItems`' "New session here", the Machines page, `?new=1`, `ThemeApi.control.compose`); the context precedence, per-machine remembered choices pruned to what the machine still advertises, and the draft (`sp.newSession.*`, try/catch) in `newSessionState.ts`; the folder list and the segment-prefix "under" rule in `folders.ts`; it signs one `start` with `files`, `permission`, `model` only when the hello advertised them, then opens `/s/<harness>/<uuid>`, which `Starting.tsx` draws from the start's activity until the first hook event (the board shows a starting row, and hides the Codex / Antigravity twin for 30 s) |
| `web/src/control/origin.ts` | control-web | the wrong-origin guard: a page whose origin is not in `Info.control.origins` (or under the rp id on an older server) gets the one line "Sending works from <origin>; open it there." (`words.ts WRONG_ORIGIN`, `insecureHint`, `refusalWords("untrusted_key")`) and is never offered to add a device |
| `web/*` | web | the app; `web/src/mock/` a mock stream so it runs with no server (`?phone=<scene>&side=phone` for the phone page's scenes) |

A module touches only its own paths; a change it needs elsewhere is a request to the
owner (in a PR comment or an issue). `server/app.ts` wires modules by the exact
function names above.

## The store's readings

- COALESCE the session block (spec §3): a later empty field never blanks a full one;
  `title` keeps the better `title_source` (`custom` > `harness` > `first-ask`).
- `turn.progress` is kept only until its `turn.transcript` or the turn's end.
- An attention is open from `attention.needed` until `attention.cleared` **or the
  session's next hook event** (CONTROL.md §7).
- `currentTool` is the orchestrator's last `tool.started` without its `tool.ended` (by `call_id`,
  else by name), cleared by any `turn.ended`.
- State timers: a `working` session with no event for `STALE_AFTER_MS` becomes
  `stale`; anything silent for `DONE_AFTER_MS` becomes `done`. The store re-evaluates
  on a timer and emits `session` messages.
- `session.forgotten` deletes the file and the index entry, then emits `forgotten`.
- Subagent sessions (`parent_id` set) count toward the parent's `children`.
- `agents` (`AgentRun`): the subagents a session ran, read the way Claude Code and Codex
  send them, inside the parent's session. `subagent.started` opens one (its type; its
  description and launch call from the newest Agent / Task call not matched yet, or the
  one whose `output.agentId` names it), `subagent.ended` closes it, and a tool event
  with `agent_id` is that agent's: it moves the agent's `currentTool`, counts and
  `recentTools`, never the orchestrator's `currentTool` or turn. A synchronous Agent
  call's output, or the `<task-notification>` turn Claude Code sends when a background
  agent stops (tier 2+), is its `result`. An open agent keeps its session `working`
  after the launching turn ended; one silent for `STALE_AFTER_MS` reads `stale`; the
  session ending closes them all. A child session (`parent_id`) is merged in by id with
  `session` set and its own state. `counts.agentsRunning` is the open ones;
  `counts.subagents` stays the cumulative count. `DetailQuery.agent` pages one agent's
  events (its `agent_id`, its `subagent.*`, its launch call).
- sessionpipe 0.10: `turn.ended.background` > 0 keeps a session `working` ("waiting on N
  background tasks", `SessionSummary.background`) until its next turn or its end, `stale`
  after STALE_AFTER_MS of silence as any working session; `session.attended` is the latest
  value, absent unknown (`attended`); `turn.started.submitted_by` / `injected` ride on
  `currentTurn`, a repeated `turn.started` for the same `turn_id` changes nothing, and an
  injected turn's prompt never becomes `lastUser` (the row's last ask).
- Labels are not a reading: they are the person's (`server/ui/labels.ts`), kept beside
  the store, never on a `SessionSummary`.

## UI API (all under `/api/ui`, JSON, see `ROUTES` in `shared/api.ts`)

| Method · path | Returns |
|---|---|
| GET `/info` | `Info` (sink token and UI key only to loopback or an authenticated UI) |
| GET `/snapshot` | `Snapshot` |
| GET `/stream` | SSE of `StreamMessage`; `event:` = kind, `data:` = JSON; first frame a snapshot (with plugins' open `suggestions` and the `labels`); a `suggestion` frame when a plugin suggests an answer; a `labels` frame (the whole document, `rev` bumped) on every label change; a `viewState` frame (`id`, `etag`) when a view's state is written; a `: ping` comment every 15 s |
| GET `/sessions/:harness/:id?after=<seq>&limit=<n>&agent=<id>` | `SessionDetail` (full events, read from disk); `agent` keeps one subagent's events |
| GET `/labels` | `Labels`: `{ rev, names, sessions }` |
| PATCH `/labels` | `LabelsPatch` (JSON only, 415 otherwise): a merge, `null` clears → `Labels`; 400 `malformed` / `bad_label` / `bad_name`, 404 `not_found` (a session the store does not know), 413 `too_many` / `too_large` |
| GET `/events?limit&before&harness&machine&type&session&q` | `FeedPage`, newest first |
| POST `/sessions/:harness/:id/forget` | 204; same effect as a `session.forgotten` event |
| POST `/token/rotate` | `{ sinkToken }` (loopback only) |
| POST `/demo` `{ on }` | `{ on }` |
| `/control/*` | phase 2 (control agent + web) |
| GET `/plugins` | `{ plugins: InstalledPlugin[] }`: status, error, `values` with secrets masked (`shared/plugin-api.ts`) |
| POST `/plugins/reload` | loopback: deactivate every plugin, re-read the folder, import afresh → `{ plugins }` |
| PUT `/plugins/:id/settings` | loopback: `{ key: value }` → `{ settings }` (masked); a masked secret sent back is left as stored |
| POST `/plugins/:id/enable`, `/disable` | loopback: start or stop a plugin and remember it (`config.json` `enabled` for a bundled one, `disabled` otherwise) → `{ plugins }` |
| GET `/skins` | `{ skins: InstalledSkin[] }` (`shared/skin-api.ts`): built-ins (`source: "builtin"`), installed and bundled packages (`"skin"`, with `url`; `bundled`, `disabled`), color-theme files (`"color-theme"`); broken ones with `error` |
| POST `/skins/reload` | loopback: re-read the skins and color-themes folders → `{ skins }` |
| `/skins/:id/*` | a package's own files (uiAuth): fonts `immutable`, `.json`/`.css` `no-cache` |
| POST `/themes/:id/disable`, `/enable` | loopback: a bundled (or any) view hidden from the rail and `/t/:id`; remembered in `config.json` `disabled` |
| GET `/phone` | `PhoneInfo`: the LAN url with the UI key as a PNG data URI, the rp id, `publicUrl`, Tailscale (installed, running, MagicDNS `name`, `serving`), the keys the paired machines trust, the device requests waiting |
| POST `/phone/tailscale` | this machine: `tailscale serve --bg <port>` unless `serve status` already names the port, then the public url `https://<name>` the way `/setup/remote` sets it → `PhoneInfo`; 409 / 502 `{ error }` with the CLI's last lines |
| GET `/phone/device/:id` | `PhoneDeviceState` for a device request: `pending` · `trusted` (the `key.add` was delivered; `machine` names who) · `refused` (the machine said no, the approving page rejected it, or no such id) · `expired` |
| POST `/phone/trust-check` | `{ https, rpId }`: `https` true when this very request came over TLS or through the trusted proxy |
| GET `/search/sessions?q&sort&limit&cursor&live&tz&hits` | `SessionSearchPage`: one row per session, filters inside `q`; 400 `bad_limit` (1–100) / `bad_cursor` / `bad_tz`; `q` cut at 1,000 chars; `no-store` |
| GET `/search/transcript/:harness/:id?q&around\|before\|after&limit` | `SearchTranscript` from the index (redacted, no tool output); `hits` = every match for the find bar; 404 `not_found` |
| GET `/search/facets` | `SearchFacets`: agents, machines, repos, labels with counts |
| GET `/search/status` | `SearchIndexStatus` with `local`; `searchIndex` stream frames (at most 1/s, never `local`) |
| POST `/search/reindex` `{ rebuild? }` | this machine, JSON: 202 `SearchIndexStatus`; 403 `local_only`, 415 `json_only` |
| POST `/search/settings` `{ history }` | this machine, JSON: `SearchIndexStatus`; off deletes `<stateDir>/search/history/`; 403 / 400 `malformed` / 415 |
| POST `/search/reveal` `{ harness, id, what }` | this machine, JSON, a session that ran here: 204 after `open -R` / `explorer /select,` / `xdg-open`; 404 `gone` / `not_here`; 403 / 400 / 415 |

## Running

```sh
npm install
npm run dev            # server :7373 (rebuilt on change) + Vite :5173 proxying to it
npm run build && npm start -- --demo
npm test               # vitest: store, receiver, control, conformance in-process
npm run test:e2e       # playwright against a built server with --demo
```

## Conventions

- SPDX header on every source file; Apache-2.0; commits signed off (DCO).
- Biome for format + lint; `npm run typecheck` must pass for both tsconfigs.
- Tests live beside code as `*.test.ts` or under `test/`.
- No telemetry, ever. Nothing in the web bundle calls anywhere but its own origin.
