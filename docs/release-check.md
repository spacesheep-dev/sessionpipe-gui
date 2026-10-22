# Release check · 0.1.0

The pre-publication review of `sessionpipe-gui` and `sessionpipe-gui-themes`, run on
2026-10-15 against the working trees and the full git history of both. Every row names
the command, so the check can be run again before the push.

Legend: ✔ passed · ✘ failed · ◐ passed with findings (listed) · — not run (reason given).

## 1. Secrets

| Check | GUI | Themes | Command |
|---|---|---|---|
| gitleaks, full history | ◐ 5 hits, all fake test values (`secret-abcd1234`, mock `uik_2f9c1e7a`, an e2e flag name) | ✔ none | `gitleaks detect --source . --redact -v` |
| gitleaks, working tree | ◐ same fakes + the built copy in `dist/` (ignored) | ✔ none | `gitleaks detect --source . --no-git --redact` |
| Telegram bot token `\d{8,10}:[A-Za-z0-9_-]{35}` | ✔ none | ✔ none; the test uses `123456:ABC-very-secret-token` | `git log -p --all \| grep -nE …` |
| Sink tokens `spg_…` / `ss_…` / `mt_…` | ✔ only `spg_test_sink_token_0123456789`, `spg_not_the_token`, `spg_…` | ✔ none | same |
| UI keys in `?k=` URLs, `Bearer …`, `whsec_`, private keys, passkey SPKI | ✔ none | ✔ none | same |
| Owner's e-mail | ✔ none in code or docs (only the git author, a GitHub noreply address) | ✘→✔ `misha@fictiontribe.com` and a personal Gmail address in `packages/canvas/dev/mock.ts` (commit `a57c581`); replaced with `example.com` addresses | `git grep -nE 'misha@\|fictiontribe\|gmail'` |
| LAN IPs `192.168.1.*` | ◐ test fixtures use `192.168.1.9`, `192.168.1.21`, `192.168.7.x` (placeholders); the README shows `192.168.1.20` as an example | ◐ `192.168.1.24`, `.31` in the canvas mock (fictional) | `git grep -nE '192\.168\.'` |
| Hostname `Misha-Petrov-laptop` | ✘→✔ `server/setup/setup.test.ts` (commit `b14365f`) and `server/tls/tls.test.ts` (`100ade1`); replaced with `Build-Box` | ✔ none | `git grep -ni 'misha-petrov-laptop'` |
| Home path `/Users/mishapetrov` | ✘→✔ `server/store/paths.test.ts` (commit `e34d616`); replaced with `/Users/alex` | ✔ none (the canvas mock uses the fictional `/Users/misha/…`) | `git grep -n '/Users/mishapetrov'` |
| Real client / personal repo names in demo data | ✘→✔ `web/src/mock/world.ts` (commit `1f1754e`) named `github.com/fictiontribe/*`, `github.com/tackleai/*`, `github.com/micmmakarov/spacesheep`; replaced with `acme/*` and `spacesheep-dev/spacesheep`, cwds renamed to match | ✔ only `spacesheep-dev/*` | `git grep -nE 'fictiontribe\|tackleai\|micmmakarov'` |
| Scratchpad paths, agent chatter | ✔ none (`/private/tmp/claude`, `scratchpad`, `claude-502`: no hits) | ✔ none | `git grep -niE 'scratchpad\|claude-502\|/private/tmp/claude'` |
| Screenshots (each viewed) | ◐ all 12 are from `--demo` data (`build-box`, `studio-mac`, `acme/*`). `connect-*.png` and `machines-*.png` show the LAN URL of the shooting machine at the time, `http://192.168.1.121:7311/?k=-x6rCUfy3UrgOHVF`: the port is the e2e port and the key is **not** the live UI key (compared against `~/.local/state/sessionpipe-gui/config.json`), so it was the throwaway e2e state's key. The IP is a DHCP address that has since changed. Low risk; re-shoot when the screenshot set is redone (the README already references a new set that is not committed yet). `og.png` and `swatches.png` are clean. | ✔ `swatches.png` clean | `Read` each `docs/screenshots/*.png` |
| `dist/`, `test-results/`, `playwright-report/`, `.tmp/`, logs tracked? | ✔ none tracked | ✔ none tracked | `git ls-files \| grep -E 'dist/\|\.log$\|test-results\|playwright-report'` |
| `package-lock.json` registries | ✔ only `https://registry.npmjs.org` | ✔ same | `grep -oE '"resolved": "https?://[^/]+' package-lock.json \| sort \| uniq -c` |
| `plugin-ping-a-human` embeds no token | ✔ the token comes from `configPath` or the masked `type: "secret"` setting; the test token is a fake | | `git grep -n botToken packages/plugin-ping-a-human/src` |

