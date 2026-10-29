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
   bundled extensions), `pack:check`; then a **draft** GitHub Release named after the tag
   with the changelog section as its notes and the tarball attached. A failed run is re-run
   once the cause is fixed. The draft goes out with the desktop app: *Desktop release*,
   then *Publish update* (The desktop app, below).
6. The phones, from the same tag: *Android release* (attaches the `.apk` to the draft, so
   run it before *Publish update*; uploads the `.aab` to Google Play on a track) and
   *iOS → TestFlight* (The Android app, The iOS app, below). Each waits for the `release`
   environment's approval.

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

## The desktop app

The macOS, Windows and Linux app (`apps/desktop`, a Tauri 2 shell around the same web UI)
ships with every release of the GUI: same version, same tag. Nothing builds or publishes it
on a push: three buttons under *Actions → Run workflow* do, each in the `release`
environment, so each run waits for the owner's approval before it can read a secret.

1. **Tag.** `release.yml` (step 5 above) makes the tag's GitHub Release as a **draft**.
2. **Desktop release** (`desktop-release.yml`; inputs `tag`, `platforms` all | macos |
   windows | linux, `notarize`). Builds into the draft: the macOS universal dmg (Developer
   ID, hardened runtime, notarized and stapled), Windows NSIS and MSI (unsigned for now),
   Linux AppImage and deb, every updater archive with its `.sig`, and `latest.json`. The
   macOS job runs `codesign --verify --deep --strict` and `spctl`, and fails unless it says
   *Notarized Developer ID*. It notarizes with the App Store Connect API key when its three
   `APPLE_API_*` secrets are set, else with `APPLE_ID` + `APPLE_PASSWORD` (an app-specific
   password), and fails when `notarize` is on and neither is there. With `notarize` off it
   signs without notarizing and says so in a warning at the top of the run's summary; such
   a build is for looking at, not for publishing. It refuses a release that is already
   published.
3. **Check the dmg on a clean Mac**: download it from the draft, open it, drag the app out,
   launch it. No Gatekeeper warning; it finds the local receiver.
4. **Publish update** (`publish-update.yml`; input `tag`). Checks that the draft has the
   dmg, `latest.json` and a `.sig` for every platform in it, and that every signature in
   `latest.json` verifies against the public key in `tauri.release.conf.json` (key id
   `5D71CED7E98EE42F`); then publishes the release as the latest. Installed apps read
   `releases/latest/download/latest.json`, which a draft never is, so this is the moment
   they see the update. Nothing else publishes a desktop release.

**iOS → TestFlight** (`ios-testflight.yml`; inputs `tag`, `upload`) runs any time after
the tag: it builds the iOS app with Xcode 26 (bundle id `dev.spacesheep.sessionpipe`, team
`QR7H8ARENW`, build number = the run number), signs it with the Apple Distribution
certificate and the *sessionpipe App Store* profile from a temporary keychain, exports and
checks an `.ipa` (app-store-connect, manual signing), keeps it as a workflow artifact,
uploads it with `xcrun altool` and waits until App Store Connect has processed it. The
keychain and keys are deleted at the end, pass or fail. Without a tag it is a dry run of
the branch it runs on: everything up to the upload.

### Once: the `release` environment and its secrets

*Settings → Environments → New environment* `release`, with the owner as a required
reviewer, and these secrets in it (names only here, never values; the owner sets them with
a private script outside the repo, and every workflow says which one is missing):

