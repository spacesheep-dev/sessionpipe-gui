# Writing a plugin

A plugin is server-side code that reacts to what the receiver sees: a message to your
phone when a session needs you, a line in a log, a suggested answer to a permission
prompt. It is an ES module plus a `plugin.json`, kept **outside** the GUI under the
state dir (`~/.local/state/sessionpipe-gui/plugins/<id>/`) and imported by the GUI's
own Node process at boot and on reload. The host talks to it through one object, the
`PluginApi`, and expects one thing back: a `deactivate` function.

The contract is `shared/plugin-api.ts`; this page explains it. Views (themes) are the
other kind of extension, code that runs in the page: `theme-authoring.md`.

## What a plugin can and cannot do

- It sees everything the board sees: every event, every session's readings, the machines,
  control activity. It can call out (`fetch`), read and write its own settings and a
  small storage document, and log.
- It can **suggest** an answer to an open permission (`api.suggest`). The GUI shows the
  suggestion beside the prompt, "Allow suggested by Misha on Telegram · Confirm", and a
  person confirms it with one tap, which sends the ordinary signed `permission.answer`.
- It can **never** answer a permission itself. Only a passkey on a trusted device signs
  a control message (CONTROL.md); the receiver holds no key, so neither does a plugin.
- It is code running in the receiver process with everything that process has: the
  state dir, the network, the machine. The Views page and `plugin add` say so. Tell
  people what yours does.

## A plugin in thirty lines

`plugin.json`:

```json
{
  "id": "needs-you-log",
  "name": "Needs-you log",
  "version": "0.1.0",
  "kind": "plugin",
  "api": 1,
  "settings": [
    { "key": "file", "label": "Log file", "type": "string", "default": "~/needs-you.log" },
    { "key": "token", "label": "Webhook token", "type": "secret", "help": "Optional; sent as a bearer." }
  ]
}
```

`index.js`:

```js
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";

export default {
  async activate(api) {
    const seen = new Set();
    const file = () => api.settings.get().file.replace(/^~/, homedir());
    const off = api.events.subscribe((m) => {
      if (m.kind !== "event" && m.kind !== "session") return;
      const s = m.session;
      for (const a of s.openAttentions) {
        if (seen.has(a.attentionId)) continue;
        seen.add(a.attentionId);
        const line = `${a.at} ${s.machine ?? "?"} ${a.kind} ${a.tool ?? ""} ${a.message ?? ""} ${api.sessions.url(s.key)}\n`;
        appendFileSync(file(), line);
        api.log("info", "logged an attention", { session: s.key, kind: a.kind });
      }
    });
    api.log("info", "watching");
    return { deactivate: () => off() };
  },
};
```

Install it, then Reload on the Views page (or restart):

```sh
sessionpipe-gui plugin add ./needs-you-log      # copies the folder
sessionpipe-gui plugin link ./needs-you-log     # or: link it while you work on it
```

## The manifest

`plugin.json` sits beside the entry module.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `[a-z][a-z0-9-]{1,40}`. The folder name, the settings file name, the log prefix. |
| `name` | yes | Shown on the Views page. |
| `version` | yes | Yours; shown on the Views page. |
| `kind` | yes | `"plugin"`. (A view's `theme.json` has no kind; a skin's `skin.json` says `"skin"`.) |
| `api` | yes | The `PluginApi` version you wrote against (`1` today). The host refuses a plugin whose `api` is newer than its own. |
| `entry` | no | The ES module, relative to the folder; `index.js` by default. |
| `description` | no | One line for the Views page. |
| `settings` | no | The fields of the settings form (below). |
| `source` | — | Written by the host on install; leave it out. |

### Settings

Each entry of `settings` is `{ key, label, type, options?, default?, help? }`. The host
draws a form from it on the Views page, keeps the values in
`<stateDir>/plugins-settings/<id>.json` (mode 0600) and hands them to you with
`api.settings.get()`, defaults filled in. Saving works from the receiver machine only.

| `type` | Field | Value |
|---|---|---|
| `string` | text | string |
| `secret` | password | string. Listed as `"••••" + last 4`; the page never sees the value. The host masks it in your log lines too, but never log a token. |
| `number` | number | number |
| `boolean` | checkbox | boolean |
| `select` | dropdown over `options` | one of `options` |
| `multiselect` | checkboxes over `options` | a list from `options` |

`api.settings.onChange(fn)` fires with the new values after a save. A plugin that threw
in `activate` (no token yet, say) is started again after a save.

## The `PluginApi`

`activate(api)` is called once the module has loaded, after the server listens. Return
`{ deactivate }` (may be async); the host calls it on reload and at shutdown. Stop
everything in it: subscriptions, timers, waits.

