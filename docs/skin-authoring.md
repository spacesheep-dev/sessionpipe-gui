# Writing a skin

A skin restyles the GUI without code: the colours, the typeface, the corner radius, the
weight of the hairlines, how tall a row is, and, when that is not enough, one stylesheet
of your own. It is a folder with a `skin.json`, kept **outside** the GUI under the state
dir (`~/.local/state/sessionpipe-gui/skins/<id>/`), served by the GUI at `/skins/<id>/`
and picked from the appearance popover (the gear on the rail, or *Display* in the
phone's More sheet). Skins are one of three kinds of extension the same installer
handles; the others are views (pages, `theme-authoring.md`) and plugins (server-side
code, `plugin-authoring.md`). A skin runs no code, so it is the one kind a person can
install without trusting its author with their sessions.

The contract is `shared/skin-api.ts`; this page explains it. The GUI ships with two
skins (sessionpipe, the default, and Paper; Plain, the stock tokens, is the base and never
listed); yours are listed under *Installed* beside them.

## A skin in ten lines

`skin.json`:

```json
{
  "id": "mint",
  "name": "Mint",
  "version": "0.1.0",
  "kind": "skin",
  "api": 1,
  "scheme": "light",
  "tokens": { "--bg": "oklch(0.975 0.012 160)", "--fg": "oklch(0.24 0.03 170)", "--needs": "oklch(0.7 0.15 65)" }
}
```

```sh
sessionpipe-gui skin add ./mint     # copies the folder under <stateDir>/skins/mint
sessionpipe-gui skin link ./mint    # or: symlink it while you work on it
```

Open the appearance popover and pick **Mint**. No restart: the server re-reads the
folder on every open of the popover from the receiver machine (`POST /api/ui/skins/reload`)
and lists it at `GET /api/ui/skins` for every device.

## The manifest

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `[a-z][a-z0-9-]{1,40}`. The folder name and the key the choice is stored under. The built-in ids are taken. |
| `name` | yes | Shown in the popover (1–60 chars). |
| `version` | yes | Yours; shown by `skin list`. |
| `kind` | yes | `"skin"`. (A view's `theme.json` has no kind; a plugin's `plugin.json` says `"plugin"`.) |
| `api` | yes | The skin contract version you wrote against (`1` today). The host refuses a skin whose `api` is newer than its own. |
| `scheme` | yes | `"dark"`, `"light"` or `"both"`. A single-scheme skin forces that scheme while applied (the Appearance control is set by it); a `"both"` skin follows the appearance setting and carries one token set per scheme. |
| `tokens` | yes | The custom properties to set (below). A flat map for `"dark"` / `"light"`; `{ "dark": {…}, "light": {…} }` for `"both"`. May be empty. |
| `fonts` | no | Font files inside the package, declared as `@font-face` rules (below). |
| `typography` | no | `ui` and `mono`: the two font stacks; `scale`: a root font-size multiplier, 0.9–1.15. |
| `shape` | no | `radius` (px, 0–24), `hairline` (1, 1.5 or 2), `density` (`compact`, `default`, `comfortable`). |
| `css` | no | A stylesheet inside the package, linked **after** the app's own. |
| `preview` | no | An image inside the package (png, jpg, webp, svg) for listings and READMEs. |
| `description` | no | One line. |
| `source` | — | Written by the host on install; leave it out. |

Every path is relative and must stay inside the folder; the host checks each file exists
when it installs and when it scans. A skin whose manifest is wrong is still listed, with
its error, so the problem shows instead of the skin vanishing.

## Tokens

The GUI draws everything from the custom properties in `web/src/styles/tokens.css`, and
so does every view (`api.tokens` hands them the same names). A skin sets any subset of
the **colour tokens**; the scheme's defaults fill the rest:

| Role | Tokens |
|---|---|
| Surfaces | `--bg` (page), `--bg-2` (card), `--bg-3` (inset, hover), `--bg-4` |
| Hairlines | `--line`, `--line-2` |
| Text | `--fg` (body), `--fg-2` (secondary, ≥ 7:1 on the page), `--fg-3` (meta, ≥ 5:1), `--fg-4` (marks, ≥ 3:1) |
| Needs you | `--needs` (the accent), `--needs-fg`, `--needs-bg`, `--needs-line`, `--needs-ink` (text on a `--needs` fill) |
| The phone's tint | `--tint` (a glyph or a fill: the selected tab, a switch, the slider), `--tint-fg` (the same as words: the back button, links); the stock skins set both to the brand orange |
| State colours (views that colour-code) | `--state-working`, `--state-working-bg`, `--state-stale`, `--state-stale-bg` |
| Working / stale / idle / done shades | `--work`, `--work-fg`, `--work-bg`, `--work-line`, `--stale`, `--stale-fg`, `--stale-bg`, `--idle`, `--idle-fg`, `--done`, `--done-fg` |
| Outcomes | `--ok`, `--err`, `--err-soft`, `--err-bg` |
| Other | `--focus` (the ring), `--mark`, `--mark-fg` (search hits), `--shadow`, `--qr-bg`, `--qr-fg` |

Values are plain CSS colours (`oklch(…)`, `#hex`, `rgb(…)`, a keyword): no `url()`, no
braces, no semicolons. Keep the text tiers at their floors on the page and the card
(`--fg` ≥ 7:1, `--fg-2` ≥ 5:1, `--fg-3` ≥ 4.5:1 for the 12–13 px meta text, `--fg-4`
≥ 3:1, marks only, each on `--bg` and `--bg-2`). The server measures them when it lists
a skin (`shared/contrast.ts`; oklch, hex and rgb values; a token you leave unset is
measured against the stock scheme's) and reports a shortfall in the skin's `warning`
("low contrast: --fg-3 on --bg 3.9:1, needs 4.5"), shown in the popover's row; the skin
still applies. The themes repo's `packages/color-themes/scripts/check.mjs` measures a
whole token set, with more pairs.

The `tokens` map may also set the five **style tokens** directly, which is what the
structured fields do for you: `--font-ui`, `--font-mono`, `--radius`, `--radius-sm`,
`--hairline`. Prefer `typography` and `shape`; the host validates those.

How the page applies a skin (`web/src/lib/skins.ts`): every token a skin may set is first
cleared from `<html>`, then the set for the scheme in force is written, so switching skins
never leaves a stray value behind. `<html>` carries `data-skin="<id>"` and
`data-skin-scheme="dark|light"` while it is on.

## Fonts

```json
"fonts": [
  { "family": "Literata", "src": "fonts/Literata-Variable.woff2", "weight": "200 900" },
  { "family": "Literata", "src": "fonts/Literata-Italic-Variable.woff2", "weight": "200 900", "style": "italic" }
],
"typography": { "ui": "\"Literata\", Georgia, serif", "scale": 1.05 }
```

Each entry becomes one `@font-face` rule in a `<style id="skin-fonts">` the host keeps in
`<head>`: `font-family` from `family`, `src: url(/skins/<id>/<src>) format(…)` from the
file's extension (woff2, woff, ttf, otf), `font-weight` from `weight` (`"400"`, `"600"`,
or a range for a variable font; default `"400"`), `font-style` from `style` (`normal`,
`italic`; default `normal`), and `font-display: swap`. The files are served
`public, max-age=31536000, immutable`, so give a changed font a new file name.

`typography.ui` is the `--font-ui` stack the whole interface uses; `typography.mono` is
`--font-mono` (code, stamps, the feed's ids). Name your bundled family first and a system
fallback after it. `typography.scale` multiplies the root font size (the person's own
text-size setting stacks on top): a serif that sets small wants `1.05`; keep it within
0.9–1.15 so the layout's px-based parts (the rail, the row heights) still fit the text.

Bundle only fonts whose licence allows it (the SIL Open Font License does; keep the
licence file in the package). The GUI itself loads no font from the network, and neither
can a skin: a `src` must be a file in the folder.

## Shape

| Field | Sets | Notes |
|---|---|---|
| `radius` | `--radius` and `--radius-sm`, in px | `6` is the stock value; `2` reads sharp, `12` soft. Pills (`--radius-pill`) stay round. |
| `hairline` | `--hairline` | `1` (stock), `1.5` or `2`: every rule and border that is a hairline today (`var(--hairline) solid var(--line…)`). On a 1× display `1.5` paints as 2. |
| `density` | `data-density` on `<html>` | `compact` (rows 28 / 32 / 36 px), `default` (32 / 36 / 40), `comfortable` (36 / 40 / 44), with the padding between settings rows following (4 / 8 / 12). `app.css` maps the attribute to `--row-sm`, `--row`, `--row-lg` and `--row-pad`. |

## Your own stylesheet

`"css": "skin.css"` links the file into `<head>` as `<link id="skin-css">`, after the
app's stylesheets, so on equal specificity yours wins. It is removed when another skin is
picked. Advice:

- Scope every rule to your skin: `html[data-skin="mint"] .card { … }`. The attribute is
  on `<html>` only while your skin is on, and the rule then also wins on specificity.
- Use the tokens, not literal colours, so your rules hold in both schemes
  (`html[data-skin="mint"][data-skin-scheme="dark"] …` when a scheme needs its own rule).
- Change paint, not layout: colours, borders, shadows, backgrounds, type. Moving or
  hiding things breaks the keyboard paths and the phone layout the suite checks.
- No `@import`, no `url()` to anywhere but your own folder; nothing else loads.
- A linked skin's stylesheet and `skin.json` are served `no-cache`, and the page re-links
  the css with a fresh query string, so an edit shows after the popover is opened again
  (the list is re-read then) or on the next page load.

## Install, link, list, remove

```sh
sessionpipe-gui skin add ./my-skin                 # a folder: copied
sessionpipe-gui skin add my-skin-0.1.0.tgz         # an archive: extracted (tar / unzip)
sessionpipe-gui skin add https://…/my-skin.zip     # downloaded, then extracted
sessionpipe-gui skin add sessionpipe-skin-mint     # an npm package name (npm install, then copied)
sessionpipe-gui skin add https://github.com/you/mint.git
sessionpipe-gui skin link ./my-skin                # a symlink: edits show on the next open of the popover
sessionpipe-gui skin list
sessionpipe-gui skin remove mint
```

The id always comes from the skin's own `skin.json`; the installed copy records where it
came from in `source`. `--state DIR` (or `--skins-dir DIR`) chooses the folder. The
server reads it at boot and on `POST /api/ui/skins/reload` (loopback: the appearance
popover asks for it when opened on the receiver machine).

The GUI ships two skins, built in (`shared/skins-builtin.ts`): sessionpipe, the default, in
both schemes, and Paper, light only. No skin package ships with it. The folder
`dist/bundled/skins/<id>/` still works for a distribution that wants one: a skin there is
listed after the person's own with `bundled: true` and `origin: "bundled"`, `skin add` of
the same id overrides it, and it cannot be removed, only hidden: `sessionpipe-gui skin
disable <id>` (`skin:<id>` in `config.json` `disabled`; its files are not served
meanwhile), `skin enable` shows it again. Any skin can be disabled the same way.

A plain **color-theme file** still works: `<stateDir>/color-themes/<id>.json` with `id`,
`name`, `scheme` (`dark` or `light`) and `tokens` ([`color-theme.example.json`](color-theme.example.json)).
It is listed with the skins as a token-only skin (`source: "color-theme"`), with no
fonts, shape or css. Turning one into a skin is adding `"kind": "skin"`, `"version"` and
`"api": 1` and putting it in a folder named after its id.

## The preview

`"preview": "preview.png"` names an image for listings; the GUI does not render it yet,
READMEs do. Render one with Playwright against a GUI in demo mode: link the skin into a
scratch state dir, start `sessionpipe-gui --demo` on a spare port, open Display, pick the
skin, screenshot the board at 1280 × 800.

## Choosing and storing

The choice is per device, in `localStorage` under `sessionpipe-gui.skin`, the whole
skin (not only its id) so it applies at boot before any request. A device that never
chose gets sessionpipe, and so does one that had Spacesheep, the default before the
brand (moved once, silently). A device that chose a color theme before skins existed
(`sessionpipe-gui.colorTheme`) keeps that choice: the old key is read once and rewritten
under the new one. When the list arrives with a newer copy of the applied skin (a linked
skin you edited), that copy is applied and stored.

`Shift+T` steps to the next skin; the appearance toggle on a single-scheme skin first
steps to the first skin that follows the appearance.

## Rules of the house

- Keep the text tiers at their floors (above); the token checker in the themes repo
  tells you where a set is short.
- One accent. sessionpipe's is its orange; whatever yours is,
  `--needs*` is where it lives, and it stays the loudest colour on a page.
- Change what a skin is for: colour, type, shape, density. A page that needs new
  behaviour is a view.
- Nothing loads from outside the folder; the host refuses anyway.