| Secret | What | How |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the updater's minisign key (id `5D71CED7E98EE42F`) | its **public** half is `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.release.conf.json`. Keep the private key backed up offline: losing it means no installed app can update again. The spike key in `tauri.conf.json` / `tauri.measure.conf.json` is for local tests and never signs a release |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | the Developer ID Application certificate | Keychain Access → export "Developer ID Application: Michael Petrov (QR7H8ARENW)" with its key as .p12, then `base64 -i cert.p12 \| pbcopy` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Michael Petrov (QR7H8ARENW)` | |
| `APPLE_TEAM_ID` | `QR7H8ARENW` | |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY` | an App Store Connect API key, for notarization (preferred) and the TestFlight upload | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys, role *App Manager* (it uploads builds and reads TestFlight; *Developer* only notarizes): the issuer id, the key id, and the downloaded `AuthKey_<id>.p8`'s text |
| `APPLE_ID`, `APPLE_PASSWORD` | the other way to notarize, used when the API key's three are not all set | the Apple ID of a member of team `QR7H8ARENW`, and an app-specific password made for it at account.apple.com → Sign-In and Security → App-Specific Passwords (never the account's own password) |
| `IOS_DIST_P12`, `IOS_DIST_P12_PASSWORD` | the Apple Distribution certificate with its key | export it from Keychain Access as .p12, base64 |
| `IOS_APPSTORE_PROFILE` | the *sessionpipe App Store* provisioning profile | the downloaded `.mobileprovision`, base64 |

Windows signing (Authenticode or Azure Trusted Signing) is not set up: SmartScreen warns
on the unsigned installer until it is.

### Building and signing on a Mac

```sh
npm run build                                   # dist/web and the bundled views
cd apps/desktop && npm ci
scripts/build-mac.sh --sign --out /tmp/sp-app   # arm64 .app + dmg, Developer ID, hardened runtime
scripts/build-mac.sh --sign --universal         # arm64 + x86_64 (≥ 11 GB free)
```

`build-mac.sh` assembles the frontend (`scripts/assemble-frontend.sh`: `dist/web` plus
Canvas and Office under `themes/`, no source maps), runs `tauri build` with
`tauri.release.conf.json` (product *sessionpipe*, `dev.spacesheep.sessionpipe`, the
`sessionpipe://` scheme, the GitHub updater endpoint) and the `identity` feature (the
Touch ID signer, as the release ships it), signs the dmg, and prints
`codesign -dv`, `codesign --verify --deep --strict` and `spctl -a -vv`. Until the app is
notarized, `spctl` says `rejected … source=Unnotarized Developer ID`: expected.

Never open a release build on a development Mac without `SP_RECEIVER_URL` set (it would
find the receiver on :7373), and never copy it to /Applications: opening it registers the
`sessionpipe://` scheme with LaunchServices. `--measure` builds the variant used for
measurements and tests: no URL scheme, identifier `dev.spacesheep.sessionpipe.dev-packaging`,
the updater pointed at `http://127.0.0.1:7830` with a throwaway key. Unregister any bundle
you launched: `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u <path>.app`.

### Notarizing by hand

CI notarizes through tauri-action. By hand, once, a person stores the credentials in the
login keychain under the profile `sessionpipe-notary` (an App Store Connect API key, or an
Apple ID with an app-specific password; nothing else ever asks for them):

```sh
xcrun notarytool store-credentials sessionpipe-notary --key AuthKey_<id>.p8 --key-id <id> --issuer <issuer>
# or: xcrun notarytool store-credentials sessionpipe-notary --apple-id <apple id> --team-id QR7H8ARENW
```

then for each dmg:

```sh
apps/desktop/scripts/notarize-mac.sh sessionpipe_X.Y.Z_aarch64.dmg
```

which checks the profile (`xcrun notarytool history --keychain-profile sessionpipe-notary`;
without it, it says so and changes nothing), then runs

```sh
xcrun notarytool submit sessionpipe_X.Y.Z_aarch64.dmg --keychain-profile sessionpipe-notary --wait
xcrun stapler staple sessionpipe_X.Y.Z_aarch64.dmg
spctl -a -vv -t open --context context:primary-signature sessionpipe_X.Y.Z_aarch64.dmg   # accepted, Notarized Developer ID
```

and prints `xcrun notarytool log <submission id> --keychain-profile sessionpipe-notary` for
a rejected submission. The ticket is stapled to the dmg; the app copied out of it is checked
online by Gatekeeper on first open.

### Checking a release

- `latest.json` is on the release, and its `version` is the tag without `v`.
- The macOS dmg is under 10 MB (the budget: 17 MB universal at most), opens without a
  Gatekeeper warning, and holds only the app and an Applications link.
