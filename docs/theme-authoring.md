# Writing a theme

A theme is a plugin that draws the board its own way: a different page in the GUI,
listed on the rail, rendering into a container the host gives it. It is an ES module
plus a `theme.json`, kept **outside** the GUI under the state dir
(`~/.local/state/sessionpipe-gui/themes/<id>/`), served by the GUI at `/themes/<id>/`
and imported by the page at runtime. The host talks to it through one object, the
`ThemeApi`, and expects one thing back: a function that unmounts it.

The contract is `shared/theme-api.ts`; this page explains it.

## A theme in thirty lines

`theme.json`:

```json
{ "id": "tally", "name": "Tally", "version": "0.1.0", "api": 1 }
```

`index.js`:

```js
export default {
  mount(container, api) {
    const el = document.createElement("div");
    el.style.cssText = "padding:24px;font:14px/1.5 var(--font-ui);color:var(--fg)";
    container.append(el);

    const draw = (snap) => {
      const needs = [...snap.sessions.values()].filter((s) => s.state === "needs_you");
      el.innerHTML = `
        <h1>${snap.sessions.size} sessions · ${needs.length} need you</h1>
        <p>${snap.stats.eventsLastMinute} events in the last minute · ${snap.connection}</p>
        <ul>${[...snap.sessions.values()]
          .map((s) => `<li data-key="${s.key}">${api.format.monogram(s.harness)} ${api.format.title(s)} · ${s.state}</li>`)
          .join("")}</ul>`;
    };
    draw(api.state.get());
    const stop = api.state.subscribe(draw);

    el.addEventListener("click", (e) => {
      const key = e.target.closest("[data-key]")?.dataset.key;
      if (key) api.openSession(key);
    });
    return () => stop(); // unmount: stop listening; the host clears the container
  },
};
```

Install it and open `/t/tally`:

```sh
sessionpipe-gui view add ./tally        # copies the folder
sessionpipe-gui view link ./tally       # or: symlink it while you work on it
```

## The manifest

`theme.json` sits beside the entry module.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `[a-z][a-z0-9-]{1,40}`. The folder name, the route (`/t/<id>`) and the storage key. |
| `name` | yes | Shown on the rail and the Themes page. |
| `version` | yes | Yours; shown on the Themes page. |
| `api` | yes | The `ThemeApi` version you wrote against (`1` today). The host refuses a theme whose `api` is newer than its own. |
| `entry` | no | The ES module, relative to the folder; `index.js` by default. |
| `style` | no | A stylesheet the host links before mounting and removes after. Scope your selectors: it lands in the whole page. |
| `icon` | no | Inline SVG for the rail (24×24 viewBox, `currentColor`). Without one you get a plug. |
| `description` | no | One line for the Themes page. |
| `experimental` | no | `true` puts the entry under the "experimental" divider. |
| `source` | — | Written by the host on install; leave it out. |

## The `ThemeApi`

`mount(container, api)` is called once the module has loaded, with a container that
fills the page below the shell: no padding, `position: relative; overflow: hidden`.
Scrolling inside it is yours to do. Return the function that unmounts (it may be
`async`). The host calls it when the route changes, then clears the container.

