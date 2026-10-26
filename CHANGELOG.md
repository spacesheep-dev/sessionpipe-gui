# Changelog

All notable changes to `sessionpipe-gui`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (`0.x`: anything may change between minors).

## [Unreleased]

### Added

- **New session.** One compose sheet, from anywhere: `c`, the compose glyph beside the
  sidebar's name (top right of Board and Inbox on a phone), the palette ("New session…",
  "New session on studio-mac…", "New session in acme/web"), right-click a session for
  *New session here*, a machine for *New session on …*, a folder on Machines for *New
  session in this folder*, the empty board's "Start a session on …", and
  `?new=1&machine=&harness=&cwd=`. Machine, agent and folder (recent folders under one the
  machine allows, then the allowed ones, then a typed path, checked by whole path
  segments), the message and files; Permission and Model only when the machine's
  sessionpipe advertises them (0.10), one muted line when it does not. A machine that
  cannot take a start from this page stays in the list with its reason; an offline one can
  be chosen and queues. The draft is kept per device until it is sent or discarded.
- **The started session opens live.** Start goes straight to the new session's page,
  which shows the message, then "Sent to", "Starting on", the reply as it grows, and turns
  into the ordinary live session at its first event; what the machine ran it with
  ("Accept edits · sonnet") sits in the bar. A refusal says why in place, with *Edit and
  start again*. The board shows the start as a row at once.
- **Files on a new session** (CONTROL.md §3.1, HTTP.md §3): `POST /api/ui/control/files`
  holds a file under its SHA-256 and `GET {control}/files/{sha256}` serves it to a paired
  machine's token; the well-known says `control.files`. Nothing about a file goes into the
  text the agent reads.
- **The receiver reads sessionpipe 0.10's start options**: the hello's `start`, `home`,
  `files`, `prompt_files`, and an ack's `applied`; it refuses before queueing a start that
  asks for what the machine did not advertise (`permission`, `model`, `file`,
  `bad_fields`).
- `ThemeApi.control.compose(prefill)` opens the sheet from a view.
- **Search.** Every session from one field, as you type: what the receiver holds from
  every machine, and this machine's own agent history read from the harness logs (Claude
  Code with subagents and forks, Codex `.jsonl` and `.jsonl.zst`, Antigravity, Gemini
  CLI), even sessions from before sessionpipe. Prompts, replies and one line per tool call
  are indexed; tool output, thinking and anything the harness redacts are not. Our own
  index in TypeScript, no new dependency: BM25F with recency, phrases, prefixes,
  `-exclusions`, camelCase and path tokens, folded diacritics and CJK; a niced child
  writes it crash-safely and incrementally, and a live tail finds a new line in about
  50 ms. One query language (`"phrase"`, `-word`, `pre*`, `agent:` `machine:` `repo:`
  `since:` `until:` `in:prompt` `label:`) for:
  - the Search page (third in the rail, `⌘⇧F`): results per keystroke grouped by session,
    filter chips that edit the query, Best match or Newest, keys (`⏎`, `⇧⏎`, Space to
    peek, `j`/`k`, `⌘C` copies the resume command) and a right-click menu;
  - `⌘K`, whose *In transcripts* group previews the matched moment;
  - a read-only transcript for a session the receiver never saw (`/s/<harness>/<id>`),
    with a find bar and its resume line;
  - the terminal, with no browser: `sessionpipe-gui search "…" [--agent] [--machine]
    [--repo] [--since] [--newest] [--json]` and `sessionpipe-gui index
    [--rebuild|--status|--verify]`;
  - `/api/ui/search/*`, behind the UI key.

  History indexing is on by default and can be turned off in Settings › Data, which
  deletes that index; `--search-home` points it at another home.

### Changed

- The Machines page's inline start form is gone: the Control row has *New session…*.
- **Cancel the running turn** is `⇧C` now (`c` is New session).
- A dialog's Esc closes an open pop-up inside it first; a pop-up's filter takes focus once
  it is placed (it was missed on a desktop).

## [0.2.1] - 2026-10-24

### Security

