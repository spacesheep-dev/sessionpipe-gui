# Agents that ask each other: Ask, bringing an answer back, and Workflows

Three ways one agent's work reaches another, all through sessionpipe's control protocol and
the daemon on the agent's machine. The GUI never runs an agent itself: it shows what the
events say, and signs what you ask for. Each needs sessionpipe 0.11 or newer on that
machine; the Machines page says under *Control* what a machine's daemon offers, and the
sheets and menus only appear where it does.

| | Who starts it | Where the answer goes | Needs |
|---|---|---|---|
| **Ask** | the agent, from inside its session (`sessionpipe ask …`) | back to the agent, on stdout | `sessionpipe ask on` on that machine |
| **Bringing an answer back** | you, from a session's page (*Ask another agent…*) | into that session, as a message | a daemon that takes `reply_to` |
| **Workflows** | you, from the Workflows page | each step's reply into the next step's prompt | a paired machine, and a device that can sign |

What the GUI calls them in the UI is plain: a session *asked* Codex; the answer was
*brought back*; a workflow has *steps* and *runs*.

## Ask: an agent hands a task to another agent

Inside a session, any harness with a shell can run:

```sh
sessionpipe ask codex "Review the diff in src/webhooks/send.ts and say what you'd do differently."
sessionpipe ask claude-code:3f1c… "Is the retry change in the billing repo ready to merge?"   # an existing session instead of a new one
sessionpipe ask gemini-cli --cwd ~/code/billing --permission read "List the tests this change needs."
```

The daemon on that machine starts the asked agent (or hands the question to the session
named), in the asker's folder or `--cwd`, at the machine's permission mode or narrower
(`--permission read|safe`, `--model`), and prints the answer on stdout when it is done,
progress on stderr. `--json` prints `{ask_id, session, reply, ms}`; `--quiet` only the
answer. An agent may ask one that asks another; the third cannot ask (depth 2), and nothing
can ask itself. The asked session learns nothing but the question and that it was asked.

On the machine, once:

```sh
sessionpipe ask on          # turns it on, and keeps the daemon running even with no paired receiver
sessionpipe ask status      # on or off, the daemon's state, the agents it can ask
sessionpipe ask setup       # writes a short section into ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
                            # telling the model the command exists; --remove takes it out
sessionpipe ask off
```

`setup` is how a session learns the command: hooks never inject anything. The section says
which agents are installed and that `ask` is never a way to send its own reply.

In the GUI, the ask is one row in the asking session's chat, where it happened: *Asked
Codex · new session · running 1 m 20 s*, then *answered in 2 m 05 s* with the answer folded
under it, or *failed after 40 s · <why>*. The row opens the asked session; its menu has
*Open beside*, *Copy the answer* and, while it runs, *Stop Codex…*. The asked session's
page says *for <the asking session>* in its bar, with a link back, and on the board it
nests under the one that asked it, with its own harness's glyph.

## Bringing an answer back: a second opinion from the page

On a session's page, *Ask another agent…* (the ghost button under the composer, the
session's menu, `shift+a`, or ⌘K) opens a sheet like New session with the rows it needs:
the agent (an existing session on the same machine, or a new one of a harness the daemon
lists), the folder for a new session, the question prefilled with the session's last reply,
and the switch **Bring the answer back into this session**, on by default.

With the switch on, the signed `prompt` or `start` carries `reply_to`: the daemon runs the
asked agent and, when it answers, delivers the reply into the asking session as a message
framed *Answer from codex:1f3a9c0e (sessionpipe handoff, asked via <this receiver>)*. The
chat draws that as the asked agent's turn, *Codex · answer*, never as your bubble; the
session's own reply to it follows as usual, and the ask row above reads *answered in 2 m
05 s · answer below*. With the switch off, the answer stays in the asked session and the row
links to it.

A daemon that does not take `reply_to` yet keeps working: the sheet says *needs a newer
sessionpipe to bring answers back* and the switch is not offered.

Under *Messages sent* the message says which page asked and where the answer goes:
*asked from Webhook backoff · the answer comes back there*.

## Workflows: steps across agents and machines

The Workflows page (`/workflows`, `g w`) chains steps: each step is an agent on a machine
(a new session of a harness, or an existing session), a folder, and a prompt that may use
`{{input}}` (what you type when you press Run), `{{prev}}` (the reply of the step it runs
after, or several joined by a blank line) and `{{step.<id>}}` (a named earlier step's
reply). A step runs after the one before it unless *Runs after* says otherwise; several
steps may run after the same one, in parallel, and one may wait for several.

Three templates to start from:

| | Steps |
|---|---|
| **Implement, then review** | Claude Code implements `{{input}}` · Codex reviews the diff · Claude Code applies the review |
| **Second opinion** | Claude Code and Codex answer the same question at once · a third step compares the two |
| **Plan, build, test** | Claude Code plans · Codex builds from the plan · Gemini CLI writes and runs the tests |

The server keeps every run and moves it: a step is *ready* when the steps it runs after are
done, and its reply (the machine's final ack) moves the next ones. The browser is only the
signer: on any device that can sign (a passkey or the app's device key), each ready step is
claimed and sent as one signed `start` or `prompt`, so a run continues from a phone as well
as a laptop and never needs the page that started it. With no signer open, the run reads
*waiting for a signer — open this page on a device that can sign*; with the machine
offline, *waiting for <machine>*. A failed step skips the steps that depended on it and
fails the run; *Cancel* skips what has not started and offers to stop what is running.

The run view shows each step with its elapsed time, its reply folded, and a link to the
session it made. Runs are saved in `~/.local/state/sessionpipe-gui/workflow-runs.json`
beside `workflows.json`; a run is frozen at start, so editing the workflow never changes a
run under way.

## What stays where

Nothing here grants an agent anything it did not have: an asked session runs at the
machine's mode or narrower, in a folder on the machine's allowlist, with the machine's
start caps, and only from a process of your own user on that machine. A receiver cannot
make a machine ask; it can only queue a signed `prompt` or `start`, which the daemon checks
as it checks every command. The lineage (`delegated_by` on the asked session's events, the
`delegation.started` / `.ended` events on the asker) is a fact for the GUI to show, never
an authority.
