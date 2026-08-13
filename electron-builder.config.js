'use strict';
// Packaging config. A .js file and not a block in package.json because the
// build has two modes and they must not be two configs that drift:
//
//   no CSC_LINK  → unsigned. electron-builder is told `identity: null` and
//                  build/after-pack.js ad-hoc signs instead, which is the
//                  minimum an Apple Silicon Mac will launch at all.
//   CSC_LINK set → the real thing: Developer ID, hardened runtime, notarized
//                  and stapled. Add the secrets and this switches over with no
//                  edit here (see .github/workflows/release.yml).

const signed = Boolean(process.env.CSC_LINK);
const notarize = signed && Boolean(process.env.APPLE_TEAM_ID);

module.exports = {
  appId: 'com.abaicus.claude-pet',
  productName: 'Claude Pet',
  copyright: 'Copyright © Andrei Baicus',

  directories: { buildResources: 'build', output: 'dist' },

  // Ship the app and nothing else: the tests, the mockups and the icon
  // generator are development weight, and node_modules holds only electron
  // itself, which is the runtime rather than a dependency.
  files: [
    'src/**/*',
    'package.json',
    '!**/*.md'
  ],

  npmRebuild: false, // pure JS — there is nothing native to rebuild

  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    // Arch in every name, x64 included: electron-builder's default drops it
    // for x64, and the Homebrew cask interpolates one name for both arches.
    artifactName: 'claude-pet-${version}-${arch}.${ext}',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] } // the cask installs from this
    ],
    darkModeSupport: true,
    // Electron 33 runs on Catalina and later.
    minimumSystemVersion: '10.15.0',
    identity: signed ? undefined : null,
    hardenedRuntime: signed,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: notarize ? { teamId: process.env.APPLE_TEAM_ID } : false
  },

  dmg: {
    // Drag-to-Applications, the only layout anyone reads without instructions.
    contents: [
      { x: 140, y: 180, type: 'file' },
      { x: 400, y: 180, type: 'link', path: '/Applications' }
    ],
    window: { width: 540, height: 380 }
  },

  afterPack: './build/after-pack.js',

  publish: [{ provider: 'github', owner: 'abaicus', repo: 'claude-pet' }]
};
