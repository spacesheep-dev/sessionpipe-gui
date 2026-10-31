# Changelog

All notable changes to `sessionpipe-gui`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (`0.x`: anything may change between minors).

## [Unreleased]

### Fixed

- A self-assigned 169.254 address (no DHCP answered on that link) no longer comes first among
  the receiver's LAN addresses, so the Machines page's pair command, Connect and the phone
  link name an address the other device can reach.

## [0.7.0] - 2026-10-31

### Added

- **The phone's first run.** With no computer connected yet, the iPhone and Android
  apps open on the lockup and three ways in: scan the code under Connect on your
  computer (a full-screen viewfinder; the camera is asked for only then), enter its
  address, or try the demo. A code the app can't use, a refused camera, a computer out
  of reach and the TLS code's trust page (open it in Safari, come back, Connect) each
  get one plain screen. Once the board is up, one sheet says the step left: the
  computer approves this iPhone once, where that is in the computer's own labels, "Ask
  <computer> to approve" (which files the request) and Later.
- **Files beside a session.** A Files button on the session's bar (and the panel's head,
  `⇧F`, the "⋯" menu) opens a drawer of every file the session read or changed, from the
  events it already sent: the receiver's index of the whole session
  (`GET /api/ui/sessions/:harness/:id/files`, the same reading the Review page makes) and
  the live events since; nothing is asked of the machine. The list is the repo's tree, by
  folder, each file with what happened to it and when; a filter narrows it; a file can be
  marked viewed.
- **A file's changes, its text, and every version.** A file opens on its **Changes**: the
  lines taken out and put in against the text the agent last read, the rest folded past
  three lines of context and opened in place; **Text** is the whole file as it stands,
  rebuilt from its last Read or Write with the Edits after it applied in order and the
  lines they wrote marked (hover one for the edit that wrote it). Every Read or Write the
  agent made is a version, one step away. Edits the text cannot hold (a patch, a page of a
  big file, a notebook cell) read as hunks. The page's `?file=<path>` opens the drawer on
  one file; "Copy link to this file" writes it.
