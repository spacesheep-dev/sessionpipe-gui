<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/web/public/brand/wordmark-dark.svg">
    <img src="https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/web/public/brand/wordmark.svg" alt="sessionpipe gui" width="248">
  </picture>
</p>

<p align="center">
  <b>The control room for the agents you already run.</b><br>
  Every coding-agent session on your machines on one live board, and every one you ever ran
  a keystroke away. Answer, steer and start them from your laptop or your phone.<br>
  No account, no cloud, no telemetry.
</p>

<p align="center">
  <a href="https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.6.2/sessionpipe_0.6.2_universal.dmg"><picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/buttons/macos-dark.svg">
    <img src="https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/buttons/macos.svg" alt="Download for macOS: Apple silicon and Intel" width="272" height="56">
  </picture></a>
  &nbsp;
  <a href="https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.6.2/sessionpipe_0.6.2_amd64.deb"><picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/buttons/linux-dark.svg">
    <img src="https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/buttons/linux.svg" alt="Download for Linux: .deb, x86-64" width="272" height="56">
  </picture></a>
</p>

<p align="center">
  <sub>Signed and notarized for macOS 11 or newer · Linux <a href="https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.6.2/sessionpipe_0.6.2_amd64.AppImage">AppImage</a> · <a href="https://github.com/spacesheep-dev/sessionpipe-gui/releases">All releases</a> · or <a href="#install">install with npm</a></sub>
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <a href="package.json"><img alt="Node 20 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen"></a>
  <a href="DCO"><img alt="DCO" src="https://img.shields.io/badge/contributions-DCO-informational"></a>
</p>

![The board, live: sessions grouped by state, the one that needs you first](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/board.gif)