- **One request could stop the server.** A path whose percent escape does not decode as
  UTF-8 (`/api/ui/sessions/%E0%A4%A/x`) threw outside the request's error handling and
  ended the process, before any key was checked, so anyone who could reach the port could
  do it. It is now a `400 bad_path` and the server keeps serving. A cookie value that does
  not decode (another app on the same host can set one, since cookies ignore the port) is
  read as it is instead of failing every request from that browser. Upgrade if the GUI
  listens on your network (the default).

## [0.2.0] - 2026-10-23

The native redesign: one window shell, grouped rows, right-click menus everywhere, and
ways to organise the work (colour labels, subagents you can watch, canvas views).

### Added

- **Colour labels.** Right-click any session, then "Label ▸", to give it one of seven
  colours; "Edit labels…" names them. A label is one dot wherever the session appears, the
  board and the feed filter by it (`label:red`), and every device sees the same labels.
- **Subagents you can watch.** A parent row says how many subagents run and opens a tree of
  what each is doing; the session page shows each agent under the turn that started it,
  with its tools and result; an agent opens beside its parent as its own tab.
- **Canvas views.** One click lays the canvas out by machine, harness, repo, state or
  label; *My layout* keeps your own areas and notes, the same on every device.

- **Your phone.** `/phone` (and setup step 4) gets a phone onto the board and sending from
  it in three steps, on the laptop and on the phone itself: the Wi-Fi QR; one recommended
  way to an https address the phone trusts (Tailscale in one click when it runs here, else
  the same Wi-Fi with the local CA, the iPhone and Android steps and a Check from the
  phone), the rest under "Other ways"; then "Send from this phone", six digits, one Approve
  on the laptop, no reload anywhere. A page on the wrong address (http://localhost while
  passkeys live at the `.local` name) now says "Sending works from https://…; open it
  there." instead of offering to add a device.
- **From anywhere.** `--public-url https://<name>` puts the GUI behind a trusted https
  reverse proxy on the same machine; the setup page's optional sixth step finds Tailscale,
  shows the `tailscale serve --bg 7373` line and sets the url in one click. The url's host
  is the passkeys' rp id, so one name works on the Wi-Fi and away; the proxy's
  `X-Forwarded-*` headers are trusted on loopback connections only, a visitor through it
  needs the UI key like any other device, and the setup actions stay for this machine.
  `Info.remote` carries the `sink add` and `connect` lines for a machine elsewhere;
  `--no-public-url` forgets it.
- **A phone in one read.** `GET /api/ui/phone` gathers what connecting a phone needs: the
  LAN QR, the rp id and the origins it is valid for (`Info.control.origins`, so a browser on
  the wrong address is sent to the right one instead of being asked for a new passkey),
  Tailscale's state, the trusted passkeys and the device requests waiting. One click
  (`POST /api/ui/phone/tailscale`, this machine only) runs `tailscale serve --bg` and sets
  the public url; a phone polls `GET /api/ui/phone/device/:id` while the laptop approves
  its passkey, and proves https works with `POST /api/ui/phone/trust-check`.

### Changed

- **A native app, not a web page.** One window shell (a sidebar and one title band), every
  list a grouped list of plain rows with a single status glyph, no cards; iOS-style large
  titles, sheets and tab bar on a phone. Fewer colours: neutrals, amber for needs-you, red
  for an error.
- **Right-click menus everywhere.** Session rows, tabs, messages, machines, paths and pages
  open a menu of their real actions (Shift+F10 or the context-menu key from the keyboard;
  a long-press opens the same items as an action sheet on touch).
- A delivered message whose turn is already in the chat folds to one line instead of
  repeating the reply; a background copy says "Copy of …" and links back, and the
  original's row links to the copy.

### Removed

- The built-in Plain, Graphite, Ink and Sepia skins and the bundled Spacesheep Vivid and
  Paper Serif: the GUI ships Spacesheep (the default) and Paper. A device that had picked
  one of them gets Spacesheep; installing a skin from elsewhere still works.

### Fixed

- "Claude is waiting for your input" no longer puts a session under "needs you"; it stays
  idle and the inbox does not count it.
- A message sent from the GUI showed beside the wrong turn (the second prompt read "hi")
  when two transcripts arrived together; transcripts now land on the turn their time falls in.