**History.** The fixed items above are still in git history (`e34d616`, `b14365f`,
`100ade1`, `1f1754e` in the GUI; `a57c581` in the themes repo). None is a credential: a
hostname, a home directory, demo repo names and two e-mail addresses. No token, key or
certificate was ever committed to either repo. Two ways to publish clean:

- **Fresh history** (simplest for a first public push): `git checkout --orphan public && git commit -s -m "sessionpipe-gui 0.1.0"`, push that as `main`.
- **Rewrite** (keeps the 33 / 12 commits): with [`git filter-repo`](https://github.com/newren/git-filter-repo) and a `replacements.txt` of
  ```
  Misha-Petrov-laptop==>Build-Box
  misha-petrov-laptop==>build-box
  /Users/mishapetrov==>/Users/alex
  misha@fictiontribe.com==>dev@example.com
  misha.petrov@gmail.com==>dev.home@example.com
  github.com/fictiontribe/right2hope==>github.com/acme/charity-site
  github.com/fictiontribe/ft-brand-skill==>github.com/acme/brand-kit
  github.com/fictiontribe/mattermost-cloudcannon==>github.com/acme/marketing-site
  github.com/tackleai/tackleai-ui==>github.com/acme/ui-kit
  github.com/tackleai/elemonator==>github.com/acme/doc-extractor
  github.com/micmmakarov/spacesheep==>github.com/spacesheep-dev/spacesheep
  ```
  run `git filter-repo --replace-text replacements.txt` in a fresh clone of each repo, then force-push.

## 2. Rotation list for the owner

Nothing secret was committed, so nothing *must* rotate on account of the repos. Rotate
anyway if any of these was ever pasted into a chat, a screenshot or a scratch file:

| Credential | How |
|---|---|
| Sink token (`spg_…`) | Connect page → *Rotate*, or `curl -X POST http://localhost:7373/api/ui/token/rotate` from the receiver machine; then `sessionpipe sink add … --token <new>` on every sending machine |
| UI key (`?k=`) | delete `uiKey` from `~/.local/state/sessionpipe-gui/config.json`, restart; re-scan the QR on every phone |
| Telegram bot token | BotFather → `/revoke`, then `npx ping-a-human setup` again |
| TLS CA (`~/.local/state/sessionpipe-gui/tls`) | `sessionpipe-gui tls reset`; re-trust on each phone (not committed anywhere; listed for completeness) |

## 3. Hygiene

| Check | GUI | Themes |
|---|---|---|
| `.gitignore` covers node_modules, dist, coverage, test-results, playwright-report, .tmp, logs, .DS_Store | ✔ (+ `.env`, `.env.*` added) | ✔ (+ `.env`, `.env.*` added) |
| LICENSE Apache-2.0, NOTICE | ✔ | ✔ NOTICE added (was missing) |
| Trademark wording matches upstream `TRADEMARKS.md` | ✔ README and `docs/brand.md` use the allowed "receiver that speaks the sessionpipe protocol", name the marks as Michael Makarov's, link TRADEMARKS.md, and claim no endorsement | ✔ via NOTICE |
| Third-party notices | ✔ simple-icons (CC0) credited in `harnessIcons.ts` and `docs/brand.md`; Inter (OFL) credited in `brand.md` and the SVGs; no font files tracked | ✔ ping-a-human (MIT) notice added: `packages/plugin-ping-a-human/THIRD_PARTY_NOTICES.md`, shipped in `files`, cited in README and NOTICE. No skin package ships (the two skins are built in and bundle no font) |
| `package.json`: name, version, description, license, repository, files, engines, no postinstall | ✔ `repository`, `homepage`, `bugs` added (URL assumes the `spacesheep-dev` org: confirm) | ✔ `repository` + `directory` added to every package; root and `color-themes` are `private` by design |
| `npm pack --dry-run` ships only what it should | ✔ 29 files, 496 kB packed: `dist/` without source maps (`files` excludes `dist/**/*.map`; `npm run pack:check` fails on one), the bundled views, README, LICENSE, NOTICE | ✔ each package: `dist/`, manifest, README (+ DESIGN.md for office, + THIRD_PARTY_NOTICES.md for the plugin); no tests, no dev harness, no screenshots except `swatches.png` in color-themes (intended) |
| CODE_OF_CONDUCT.md (Contributor Covenant 2.1) | ✔ added | ✔ added |
| SECURITY.md (reporting, scope, the control-channel model) | ✔ added | ✔ added (points to the GUI's) |
| CONTRIBUTING.md (DCO, tests, how to add a view/skin/plugin) | ✔ rewritten | ✔ added |
| `.github/`: CI (install, typecheck, lint, vitest, build, Playwright chromium on ubuntu, npm cache, no keychain steps), issue templates (bug, feature, extension), PR template with DCO, dependabot | ✔ added | ✔ added (bug, feature) |
| CHANGELOG.md 0.1.0 stub | ✔ added | ✔ added |
| Docs free of internal chatter | ✔ `ARCHITECTURE.md` "to the lead" → "or an issue", owner label `lead` → `core`; `Select.tsx` header "the owner's rule" → "house rule". "Misha on Telegram" / "Misha's iPhone" / `misha-air` remain as demo persona names (not a hostname, e-mail or path); rename if the owner prefers | ✔ `packages/office/DESIGN.md` "until the owner picks" → "until the person picks" |
| SPDX header on every `.ts/.tsx/.mjs/.css` | ✔ added to `server/http/router.test.ts`, `vitest.config.ts`, `web/vite.config.ts` (all others had one) | ✔ added to `packages/color-themes/scripts/check.mjs` (all others had one) |
| README screenshots resolve | ✘ README links `docs/screenshots/{board,setup,session-simple,…}.png`; the tracked files are `*-desktop.png` / `*-phone.png`. An untracked `docs/screenshots/README.md` describes the new set; commit the images with it or point the README at the current names | — |

## 4. Gates (after the edits above)

| Gate | GUI | Themes | Command |
|---|---|---|---|
| Typecheck | ✔ | ✘ `packages/canvas/dev/mock.ts(746)`: `SessionSummary` gained `flags`, `turnStats` in the concurrently edited `shared-types/theme-api.ts`; not from this review | `npm run typecheck` |
| Biome | ✘ pre-existing: `scripts/dev.mjs` (useOptionalChain), `server/http/router.ts` (noConfusingVoidType), `web/src/styles/app.css` ×15 (noDescendingSpecificity), `base.css` ×5 (noImportantStyles); none in files this review touched | ✘ pre-existing: `packages/office/src/office.css` ×2, `plugin-ping-a-human/src/index.ts:216`; none in files this review touched | `npm run lint` |
| Vitest | ✔ 23 files, 324 tests | — (no vitest; see Tests) | `npm test` |
| Build | ✔ (bundled views from `../sessionpipe-gui-themes`) | ✔ | `npm run build` |
| Tests | — | ✔ canvas Playwright 32 passed, 1 flaky (`phone.spec.ts` on retry); plugin `node --test` passed; color-themes checker passed | `CI=1 npm test` |
| Playwright e2e (`:7311` / `:7312`, both free) | ◐ 94 passed, 17 skipped, 1 flaky (`feed.spec.ts`, in-flight edits), 2 failed in the **untracked** `test/e2e/skins.spec.ts` (in-flight skins work) | — | `CI=1 npm run test:e2e` |
| Control e2e | — not run (long; the CI workflow runs it) | | `npx playwright test -c web/e2e/playwright.config.ts` |

`:7373` (a running instance) was never used or restarted.