- An installed older version finds the update within a minute of launch (Settings › App
  says "Restart to Update"), and restarts into the new one.
- `apps/desktop/scripts/measure.sh` against the built app stays inside NATIVE-SPEC §8.

## The iOS app

`apps/mobile` on iOS is one App ID with the Mac app: **`dev.spacesheep.sessionpipe`**, team
**`QR7H8ARENW`**, one capability (*Time Sensitive Notifications*,
`com.apple.developer.usernotifications.time-sensitive`, in
`sessionpipe-shell_iOS.entitlements`). No Push, App Groups, Keychain Sharing or Associated
Domains. Signing is manual, by profile name (`project.yml` and the pbxproj):

| Configuration | Certificate | Profile | For |
|---|---|---|---|
| debug | Apple Development | `sessionpipe iOS Development` | builds to the owner's registered iPhone |
| release | Apple Distribution | `sessionpipe App Store` | TestFlight and the App Store |

The simulator needs neither (`tauri ios build --target aarch64-sim`). A device build picks
the profiles up once they are installed in `~/Library/MobileDevice/Provisioning Profiles`.

In the Apple portal (developer.apple.com → Certificates, IDs & Profiles), once:
1. Certificates: *Apple Development* and *Apple Distribution*, from one CSR made on the Mac
   that keeps the private key.
2. Identifiers: App ID `dev.spacesheep.sessionpipe` (explicit), capability *Time Sensitive
   Notifications* only.
3. Devices: the iPhone's UDID.
4. Profiles: *iOS App Development* named exactly `sessionpipe iOS Development` (the
   development certificate, the iPhone) and *App Store Connect* named exactly
   `sessionpipe App Store` (the distribution certificate).