| Member | What it is |
|---|---|
| `version` | `1`. |
| `host` | `{ name: "sessionpipe-gui", version }`. |
| `manifest` | Your `theme.json` as installed (with `source`, `url`, `linked`). |
| `baseUrl` | Absolute URL prefix of your own files: `new URL("worker.js", api.baseUrl)`. |
| `state.get()` | The current `ThemeSnapshot` (below). Immutable; a new object per change. |
| `state.subscribe(fn)` | `fn(snapshot)` on every change; returns the unsubscribe. |
| `onEvent(fn)` | `fn(event, session)` for each live event as it arrives, with the session summary after applying it. Returns the unsubscribe. |
| `fetch.session(key, { after, limit })` | The full events of one session (`SessionDetail`), read from disk. |
| `fetch.forget(key)` | Delete a session, as the board's Forget does. |
| `navigate(path)` | Go to any page of the GUI (`"/feed"`, `"/t/other"`). |
| `openSession(key)` | Go to that session's page. |
| `tokens` | The CSS custom properties the host defines on `:root` (`--bg`, `--fg`, `--fg-2`, `--line`, `--needs`, `--err`, …), right for both colour schemes. Use them and your theme follows the switch. |
| `storage.get()` / `storage.set(value)` | One JSON document per theme, kept by the server and shared by every device, at most 256 KB. `get()` is `null` until the first `set`. |
| `local.get(key)` / `local.set(key, value)` | `localStorage`, namespaced to your theme, for per-device conveniences. May silently be unavailable. |
| `control` | The control channel, signed by the host: `availability(target)`, `send`, `answer`, `cancel`, `start`. See [Control from a theme](#control-from-a-theme). |
| `react` | `{ React, ReactDOM, createRoot }`: the host's React 18, for a theme that wants it without bundling its own. |
| `shortcuts` | The host's keymap: `register(actions)` adds your keys while you are mounted (listed in the `?` help and on `/shortcuts`, rebindable, dispatched by the host), `active()` is every binding in force. See [Keyboard](#keyboard). |
| `format.ago(iso)` | `"12 s ago"`, `"3 m ago"`, `"yesterday"`. |
| `format.duration(ms)` | `"0.4 s"`, `"4 m 12 s"`, `"2 h 05 m"`. |
| `format.title(session)` | The title, else the cwd's basename, else the id's head. |
| `format.repoBranch(session)` | `"org/repo @ main"`. |
| `format.monogram(harness)` | `"Cl"` for claude-code, `"Cx"` for codex, … |

A `ThemeSnapshot`:

```ts
{
  connection: "connecting" | "live" | "offline",
  sessions: ReadonlyMap<SessionKey, SessionSummary>,   // key = "<harness>:<id>"
  machines: ReadonlyMap<string, MachineSummary>,
  stats: Stats,                                         // events, sessions, eventsLastMinute, …
  control: readonly ControlActivity[],                  // newest first
  recent: readonly StoredEvent[],                       // newest first, the live tail (≤ 1500)
  scheme: "dark" | "light",                             // what the page renders in right now
  viewers: readonly Viewer[],                           // browsers on the stream; `current` marks this one
  tierLens?: 0 | 1 | 2 | 3 | null,                      // the app-wide tier lens; null = everything (optional to honour)
  mode?: "simple" | "advanced",                         // Simple: fold HUD extras into one menu, drop the style switch
}
```

`SessionSummary`, `StoredEvent` and the rest are in `shared/api.ts`. A session's
`state` is the host's reading (`needs_you`, `working`, `stale`, `idle`, `done`);
`openAttentions`, `currentTool`, `currentTurn`, `counts` and `recentTools` are what
the board's cards are drawn from.

## Who is looking: `viewers`

Every browser with the GUI open holds a stream to the server, and the server reads
a `Viewer` off each connection: a per-connection `id`, the `ip` (`"this machine"`
when it is the receiver's own browser), `loopback`, a `device` and a short `label`
from the user agent, `connectedAt` and `lastSeenAt`. Nothing is installed on the
device; close the tab and it is gone. `device` is `"phone"` (iPhone, Android phone),
`"tablet"` (iPad, Android tablet), `"laptop"` (a Mac, Windows or Linux browser on
another address), `"desktop"` (the same on this machine) or `"unknown"`. The entry
for the very page your theme runs in carries `current: true`.

```js
const draw = (snap) => {
  const me = snap.viewers.find((v) => v.current);
  el.textContent = `${snap.viewers.length} connected · you are ${me?.label ?? "?"}`;
  for (const v of snap.viewers) {
    if (!v.current) el.append(` · ${v.label} (${v.device}, ${api.format.ago(v.connectedAt)})`);
  }
};
draw(api.state.get());
api.state.subscribe(draw);
```

The list is also at `GET /api/ui/viewers` (`{ viewers }`, nobody marked current).

## Control from a theme

`api.control` sends the same signed commands the Session and Machines pages do
(CONTROL.md): the host signs with the person's passkey, once a day for a day grant,
and `POST`s to the receiver, which hands the message to the machine's daemon. A theme
never sees a key. Each call resolves to a `ControlActivity`; the same message then
moves through `snap.control` (queued → taken → delivered, or refused) as the daemon
acks it.

| Call | What it does |
|---|---|
| `availability({ session })` or `availability({ machineId })` | `{ ok: true }`, or `{ ok: false, reason }` with the line the host would show: no secure context (passkeys need https or localhost), the session's machine is not paired here, or its daemon is offline. Call it before offering a button. |
| `send(session, text)` | A prompt for the session's next turn. |
| `answer(session, attentionId, "allow" \| "deny", note?)` | Answers an open permission (`session.openAttentions[].attentionId`). |
| `cancel(session)` | Interrupts the running turn. |
| `start(machineId, { harness, cwd, text })` | A new session on a paired machine (`machine.control.machineId`, a `cwd` from `machine.control.folders`). The result carries `session`, the key the host chose. |

A call that cannot be sent rejects with an `Error` whose message is the host's wording
(`not sent · …`), including a refusal the daemon returns. The first send of the day
opens the passkey prompt; a theme may want to say so next to its button.

```js
const key = "claude-code:8c132906-…";
const a = api.control.availability({ session: key });
button.disabled = !a.ok;
button.title = a.reason ?? "";
button.onclick = async () => {
  try {
    const sent = await api.control.send(key, "Run the tests and fix what fails");
    note.textContent = `queued as ${sent.id}`;
  } catch (e) {
    note.textContent = e.message; // "not sent · the machine is offline…"
  }
};
```

## Keyboard

The host has one keymap (`?` lists it, `/shortcuts` edits it). A view joins it instead
of listening for keys itself:

```js
const off = api.shortcuts.register([
  { id: "fit", label: "Fit everything", keys: ["0"], run: () => fit() },
  { id: "zoom-in", label: "Zoom in", keys: ["plus", "="], run: () => zoom(1) },
  { id: "legend", label: "Legend", keys: ["shift+l"], run: () => toggleLegend(), hint: "what the colours mean" },
]);
// … in your unmount: off();   (the host also removes them when the route changes)
```

Keys are chord strings (`"a"`, `"shift+enter"`, `"mod+k"`, or two in a row, `"g b"`;
`mod` is ⌘ on a Mac and ctrl elsewhere). The host ignores a press while a text field
has focus, runs your `run()` and, on your page, lets your binding shadow one of its own
for the same chord (`a` in a canvas answers the focused window, not a panel's prompt).
A person may rebind any of them; `api.shortcuts.active()` tells you the current
bindings (`active()["zoom-in"]`, and the host's under their ids, `active()["list.down"]`)
so your hints stay true. A host without `api.shortcuts` (older than this) is fine to
fall back on with your own listener: `api.shortcuts?.register(…) ?? listenYourself()`.

**Who wins.** While your page is mounted, a bare key (no modifier, not one of the
host's `g …` sequences, not Esc) belongs to you whenever focus is inside your container
or nowhere in particular (the body): the host does not run its own single-key bindings
there (`?`, `/`, `j`, `a` …), whether you registered yours or still listen for them
yourself. A key you `preventDefault()` is never looked at by the host. The host keeps
its modifier chords (`mod+k`, `mod+1` …), its `g …` navigation and Esc on every page.
Register your keys anyway: that is how the person sees them in `?` and can change them.

What a view must do to stay keyboard-accessible, since nothing outside your container
can reach into it:

- Every clickable thing is a real `<button>` or `<a href>`, or has `tabindex="0"`, a
  role and a key handler (Enter / Space). A window on a canvas is `tabindex="0"` with
  `aria-label`; the arrows move it, Enter opens it. Desks in the office are links.
- Focus is visible: the host's rule is `:focus-visible { outline: 2px solid var(--fg);
  outline-offset: 2px }`; keep it, or draw a ring as strong, never `outline: none` alone.
- One tab stop per list or grid (roving `tabindex`: 0 on the current item, -1 on the
  rest; the arrows move it), so Tab is not a hundred presses.
- A popover of yours traps focus while open, closes on Esc and gives focus back.
- Say what changed through an `aria-live="polite"` region when it is not where focus is.
- Do not take the host's global keys (`?`, `/`, `esc`, `mod+k`, `g` …) unless you mean
  to; register yours and the table shows the person what wins where.

## The same theme with `api.react`

```jsx
// index.jsx, bundled to index.js (see below)
import React from "react";
import { createRoot } from "react-dom/client";

function Tally({ api }) {
  const snap = React.useSyncExternalStore(api.state.subscribe, api.state.get);
  const list = [...snap.sessions.values()];
  return (
    <div style={{ padding: 24, color: "var(--fg)" }}>
      <h1>{list.length} sessions</h1>
      <ul>
        {list.map((s) => (
          <li key={s.key}>
            <button type="button" onClick={() => api.openSession(s.key)}>
              {api.format.monogram(s.harness)} {api.format.title(s)} · {s.state}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default {
  mount(container, api) {
    const root = createRoot(container);
    root.render(<Tally api={api} />);
    return () => root.unmount();
  },
};
```

`react` and `react-dom/client` are not on the page under those names: bundle them,
or map them to `api.react` with a shim.

## Bundling with esbuild

Everything in, simplest (your theme carries its own React, ~45 KB gzipped):

```sh
npx esbuild index.jsx --bundle --format=esm --outfile=dist/index.js --jsx=automatic
```

Or lean on the host's React. Two tiny shims, marked external, filled in at mount:

```js
// shims/react.js
export default globalThis.__themeReact.React;
export const { useState, useEffect, useMemo, useRef, useSyncExternalStore, createElement, Fragment } =
  globalThis.__themeReact.React;
// shims/react-dom-client.js
export const createRoot = (...a) => globalThis.__themeReact.createRoot(...a);
```

```js
// build.mjs
import { build } from "esbuild";
await build({
  entryPoints: ["index.jsx"],
  bundle: true,
  format: "esm",
  outfile: "dist/index.js",
  jsx: "automatic",
  alias: { react: "./shims/react.js", "react-dom/client": "./shims/react-dom-client.js" },
});
```

and first thing in `mount`: `globalThis.__themeReact = api.react;`. (With
`jsx: "automatic"` esbuild also imports `react/jsx-runtime`; alias that to a shim
exporting `jsx`, `jsxs` and `Fragment` from `api.react.React`, or use
`jsx: "transform"` with `jsxFactory: "React.createElement"` and the default import.)
Point `theme.json`'s `entry` at `dist/index.js`, or keep `index.js` as the output
name.

## Install, link, list, remove

```sh
sessionpipe-gui view add ./my-theme               # a folder: copied
sessionpipe-gui view add my-theme-0.1.0.tgz       # an archive: extracted (tar / unzip)
sessionpipe-gui view add https://…/my-theme.zip   # downloaded, then extracted
sessionpipe-gui view add sessionpipe-theme-tally  # an npm package name (npm install, then copied)
sessionpipe-gui view add https://github.com/you/tally.git
sessionpipe-gui view link ./my-theme              # a symlink: edits show on the next visit
sessionpipe-gui view list
sessionpipe-gui view remove tally
```

`theme` is an alias of `view` (`sessionpipe-gui theme add …` still works). Views are one
of three kinds of extension the same installer handles; the others are plugins
(server-side code, `plugin-authoring.md`) and skins (tokens, fonts, shape and an optional
stylesheet, no code, `skin-authoring.md`).

The id always comes from the theme's own `theme.json`; the installed copy records
where it came from in `source`. `--state DIR` (or `--themes-dir DIR`) chooses the
folder; the server reads it at boot and on **Reload** on the Themes page
(`POST /api/ui/themes/reload`, from the receiver machine only).

### Bundled views

Canvas and Office come with the GUI: `npm run build` copies them from the themes repo
(`scripts/build.mjs --bundle-from <path>`, default the sibling `../sessionpipe-gui-themes`,
skipped with a note when it is absent) into `dist/bundled/views/<id>/`, which the npm
package ships. The server lists them **after** the person's own folder, so `view add` of
a package with the same id overrides the bundled copy, and `view remove` of that install
brings the bundled one back. They are listed with `source: "bundled"` and `bundled: true`,
served at the same `/themes/<id>/` paths, and cannot be removed: `view remove canvas`
says so and points at `view disable canvas`, which hides it from the rail (and `/t/canvas`
says it is disabled) by adding `view:canvas` to `disabled` in `config.json`; `view enable
canvas`, or the Disable / Enable button on the Views page (receiver machine only,
`POST /api/ui/themes/:id/disable|enable`), brings it back. Any view can be disabled the
same way. The official plugin (ping-a-human) ships the same way, in
`dist/bundled/plugins/` beside the views (`--bundled-dir DIR` names the views folder;
`skins/` and `plugins/` are its siblings; the two skins are built in, so `skins/` is
empty); a clone
without the themes repo builds from the tracked copy in `bundled/`, which `npm run
bundle:sync` refreshes.

A **linked** theme is imported afresh on every visit to its page (a cache-busting
query string, and the server sends `no-cache` for `.js`, `.css` and `.json`), so an
edit shows after navigating away and back; no restart.

## Skins are not themes

A **skin** restyles the GUI without code: a `skin.json` with the custom properties of
`web/src/styles/tokens.css` to set (`--bg`, `--fg`, `--needs`, …, per scheme), bundled
fonts, a typeface, a radius, the hairline width, a density and an optional stylesheet.
People pick one from the page's quick settings (the gear on the rail or the tab bar),
beside the appearance and the text size; the built-ins are Spacesheep (the default),
Plain, Paper, Graphite, Ink and Sepia, and `sessionpipe-gui skin add` installs more.
How to write one: [`skin-authoring.md`](skin-authoring.md). A plain color-theme JSON
file in `<stateDir>/color-themes/` ([`color-theme.example.json`](color-theme.example.json))
still works and is listed with the skins. Because every view draws with the same tokens
by name (`api.tokens`), a skin restyles every view at once; a view never needs to know
which one is on.

## Rules of the house

- The container is yours; nothing else on the page is. Scope your CSS.
- Return your unmount, and really stop everything in it: subscriptions, timers,
  workers, `requestAnimationFrame` loops. The host calls it when the person leaves.
- Snapshots are immutable: compare by identity, never mutate.
- Serve nothing from outside your folder; the host refuses anyway.
- A theme is code running in the board page with everything the page has. Tell people
  what yours does; they are told, when they install it, to install only what they
  trust.
