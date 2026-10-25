# Releasing sessionpipe-gui

One package, `sessionpipe-gui`, installed from GitHub for now (`npx github:spacesheep-dev/sessionpipe-gui`,
`npm i -g github:…`, or a clone); the npm package follows when the owner turns it on. It
carries every official extension: Canvas, Office and ping-a-human (the two skins are built
in), from the tracked copy in `bundled/`, refreshed from a checkout of
[sessionpipe-gui-themes](https://github.com/spacesheep-dev/sessionpipe-gui-themes) beside
this repo with `npm run bundle:sync` (the themes repo stays the source of truth; commit the
refreshed copy here). Nothing installs from npm: the `@sessionpipe-gui/*` packages need
not be published for a release of the GUI.

## Each release

1. `main` green (CI: typecheck, lint, unit, build, both Playwright suites).
2. `CHANGELOG.md` has a `## [X.Y.Z] - date` section (the *Unreleased* lines move under it;
   the compare links at the bottom get the new version).
3. The themes repo tagged at the version the catalogue names
   (`server/extensions/catalog.ts`), and `npm run bundle:sync` run against that checkout
   so `bundled/` carries it; `npm run pack:check` passes (no source maps, the five bundled
   extensions in, about 1.4 MB packed).
4. Version, tag, push (a clean tree; commits signed off):
   ```sh
   npm version minor -m "Release %s"      # package.json + lock, a commit, the tag v0.2.0
   git commit --amend -s --no-edit        # the DCO sign-off
   git push && git push --tags
   ```
5. The tag runs `.github/workflows/release.yml`: the tag must equal `package.json`'s
   version; `npm ci`, typecheck, lint, vitest, `build:release` (refuses to ship without the
   bundled extensions), `pack:check`; then a GitHub Release named after the tag with the
   changelog section as its notes and the tarball attached. A failed run is re-run once
   the cause is fixed.

Installs pin a tag with `npx github:spacesheep-dev/sessionpipe-gui#v0.2.0`; without one
they follow `main`.

## The install smoke test

On any machine (never the receiver on :7373 you are using):

```sh
npx --yes github:spacesheep-dev/sessionpipe-gui --version            # the version
npm i -g --prefix /tmp/x github:spacesheep-dev/sessionpipe-gui
/tmp/x/bin/sessionpipe-gui --help | grep extras                       # the subcommand is there
/tmp/x/bin/sessionpipe-gui --state /tmp/spgui-smoke --port 7399 --no-outbox --quiet &
curl -s http://localhost:7399/api/ui/themes | grep -o '"id":"\(canvas\|office\)"'          # both views
curl -s http://localhost:7399/api/ui/skins | grep -o '"id":"\(sessionpipe\|paper\)"'               # the two skins
curl -s http://localhost:7399/api/ui/plugins | grep -o '"disabled":true'                   # ping-a-human off
kill %1; rm -rf /tmp/x /tmp/spgui-smoke
```

Testing a global install from a local checkout: `npm i -g git+file://…` symlinks npm's
temporary clone instead of installing (an npm quirk for local git URLs), so pack first:
`npm pack git+file://$PWD && npm i -g --prefix /tmp/x ./sessionpipe-gui-*.tgz`.

On an old Node the first line must read `sessionpipe-gui needs Node 20 or newer (you have v18.x)`.

## Publishing to npm, when the time comes

The workflow already publishes with provenance through npm trusted publishing (no token
in this repo) once the repository variable `PUBLISH_NPM` is `true`:

1. The first publish is by hand (trusted publishing cannot create a package):
   `npm login`, then `npm publish --access public` (`prepublishOnly` runs `build:release`).
2. On npmjs.com, *sessionpipe-gui → Settings → Trusted Publisher → GitHub Actions*:
   organisation `spacesheep-dev`, repository `sessionpipe-gui`, workflow `release.yml`.
3. Set `PUBLISH_NPM` to `true` under *Settings → Variables*; the next tag publishes.
   Publish the themes repo's packages first if the catalogue should install from npm again.

No `NPM_TOKEN` secret is needed or read.