5. App Store Connect → Apps → New App: iOS, name *sessionpipe*, the same bundle id, SKU
   `sessionpipe-ios` (before the first TestFlight upload; the API can't make an app).
6. App Store Connect → Users and Access → Integrations → App Store Connect API: a Team key
   with the *App Manager* role (the `APPLE_API_*` secrets).

The CI secrets for TestFlight are `IOS_DIST_P12`, `IOS_DIST_P12_PASSWORD`,
`IOS_APPSTORE_PROFILE` and, for the upload, the `APPLE_API_*` key (the table above). Never
commit a certificate, a key, a profile or a password. The App Store profile lasts a year:
the workflow says when it has expired, and a new one with the same name (Profiles → the
profile → Edit → Save, then download) goes into `IOS_APPSTORE_PROFILE`.

*iOS → TestFlight* (`ios-testflight.yml`) takes the tag and:
1. checks the iOS SDK is 26 or later (App Store Connect refuses older builds since
   2026-04-28; the job runs on `macos-26`), the secrets, and that the app's record is in
   App Store Connect;
2. builds, signs and exports the `.ipa`, then checks what App Store Connect checks first:
   the bundle id, the version, the build number, the SDK, the Apple Distribution signer,
   the embedded profile, no `get-task-allow`, and the privacy manifest
   (`PrivacyInfo.xcprivacy`); the `.ipa` is kept as a workflow artifact;
3. uploads it with `xcrun altool`, naming the app by its Apple ID (Xcode 26's altool can
   otherwise pick another app whose bundle id starts the same);
4. waits until App Store Connect has processed the build (`VALID`) and puts the TestFlight
   link in the run's summary. A build that never shows up fails the run, whatever altool
   said.

The privacy manifest declares no tracking, no data collected, and the one required-reason
API the binary links (`stat`/`fstat`: file timestamps, for files in the app's container).
If App Store Connect emails *ITMS-91053: Missing API declaration*, a dependency has started
using another one; `nm -u` on the binary in the `.ipa` names it, and its category and reason
go into the manifest.

`CFBundleVersion` is the workflow's run number (`bundle.iOS.bundleVersion`), so every upload
is new to App Store Connect; `CFBundleShortVersionString` is the version. Re-running a run
that uploaded reuses its number and is refused: start a new run instead. With no tag it is a
dry run of the branch it runs on (the tag check, the upload and the wait are skipped), the
way to try a signing change before tagging. `ITSAppUsesNonExemptEncryption` is false in
Info.plist, so a build needs no export-compliance answer before testers get it. Internal
testers (App Store Connect users on the team, in a group with access to all builds) get each
build as soon as it is processed, without App Review; external testers wait for Beta App
Review.

`apps/mobile/scripts/asc.mjs` speaks to the App Store Connect API with the same key, by
hand too:

```sh
node apps/mobile/scripts/asc.mjs app                  # the app's Apple ID
node apps/mobile/scripts/asc.mjs wait 0.5.0 42        # until build 42 of 0.5.0 is processed
node apps/mobile/scripts/asc.mjs get /v1/betaGroups   # any GET
```

with `APPLE_API_ISSUER`, `APPLE_API_KEY` and `APPLE_API_PRIVATE_KEY` (or
`APPLE_API_KEY_PATH`) in the environment.

## The Android app

`apps/mobile` on Android is the package **`dev.spacesheep.sessionpipe`** (minSdk 24, arm64,
armv7 and x86_64). `versionName` is the version and `versionCode` comes from it
(`major·1000000 + minor·1000 + patch`: 0.4.1 is 4001), so Google Play takes one upload per
version.

Signing is **Play App Signing**: Google keeps the key the store signs with, and our
**upload key** signs what we send. It is a PKCS12 keystore with the alias `upload`,
certificate `CN=sessionpipe, O=spacesheep, C=US`, SHA-256
`92:14:30:AE:A4:B1:A7:C4:06:36:EC:52:56:21:F5:14:12:62:3E:9B:BB:16:6E:D4:1B:EA:3A:4C:28:CA:6C:69`.
The release workflow refuses anything signed by another key. If the upload key is lost,
Play can reset it; the app signing key never leaves Google. The `.apk` attached to the
GitHub release is signed by the upload key, not Play's key, so an install from GitHub and
one from Play don't update each other: uninstall one before installing the other.

The Gradle project (`gen/android/app/build.gradle.kts`) signs the release build when
`ANDROID_UPLOAD_KEYSTORE` (the keystore's path) and `ANDROID_UPLOAD_KEYSTORE_PASSWORD` are
set, and leaves it unsigned otherwise. They are only ever environment variables, never a
file in the repo. On the Mac that holds the key:

```sh
cd apps/mobile
ANDROID_UPLOAD_KEYSTORE=<path to the keystore> \
ANDROID_UPLOAD_KEYSTORE_PASSWORD="$(security find-generic-password -s <service> -a <account> -w)" \
  npx tauri android build --aab --apk --target aarch64 armv7 x86_64 --ci
```

It needs JDK 17, the Android SDK and NDK (`ANDROID_HOME`, `NDK_HOME`), and the Rust
targets `aarch64-linux-android`, `armv7-linux-androideabi` and `x86_64-linux-android`.

*Android release* (`android-release.yml`) takes the tag and builds both, checks the signer,
keeps them as workflow artifacts, attaches `sessionpipe_<version>_android.apk` to the tag's
**draft** release (`attach`), and uploads the `.aab` to Google Play when `track` is
`internal`, `alpha` or `beta`. Its secrets, in the `release` environment:

| Secret | Value |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE` | the keystore, base64 |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | its password (the store's and the key's) |
| `PLAY_SERVICE_ACCOUNT_JSON` | a Play Console service account's JSON key, for `track` only |

In the Google Play Console, once:
1. A developer account, then **Create app**: *sessionpipe*, app, free.
2. **Play App Signing** on (the default); upload the first `.aab` by hand to **Internal
   testing**. The API can't create an app or make its first release.
3. **Users and permissions**: a Google Cloud service account (with the *Google Play Android
   Developer API* enabled) invited with *Release to testing tracks*; its JSON key becomes
   `PLAY_SERVICE_ACCOUNT_JSON`.
4. The store listing, content rating, data safety (sessionpipe collects nothing: the app
   talks only to your own computer) and the testers' list.
