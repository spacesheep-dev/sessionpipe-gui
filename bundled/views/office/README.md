# @sessionpipe-gui/theme-office

**Office**, a theme for the [sessionpipe GUI](https://github.com/spacesheep-dev/sessionpipe-gui):
every machine is a room, every live session a person at a desk, every live subagent a helper
at a side table. Posture is the state (pulled to a lit screen, standing with a hand up, pushed
back, pushed back and asleep, an empty chair), amber marks who needs you, and nothing else is
coloured. One room per machine, a tally by the door of who went home today. `DESIGN.md` is the
whole design, including what it must never do.

Two drawing styles, switched with the control in the header and kept per device:

- **iso** (the default): a small isometric office. Two-tone desks with hairline edges, one
  neutral tone for everyone, the running tool on the lit screen, the harness monogram on the
  desk's front, a pool of amber light under whoever needs you. Rows step toward the front,
  each desk with its nameplate on the floor.
- **figures**: people seen from behind at desks, each with its own look fixed for the session's
  life, a lit screen with the running tool, a lamp for *needs you*, a mug for *idle*, a window
  tinted by your hour.

Keyboard: `j` / `k` move through the desks, `Enter` opens the session, `?` shows the legend,
`Esc` closes it (then goes back, as everywhere in the GUI). Hover or focus a desk for the
tooltip. Both styles lay out from the width they are given (the split panel, a phone), the
iso room becoming a list of desks under 700 px; `prefers-reduced-motion` turns the walks into
fades and stops the typing.

## Install

```sh
# Office ships inside the GUI's package: nothing to install on a current sessionpipe-gui.
sessionpipe-gui view add @sessionpipe-gui/theme-office                       # from npm, on an older GUI
sessionpipe-gui view add /path/to/sessionpipe-gui-themes/packages/office     # or a folder: copied
```

Then open `/t/office`; it is listed on the rail under *experimental*.

## Development

```sh
npm install                  # at the repo root (workspaces)
npm run build                # dist/index.js + dist/index.css, the files theme.json points at
npm run dev                  # the same, rebuilt on every change
npm run typecheck
```

Link the package folder instead of copying it, and every visit to `/t/office` picks up the
latest build (the GUI re-imports a linked theme on each visit, no restart):

```sh
sessionpipe-gui theme link /path/to/sessionpipe-gui-themes/packages/office
```

## How it uses the host's React

The theme is written in TSX but `dist/index.js` carries no React: it draws with the host's
(`api.react`, React 19), so the bundle is ~75 KB with source maps off to the side. It calls
only `createRoot`, hooks and `createElement`, so the same bundle draws on React 18. The trick
is three small shims in `shims/`, which `scripts/build.mjs` substitutes for `react`,
`react/jsx-runtime` and `react-dom/client` at bundle time:

- `shims/react.js` exports the hooks the theme uses as thin wrappers that look the real
  function up on `globalThis.__sessionpipeThemeReact.React` **when called**, so nothing touches
  React at import time (the host imports the module before it hands over the api).
- `shims/jsx-runtime.js` implements `jsx` / `jsxs` on top of that `createElement`, and
  `Fragment` as the registered symbol `Symbol.for("react.fragment")` that React itself uses.
- `shims/react-dom-client.js` forwards `createRoot`.

`mount()` sets `globalThis.__sessionpipeThemeReact = api.react` first thing, then renders.
The one rule this imposes on the source: no React call at module scope (`memo`, `createContext`,
…); the api context in `src/api.tsx` is created on first use for that reason. TypeScript still
type-checks against `@types/react`, since the substitution happens in esbuild only. The build
fails if a copy of React ends up in the bundle or it grows past 100 KB.

## What it reads from the ThemeApi

`api.state` for sessions, machines, connection and the colour scheme (the session tree is
derived the way the board does it: roots are sessions without a parent, children by
`parentId`, state then recency); `api.format` for titles, `repo @ branch` and durations;
`api.openSession` / `api.navigate` behind every link; `api.local` for the drawing style and the
seating map (which desk a session holds, so nobody changes seats while alive). It needs nothing
from the network and keeps nothing on the server.
