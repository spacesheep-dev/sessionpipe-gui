# Changelog

All notable changes to `sessionpipe-gui`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (`0.x`: anything may change between minors).

## [Unreleased]

### Changed

- **A failed send clears.** A message the machine could not take (`unsupported`, `expired`,
  `failed`, `refused`) stays under the composer for five minutes, or until a later send
  gets through, or until its ×; a delivery for two. Dismissals are per device. *Show* lists
  everything the session carried.
- **The composer on a phone.** With the keyboard up the composer follows the visual
  viewport, the tab bar and the context line's explanation step aside, and the field reads
  at 16 px so iOS does not zoom into it. The session header wraps the machine and branch
  under the title instead of squeezing it out; a turn's tool fold is a thumb-sized row.

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

[Unreleased]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/spacesheep-dev/sessionpipe-gui/releases/tag/v0.1.0
