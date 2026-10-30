# Contributing

Thanks for looking. This is a small project with a clear shape; the quickest way to a
merged change is to keep to it.

## The paperwork

- **DCO, not CLA.** Sign off every commit (`git commit -s`), which adds
  `Signed-off-by: Your Name <you@example.com>` and certifies the
  [Developer Certificate of Origin](DCO). Use a real name and an address you control;
  a GitHub `noreply` address is fine.
- **License.** Everything is Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). Every
  source file (`.ts`, `.tsx`, `.mjs`, `.css`) starts with
  `// SPDX-License-Identifier: Apache-2.0` (or the `/* … */` form in CSS).
- **Conduct.** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports go through
  [SECURITY.md](SECURITY.md), never a public issue.

## Running it

```sh
nvm use                 # Node 22 (anything ≥ 20 works)
npm install
npm run dev             # server on :7373 (rebuilt on change) + Vite on :5173 proxying to it
npm run build           # dist/ (server) + dist/web (app)
npm start -- --demo     # the built server with synthetic sessions
```

The gates a PR must pass, the same ones CI runs:

```sh
npm run typecheck       # both tsconfigs
npm run lint            # biome check .
npm test                # vitest: store, receiver, control, conformance, demo, tls, plugins, ui
npm run build
npm run test:e2e        # playwright: a built server in demo mode on :7311 / :7312, desktop and phone
```

The e2e suite never touches :7373, so it runs beside a GUI you have open. The control
e2e (`npx playwright test -c web/e2e/playwright.config.ts`) boots its own server on a
free port. `SHOTS=1 npx playwright test screenshots` writes the README screenshots from
demo data; never commit a screenshot taken from a real state dir.

## A good PR

- One concern per PR, the smallest diff that does it, in the repo's style (Biome
  formats; hand-written CSS on the design tokens; no component library).
- Tests beside the code (`*.test.ts`) or under `test/`; a UI change comes with a
  Playwright assertion and a screenshot in the description.
- Module ownership and the contracts between modules are in
  [ARCHITECTURE.md](ARCHITECTURE.md). A change to `shared/api.ts` is a change to the wire
  contract: say so in the PR and update both sides.
- No telemetry, no outbound request from the server, nothing in the web bundle that
  calls anywhere but its own origin.
- Secrets never land in the repo: tests use obvious fakes (`spg_test_…`, `uik_…`),
  fixtures use `example.com`, `acme/*` repos and `10.0.0.x` / `192.168.1.x` addresses.

## Adding a view, a skin or a plugin

The official ones live in
[sessionpipe-gui-themes](https://github.com/spacesheep-dev/sessionpipe-gui-themes); a
PR there is the normal route. Each kind has an authoring guide in this repo:

| Kind | What it is | Guide |
|---|---|---|
| View | An ES module beside a `theme.json`, drawn on a page of the GUI with the `ThemeApi` (`shared/theme-api.ts`) | [docs/theme-authoring.md](docs/theme-authoring.md) |
| Skin | Tokens, fonts, radius, density and an optional stylesheet in a `skin.json`; no code | [docs/skin-authoring.md](docs/skin-authoring.md), [docs/color-theme.example.json](docs/color-theme.example.json) |
| Plugin | Server-side code in the receiver process with the `PluginApi` (`shared/plugin-api.ts`) | [docs/plugin-authoring.md](docs/plugin-authoring.md) |

Develop against a running GUI with `sessionpipe-gui view link <folder>` (or `skin link`,
`plugin link`), and keep the house rules: hairlines, the host's tokens by name, amber
only for *needs you* (the phone's tint, `--tint`, is the shell's own; a view never spends
it), `prefers-reduced-motion` honoured.

## Changelog

Add a line under *Unreleased* in [CHANGELOG.md](CHANGELOG.md) for anything a person
running the GUI would notice.
