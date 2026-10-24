# Canvas

A sessionpipe GUI view: every live session is a **window** on an infinite canvas, in
**views**. The presets (State, the default, then Machine, Harness, Repo, Label) lay the
windows out as a clean grid in labelled groups, computed the same on every device and never
stored. **My layout** is your own arrangement, with areas and notes, kept by the host
(`api.storage`) so it is the same on every device. **Map** is the infrastructure. The view
and the viewport are per device (`api.local`).

Experimental: it lives under the "experimental" divider in the GUI's navigation, at `/t/canvas`.

## What it shows

**A window per session**, a native panel: a title bar (the state glyph, your colour label as
one small dot, the title, the harness's mark; `↗` Open beside and `⋯` on hover), one muted
line with only what the current grouping doesn't already say (machine, repo, branch, errors)
and the time on the right, then up to three lines: the request with **Allow** / **Deny** when
it needs you and can be answered from here, the live tail while it works, the last reply when
it rests. Hover the title for the model and counts. Double-click or `Enter` expands it into the
session's rows with the prompt at the bottom. Nothing repeats across windows: whether this
page can send to a machine is said once, in the status bar.

**Subagents** hang off their orchestrator as compact pills (type · description, then what it
does now or its result), joined by hairline tethers; four at most, then "+n more". A pill's
place always derives from its parent; a child session (`parent_id`) is a pill too. Double-click
a pill to open the agent beside.

**Views** — the segmented control or keys `1`–`7`. Switching animates the windows into their
groups. In a preset a drag pans; arrange by hand in My layout.

**My layout** — drag windows (Shift snaps to 8 px); draw **areas** (`+ Area`, `A`, or hold `A`
and drag; "New area from selection") and drop windows in: moving an area carries its members.
**Notes** hold plain text (`+ Note`, `N`; `⌘↵` commits). Rename, label, delete (`⌫`, with an
Undo), `⌘Z` / `⇧⌘Z`. **Tidy** (`⇧T`) grids each area's members and the free windows. Every
change is one operation written with `api.storage.update`, so two devices merge; another
device's change arrives live. A phone shows one column and never writes positions.

**Right-click** anything for the host's own menu (long-press on touch, Shift+F10 from the
keyboard): a window gets the board's session menu (Label ▸, Subagents ▸, Copy ▸, Forget…) plus
Expand, Hide until it changes and Remove from area; pills, areas, notes, headings and the
ground have theirs. `⌥⌘1`–`⌥⌘7` / `⌥⌘0` label the selection.

**Map** — lanes of devices (one per browser name, "you" once, and the passkeys machines trust),
agents (one per harness; accounts named by email), machines with their sessions as rows under
them, and repos. Lines show for what you hover. Hand-drawn nodes and links live here; drag an
agent onto a machine to start a session there.

**Chrome** — a 48 px toolbar (views, My layout's tools, search with `label:` `machine:`
`harness:` `repo:` tokens, Fit `0`, zoom, `⋯`: Show done sessions, Show minimap, Edit labels…,
Reset My layout…) and a 28 px status bar (the connection when not live, the pairing hint once,
Hidden n and Done n). The minimap shows only when something is off screen.

## Build, dev, test

```sh
npm run build        # esbuild, minified → dist/index.js (~103 KB) + dist/index.css, and
                     # dist/map.js (~17 KB): the Map view, imported when first shown
npm run dev          # the harness at http://127.0.0.1:7420/harness.html
npm run typecheck
npm test             # Playwright on 7421 (run it alone): views, My layout, areas, notes,
                     # undo, labels, menus, subagent pills, map, control, two devices, phone
```

The harness (`dev/`) mounts the theme against a fake `ThemeApi` with a small world of sessions
in every state on two machines, subagents, and a tick that turns tools over, grows the text,
raises and clears attentions, ends and starts sessions. Query: `?tick=0` freezes it,
`?speed=N`, `?extra=N` adds sessions (try `?extra=50`), `?scheme=light|dark`. The dev
server keeps the stored document per `?room=` with the host's ETag and If-Match rules and
announces every write, so two browser contexts act as two devices; the host's menus,
confirm and labels have small recorded stand-ins, and `dev/host.css` is a copy of the
host's foundation styles.

In the real GUI: `sessionpipe-gui view link <this folder>` and open `/t/canvas`. Canvas
ships inside the GUI's package; on an older GUI, `sessionpipe-gui view add @sessionpipe-gui/theme-canvas`.

## How it is drawn

Plain TypeScript and DOM; nothing from `api.react`. The world is one element with a
`translate3d(...) scale(k)` transform; every window is `position: absolute` with its own
`translate3d`, so pan, zoom and drag never cause layout. One `requestAnimationFrame` applies
whatever changed and is idle otherwise; the elapsed numerals update once a second by setting
text only. Each window re-renders only when a signature of its session changes. The dot grid
is a CSS background whose spacing follows the zoom. Colours are the host's tokens by name, so
dark and light are the host's, and the controls wear the host's classes (`.seg`,
`.icon-btn`, `.search`, `.btn`); `prefers-reduced-motion` makes a view switch instant.

`src/`: `index.ts` (the canvas: views, layout, menus, persistence), `doc.ts` (the stored
document as operations, undo, the v1 migration), `window.ts` (a window), `agents.ts`
(pills), `areas.ts` (areas and notes), `chrome.ts` (toolbar and status bar), `detail.ts` +
`events.ts` (the rows), `map.ts` (the Map view, its own module: `import()`ed on first use),
`input.ts` (pointer, pinch, wheel, keys, right-click, long-press), `layout.ts` (placement
and the grid), `types.ts`, `canvas.css`.

The harness fakes `snapshot.viewers` (three browsers) and `api.control` (`misha-air`
online with two accounts, `studio` offline; `send`/`answer`/`cancel`/`start` carry a
message through queued → taken → delivered in about three seconds; `?control=0` removes
the channel; `?world=small` is the map test's fixture).