- A session that ended and started again (Claude Code resumed, a compaction restart, a
  harness reopened after a reboot) is live again on the board instead of staying "done".

## [0.1.0] - 2026-10-15

The first public release: a sessionpipe receiver with a face.

### Added

- **Receiver.** The sessionpipe HTTP binding (`/.well-known/sessionpipe`,
  `POST /api/sessionpipe/v1/events`) at every tier up to 3, with a bearer sink token;
  the local outbox tailed with zero configuration; `--demo` synthetic sessions and
  `--replay file.jsonl`. Scores 100 % on the upstream delivery conformance fixtures.
- **Store.** Append-only JSONL per session under `~/.local/state/sessionpipe-gui/`, an
  in-memory index rebuilt at boot, slim previews with the full event read back from disk
  by offset; `--keep-days`; *Forget* and `session.forgotten`.
- **Board, Session, Feed, Machines, Inbox, Review, Connect.** States `needs_you`,
  `working`, `stale`, `idle`, `done`; flags (slow tool, error streak, loop, compactions,
  sequence gap); Simple and Advanced modes; the tier lens; a split panel; the command
  palette; keyboard help and rebinding with vim and emacs presets; notifications, sounds
  and the installed-app badge.
- **Control.** A full control-channel receiver: pairing with six digits and a passkey,
  day keys, message, permission answer, stop, new session, images in the composer,
  `/add-device` for a phone, suggestions from plugins confirmed with a passkey.
- **TLS.** `--tls`: a local CA and certificate for `<machine>.local`, `localhost` and the
  LAN addresses, one port speaking both protocols, a trust page for phones.
- **Setup.** `/setup`: five live-detected steps for a first run.
- **Extensions.** Views (ES modules with `ThemeApi`), skins (tokens, fonts, shape, an
  optional stylesheet) and plugins (server-side, `PluginApi`), installed from a folder,
  archive, npm package or git URL; Canvas and Office bundled from
  `sessionpipe-gui-themes`; six built-in skins with Spacesheep as the default.
- **Extras.** Every official extension ships inside the GUI: Spacesheep Vivid, Paper
  Serif and ping-a-human bundled beside Canvas and Office (`dist/bundled/{views,skins,plugins}`,
  with a tracked copy in `bundled/` that `npm run bundle:sync` refreshes from the themes
  repo). `sessionpipe-gui extras list` is the catalogue with every entry marked bundled;
  bundled skins and plugins are listed after the person's own (an install of the same id
  overrides), cannot be removed, and are turned off with `skin|plugin disable <id>`. A
  bundled plugin is off until enabled: `plugin enable ping-a-human`, or Enable on the
  Views page (`POST /api/ui/plugins/:id/enable|disable`, loopback), remembered in
  `config.json` `enabled`.
- **Harnesses.** Every name in the protocol registry is known (Claude Code, Codex, Gemini
  CLI, Antigravity, Cursor, Copilot CLI, Droid, Kiro, OpenCode), with monochrome marks for
  the first five (Antigravity's official arch, Cursor's cube) and monograms for the rest;
  the setup page lists the harnesses installed on this machine with their hook state
  (`SetupStatus.harnesses`); a loop of identical tool calls is read from tool ends alone
  for a harness with no pre-tool hook (Antigravity); `--demo` plays Antigravity and Cursor
  sessions as ADAPTERS.md maps them.
- **Packaging.** Installs from GitHub while the package is not on npm:
  `npx github:spacesheep-dev/sessionpipe-gui`, `npm i -g github:…`, or a clone with
  `npm install && npm start` (`prepare` builds once, with the bundled extensions from the
  tracked copy); no source maps in the tarball; a plain "needs Node 20 or newer" instead
  of a stack trace on an old Node; a `v*` tag makes a GitHub Release with the tarball
  (npm publishing waits for the `PUBLISH_NPM` variable; RELEASING.md).
- **Phone.** The QR code with the UI key, a responsive layout, a PWA manifest and
  service worker.

[Unreleased]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/spacesheep-dev/sessionpipe-gui/releases/tag/v0.1.0
