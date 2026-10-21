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
| Extensions | Three kinds, one installer (`server/extensions`, `sessionpipe-gui <kind> add\|link\|remove\|list`): **views** (themes: an ES module + `theme.json`, loaded by the page with `ThemeApi`, `docs/theme-authoring.md`), **plugins** (an ES module + `plugin.json`, imported into the receiver process with `PluginApi`, `shared/plugin-api.ts`, `docs/plugin-authoring.md`), **skins** (`skin.json`: colour tokens per scheme, bundled fonts, typography, shape, an optional stylesheet; no code; `shared/skin-api.ts`, `docs/skin-authoring.md`; the old color-theme JSON files are listed as token-only skins). The official ones live in `sessionpipe-gui-themes`; six skins are built in (`shared/skins-builtin.ts`), Spacesheep the default; every official extension ships **bundled** in `dist/bundled/{views,skins,plugins}/` (copied from the themes repo at build time, or from the tracked `bundled/` copy; listed after the person's own installs so an install of the same id overrides, disabled rather than removed); a bundled plugin stays off until `config.json` `enabled` names it | Everything optional stays out of the main GUI and can be installed, linked for development, or removed. A plugin may notify and *suggest* an answer to a permission; it never signs one: the receiver holds no key. A skin is the kind that needs no trust |
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
| `server/ui/*` | server-core | `registerUi(router, deps)`: info, snapshot, stream (SSE), session, feed, forget, rotate token, demo toggle; `staticFiles(dir)` fallback |
| `server/cli.ts` | server-core | flags, banner with LAN URL + QR + `sink add` line, `--open`, `--tls`, `tls status/trust/reset`, `--public-url` |
| `server/setup/tailscale.ts` | onboarding | `tailscale status --json` / `serve status` probe for the "From anywhere" step, cached across the 2 s polls (`fresh` skips the cache); `serveTailscale`: `tailscale serve --bg <port>`, skipped when already served, `TailscaleError` with the CLI's last lines |
| `server/phone/*` | onboarding | `registerPhone(router, deps)`: `/api/ui/phone` (`PhoneInfo`: LAN QR, rp id, public url, the Tailscale probe, trusted keys, pending device requests), `POST /tailscale` (this machine: serve, then the public url), `GET /device/:id` (`PhoneDeviceState`, from control's device requests), `POST /trust-check` (`https` true when the request came over TLS) |
| `server/tls/*` | tls | `ensureCerts(dir, opts) → TlsMaterial`, `createDualListener({http, https})`, `registerTrust(router, deps)`: `/trust`, `/ca.crt` |
| `server/control/*` | control | `registerControl(router, deps)`: pair/hello/poll/ack/off, queues, keys, early verify, test door; `ControlState` the UI reads (`machines()`, `activity()`, `pendingDevices()`, `deviceRequest(id)`) |
| `server/conformance/*` | control | runner CLI + vitest that boots `createApp` in-process and runs every delivery fixture |
| `server/demo/*` | demo | `startDemo(store, opts) → { stop }`: realistic synthetic sessions through `store.ingest(…, "demo")` |
| `server/extensions/*` | platform | `ExtensionKind { kind, noun, manifestFile, dir, validate }`, `scanKind`, `addExtension/linkExtension/removeExtension/formatEntries`: the folder layout, scan and installer every kind shares |
| `server/themes/*` | platform | the view kind (`<stateDir>/themes/<id>/theme.json`): `ThemeRegistry`, `/api/ui/themes`, per-theme state, `/themes/:id/*` static, `view add/link/remove/list` (`theme` alias) |
| `server/plugins/*` | platform | the plugin kind (`<stateDir>/plugins/<id>/plugin.json`): `PluginRegistry`, `PluginHost` (import at boot / reload, `PluginApi`, suggestions), settings at `<stateDir>/plugins-settings/<id>.json` (0600, secrets masked on the wire), `/api/ui/plugins`, `/api/ui/plugins/reload` and `PUT …/:id/settings` (loopback), `plugin add/link/remove/list` |
| `server/skins/*` | platform | the skin kind (`<stateDir>/skins/<id>/skin.json`): `SkinRegistry` (built-ins + packages + `<stateDir>/color-themes/*.json` as one list), `/api/ui/skins`, `/api/ui/skins/reload` (loopback), `/skins/:id/*` static (fonts immutable, json/css no-cache), `skin add/link/remove/list` |
| `web/src/lib/skins.ts`, `theme.ts` | platform | applies a skin to `<html>` (tokens per scheme, `--font-ui`/`--font-mono`, `--radius`, `--hairline`, `data-density`, `@font-face`, the stylesheet); the per-device choice under `sessionpipe-gui.skin` (migrated once from `sessionpipe-gui.colorTheme`) |
| `web/src/themes/host/*` | platform | loads a theme at `/t/:id` and builds its `ThemeApi` (`shared/theme-api.ts`) |
| `web/src/plugins/*` | platform | the Plugins section of the Views page: the list from `/api/ui/plugins`, the settings form made from each manifest, Reload; suggestions reach the control strip through `AppState.suggestions` |
| `web/src/phone/*` | phone-web | `/phone`: one page, laptop side and phone side (`state.ts`, pure and tested), three steps from `GET /api/ui/phone` polled every 2 s; the lane it recommends (Tailscale here, else the same Wi-Fi with the local CA), the phone's own passkey request through `control/useDeviceRequest.ts`, the laptop's Approve through `control/PendingDevices.tsx` |
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
- `currentTool` is the last `tool.started` without its `tool.ended` (by `call_id`,
  else by name), cleared by any `turn.ended`.
- State timers: a `working` session with no event for `STALE_AFTER_MS` becomes
  `stale`; anything silent for `DONE_AFTER_MS` becomes `done`. The store re-evaluates
  on a timer and emits `session` messages.
- `session.forgotten` deletes the file and the index entry, then emits `forgotten`.
- Subagent sessions (`parent_id` set) count toward the parent's `children`.

## UI API (all under `/api/ui`, JSON, see `ROUTES` in `shared/api.ts`)

| Method · path | Returns |
|---|---|
| GET `/info` | `Info` (sink token and UI key only to loopback or an authenticated UI) |
| GET `/snapshot` | `Snapshot` |
| GET `/stream` | SSE of `StreamMessage`; `event:` = kind, `data:` = JSON; first frame a snapshot (with plugins' open `suggestions`); a `suggestion` frame when a plugin suggests an answer; a `: ping` comment every 15 s |
| GET `/sessions/:harness/:id?after=<seq>&limit=<n>` | `SessionDetail` (full events, read from disk) |
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
