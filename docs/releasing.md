# Releasing

Two artifacts come out of one run: the **downloadable app** (a DMG each for
Apple Silicon and Intel, attached to a GitHub release) and the **Homebrew cask** in
[abaicus/homebrew-tap](https://github.com/abaicus/homebrew-tap).

## Cutting a release

**Actions → Release → Run workflow**, type the version (`0.2.0`), run it. The
workflow bumps `package.json`, commits, tags `v0.2.0`, builds, publishes, and
updates the tap.

Or do the bump yourself and push a tag — the tag must match `package.json` or
the run fails on purpose, because a `v0.2.0` release that reports `0.1.9` in
its about box is worse than a failed build:

```sh
npm version 0.2.0        # commits and tags
git push && git push --tags
```

## What a release produces

| Asset | What it is |
| --- | --- |
| `gogu-<v>-arm64.dmg` / `-x64.dmg` | the download, and what the Homebrew cask installs |
| `gogu.rb` | the rendered cask — the tap copies this file verbatim |

One image per arch, ~57 MB each. There used to be a zip alongside for the cask
to install from; the cask reads the dmg now, which is smaller for the same app.

## Why the download is not 95 MB

Most of an Electron app is Electron, and most of the rest is reachable only in
theory. Three things hold the size down, none of them the app's own code:

- `build/after-pack.js` deletes Chromium's 50-odd non-English `.lproj`
  bundles and its SwiftShader driver — 58 MB the app has no way to reach.
  (`mac.electronLanguages` looks like it does the first job and does not: on
  macOS it only prunes the empty stubs under `Contents/Resources`.)
- The dmg is built with lzfse rather than zlib.
- `build/after-all.js` re-compresses it again with `ULMO`, which is another
  17-19 MB and which electron-builder's config schema refuses to name.

CI asserts the first of those on every build, because a prune that stops
running produces an app that is correct in every way except its weight.

## The two routes into the tap

1. **Push** — the release workflow commits `Casks/gogu.rb` to the tap
   directly. Needs a `HOMEBREW_TAP_TOKEN` secret on this repo (below).
2. **Pull** — the tap's own `update-cask` workflow checks this repo's latest
   release hourly and copies the `gogu.rb` asset. It uses the tap's own
   `GITHUB_TOKEN` and needs no secret at all.

Route 2 exists so a missing or expired token delays the cask by an hour
instead of silently shipping a release nobody can `brew upgrade` into. Both
routes copy the same asset, so they cannot disagree. (GitHub pauses cron
workflows in repositories that see no commits for 60 days, and the tap is
quiet by design — so route 1 is worth setting up, and route 2 can always be
run by hand from the tap's Actions tab.)

To enable route 1: create a fine-grained PAT with **Contents: Read and write**
scoped to `abaicus/homebrew-tap`
([github.com/settings/tokens](https://github.com/settings/personal-access-tokens/new)),
then add it here as `HOMEBREW_TAP_TOKEN`:

```sh
gh secret set HOMEBREW_TAP_TOKEN --repo abaicus/gogu
```

## Signing

Today the app is **ad-hoc signed and not notarized**. That is the free floor:
an unsigned binary will not launch at all on Apple Silicon, and an ad-hoc one
launches once the quarantine flag is cleared — which the cask does for you,
and which the DMG instructions spell out.

Nothing needs editing to switch to real signing. `electron-builder.config.js`
reads `CSC_LINK`: with it set the build uses your Developer ID, turns on the
hardened runtime with `build/entitlements.mac.plist`, notarizes and staples;
`build/after-pack.js` then leaves the signature alone. Add these secrets and
the next release is notarized:

| Secret | Value |
| --- | --- |
| `APPLE_CERT_P12` | base64 of your exported Developer ID `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERT_PASSWORD` | the password you exported it with |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_PASSWORD` | an app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | the 10-character team ID |

Then drop the `postflight` xattr block from `scripts/render-cask.js` — a
notarized app does not need it, and clearing quarantine on a build that
Gatekeeper would have accepted anyway is a habit worth losing.

## Building locally

```sh
npm run dist     # dist/*.dmg for both arches
npm run pack     # just the .app, no disk image — faster when checking packaging
npm run icon     # regenerate build/icon.icns from the pet's own drawing code
```