sessionpipe-gui is a [sessionpipe](https://github.com/spacesheep-dev/sessionpipe) receiver
with a face: one Node process on your machine that shows what Claude Code, Codex, Gemini
CLI, Antigravity and the other agents sessionpipe hooks are doing in any terminal, IDE or
machine, and lets you talk back. sessionpipe does the hooks, the privacy filtering and the
signed control; this is the board, the inbox, the chat per session, and search across all
of it.

- **It sees what you already run.** Start agents the way you always do. sessionpipe's hooks
  report every session on this machine and on the others you connect; nothing has to be
  started from here to show up.
- **It finds what they said.** Search covers every session the board holds and this
  machine's own agent history, sessions from before sessionpipe included, in milliseconds,
  with the network down.
- **Steer from any device, signed by you.** Allow a permission from the couch, send the next
  message from your phone, start a session on the build box. Each command is signed by your
  passkey and checked on the machine that runs the agent; the GUI carries commands and
  cannot forge one.
- **Yours, on your machine.** Plain files on your disk, no database, no account, no service
  of ours in between, no Electron. The server makes no outbound request of its own.

## Search

*New in 0.3.0.* Find anything you or your agents said, across every session and every
machine, as you type.

![Search: one row per session, its best moments marked](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/search.png)

**What it searches.** Every session the receiver holds, from every machine, within the tier
each arrived at; and this machine's own agent history, read straight from the harness logs:
Claude Code (every `~/.claude*` home, subagents and forks included), Codex (`.jsonl` and
`.jsonl.zst` rollouts), Antigravity and Gemini CLI. So it finds sessions from before
sessionpipe was installed, and a session seen both ways shows once. Prompts, replies and one
line per tool call are indexed. Tool output, thinking and anything the harness redacts are
never indexed.

**Offline and local.** The index is the GUI's own, written in TypeScript with no new
dependency, under `~/.local/state/sessionpipe-gui/search/`. A low-priority child process
builds it in the background on first start, then keeps it up to date incrementally and
crash-safely; nothing leaves the machine. Settings › Data turns reading this machine's
history off, which deletes that part of the index; `--search-home DIR` points it at another
home.

**Fast enough not to notice.** Measured on one Mac (Apple M1 Max) against 3.2 GB of real
agent history: indexed from scratch in about 11 s, first results after about a second;
queries in about 1.5 ms at the median; a line an agent writes is findable about 50 ms later.
`npm run bench:search` runs the budgets on a generated corpus.

**Where you search.**

- **The Search page**, third in the sidebar (`⌘⇧F` from anywhere): results per keystroke,
  grouped by session with one to three marked moments each, filter chips that edit the
  query, *Best match* or *Newest*.
- **`⌘K`**, whose *In transcripts* group previews the matched moment, with a row to search
  all sessions for what you typed.
- **A history transcript** for a session the receiver never saw: read-only, in the same
  chat look, with a find bar (`⌘G` for the next hit) and the command that resumes it.
- **The terminal**, no browser needed; it asks the running GUI when there is one:

  ```sh
  sessionpipe-gui search "rate limiter" --since 7d
  sessionpipe-gui search webhook --agent codex --newest
  sessionpipe-gui search '"rate limiter" -staging' --json | jq '.sessions[0].resume'
  sessionpipe-gui index --status        # or --rebuild, --verify
  ```

  `search` exits 0 with results and 1 with none.
- **The API**, `/api/ui/search/*`, behind the UI key like every other route.

![⌘K: In transcripts, with a preview of the matched moment](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/search-palette.png)

**The query.** One language for the page, `⌘K`, the terminal and the API:

| Write | Finds |
|---|---|
| `webhook retry` | Sessions with every word |
| `"rate limiter"` | The exact phrase |
| `-staging` | Sessions without the word |
| `migrat*` | Words that start with `migrat` |
| `agent:codex` | One agent: `claude`, `codex`, `gemini`, `antigravity` |
| `machine:build-box`, `repo:billing`, `label:red` | One machine (`machine:this` is this one), repo or label |
| `since:7d`, `until:2026-10-20` | A time range: `12h`, `7d`, `2w`, `3m`, `1y`, `today`, `yesterday`, a date |
| `in:prompt`, `in:reply`, `in:tool`, `in:title` | Only that field |
| `source:history`, `source:sessionpipe` | Only this machine's own logs, or only what sessionpipe delivered |

For example `"rate limiter" -staging since:30d`, `agent:claude in:prompt migrat*`, or
`webhook machine:this`.

**Keys.** `⏎` opens a result, `⇧⏎` opens it beside the page, `⌘⏎` beside as a background
tab; `Space` peeks; `j` `k` move; `⌘C` copies the resume command (`claude --resume …` in its
folder, `codex resume …`). Right-click a result for the rest: copy its link, id or
transcript path, reveal it in Finder (this Mac only), find in this session, or more from the
same repo or machine.

## Install

You need Node 20 or newer, and [sessionpipe](https://github.com/spacesheep-dev/sessionpipe)
on each machine whose live sessions you want to see (`npx sessionpipe install`; the first-run
page says so if it is missing). Search of this machine's own history works without it.

```sh
npx github:spacesheep-dev/sessionpipe-gui      # try it straight from GitHub: builds once, then runs
```

To keep it on the PATH as `sessionpipe-gui`, install a [release](https://github.com/spacesheep-dev/sessionpipe-gui/releases)'s
tarball:

```sh
npm i -g https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.6.2/sessionpipe-gui-0.6.2.tgz
```

Or from a clone: `git clone https://github.com/spacesheep-dev/sessionpipe-gui && cd
sessionpipe-gui && npm install && npm start`. The npm package (`npx sessionpipe-gui`)
follows once it is published.

Everything official is inside: the Canvas and Office views, the two skins and the
ping-a-human Telegram plugin (off until you turn it on). The board runs on port 7373.

### Your first minute

1. **Run `sessionpipe-gui`.** It prints where to open it, and a QR code for your phone:

   ```
   sessionpipe-gui 0.6.2 · ~/.local/state/sessionpipe-gui

     setup   http://localhost:7373/setup   (first run: your sessions, https, pairing, your phone)
     local   http://localhost:7373
     network http://192.168.1.20:7373/?k=…

     on a phone, scan this (same Wi-Fi):
     █▀▀▀▀▀█ ▀ █▀▀▀▀▀█ …
     from another machine:
       sessionpipe sink add http://192.168.1.20:7373 --tier 3 --token …
   ```

2. **Open it.** The first time, you land on Setup. It checks every two seconds, so each step
   turns green by itself: your sessions, https for passkeys, pairing this machine, your
   phone, one message sent and delivered.
3. **Start an agent in any terminal** (`claude`, `codex`, `gemini`, `agy`). Its row drops onto
   the board within a second: the GUI tails the outbox `sessionpipe tail` reads, so there is
   nothing to configure here, and the history already in it is there at once.
4. **Pair this machine** to answer from the page: Setup runs `sessionpipe control pair` for
   you, and you approve the six digits with your passkey.
5. **Add your phone.** Scan the QR code; Setup's phone step gets it sending, over the same
   Wi-Fi or [Tailscale](https://tailscale.com).

No agent handy? `sessionpipe-gui --demo` fills the board with a synthetic team.

## Tour

### Board

![The board: needs you, working, stale, idle; done collapsed](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/board.png)

Every session, grouped in the order you would look: **needs you**, **working**, **stale**,
**idle**, **done**. A row is the title, one line of what is happening (the command waiting
for you, the tool running, the last thing the agent said) and where it runs. One mark says
the state, and only *needs you* gets the colour. Flags call out what is off: a slow tool, a
run of errors, the same call three times in a row. Every row has a right-click menu with its
real actions; on a phone, a long press.

### Session

![A session: the chat, a turn's tools folded into one line, the open prompt with Allow and Deny](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/session-simple.png)

A session reads as a chat: your prompts, the agent's replies, each turn's tools folded into
one line, a composer at the bottom. Advanced mode shows the full timeline with every tool
call's input, output and duration, and a tier lens that shows the session as a lower-tier
receiver would have got it. Send the next message, attach up to six images, stop a turn, or
answer the prompt in place.

### New session

![New session: machine, agent, folder, what it should do](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/new-session.png)

`c` anywhere, or right-click a machine, a folder or a session: pick the machine, the agent
and the folder, type what it should do, add files. The page opens at once and fills in as the
agent starts; a machine that is offline takes it when it is back. The machine's own
sessionpipe daemon starts the agent and checks everything again; the GUI runs nothing.
Permission mode and model appear only when that machine's sessionpipe offers them
(sessionpipe 0.10); until then the sheet says which mode the machine set at its terminal.

### Inbox

![Inbox: every open prompt on every machine](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/inbox.png)

Every open permission, question and error from every machine, newest first, with Allow and
Deny on the ones a signed answer can reach. A toast appears for each new one while you are
elsewhere in the app; system notifications and sounds are per device.

### Labels and subagents

![Colour labels on the board and the Label menu](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/labels.png)

Seven colours, Finder-style: right-click a session, *Label ▸*, or `⌥⌘1`–`⌥⌘7`. A label is
one dot wherever the session appears, filters with `label:red`, can be named, and is the same
on every device.

![A session's subagents, each under the turn that started it, with its tools](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/subagents.png)

A parent row says how many subagents are running and opens a tree of what each is doing. In
the session, each agent sits under the turn that started it, with its tools and its result,
and opens beside its parent as a tab of its own.

A run a script started for a session is not a subagent. When the sender says so
(`session.launched_by`), the run's header links the session it ran for, and that session's
header links the run it started, or lists several in a menu.

### Agents that ask each other

A session can hand a task to another agent on its machine and get the answer back
(`sessionpipe ask codex "review this diff"`), and from a session's page you can ask another
agent and have its answer brought back into that session as a message. Either way the ask
is one row in the chat where it happened, the asked session says who it is for, and the
board nests it under the one that asked. **Workflows** chain steps across agents and
machines (implement, then review; two opinions, then a comparison), every step a signed
command, every run resumable from any device that can sign. Details and the commands:
[docs/orchestration.md](docs/orchestration.md).

### Review

![Review: the files your agents changed, by repo](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/review.png)

What happened, rather than what is happening: the files your agents changed in a range,
grouped by repo, and one day as a digest per machine and repo. Review sits in Advanced mode
with the Feed (every event as it arrives) and Machines (each sender, its versions and its
pairing).

### Canvas and Office

![Canvas: sessions as windows, grouped by machine](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/canvas.png)

Two views that ship with the GUI, under *Experimental* in the sidebar. **Canvas** puts every
live session in a window on an infinite canvas, laid out in one click by state, machine,
harness, repo or label, or in your own areas and notes, the same on every device; its Map
draws the machines, accounts and repos around them. **Office** makes every machine a room and
every session a person at a desk.

### Phone

| ![The board on a phone](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/phone-board.png) | ![A session on a phone, Allow and Deny on its prompt](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/phone-session.png) | ![Getting a phone sending: its own steps](https://raw.githubusercontent.com/spacesheep-dev/sessionpipe-gui/main/docs/screenshots/phone-wifi-phone.png) |
|---|---|---|

The same app at phone size: a tab bar, sheets, a two-line banner when something needs you.
Scan the QR code and the board is there; the key in the link signs the phone in. Sending
needs https and a passkey, and the phone page walks you through one of two ways: the same
Wi-Fi with the GUI's own certificate (`--tls`), or Tailscale from anywhere. Add it to your
home screen and it opens like an app. Details: [docs/remote.md](docs/remote.md).

### Keyboard, ⌘K and the look

`⌘K` finds any session, page or action, and searches text across sessions. `c` starts a
session, `j` `k` move, `Enter` opens, `Shift+Enter` opens beside, `a` and `d` allow or deny,
`g` then a letter jumps between pages. `?` lists every binding in force; `/shortcuts`
rebinds them, with vim and emacs presets.

Two skins ship. **sessionpipe**, the default, is the brand's ink, graphite and paper with its
orange as the one accent, for *needs you*, in light and dark; **Paper** is warm paper and ink,
light only. Text is set in Geist and code in Geist Mono, served by the GUI itself. Light,
dark or system, the skin and the text size are one click from the sidebar and kept per
device.

## Desktop apps

| Platform | Download |
|---|---|
| macOS 11 or newer, Apple silicon and Intel | [sessionpipe_0.6.2_universal.dmg](https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.6.2/sessionpipe_0.6.2_universal.dmg), signed and notarized |
| Linux, x86-64 | [.deb](https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.6.2/sessionpipe_0.6.2_amd64.deb) · [AppImage](https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.6.2/sessionpipe_0.6.2_amd64.AppImage), for any distribution |

The same UI in a small [Tauri 2](https://tauri.app) app that uses the system's own web view
(the AppImage carries WebKitGTK with it, which is why it is larger). It connects to the
receiver on this machine; on first run it can start one for you as a service, which needs
Node 20 or newer (`sessionpipe-gui service install` does the same from a terminal, and a
newer version upgrades the service it finds in place). It
keeps a menu bar item and a Dock badge that count what needs you, notifies you, launches at
login if you like, and updates itself. Every release is
on the [releases page](https://github.com/spacesheep-dev/sessionpipe-gui/releases).

On a Mac the app also sends: prompts, new sessions and permission answers, from the window
or from a notification. It signs with a key in the Mac's Secure Enclave, unlocked with Touch
ID once a day. Set it up once with **Sign with Touch ID** (on Machines, or Settings › App):
a browser or phone the machine already trusts approves the Mac with its passkey. This needs
a receiver and a machine that take device keys (sessionpipe 0.10); where either is older,
or on Linux, the app says which and you send from a browser, where your passkey signs.

The phone app, for iPhone and Android, is the same UI again: it connects to your computer by
its address or phone link and shows the board and sessions live. It is in testing (iPhone
builds go to TestFlight for the team's testers) and not in the stores yet.

## How it works

```
 Claude Code · Codex · Gemini CLI · Antigravity · Devin
        │ hooks, in any terminal or IDE, on any machine
        ▼
 sessionpipe       filters to a privacy tier, removes secrets, appends to the outbox
        │ this machine: the outbox is tailed     other machines: a sink posts the events
        ▼
 sessionpipe-gui   store · receiver · control · search index                  :7373
        │ live, over SSE
        ▼
 the board         any browser: this machine, your phone, another laptop

 and back:  board ── command signed by your passkey ──► sessionpipe-gui ──► the agent's
            machine, whose sessionpipe daemon verifies it and delivers it through the
            agent's own hooks
```

On this machine there is nothing to configure: the GUI tails the outbox `sessionpipe tail`
reads (`--no-outbox` turns that off). Another machine sends with one line, shown filled in on
the Connect page and in the banner:

```sh
sessionpipe sink add http://<this-machine>:7373 --tier 3 --token <sink token>
```

The receiver implements sessionpipe's [HTTP binding](https://github.com/spacesheep-dev/sessionpipe/blob/main/spec/HTTP.md)
and [control channel](https://github.com/spacesheep-dev/sessionpipe/blob/main/spec/CONTROL.md)
and accepts every tier up to 3.

**Privacy tiers.** What leaves each machine is decided there, by the tier its sink is set to,
and secrets are redacted before the outbox. The GUI shows what arrived and nothing more.

| Tier | What it carries |
|---:|---|
| 0 | Ids, state, timing, machine, repo, branch, model, title, what kind of attention is needed |
| 1 | + tool names, durations, ok or error, file paths, what a prompt asks, subagents |
| 2 | + your prompts and the agent's replies, a running turn as it runs |
| 3 | + tool input and output (your own receiver only) |

**Security model.**

1. **Seeing** needs the UI key, carried once in the QR link and then as a cookie. The machine
   itself (`localhost`) needs none. Other machines post events with a separate sink token.
2. **Acting** needs a passkey. Every command is signed on your device and verified by the
   agent's machine against keys enrolled at its own terminal. The GUI holds no key that can
   sign, so it cannot forge a command, and a plugin can only *suggest* an answer for you to
   confirm.
3. **The wrong address says so.** A page opened where passkeys cannot work names the address
   where sending does, instead of offering to enrol a new device.
4. **Setup is local.** Setup's actions, token rotation and plugin settings answer only on
   this machine.
5. **Nothing phones home.** No telemetry; the web app calls only its own origin, and the
   server's only outbound request is an extension you ask it to install by URL.
   [SECURITY.md](SECURITY.md) has the details.

The GUI is meant for your own network. For outside it, use Tailscale or another https proxy
([docs/remote.md](docs/remote.md)); putting the port on the public internet is not supported.

**Footprint.**

| Measure | Value | Conditions |
|---|---|---|
| Package | about 1 MB packed | `npm pack` of 0.3.0, fonts and the bundled views included |
| Board first load | 140 KB of JS, gzipped | 0.3.0's entry chunk; the other pages load when they are opened |
| Server boot | about 1 s | to the first API answer; 177 sessions, 11 027 events, 182 MB of JSONL |
| Server memory | 95–100 MB RSS | the same store, settled about 35 s after boot |
| Server idle CPU | 0.2 % | the same store, no browser connected |
| Board JS heap | about 9 MB, flat | after 30 minutes of streaming |

The server and heap rows were measured on 2026-10-15 (0.1, before search) on an Apple-silicon
Mac; method, raw numbers and what is still slow: [docs/perf.md](docs/perf.md). Search's own
numbers are [above](#search).

Other sessionpipe receivers: [spacesheep.dev](https://spacesheep.dev) (hosted, tier 2),
[sessionpipe-receiver](https://github.com/spacesheep-dev/sessionpipe/tree/main/packages/receiver)
(the reference), and `sessionpipe tail` in a terminal.

## Reference

<details>
<summary><b>Options</b></summary>

| Option | Default | |
|---|---|---|
| `--port N` | 7373 | |
| `--host H` | `0.0.0.0` | this machine and the LAN |
| `--state DIR` | `~/.local/state/sessionpipe-gui` | events, config, keys, the search index |
| `--no-outbox`, `--outbox DIR` | the sessionpipe outbox here | what to tail on this machine |
| `--keep-days N` | 14 | older events keep a shorter preview in memory; files are never trimmed |
| `--search-home DIR` | your home | where search reads agent history (`~/.claude*`, `~/.codex`, `~/.gemini`); with `--demo`, none is read unless given |
| `--tls`, `--no-tls` | off | https on the same port from the GUI's own local CA, for passkeys from a phone; remembered |
| `--public-url URL`, `--no-public-url` | none | the https origin a proxy on this machine serves (Tailscale); remembered |
| `--rp-id HOST` | `localhost` | the passkeys' rp id; set by `--tls` and `--public-url` |
| `--demo`, `--replay FILE`, `--speed N` | | synthetic sessions, or a sessionpipe JSONL file replayed |
| `--open`, `--quiet` | | open the browser; no banner |
| `--themes-dir`, `--skins-dir`, `--plugins-dir`, `--bundled-dir` | under the state dir | where extensions live |
| `--test-door` | off | loopback-only door for the conformance runner |

`sessionpipe-gui --help` prints the full list.

</details>

<details>
<summary><b>Commands</b></summary>

```sh
sessionpipe-gui                              # the board
sessionpipe-gui search "query" [--agent a] [--machine m] [--repo r] [--since 7d] [--until d]
                       [--in f] [--source s] [--newest] [--limit n] [--json]
sessionpipe-gui index [--rebuild] [--status] [--verify]
sessionpipe-gui tls status|trust|reset
sessionpipe-gui view|skin|plugin list|add|link|remove|enable|disable
sessionpipe-gui extras list                  # the official extensions, all bundled
```

</details>

<details>
<summary><b>Where things live</b></summary>

Everything is under `~/.local/state/sessionpipe-gui/` (or `--state DIR`):

| | |
|---|---|
| `events/<harness>/<session>.jsonl` | One append-only file per session, the full events; the index is rebuilt at boot |
| `search/` | The search index: what the receiver holds, and this machine's history unless it is off |
| `config.json` | The sink token, the UI key, TLS and public url, which extensions are on or off |
| `control/` | Paired machines (token hashes), their queues, and files a new session carries until the machine fetches them |
| `tls/` | The local CA and certificate (`--tls`) |
| `attachments/` | Images sent from the composer |
| `labels.json` | Your colour labels |
| `themes/`, `skins/`, `plugins/` | Installed extensions, with their settings (mode 0600) beside them |

*Forget* on a session's menu deletes its file; deleting the folder starts over.

</details>

<details>
<summary><b>Extending: views, skins, plugins</b></summary>

A **view** is an ES module that draws the board its own way on a page of the GUI. A **skin**
is colours, fonts and shape, no code. A **plugin** is server-side code that reacts to events,
such as [ping-a-human](https://github.com/spacesheep-dev/sessionpipe-gui-themes/tree/main/packages/plugin-ping-a-human),
which sends a Telegram message when a session needs you, with Allow and Deny that come back
as a suggestion you confirm with your passkey. The official ones ship inside the GUI and
their sources live in [sessionpipe-gui-themes](https://github.com/spacesheep-dev/sessionpipe-gui-themes).

```sh
sessionpipe-gui plugin enable ping-a-human                              # bundled, off until you say so
sessionpipe-gui view add <folder | .tgz | .zip | npm package | git url> # skin add, plugin add the same
```

A view runs with everything the page has and a plugin with everything this machine has;
install only what you trust. Guides: [views](docs/theme-authoring.md),
[skins](docs/skin-authoring.md), [plugins](docs/plugin-authoring.md).

</details>

## FAQ

<details>
<summary><b>Do I need sessionpipe?</b></summary>

For live sessions, yes. sessionpipe is the protocol and the hooks; this is a receiver for it.
`npx sessionpipe install` on a machine writes the hooks and keeps its events in a local
outbox, and the GUI on that machine reads it with no configuration. Without sessionpipe the
GUI still searches this machine's own agent history, and `--demo` shows the rest.

</details>

<details>
<summary><b>Does it run my agents?</b></summary>

No. Your agents run where you started them. When you start one from the GUI, it sends a
signed `start` to that machine, and the machine's own sessionpipe daemon checks it and starts
the agent. Without pairing, the GUI is a read-only board.

</details>

<details>
<summary><b>Which agents does it show?</b></summary>

Every agent sessionpipe hooks: today Claude Code, Codex, Gemini CLI, Antigravity and Devin.
Cursor, Copilot CLI, Droid, Kiro and OpenCode are next in sessionpipe's
[registry](https://github.com/spacesheep-dev/sessionpipe/blob/main/spec/ADAPTERS.md) and
appear here as sessionpipe adds them. Search reads the history of Claude Code, Codex,
Antigravity and Gemini CLI on this machine.

</details>

<details>
<summary><b>Does anything leave my machine?</b></summary>

Not unless you ask. No telemetry, no analytics, no account; search runs here, on files here.
The server's one outbound request is an extension you install by URL. What other machines
send to this one is up to each machine's sink tier.

</details>

<details>
<summary><b>Can I reach it away from home?</b></summary>

Yes, through Tailscale: `tailscale serve --bg 7373`, then
`sessionpipe-gui --public-url https://<machine>.<tailnet>.ts.net`, or one click on the phone
page when Tailscale runs here. No port forwarding, no certificate to install. Other https
proxies work too: [docs/remote.md](docs/remote.md).

</details>

<details>
<summary><b>Is it on npm?</b></summary>

Not yet. Run it with `npx github:spacesheep-dev/sessionpipe-gui`, or install a release's
tarball with `npm i -g` (above); the npm package follows.

</details>

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md): one
concern per PR, tests beside the code, and every commit signed off under the [DCO](DCO)
(`git commit -s`); there is no CLA. The architecture and module owners are in
[ARCHITECTURE.md](ARCHITECTURE.md), cutting a release in [RELEASING.md](RELEASING.md), and
security reports go through [SECURITY.md](SECURITY.md).

```sh
npm install
npm run dev            # server on :7373 + Vite on :5173
npm test               # vitest
npm run test:e2e       # Playwright, desktop and phone
```

## License

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). This GUI is a receiver that speaks the
sessionpipe protocol; it is not part of the sessionpipe project and is not endorsed by it.
The protocol is by Michael Makarov and contributors; "sessionpipe" and the sessionpipe
logo are [marks of Michael Makarov](https://github.com/spacesheep-dev/sessionpipe/blob/main/TRADEMARKS.md).
The logo and wordmark in `web/public/brand/` are the sessionpipe logo system, Michael
Makarov's marks ([docs/brand.md](docs/brand.md)). Geist and Geist Mono (`web/public/fonts/`)
are by Vercel under the SIL Open Font License 1.1 (`web/public/fonts/OFL.txt`).
Claude Code, Codex, Gemini, Antigravity, Devin, Cursor and the other agent names are
trademarks of their owners, named here only to identify the software a session runs in.
