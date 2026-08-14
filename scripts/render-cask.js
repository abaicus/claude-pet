'use strict';
// Renders the Homebrew cask for a released version.
//
//   node scripts/render-cask.js <version> <arm64-sha256> <x64-sha256> [outfile]
//
// The rendered file is uploaded as a release asset, and BOTH routes into the
// tap (the push from the release workflow, and the tap's own scheduled
// updater) copy that asset verbatim. One template, one source of truth — a
// cask that is re-typed in the tap repo is a cask that drifts from the app.

const fs = require('fs');

const [version, shaArm, shaIntel, out] = process.argv.slice(2);

if (!version || !shaArm || !shaIntel) {
  console.error('usage: render-cask.js <version> <arm64-sha256> <x64-sha256> [outfile]');
  process.exit(1);
}
for (const [label, sha] of [['arm64', shaArm], ['x64', shaIntel]]) {
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    console.error(`${label} sha256 is not a 64-char hex digest: ${sha}`);
    process.exit(1);
  }
}
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`version is not semver: ${version}`);
  process.exit(1);
}

// The app ships unsigned, so the cask clears the quarantine flag Homebrew puts
// on the download. Without it macOS refuses to open the app at all and the
// user is left with "Gogu is damaged" — which is a lie about a build that is
// merely uncertified.
const cask = `cask "gogu" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${shaArm}",
         intel: "${shaIntel}"

  url "https://github.com/abaicus/gogu/releases/download/v#{version}/gogu-#{version}-#{arch}.zip"
  name "Gogu"
  desc "Desktop tamagotchi that feeds on Claude Code activity"
  homepage "https://github.com/abaicus/gogu"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :catalina

  app "Gogu.app"

  # Not signed with an Apple Developer ID, so Gatekeeper would quarantine it
  # into "damaged, move to Trash". The build IS ad-hoc signed and its checksum
  # is pinned above; this drops the quarantine flag on that verified download.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Gogu.app"]
  end

  uninstall quit: "com.abaicus.gogu"

  # Not listed: ~/.claude/settings.json. The pet writes its hooks there and
  # removes exactly its own entries from the tray's uninstall — a zap that
  # rewrote your Claude config would be overreach.
  zap trash: [
    "~/.gogu",
    "~/Library/Application Support/Gogu",
    "~/Library/Preferences/com.abaicus.gogu.plist",
    "~/Library/Saved Application State/com.abaicus.gogu.savedState",
  ]

  caveats <<~EOS
    Gogu watches Claude Code sessions by installing hooks into
    ~/.claude/settings.json on first launch. It appends its own entries,
    leaves the rest of your config alone, and the tray menu removes them.

    The build is not notarized by Apple. This cask has already cleared the
    quarantine flag for you, so it will just open.
  EOS
end
`;

if (out) {
  fs.writeFileSync(out, cask);
  console.log(`wrote ${out}`);
} else {
  process.stdout.write(cask);
}