| Member | What it is |
|---|---|
| `version` | `1`. |
| `host` | `{ name: "sessionpipe-gui", version, urls: { local, lan[], https? } }`. |
| `manifest` | Your `plugin.json` as installed (with `source`). |
| `log(level, msg, data?)` | To the host's stderr as `[plugin:<id>] level: msg {json}`. |
| `settings.get()` | The current values, defaults under them. `onChange(fn)` → unsubscribe. |
| `events.subscribe(fn)` | `fn(message)` for every `StreamMessage` (`shared/api.ts`): `event` (with the session after applying it), `session` (a reading changed: state, flags, attentions), `forgotten`, `machine`, `stats`, `control` (a control message moved: queued → taken → delivered). Returns the unsubscribe. A listener that throws is logged; the stream goes on. |
| `events.snapshot()` | The current `Snapshot`: every session, machine, the stats, open suggestions. |
| `sessions.get(key)` | One `SessionSummary` or `undefined`. |
| `sessions.url(key)` | The session page a phone can open: the https origin with TLS mode on, else the first LAN URL; with the UI key. |
| `suggest({ session, attentionId, decision, by, note? })` | Advice on an open, answerable permission. Streamed to every page, shown beside the prompt, dropped when the attention closes. Throws when the attention is not open, is not a permission, or is a notification twin nobody can answer. |
| `storage.get()` / `storage.set(value)` | One JSON document per plugin under `<stateDir>/plugins-storage/`, at most 256 KB. `get()` is `null` until the first `set`. |
| `fetch` | The host's `fetch`. |

### Reading the stream

A `session` or `event` message carries the session summary *after* the event: its
`state` (`needs_you`, `working`, `stale`, `idle`, `done`), `openAttentions` (each with
`attentionId`, `kind`, `tool`, `message`, `at`, and `answerable` on a permission a
control answer can reach), `flags` (`slow_tool`, `error_streak`, `loop`, `compacting`,
`gap`), `currentTool`, `machine`, `title`. Keep your own `Set` of attention ids you acted
on: a session repeats its open attentions on every message until they close.

A `control` message carries a `ControlActivity`; `outcome: "delivered"` means the machine
took a message a person sent (a prompt, an answer) and the harness has it.

## Suggesting an answer

```js
const r = await channel.awaitReply({ timeoutMs: 120_000 });   // whatever your channel is
if (r.status === "answered" && (r.answer === "Allow" || r.answer === "Deny")) {
  api.suggest({
    session: s.key,
    attentionId: a.attentionId,
    decision: r.answer.toLowerCase(),
    by: r.respondent.name ? `${r.respondent.name} on Telegram` : "Telegram",
  });
}
```

The suggestion is advice. Nothing reaches the machine until a person on a trusted
device taps Confirm, which signs and sends the usual answer. If the prompt was answered
in the terminal meanwhile, the suggestion disappears with it.

## Bundling

The host is Node ≥ 20, ESM. A plugin with dependencies is bundled to one file, so the
installed copy needs no `node_modules` (the installer leaves them out):

```sh
npx esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 \
  --external:node:* --outfile=dist/index.js
```

and `"entry": "dist/index.js"` in `plugin.json`. The reference plugin, ping-a-human
(`sessionpipe-gui-themes/packages/plugin-ping-a-human`), is built this way; a type-only
copy of the contract is `@sessionpipe-gui/theme-types/plugin-api` in that repo.

## Install, link, list, remove, reload

```sh
sessionpipe-gui plugin add ./my-plugin                 # a folder: copied
sessionpipe-gui plugin add my-plugin-0.1.0.tgz         # an archive: extracted
sessionpipe-gui plugin add @you/sessionpipe-plugin-x   # an npm package name
sessionpipe-gui plugin add https://github.com/you/x.git
sessionpipe-gui plugin link ./my-plugin                # a link (a symlink, or a junction on Windows), for development
sessionpipe-gui plugin list
sessionpipe-gui plugin remove my-plugin
```

The id comes from the plugin's own `plugin.json`; the installed copy records `source`.
`--state DIR` (or `--plugins-dir DIR`) chooses the folder. The server imports at boot and
on **Reload plugins** on the Views page (`POST /api/ui/plugins/reload`, from the receiver
machine only), which calls every `deactivate`, re-reads the folder and imports afresh,
so a linked plugin shows its edits without a restart.

Routes: `GET /api/ui/plugins` → `{ plugins: InstalledPlugin[] }` (status, error, masked
values); `PUT /api/ui/plugins/:id/settings` `{ key: value }` → `{ settings }` (loopback);
`POST /api/ui/plugins/:id/enable|disable` → `{ plugins }` (loopback).

## Bundled plugins start off

ping-a-human ships with the GUI (`dist/bundled/plugins/ping-a-human/`, copied from the
themes repo at build time) and is listed with `bundled: true`, `source: "bundled"` and
`disabled: true`. A bundled plugin is never activated until the person enables it (the
Enable button on the Views page, or `sessionpipe-gui plugin enable ping-a-human`, which
puts `plugin:ping-a-human` in `config.json` `enabled`): it runs code in the receiver and
reaches out to Telegram, so nothing happens unasked. `plugin disable <id>` turns any
plugin off (`disabled` in `config.json`; the host calls its `deactivate`); a bundled one
cannot be removed, and `plugin add` of a package with the same id overrides it.

## Demo mode never runs plugins

`sessionpipe-gui --demo` exists to look at the UI with synthetic sessions. Plugins are
not activated in that mode (the listing reports `demo: true` and the Plugins section
says so), because a plugin may reach outside the machine: nobody wants a Telegram
message about a pretend prompt from a throwaway server. Test a plugin against real
events on a scratch state dir without `--demo`, or with its own `dryRun` setting.

## Rules of the house

- Never block the host: no synchronous waits, no long loops. `await` your channel, and
  make `deactivate` cancel what is waiting.
- Never log a token. Settings of type `secret` are yours to keep quiet.
- Debounce: a session repeats its open attentions; act once per `attentionId`.
- Suggest, do not act: a plugin that could answer a permission by itself would be a
  key without a person. There is no such api, on purpose.
- Say what it does, and from where. People are told, when they install it, to install
  only what they trust.