- **Comment on a line to ask for a change.** Click a line number (shift-click, or ⇧↓, for
  a range) and say what should change, or **suggest a replacement** for the lines; a
  comment can be on the whole file. The comments gather at the drawer's foot and go to the
  session as one review message (`path:line`, the lines quoted in a fence tagged by the
  file's language, "Replace with:" for a suggestion, a per-item reply asked for), the same
  signed `prompt` the composer sends, or into the composer to finish by hand. While the
  agent is mid-turn the button says the review is read when the turn ends. Afterwards the
  list says which files changed since your review.
- **Problems.** The drawer's second tab lists every tool that failed and every error the
  session raised, each a jump to its row in the timeline.
- **Open in editor.** Where the session runs on this machine, a file opens in VS Code,
  Cursor, Zed or Windsurf (the drawer's "⋯" chooses), at the commented line.
- **The drawer from the keyboard.** `⇧F` opens it with focus in the filter; ↓ ↑ (j k) move
  over the files and the lines, Enter opens a file or the comment on a line, n and p go to
  the next and previous change, Esc steps back (the comment, the file, the drawer) wherever
  focus is. Focus follows each step and returns where it was on close; over the timeline
  (the panel, a narrow page) what is under the drawer is inert meanwhile; a status line
  says what happened for a screen reader; forced colours draw the changes as borders.
- **Go to file from ⌘K.** `/` then a path finds any file changed in the last thirty days,
  across every session and machine (the Review page's reading); a query that reads as a
  path brings the files in beside the sessions. Enter opens the newest session that touched
  it, on that file; a file several sessions touched asks which (›); ⇧↵ opens it beside.
  On a session's page, "Files of this session" toggles its drawer.

### Changed

- The phone's Settings › App no longer shows the Mac's rows (the Dock badge, keeping
  the app running with the window closed) or names System Settings; the device key's
  rows and the device request say "this iPhone" / "this phone".

### Fixed

- The phone app at tablet width (an iPad): the rail's head and the page bar start under
  the status bar, and the compose glyph no longer pushes the mark off the rail's edge.

## [0.6.2] - 2026-10-30

### Added

- **Pull down to refresh** on the phone's list pages (Board, Inbox, Search, Feed, Review,
  Machines), as a native list does: a ring draws in the tint as you pull, a tick as it
  arms, and the stream reopens for a fresh snapshot. While the stream is down the same
  pull is the retry.
- **The phone's tint.** The sessionpipe orange on the selected tab, the back chevron, a
  sheet's Cancel and Start, a switch that is on, the text-size slider, the caret and
  links. Needs you keeps its own orange; everything else stays graphite. Skins may set
  `--tint` and `--tint-fg`.
- **The phone app feels native.** Taps and outcomes play the phone's haptics; the status
  and navigation bars follow a forced Light or Dark (or a one-scheme skin); the edge swipe
  goes back on iPhone and the back button goes back on Android instead of closing the
  app; the session's message bar rises above the keyboard on iPhone.
- **Push and pop.** Opening a session from a list slides it in as a native push and Back
  slides it out, the tab bar staying put; the back button names the page it returns to.

### Changed

- The phone's tab bar and bars are translucent material, as iOS's are, with the page
  blurring under them (solid under Reduce Transparency).
- Rows highlight under the finger and release as native cells do; an empty Inbox or Feed
  centres on the screen.
- **The phone names the device it runs on:** "Approve this iPhone", "Face ID signs what
  you send" (on Android "this phone" and "your fingerprint") everywhere it said "this
  Mac" and "Touch ID".
- On the phone an Inbox row, and anything that opens a session "beside", opens the
  session's own page, pushed with Inbox behind Back, instead of the desktop's panel as a
  sheet; the panel is never restored on the phone at launch.
- A dropped stream on the phone is said under the large title ("Reconnecting · 3 s ·
  Retry") instead of a pill over it; the pill stays only on pages without one.
- With a permission pending on a machine the phone isn't paired with, the session's dock is
  the Allow and Deny card alone with one hint, and a command moves to the next line whole
  with its question mark.
- In the phone app the Inbox's notification banner and bell read the app's own permission
  ("Notifications are off · Turn on", or "Open Settings" once refused), and the empty
  Inbox no longer talks about "this page" or "your phone".

### Fixed

- Notification banners on the phone fit the screen on every title length and sit under
  the status bar; a long one ends in an ellipsis instead of running off the edge.
- **Every scrollbar on a desktop is the app's own**: a thin grey thumb on no track, the
  window's and the popovers' included (the Mac app showed the OS's), and the Display
  popover can no longer scroll sideways.
- **The Add account sheet is New session's dialog**: 640 px under the title bar over a
  scrim that dims the whole window, Cancel and Sign in in its footer (in the top bar on a
  phone), the command and the sign-in as grouped rows. It had taken the Usage page's
  reading measure and left the sidebar undimmed.
- **"Sign in to Claude…" on a machine whose pool is off turns the pool on first**, then
  opens the sign-in, and says so, instead of being refused with "the pool is off on that
  machine".

## [0.6.1] - 2026-10-30

### Added

- **The Mac app updates itself.** Settings › App › Updates has "Check for updates
  automatically" (on by default: 10 s after launch and every 6 hours), the version you have,
  "Last checked 5 min ago" and Check now. A newer release is downloaded in the background
  and verified against sessionpipe's key; then "0.7.0 is ready" with **Install and relaunch**
  in Settings and the menu bar item. "Check for Updates…" in the app menu runs the same check
  and, with no window open, answers in a dialog: up to date, ready to install, or why it
  failed. A failed check says so in plain words (offline, no manifest, no build for this
  computer, a signature that doesn't match) and leaves nothing half-installed.

### Fixed

- **`service install` upgrades the service it finds instead of refusing.** The app's
  "Start sessionpipe" (and the command) used to stop at "a service is already installed"
  whenever an earlier version had installed the LaunchAgent / systemd unit, which is every
  upgrade of the app. Now a service of ours under the label is rewritten in place with this
  version's node and cli (its port, state dir and options kept unless flags say otherwise),
  restarted (`launchctl bootout` + `bootstrap`; `systemctl --user daemon-reload` + `restart`),
  and waited for until the new version answers: `updated dev.spacesheep.sessionpipe-gui: 0.4.1
  → 0.6.0`. The same service answering already is `already running 0.6.0 on …` (exit 0); one
  still starting is left to it. A plist under our label that runs something else is still
  refused, as is another program on the port. `--dry-run` shows the rewrite and the restart.
- **A big board gets time to start.** The installer waited 10 s for the receiver and then
  printed what read as a failure, while a 1 GB state dir takes ~30 s to index at boot. It now
  waits up to 90 s (`SP_SERVICE_WAIT_MS`), says what it is waiting on ("starting on :7373…
  283 sessions to load; a big board takes a minute"), and a service that is running but not
  answering yet ends with "still starting", exit 0. The desktop app shows those lines on the
  welcome ("Updating sessionpipe 0.4.1 → 0.6.0…", "Starting… this can take a minute on a big
  board") and waits as long itself.
- `service uninstall` no longer says "still loaded" on the first call: `launchctl bootout`
  returns before the job is gone, and the command now waits for it (as the upgrade's
  restart does before it bootstraps again).
- `service status` prints the running receiver's version beside the pid.
- The Windows installers build again: `icons/icon.ico` is in the bundle's icon list, where the MSI
  bundler looks for it.

## [0.6.0] - 2026-10-29

### Added

- A session another session launched (`session.launched_by`, sessionpipe 0.10.0) says so in its
  header with a link to the launcher, and the launcher's header links what it launched. Neither is
  read as a subagent: no nesting, no muted toasts, no "N subagents" count.
- **A paired machine you rely on that went offline** gets one quiet line at the top of the
  board: "build-box is offline, last heard 14:02. 2 messages wait until it's back.", with
  Machines beside it. Only a paired machine with a message waiting or a session that needs
  you, works or went stale counts; one that only sends events has no heartbeat and is never
  called offline. × hides the line on this device until something changes: it clears
  itself when the machine is back, and a new drop brings it back.
- **Since you looked.** An idle or done session with news you haven't seen (a turn ended
  or the session ended since you last had it open) draws its glyph filled in, in ink, and
  the folded Done header says "3 unread". Opening it for a second, as a page or the
  panel's tab, marks it read on every device. A turn you typed at the terminal of a
  session you attend is not news; working, needs-you and unattended rows are never
  unread, and nothing from before the first run is.
- **Mark as read / Mark as unread** in an idle or done session's menu and the phone's
  long-press sheet, `u` on the board's cursor, and **Mark all as read** in the board's
  view menu. The marks live in `<stateDir>/marks.json` (`GET` / `PATCH /api/ui/marks`, a
  `marks` frame on every change); a forgotten session loses its marks.
- **Notify me, per session.** Every session's menu (and the phone's long-press sheet) has
  **Notify me**: When it needs me, as before; **When it needs me or finishes**, which
  also sends "Deploy billing finished" with its last answer each time it has news and is
  idle or done (a click opens it); or **Never**, which sends no notification, banner or
  sound for it while it still waits in Needs you and the Inbox. A row set to Never shows a
  small bell with a slash. A parent session can quiet its subagent sessions, never make
  them louder. The choice is kept in `marks.json` (`notify`), so it holds on every device;
  the browser's permission, the global Notify me and sounds stay per device.
- **A New line where you left off.** A session with news since you looked opens with a
  quiet "New" hairline above the first answer you haven't read, in Simple and Advanced
  and on a phone. When there's more than a screen of it, the session opens with the line
  a third of the way down instead of at the bottom. Your own turns at the terminal never
  count, the line doesn't move while the page is open, and it's gone when you come back.
  A session you haven't opened yet opens at the bottom as before.
- **Hidden sessions can be found again.** The board keeps what this device hid in a
  **Hidden** group after Done, folded like Done and under the same filters; its rows are
  ordinary rows, and **Unhide** (the row's menu, `e`, a phone's trailing swipe) puts one
  back in its state's group.
- **Hide until it needs you**, below Hide in a row's menu (or `⇧E`), for a session that
  loops ("every 30 minutes, check the nightly build"): new turns leave it hidden, and it
  shows only while it needs you. `e` hides or unhides the row under the cursor.
- **How much each account has left.** A Usage page, a line per account in the sidebar, and
  each agent in New session say how much of its 5-hour and weekly windows is left and when
  they reset, from sessionpipe's `limits.observed`. Claude Code's week is "This week, all
  models"; a per-model week it adds later shows as its own row ("This week, Fable only").
  A window past its reset says so instead of its last number, and a report older than 15
  minutes says how old. On a machine whose agent has two accounts there is no number, since
  a start can't choose one. Claude Code's numbers need its status line, on Pro and Max:
  `sessionpipe install --status-line`. Harnesses with no source say so in one line, never
  0%. `g u` opens the page; the sidebar lines can be hidden in Settings › General.
- **Several Claude accounts on one machine.** A machine whose sessionpipe pools accounts
  (`sessionpipe pool`, 0.11) says so in its hello, and the GUI reads the pool: the accounts
  in the machine's order, which one is in use, which is used up and when it is back, which
  needs signing in again, and each one's freshest numbers on the Usage page even while it is
  idle. Turning the pool on or off, reordering, enabling, disabling, removing and refreshing
  an account, and signing a new one in, are signed `pool` commands through the same channel
  as everything else, verified here before they are carried; a machine whose hello has no
  pool is told so before anything is queued. A session the pool moved to another account
  says which one serves it and since when, and its chat shows the switch. Demo mode has a
  machine with the pool on, one with an account in error, and one with the pool off.
- **Agents that use agents.** sessionpipe's next release lets a session ask another agent
  on its machine (`sessionpipe ask codex "…"`) and lets a receiver hand a task to an agent
  with the answer brought back into a session (`reply_to` on a signed `prompt` or
  `start`). The GUI reads the two events, `delegation.started` and `delegation.ended`, into
  the session (`delegations`, `delegatedBy`, `counts.delegationsRunning`), keeps a session
  working while an ask is open, and shows a capability only where a machine's hello says
  `ask` or `handoff`, so a 0.10 daemon keeps working as before.
- **Ask another agent…** on a session's page (the control strip, its menus, a reply's
  right-click "about this…", ⌘K, ⇧A): one sheet, prefilled with the last reply, that asks
  an existing session on the same machine or a new one of a harness the hello lists, with
  "Bring the answer back into this session" where the machine takes handoffs. The asking
  session shows the row at once.
- **Lineage.** "Asked Codex · new session · running 1 m 20 s" where the ask happened in the
  chat and the timeline, the answer folded under it or drawn as that agent's turn when it
  was brought back; the asked session's bar says "for <parent>" with a link; the board nests
  it under its parent; Machines says "Agents here can ask each other"; the Feed and the
  Activity page word the events and the handoff.
- **Workflows** (`/workflows`, `g w`): chain and fan out steps across your agents and
  machines (implement → review → fix; two agents in parallel, a third compares). Three
  templates, an editor of native rows that saves itself, Run with the input it names, and
  a run view with every step's state, elapsed, reply and session. The server owns a run
  (`workflows.json`, `workflow-runs.json`, moved by control's acks); the browser is only
  the signer, from any device that can sign, with claims as the guard across tabs. A
  browser signs the runs it started on its own; one started elsewhere asks once ("Sign
  here"), so nothing on the loopback or another site can set your passkey to work. The
  signed command goes back through the run itself, queued only once the server has seen
  the step is still that tab's: a step cancelled or re-offered mid-signature queues
  nothing, and one the receiver refuses fails in place instead of being offered again
  every minute. A step is never signed without the level or model it names when the
  machine's hello does not offer it; the run says so. Every write to `/api/ui/workflows`
  is JSON only, an empty POST too, and refuses a cross-site request.
- **Demo mode** plays an ask and a handoff on lab-mac, whose hello now says `ask` and
  `handoff`; the mock stream has the same.

### Changed

- **A chained shell command reads one step per line** on a session's permission strip:
  "Allow Bash to run:", then `npm run build`, `&& npm test -- bm25`, `&& npm run deploy …`
  each on its own line, so nothing wraps mid-token before you answer. Quotes, `$( … )` and
  groups stay whole, a pipeline is one step, and a short command stays on the question's
  line. The command is the call's own, whole, when the session sent it; otherwise the
  first 200 characters the machine sends, ending in "…". Four steps show, then "Show 2
  more lines", and Deny and Allow keep to the question's line. On a phone a longer one
  scrolls inside, cut through a line, so you see there is more.
- **A plan review reads as a plan.** When Claude Code asks to leave plan mode, the strip
  asks "Ready to start on this plan?" and shows the plan under it (at tier 3), eight lines
  until **Show the whole plan**, with **Approve plan** and **Keep planning** where Allow and
  Deny were; `a` and `d` are unchanged. Keep planning carries what you type in the composer
  ("What should change?") to the agent as the answer's note, and Enter there sends it.
  While the composer holds a note, Approve plan waits, so the note is never dropped: send
  it with Keep planning, or clear it. The row menus, the command palette and the Inbox
  name the same two answers, and the tool reads Plan.

### Fixed

- **The row menu says "Allow Shell"** (and Deny), as the strip and the Inbox do, not
  "Allow run_shell_command".

## [0.5.0] - 2026-10-28

### Added

- **sessionpipe for Android** (`apps/mobile`, formerly `apps/ios`): the iPhone app's
  Tauri shell now also builds for Android, with the same bundled UI. It connects to your
  computer by its address or phone link (asking first, in the system dialog), shows the
  board and sessions live, follows the system's dark mode, and draws edge to edge clear of
  the status and gesture bars. Sending from a phone comes in a later version, on both.
- **A phone's welcome** offers your computer and the demo; a phone runs no sessionpipe of
  its own, so the "This Mac" row is gone there.
- **Phone releases.** *Android release* builds the Android app for a tag (arm64, armv7,
  x86_64; about 11 MB on arm64), signs it with the upload key and checks the signer,
  attaches the `.apk` to the draft release and uploads the `.aab` to a Google Play track. A
  *Mobile* check builds both phone apps on every PR that touches them. RELEASING.md has the
  steps.

### Changed

- **iOS → TestFlight, end to end.** The build runs on Xcode 26 (App Store Connect refuses
  builds from older SDKs since April 2026), checks the `.ipa` before uploading it (ids,
  numbers, SDK, signer, profile, privacy manifest), uploads to the app by its Apple ID with
  the App Store Connect API key, and passes only once App Store Connect has processed the
  build, with the TestFlight link in the summary. Without a tag it is a dry run of the
  branch. The app carries a privacy manifest (no tracking, no data collected).
- The phone apps are called **sessionpipe** (they were "sessionpipe Dev").

### Fixed

- **TestFlight builds** set `CFBundleVersion` to the run number alone. Appending it to the
  version (`0.4.1.12`) gave App Store Connect four numbers, and it takes at most three.

## [0.4.1] - 2026-10-27

### Fixed

- **Approving the Mac app says how.** Its page names the two ways: open Machines in the
  browser that holds your passkey (a link opens it), or run `sessionpipe control pair` on
  the machine and approve it in the app with Touch ID. "Sign with Touch ID" is now
  **Approve this Mac**, and a composer on a machine that doesn't trust this Mac yet says
  what approving does.
- **A passkey prompt that never shows** no longer leaves Approve spinning in the browser:
  after eight seconds the row says where the passkey may be and what else to try.
- **Setup in the app.** Step 2 no longer asks for passkeys on the app's page (Touch ID
  signs there; the https address is the phone's), so the sidebar's Setup dot can clear.
  Step 3 is done only once the paired machine trusts this Mac, with Approve this Mac until
  then.

## [0.4.0] - 2026-10-27

### Added

- **sessionpipe 0.10.0.** A machine in `inherit` mode (no permission flag: its agents run
  as your own sessions there do, whatever their settings allow) shows as that, with one
  line saying what it means, on Machines, the pairing page and the New session picker,
  never as safe or auto; the well-known says `control.inherit: true`, so a 0.10.0 machine
  may pair or switch to inherit with this receiver. New session there defaults to "As your
  own sessions on this machine", which is sent as no level at all, and offers Read only
  and Safe; nothing wider is offered or queued there, and `inherit` is never signed. An
  ack's `applied: inherit` reads "As your own sessions".
- **A session waiting on its own background work** (`turn.ended.background`) stays
  working, "waiting on 2 background tasks", until it wakes, instead of going idle.
- **Unattended runs** (`session.attended: false`): a short one is drawn quiet on the board
  ("unattended"), and no unattended run raises a banner or a notification; absent is
  unknown and changes nothing.
- **Who submitted a turn** (`turn.started.submitted_by`): a scheduled, loop or system turn
  says so under its prompt and on its row while it runs; an injected turn (a task
  notification) never becomes the row's last ask.
- **Accounts named by host** (an API home, `api.z.ai`): kept from the hello's `accounts`
  without an email and listed on Machines.
- **ACP agents**: labels and monograms for the ACP registry's harness names, Machines lists
  what a daemon can start, New session offers them with no permission or model pickers,
  and a start delivered over `api` says "Ran on …" with its reply.
- **Demo mode pairs two machines**: studio-mac on 0.10.0 in inherit mode (goose among its
  agents, an api.z.ai account, a start it ran over ACP) and build-box on 0.9.0, and plays
  background work, a scheduled turn and a short unattended run.

### Changed

- The hello's `home` is gone (0.10.0 sends none). A start's folder may be `~/…` where the
  machine's hello has `start` and this receiver's sessionpipe-core takes one (feature
  detected, `server/control/tilde.ts`); otherwise folders stay absolute, from the
  machine's `folders`.
- The receiver's second look at a command follows 0.10.0: the closed field set per kind,
  files on a prompt only for a machine that says `prompt_files`, and a level at most Safe
  on an inherit machine. A hello keeps up to 64 harnesses.
- **The Mac app sends.** The macOS release carries its Touch ID signer: a key in the
  Mac's Secure Enclave signs new sessions, prompts and permission answers, from the window
  and from a notification's Allow, Deny and Reply. Set it up once with **Sign with Touch
  ID** (on Machines, a session's composer or Settings › App › Signing): a browser or phone
  the machine already trusts approves the Mac with its passkey, and then one Touch ID a
  day unlocks sending. It needs a receiver whose sessionpipe-core verifies device keys and
  a machine that takes them (sessionpipe 0.10). The release needs no new entitlement.

- Where the app can't send, it says exactly why, with the next step: this build has no
  signer (Linux, Windows, a dev build), the receiver can't check the Mac's key yet (update
  sessionpipe-gui), the machine predates device keys (update sessionpipe there), or the
  Mac isn't set up for that machine yet (Sign with Touch ID). Notifications offer Allow,
  Deny and Reply only once the Mac holds a key for that receiver.

## [0.3.2] - 2026-10-27

### Fixed

- **The desktop app opens on the receiver it finds.** 0.3.1 found a receiver already
  running on this Mac and selected it, but kept the window it had opened with none, so the
  board stayed on its first frame for good. Selecting a receiver now rebuilds any window
  that doesn't show it; the same fix covers the welcome's Start sessionpipe and Connect.
- The board and the inbox never sit on loading rows without saying why: after a few
  seconds they say they're still connecting, or that the connection is down, with Retry
  now. A stream that opens but never sends its first update is opened again.
- The desktop app gives up on a receiver that accepts the connection and never answers
  (20 s), and writes dropped streams and failed requests to its log (no keys, no queries).

## [0.3.1] - 2026-10-27

### Fixed

- **The desktop app finds a receiver already running on this machine.** On a first launch
  it went straight to the welcome, even with a receiver on :7373; it now looks (the
  default port, then the receiver's `run.json`) and opens on it.
- **The welcome's Start sessionpipe works.** It asked npm for `sessionpipe-gui@<version>`,
  which isn't published, and failed with E404; it now runs the same version from the
  GitHub release tarball.
- When the board's filter finds nothing, it says what it looked at and offers to search
  every session for the words.

## [0.3.0] - 2026-10-26

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

- **Desktop apps.** A macOS app (universal, signed and notarized, about 4 MB) and Linux
  builds (AppImage, .deb) around the same UI, made with Tauri 2: it connects to the receiver
  on this machine, keeps a menu bar item and a Dock badge for what needs you, notifies,
  launches at login if asked and updates itself from GitHub Releases. It does not sign yet:
  sending from the app waits on device keys in sessionpipe, and until then it says to send
  from a browser. `sessionpipe-gui service install|uninstall|status` keeps a receiver
  running. Release buttons in GitHub Actions build, sign, notarize and publish it
  (RELEASING.md). An iOS build runs in the simulator and is not released.

### Changed

- **The sessionpipe brand.** The default skin is now **sessionpipe**: ink, graphite and
  paper neutrals, the brand's orange (#FF5A1F) as the one accent for *needs you* (the dot,
  the glyph, the Inbox badge, toasts, the canvas through the host tokens), a crimson for
  errors that never reads as the orange, an orange focus ring. Paper is re-tuned to the
  brand's warm paper. A device on Spacesheep moves to sessionpipe silently; the token names
  are unchanged, so views and installed skins keep working. Text is set in Geist and code in
  Geist Mono, self-hosted (36 KB for a page, the text face preloaded, metric-matched
  stand-ins so the swap moves no line). The sessionpipe mark and lockup replace the old
  tile: the sidebar, the rail, Settings › About, the favicon (SVG and ICO), the
  installed-app icons (maskable too), the touch icon, the link preview, the trust and 401
  pages, and the README's wordmark ([docs/brand.md](docs/brand.md)).
- **The board holds still under the pointer**: within a section rows keep their place
  while the pointer rests on the list (it re-sorted nine times in 20 s before), and rows
  that do move slide (FLIP). Layout shift on load 0.127 → 0.0005; exit motion is 140 ms
  everywhere, with one highlight at a time.
- **Lighter start**: routes and dialogs load when first used, so the entry bundle is
  140 KB gz instead of 232.
- **Type**: three weights, tabular numerals for counts and times, balanced headings, and
  each Linux desktop's own face before DejaVu or Cantarell.
- **The phone**: a two-line needs-you banner, one top-bar layout, swipe actions on rows.
- Tool names read as words ("github · search_issues"); the canvas view is the polished
  one from sessionpipe-gui-themes 0.3.0.
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

[Unreleased]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/spacesheep-dev/sessionpipe-gui/releases/tag/v0.1.0
